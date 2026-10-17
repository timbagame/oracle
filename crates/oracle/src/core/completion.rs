//! Game readiness evaluation and completion (port of
//! `oracle-completion-manager.ts`, `game-completion-transaction-builder.ts`
//! and `oracle-accounts.ts`).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use regex::Regex;
use timba_common::{error, info, warn};
use timba_protocol::address::COMPUTE_BUDGET_PROGRAM_ID;
use timba_protocol::contracts::{complete_game_instruction, find_game_pda, CompleteGameInput, GameAccount};
use timba_protocol::randomness::calculate_winner;
use timba_protocol::{Address, ContractVersion, Instruction};

use super::expiry::{expiry_wakeup, ExpiryTimers};
use super::registry::RegistrySyncManager;
use super::types::{AttemptOptions, CompletionResult, GameContext, Readiness, ReadinessResolution};
use crate::db::{CompletionFailureKind, OracleDatabase};
use crate::metrics::{CompletionOutcome, CompletionRecord, OracleMetrics};
use crate::program_client::{is_account_missing_error, ProgramClient};
use crate::solana::confirm::submit_transaction;
use crate::solana::tx::sign_legacy_transaction;
use crate::solana::{Keypair, RpcPool};

pub const SECRET_KEY_LENGTH: usize = 32;

/// A completion uses 33k-48k compute units. The limit leaves headroom and keeps the
/// priority fee (price times limit) small.
pub const COMPLETION_COMPUTE_UNIT_LIMIT: u32 = 100_000;
/// Priority fee bounds in micro-lamports per compute unit: 1,000 to 50,000 lamports per
/// completion at the limit above. Without a fee, about half the completions were dropped.
pub const MIN_PRIORITY_FEE: u64 = 10_000;
pub const MAX_PRIORITY_FEE: u64 = 500_000;
/// A retry means the previous transaction expired unseen, so it bids this much more.
const RETRY_PRIORITY_FEE_FACTOR: u64 = 4;

/// `SetComputeUnitLimit` and `SetComputeUnitPrice` from the compute budget program.
pub fn compute_budget_instructions(unit_limit: u32, micro_lamports_per_unit: u64) -> [Instruction; 2] {
    let instruction = |tag: u8, value: &[u8]| Instruction {
        program_id: COMPUTE_BUDGET_PROGRAM_ID,
        accounts: Vec::new(),
        data: std::iter::once(tag).chain(value.iter().copied()).collect(),
    };
    [instruction(2, &unit_limit.to_le_bytes()), instruction(3, &micro_lamports_per_unit.to_le_bytes())]
}
pub const NO_SECRET_KEY_MESSAGE: &str = "No secret key found";

pub fn is_transient_completion_failure(error: Option<&str>) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let Some(error) = error.filter(|e| !e.is_empty()) else { return false };
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)expired|blockhash|block height|timeout|timed out|rpc|network|unavailable|temporary|not confirmed|failed to send|failed to fetch",
        )
        .unwrap()
    })
    .is_match(error)
}

pub type ReadinessCache = Arc<Mutex<HashMap<String, Readiness>>>;

/// Lazily fetched blockchain time shared across a scan cycle.
#[derive(Default)]
pub struct BlockTimeCache(Mutex<Option<i64>>);

impl BlockTimeCache {
    pub fn get(&self) -> Option<i64> {
        *self.0.lock().unwrap()
    }

    pub fn set(&self, value: i64) {
        *self.0.lock().unwrap() = Some(value);
    }

    pub fn clear(&self) {
        *self.0.lock().unwrap() = None;
    }
}

#[derive(Default)]
pub struct ResolveOptions<'a> {
    pub context: Option<GameContext>,
    pub readiness: Option<Readiness>,
    pub require_on_chain: bool,
    pub block_time: Option<i64>,
    /// Used to fetch (once) and share the blockchain time when `block_time`
    /// is unknown.
    pub block_time_cache: Option<&'a BlockTimeCache>,
}

pub struct CompletionManagerOptions {
    pub contract_version: ContractVersion,
    pub db: Arc<OracleDatabase>,
    pub metrics: Arc<OracleMetrics>,
    pub rpc: Arc<RpcPool>,
    pub program: Arc<ProgramClient>,
    pub operator: Arc<Keypair>,
    pub readiness_cache: ReadinessCache,
    pub registry: Arc<RegistrySyncManager>,
    /// Wakes min-player games at expiry; `None` leaves them to the fallback scan.
    pub expiry: Option<Arc<ExpiryTimers>>,
}

pub struct CompletionManager {
    contract_version: ContractVersion,
    db: Arc<OracleDatabase>,
    metrics: Arc<OracleMetrics>,
    rpc: Arc<RpcPool>,
    program: Arc<ProgramClient>,
    operator: Arc<Keypair>,
    readiness_cache: ReadinessCache,
    pub registry: Arc<RegistrySyncManager>,
    expiry: Option<Arc<ExpiryTimers>>,
    in_flight: Mutex<HashSet<String>>,
}

struct InFlightGuard<'a> {
    set: &'a Mutex<HashSet<String>>,
    key: String,
}

impl Drop for InFlightGuard<'_> {
    fn drop(&mut self) {
        self.set.lock().unwrap().remove(&self.key);
    }
}

struct WinnerDetails {
    game: GameAccount,
    winner: Address,
    winner_index: u32,
    secret_key: [u8; 32],
}

impl CompletionManager {
    pub fn new(options: CompletionManagerOptions) -> Self {
        Self {
            contract_version: options.contract_version,
            db: options.db,
            metrics: options.metrics,
            rpc: options.rpc,
            program: options.program,
            operator: options.operator,
            readiness_cache: options.readiness_cache,
            registry: options.registry,
            expiry: options.expiry,
            in_flight: Mutex::new(HashSet::new()),
        }
    }

    pub fn program_id(&self) -> Address {
        self.program.program_id
    }

    pub async fn is_game_ready_for_completion(&self, game_pda: &Address) -> anyhow::Result<bool> {
        let address = game_pda.to_base58();
        Ok(self.evaluate_and_cache_readiness(game_pda, &address, None).await?.ready)
    }

    /// Returns `None` when another attempt is in flight or the game has no
    /// stored context.
    pub async fn attempt_game_completion(&self, options: AttemptOptions) -> anyhow::Result<Option<CompletionResult>> {
        let key = options.game_address.clone();
        if !self.in_flight.lock().unwrap().insert(key.clone()) {
            return Ok(None);
        }
        let _guard = InFlightGuard { set: &self.in_flight, key };

        let resolved_pda = options
            .context
            .as_ref()
            .map(|c| c.game_pda)
            .or(options.game_key)
            .or_else(|| Address::parse(&options.game_address).ok());
        if resolved_pda.is_none() {
            return Ok(None);
        }

        let resolution = self
            .resolve_context_and_readiness(
                &options.game_address,
                ResolveOptions {
                    context: options.context.clone(),
                    readiness: options.readiness.clone(),
                    require_on_chain: !options.skip_readiness_check,
                    ..ResolveOptions::default()
                },
            )
            .await?;
        let ReadinessResolution::Resolved { ready, context, readiness, .. } = resolution else {
            return Ok(None);
        };
        if !options.skip_readiness_check && !ready {
            return Ok(Some(self.finalize_outcome(&options.game_address, CompletionResult::not_ready(), &options)));
        }
        let result = self.complete_game(&options.game_address, Some(readiness), Some(context)).await;
        Ok(Some(self.finalize_outcome(&options.game_address, result, &options)))
    }

    fn finalize_outcome(
        &self,
        game_address: &str,
        result: CompletionResult,
        options: &AttemptOptions,
    ) -> CompletionResult {
        if let Some(hook) = &options.on_result {
            hook(&result);
        }
        self.metrics.record_completion(CompletionRecord {
            game_address: game_address.to_string(),
            outcome: if result.success {
                CompletionOutcome::Success
            } else if result.not_ready {
                CompletionOutcome::NotReady
            } else {
                CompletionOutcome::Error
            },
            error: result.error.clone(),
        });
        if result.success {
            if let Some(log) = &options.success_log {
                let message = log(game_address, None);
                if !message.is_empty() {
                    info!("{message}");
                }
            }
        } else if !result.not_ready {
            if let Some(log) = &options.failure_log {
                let message = log(game_address, result.error.as_deref());
                if !message.is_empty() {
                    error!("{message}");
                }
            }
        }
        result
    }

    pub async fn complete_game(
        &self,
        game_address: &str,
        readiness: Option<Readiness>,
        context: Option<GameContext>,
    ) -> CompletionResult {
        match self.try_complete_game(game_address, readiness, context).await {
            Ok(result) => result,
            Err(error) => self.record_completion_failure(game_address, &format!("{error:#}"), false, None),
        }
    }

    async fn try_complete_game(
        &self,
        game_address: &str,
        readiness: Option<Readiness>,
        context: Option<GameContext>,
    ) -> anyhow::Result<CompletionResult> {
        let state = self
            .resolve_context_and_readiness(
                game_address,
                ResolveOptions { context, readiness, require_on_chain: true, ..ResolveOptions::default() },
            )
            .await?;
        let (context, game) = match state {
            ReadinessResolution::Resolved { ready: false, .. } => return Ok(CompletionResult::not_ready()),
            ReadinessResolution::Resolved {
                context, readiness: Readiness { game_account: Some(game), .. }, ..
            } => (context, game),
            // Requiring the game on-chain means a resolution always carries its
            // account; one that does not is as unusable as a missing context.
            ReadinessResolution::MissingContext | ReadinessResolution::Resolved { .. } => {
                return Ok(self.record_fatal(game_address, NO_SECRET_KEY_MESSAGE));
            }
        };

        let details = match self.resolve_winner_details(game_address, game, &context).await? {
            Ok(details) => details,
            Err(result) => return Ok(result),
        };
        let tx_hash = self
            .execute_game_completion(
                &details.game,
                &details.winner,
                &context.random_hash,
                &details.secret_key,
                details.winner_index,
            )
            .await?;
        self.finalize_successful_completion(game_address);
        Ok(CompletionResult {
            success: true,
            tx_hash: Some(tx_hash),
            winner_address: Some(details.winner.to_base58()),
            total_pot: Some(details.game.total_amount),
            ..CompletionResult::default()
        })
    }

    async fn resolve_winner_details(
        &self,
        game_address: &str,
        game: GameAccount,
        context: &GameContext,
    ) -> anyhow::Result<Result<WinnerDetails, CompletionResult>> {
        // A damaged row must not be revealed as a zero-padded secret, which the
        // program rejects only after the transaction fee is spent.
        let secret = match hex::decode(&context.secret.secret_key) {
            Ok(secret) if secret.len() == SECRET_KEY_LENGTH => secret,
            _ => return Ok(Err(self.record_fatal(game_address, "Stored secret key is corrupt"))),
        };
        let expected = i64::from(game.tickets_count);
        let players = match self.registry.ensure_players_in_sync(game_address, context, expected).await {
            Ok(players) => players,
            Err(message) => return Ok(Err(self.record_fatal(game_address, message))),
        };
        let winner_index = self.calculate_winner_index(&secret, game.last_slot, players.len() as u64)?;
        // The registry holds at least one player and the draw is below the player count; a
        // broken invariant still records a fatal failure instead of panicking.
        let drawn = players.get(winner_index as usize).map_or("", String::as_str);
        let Ok(winner) = Address::parse(drawn) else {
            return Ok(Err(self.record_fatal(game_address, "Winner address is invalid")));
        };
        let mut secret_key = [0u8; 32];
        secret_key.copy_from_slice(&secret);
        Ok(Ok(WinnerDetails { game, winner, winner_index, secret_key }))
    }

    pub fn calculate_winner_index(&self, secret: &[u8], last_slot: u64, players: u64) -> anyhow::Result<u32> {
        if players <= 1 {
            return Ok(0);
        }
        if secret.len() < SECRET_KEY_LENGTH {
            anyhow::bail!("Secret key buffer must be at least {SECRET_KEY_LENGTH} bytes");
        }
        let selection = calculate_winner(&secret[..SECRET_KEY_LENGTH], last_slot, players)
            .map_err(|error| anyhow::anyhow!("{error}"))?;
        Ok(selection.winner_index as u32)
    }

    fn record_completion_failure(
        &self,
        game_address: &str,
        error: &str,
        clear_readiness: bool,
        kind: Option<CompletionFailureKind>,
    ) -> CompletionResult {
        let kind = kind.unwrap_or(if is_transient_completion_failure(Some(error)) {
            CompletionFailureKind::Transient
        } else {
            CompletionFailureKind::Permanent
        });
        let outcome = match kind {
            CompletionFailureKind::Transient => self.db.record_transient_completion_failure(game_address),
            CompletionFailureKind::Permanent => self.db.increment_completion_attempts(game_address),
        };
        if let Err(db_error) = outcome {
            error!("Failed to record completion failure for {game_address}: {db_error:#}");
        }
        if clear_readiness {
            self.readiness_cache.lock().unwrap().remove(game_address);
        }
        CompletionResult::failure(error)
    }

    fn record_fatal(&self, game_address: &str, error: &str) -> CompletionResult {
        self.record_completion_failure(game_address, error, true, Some(CompletionFailureKind::Permanent))
    }

    fn finalize_successful_completion(&self, game_address: &str) {
        self.registry.reset_registry_prefetch_schedule(game_address);
        if let Err(error) = self.db.finalize_completed_game(game_address) {
            error!("Failed to finalize completed game {game_address}: {error:#}");
        }
        self.readiness_cache.lock().unwrap().remove(game_address);
    }

    pub async fn resolve_context_and_readiness(
        &self,
        game_address: &str,
        options: ResolveOptions<'_>,
    ) -> anyhow::Result<ReadinessResolution> {
        let provided_context = options.context.clone();
        let context = match provided_context.clone() {
            Some(context) => context,
            None => match self.resolve_stored_game(game_address)? {
                Some(context) => context,
                None => {
                    if options.require_on_chain {
                        warn!("{NO_SECRET_KEY_MESSAGE} for game {game_address}");
                    }
                    return Ok(ReadinessResolution::MissingContext);
                }
            },
        };

        let (snapshot, should_prefetch) = self.resolve_readiness_snapshot(game_address, &context, &options).await?;
        let Some(snapshot) = snapshot else {
            return Ok(ReadinessResolution::MissingContext);
        };
        let mut context = context;
        context.readiness = Some(snapshot.clone());
        if should_prefetch {
            self.registry.prefetch_player_registry(game_address, &context, &snapshot).await;
        }
        Ok(ReadinessResolution::Resolved {
            ready: snapshot.ready && snapshot.game_account.is_some(),
            context,
            readiness: snapshot,
            prefetch_scheduled: should_prefetch,
        })
    }

    async fn resolve_readiness_snapshot(
        &self,
        game_address: &str,
        context: &GameContext,
        options: &ResolveOptions<'_>,
    ) -> anyhow::Result<(Option<Readiness>, bool)> {
        let provided = options.readiness.clone().or_else(|| options.context.as_ref().and_then(|c| c.readiness.clone()));
        if let Some(candidate) = provided {
            if !options.require_on_chain || candidate.game_account.is_some() {
                return Ok((Some(candidate), false));
            }
        }
        if !options.require_on_chain {
            if let Some(cached) = self.consume_readiness(game_address) {
                return Ok((Some(cached), false));
            }
        }
        let block_time = match (options.block_time, options.block_time_cache) {
            (Some(time), _) => Some(time),
            (None, Some(cache)) => Some(match cache.get() {
                Some(time) => time,
                None => {
                    let time = self.get_blockchain_time().await;
                    cache.set(time);
                    time
                }
            }),
            (None, None) => None,
        };
        let evaluation = self.evaluate_and_cache_readiness(&context.game_pda, game_address, block_time).await?;
        if evaluation.game_account.is_none() && options.require_on_chain {
            warn!("Game {game_address} no longer exists on-chain");
            return Ok((None, false));
        }
        let prefetch = evaluation.game_account.is_some();
        Ok((Some(evaluation), prefetch))
    }

    pub fn consume_readiness(&self, game_address: &str) -> Option<Readiness> {
        self.readiness_cache.lock().unwrap().remove(game_address)
    }

    pub async fn get_blockchain_time(&self) -> i64 {
        let now = || timba_common::time::now_secs();
        let Ok(slot) = self.rpc.get_slot().await else { return now() };
        match self.rpc.get_block_time(slot).await {
            Ok(Some(time)) => time,
            _ => now(),
        }
    }

    async fn evaluate_and_cache_readiness(
        &self,
        game_pda: &Address,
        game_address: &str,
        block_time: Option<i64>,
    ) -> anyhow::Result<Readiness> {
        let readiness = self.evaluate_game_readiness(game_pda, block_time).await?;
        if let Some(expiry) = &self.expiry {
            let wakeup = match (&readiness.game_account, readiness.evaluated_at) {
                // Ready games return `None`: they are full or already expired.
                (Some(game), Some(evaluated_at)) => expiry_wakeup(game, evaluated_at),
                _ => None,
            };
            match wakeup {
                Some(expires_at) => expiry.schedule(game_address, *game_pda, expires_at),
                None => expiry.cancel(game_address),
            }
        }
        let mut cache = self.readiness_cache.lock().unwrap();
        if readiness.ready {
            cache.insert(game_address.to_string(), readiness.clone());
        } else {
            cache.remove(game_address);
        }
        Ok(readiness)
    }

    pub async fn evaluate_game_readiness(
        &self,
        game_pda: &Address,
        block_time: Option<i64>,
    ) -> anyhow::Result<Readiness> {
        let Some(game) = self.fetch_game_account(game_pda).await? else {
            return Ok(Readiness { ready: false, game_account: None, evaluated_at: None });
        };
        // A full game is ready at any time, so it skips the two clock RPCs.
        let is_full = game.tickets_count >= game.max_tickets;
        let evaluated_at = match block_time {
            Some(time) => time,
            None if is_full => timba_common::time::now_secs(),
            None => self.get_blockchain_time().await,
        };
        Ok(Readiness {
            ready: is_game_ready(&game, evaluated_at),
            game_account: Some(game),
            evaluated_at: Some(evaluated_at),
        })
    }

    pub async fn fetch_game_account(&self, game_pda: &Address) -> anyhow::Result<Option<GameAccount>> {
        match self.program.fetch_game(game_pda).await {
            Ok(game) => Ok(Some(game)),
            Err(error) if is_account_missing_error(&error.to_string()) => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub fn build_completion_instruction(
        &self,
        game: &GameAccount,
        winner: &Address,
        random_hash: &[u8; 32],
        secret_key: &[u8; 32],
        winner_index: u32,
    ) -> anyhow::Result<Instruction> {
        if winner.is_off_curve() {
            anyhow::bail!("Token owner must be on the ed25519 curve");
        }
        let program_id = self.program.program_id;
        Ok(complete_game_instruction(
            self.contract_version,
            &CompleteGameInput {
                game: find_game_pda(random_hash, &program_id),
                token_mint: game.token_mint,
                oracle_operator: self.operator.address(),
                winner: *winner,
                creator: game.creator,
                random_hash: *random_hash,
                secret_key: *secret_key,
                winner_index,
            },
            &program_id,
        ))
    }

    pub async fn execute_game_completion(
        &self,
        game: &GameAccount,
        winner: &Address,
        random_hash: &[u8; 32],
        secret_key: &[u8; 32],
        winner_index: u32,
    ) -> anyhow::Result<String> {
        let instruction = self.build_completion_instruction(game, winner, random_hash, secret_key, winner_index)?;
        let mut fee = self.priority_fee(&instruction).await;
        let started = std::time::Instant::now();
        let operator = self.operator.clone();
        let mut fees = Vec::new();
        let signature = submit_transaction(
            &self.rpc,
            |latest| {
                if !fees.is_empty() {
                    fee = fee.saturating_mul(RETRY_PRIORITY_FEE_FACTOR).min(MAX_PRIORITY_FEE);
                }
                fees.push(fee);
                let [limit, price] = compute_budget_instructions(COMPLETION_COMPUTE_UNIT_LIMIT, fee);
                Ok(sign_legacy_transaction(&operator, &[], &latest.blockhash, &[limit, price, instruction.clone()])?.1)
            },
            None,
        )
        .await?;
        info!(
            "📨 Completion {signature} confirmed in {}ms (priority fee {} micro-lamports/CU)",
            started.elapsed().as_millis(),
            fees.iter().map(u64::to_string).collect::<Vec<_>>().join(" then ")
        );
        Ok(signature)
    }

    /// The Helius "High" estimate for the instruction's writable accounts, clamped to
    /// [`MIN_PRIORITY_FEE`]..=[`MAX_PRIORITY_FEE`]; the minimum when no estimate is available.
    async fn priority_fee(&self, instruction: &Instruction) -> u64 {
        let writable: Vec<Address> =
            instruction.accounts.iter().filter(|account| account.writable).map(|account| account.address).collect();
        match self.rpc.get_priority_fee_estimate(&writable).await {
            Ok(estimate) => estimate.clamp(MIN_PRIORITY_FEE, MAX_PRIORITY_FEE),
            Err(error) => {
                warn!("Priority fee estimate unavailable, using {MIN_PRIORITY_FEE}: {error}");
                MIN_PRIORITY_FEE
            }
        }
    }

    pub fn resolve_stored_game(&self, game_address: &str) -> anyhow::Result<Option<GameContext>> {
        let Some(secret) = self.db.get_secret_key(game_address) else { return Ok(None) };
        let random_hash = decode_random_hash(&secret.random_hash)?;
        let game_pda = find_game_pda(&random_hash, &self.program.program_id);
        Ok(Some(GameContext { game_pda, secret, random_hash, readiness: None }))
    }

    pub fn get_game_pda(&self, random_hash: &[u8]) -> anyhow::Result<Address> {
        let hash: [u8; 32] =
            random_hash.try_into().map_err(|_| anyhow::anyhow!("Game random hash must be 32 bytes"))?;
        Ok(find_game_pda(&hash, &self.program.program_id))
    }

    pub fn reset_registry_prefetch_schedule(&self, game_address: &str) {
        self.registry.reset_registry_prefetch_schedule(game_address);
    }
}

pub fn decode_random_hash(value: &str) -> anyhow::Result<[u8; 32]> {
    hex::decode(value)
        .ok()
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .ok_or_else(|| anyhow::anyhow!("Game random hash must be 32 bytes"))
}

/// A game is ready once it has tickets and is either full or expired with
/// the minimum number of tickets.
pub fn is_game_ready(game: &GameAccount, evaluated_at: i64) -> bool {
    let expires_at = game.created_at as i128 + game.timeout as i128;
    let is_expired = i128::from(evaluated_at) >= expires_at;
    let tickets = game.tickets_count;
    let has_tickets = tickets > 0;
    let is_full = has_tickets && tickets >= game.max_tickets;
    let has_min = has_tickets && tickets >= game.min_tickets;
    has_tickets && (is_full || (is_expired && has_min))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::registry::{RecoverPlayerRegistry, RecoverRequest};
    use crate::core::testing::{account_value, fail_updates, game_account};
    use crate::db::SecretKeyData;
    use crate::metrics::CompletionOutcome;
    use crate::solana::pool::testing::FakeTransport;
    use crate::solana::rpc::RpcError;
    use base64::Engine;
    use futures::FutureExt;
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use timba_protocol::contracts::PROGRAM_ID;

    const SECRET: [u8; 32] = [0x11; 32];
    const BLOCK_TIME: i64 = 1_700_000_000;
    const BLOCKHASH: &str = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";

    struct Harness {
        _dir: tempfile::TempDir,
        db: Arc<OracleDatabase>,
        transport: Arc<FakeTransport>,
        metrics: Arc<OracleMetrics>,
        cache: ReadinessCache,
        manager: CompletionManager,
    }

    fn harness(recover: Option<RecoverPlayerRegistry>) -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(OracleDatabase::open(dir.path().join("o.sqlite").to_str().unwrap()).unwrap());
        let transport = FakeTransport::new();
        transport.on(|_, method, _| match method {
            "getSlot" => Some(Ok(json!(100))),
            "getBlockTime" => Some(Ok(json!(BLOCK_TIME))),
            _ => None,
        });
        let rpc = Arc::new(RpcPool::with_transport(&["https://a".into()], transport.clone()).unwrap());
        let program = ProgramClient::new(rpc.clone(), ContractVersion::V0_3_0, None);
        let metrics = Arc::new(OracleMetrics::new(50));
        let cache = ReadinessCache::default();
        let registry = Arc::new(RegistrySyncManager::new(db.clone(), recover, true, None));
        let manager = CompletionManager::new(CompletionManagerOptions {
            contract_version: ContractVersion::V0_3_0,
            db: db.clone(),
            metrics: metrics.clone(),
            rpc,
            program,
            operator: Arc::new(Keypair::generate()),
            readiness_cache: cache.clone(),
            registry,
            expiry: None,
        });
        Harness { _dir: dir, db, transport, metrics, cache, manager }
    }

    fn recover_with(
        calls: Arc<AtomicUsize>,
        result: impl Fn(usize) -> anyhow::Result<Option<Vec<String>>> + Send + Sync + 'static,
    ) -> RecoverPlayerRegistry {
        let result = Arc::new(result);
        Arc::new(move |_request: RecoverRequest| {
            let n = calls.fetch_add(1, Ordering::SeqCst) + 1;
            let outcome = result(n);
            async move { outcome }.boxed()
        })
    }

    /// Stores a commitment and returns `(game_address, game_pda, random_hash)`.
    fn store_game(h: &Harness, random_hash: [u8; 32]) -> (String, Address, [u8; 32]) {
        let pda = find_game_pda(&random_hash, &PROGRAM_ID);
        let address = pda.to_base58();
        h.db.save_secret_key(&address, &hex::encode(SECRET), &hex::encode(random_hash)).unwrap();
        h.db.track_game(&address, None, false).unwrap();
        (address, pda, random_hash)
    }

    fn serve_game(h: &Harness, game: Option<GameAccount>) {
        let value = match game {
            Some(game) => account_value(&game),
            None => json!({"value": null}),
        };
        h.transport.on(move |_, method, _| (method == "getAccountInfo").then(|| Ok(value.clone())));
    }

    fn serve_submission(h: &Harness) {
        h.transport.on(|_, method, _| match method {
            "getLatestBlockhash" => Some(Ok(json!({"value": {"blockhash": BLOCKHASH, "lastValidBlockHeight": 100}}))),
            "sendTransaction" => Some(Ok(json!("landed-sig"))),
            "getSignatureStatuses" => {
                Some(Ok(json!({"value": [{"slot": 1, "confirmationStatus": "confirmed", "err": null}]})))
            }
            "getBlockHeight" => Some(Ok(json!(1))),
            _ => None,
        });
    }

    fn players(n: usize) -> Vec<String> {
        (0..n).map(|_| Keypair::generate().address().to_base58()).collect()
    }

    fn context(pda: Address, random_hash: [u8; 32], readiness: Option<Readiness>) -> GameContext {
        GameContext {
            game_pda: pda,
            secret: SecretKeyData { secret_key: hex::encode(SECRET), random_hash: hex::encode(random_hash) },
            random_hash,
            readiness,
        }
    }

    #[test]
    fn classifies_transient_failures() {
        assert!(!is_transient_completion_failure(None));
        assert!(!is_transient_completion_failure(Some("")));
        assert!(is_transient_completion_failure(Some("Blockhash not found")));
        assert!(is_transient_completion_failure(Some("RPC request failed: connection reset")));
        assert!(is_transient_completion_failure(Some("Transaction sig expired before confirmation")));
        assert!(!is_transient_completion_failure(Some("Ticket registry out of sync")));
        assert!(!is_transient_completion_failure(Some(NO_SECRET_KEY_MESSAGE)));
        // A failed preflight is permanent unless the node blames the blockhash.
        let simulation = "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1771";
        assert!(!is_transient_completion_failure(Some(&RpcError::json_rpc(-32002, simulation).to_string())));
        let stale = "Transaction simulation failed: Blockhash not found";
        assert!(is_transient_completion_failure(Some(&RpcError::json_rpc(-32002, stale).to_string())));
    }

    #[test]
    fn readiness_rules() {
        // Zero tickets never complete, even when expired with a zero minimum.
        assert!(!is_game_ready(&game_account(0, 5, 0, 0, 10), 100));
        // The timeout boundary counts as expired when the minimum is met.
        assert!(is_game_ready(&game_account(3, 5, 2, 1_000, 60), 1_060));
        assert!(!is_game_ready(&game_account(3, 5, 2, 1_000, 60), 1_059));
        // Full games are ready before expiry.
        assert!(is_game_ready(&game_account(2, 2, 2, 1_000, 60), 0));
        // Expired games below the minimum are not.
        assert!(!is_game_ready(&game_account(1, 5, 2, 0, 10), 100));
        // Huge timeouts do not overflow.
        assert!(!is_game_ready(&game_account(1, 5, 1, u64::MAX, u64::MAX), i64::MAX));
    }

    #[test]
    fn calculates_deterministic_winner_indexes() {
        let h = harness(None);
        let mut seed: u32 = 1;
        let mut next = || {
            let mut buf = [0u8; 64];
            for byte in buf.iter_mut() {
                seed = (seed.wrapping_mul(1_103_515_245).wrapping_add(12_345)) & 0x7fff_ffff;
                *byte = (seed & 0xff) as u8;
            }
            buf
        };
        for players in 2..=12u64 {
            let mut seen = HashSet::new();
            for iteration in 0..20u64 {
                let secret = if iteration == 0 { [0u8; 64] } else { next() };
                let slot = 10_000 + iteration;
                let first = h.manager.calculate_winner_index(&secret, slot, players).unwrap();
                let second = h.manager.calculate_winner_index(&secret, slot, players).unwrap();
                assert_eq!(first, second);
                assert!(u64::from(first) < players);
                seen.insert(first);
            }
            assert!(seen.len() > 1, "{players} players always drew the same index");
        }
        assert_eq!(
            h.manager.calculate_winner_index(&[0; 16], 1, 2).unwrap_err().to_string(),
            "Secret key buffer must be at least 32 bytes"
        );
        // Single-player games skip the draw entirely.
        assert_eq!(h.manager.calculate_winner_index(&[], 1, 1).unwrap(), 0);
    }

    #[test]
    fn derives_pdas_and_decodes_hashes() {
        let h = harness(None);
        assert_eq!(h.manager.program_id(), PROGRAM_ID);
        let hash = [0x22; 32];
        assert_eq!(h.manager.get_game_pda(&hash).unwrap(), find_game_pda(&hash, &PROGRAM_ID));
        assert_eq!(h.manager.get_game_pda(&[1; 16]).unwrap_err().to_string(), "Game random hash must be 32 bytes");
        assert_eq!(decode_random_hash(&hex::encode(hash)).unwrap(), hash);
        assert!(decode_random_hash("zz").is_err());
        assert!(decode_random_hash("abcd").is_err());

        assert_eq!(h.manager.resolve_stored_game("unknown").unwrap(), None);
        let (address, pda, random_hash) = store_game(&h, hash);
        let stored = h.manager.resolve_stored_game(&address).unwrap().unwrap();
        assert_eq!(stored, context(pda, random_hash, None));
        h.db.save_secret_key("corrupt", "00", "abcd").unwrap();
        assert!(h.manager.resolve_stored_game("corrupt").is_err());
    }

    #[test]
    fn block_time_cache_round_trips() {
        let cache = BlockTimeCache::default();
        assert_eq!(cache.get(), None);
        cache.set(5);
        assert_eq!(cache.get(), Some(5));
        cache.clear();
        assert_eq!(cache.get(), None);
    }

    #[tokio::test]
    async fn evaluates_readiness_from_chain() {
        let h = harness(None);
        let (address, pda, _) = store_game(&h, [0x22; 32]);
        serve_game(&h, Some(game_account(3, 5, 2, 1_000, 60)));

        let readiness = h.manager.evaluate_game_readiness(&pda, Some(1_060)).await.unwrap();
        assert!(readiness.ready);
        assert_eq!(readiness.evaluated_at, Some(1_060));
        assert_eq!(readiness.game_account.as_ref().unwrap().total_amount, 12_345);

        // Without a block time the blockchain time is fetched.
        let readiness = h.manager.evaluate_game_readiness(&pda, None).await.unwrap();
        assert_eq!(readiness.evaluated_at, Some(BLOCK_TIME));
        assert_eq!(h.transport.calls_for("getSlot").len(), 1);
        assert_eq!(h.transport.calls_for("getBlockTime")[0].1, json!([100]));

        // Ready evaluations are cached for the scan; consuming removes them.
        assert!(h.manager.is_game_ready_for_completion(&pda).await.unwrap());
        assert!(h.cache.lock().unwrap().contains_key(&address));
        assert!(h.manager.consume_readiness(&address).is_some());
        assert!(h.manager.consume_readiness(&address).is_none());
    }

    #[tokio::test]
    async fn not_ready_evaluations_clear_the_cache() {
        let h = harness(None);
        let (address, pda, _) = store_game(&h, [0x23; 32]);
        serve_game(&h, Some(game_account(1, 5, 2, BLOCK_TIME as u64, 600)));
        h.cache
            .lock()
            .unwrap()
            .insert(address.clone(), Readiness { ready: true, game_account: None, evaluated_at: None });
        assert!(!h.manager.is_game_ready_for_completion(&pda).await.unwrap());
        assert!(!h.cache.lock().unwrap().contains_key(&address));
    }

    #[tokio::test]
    async fn missing_accounts_are_not_ready_and_other_errors_propagate() {
        let h = harness(None);
        let pda = Address([5; 32]);
        h.transport.push("getAccountInfo", Ok(json!({"value": null})));
        assert_eq!(h.manager.fetch_game_account(&pda).await.unwrap(), None);
        h.transport.push("getAccountInfo", Ok(json!({"value": null})));
        let readiness = h.manager.evaluate_game_readiness(&pda, None).await.unwrap();
        assert_eq!(readiness, Readiness { ready: false, game_account: None, evaluated_at: None });

        h.transport.push("getAccountInfo", Err(RpcError::json_rpc(-32602, "Invalid params")));
        let err = h.manager.fetch_game_account(&pda).await.unwrap_err();
        assert_eq!(err.to_string(), "JSON-RPC error -32602: Invalid params");

        h.transport.push(
            "getAccountInfo",
            Ok(json!({"value": {"data": ["AAAA", "base64"], "owner": PROGRAM_ID.to_base58()}})),
        );
        let err = h.manager.fetch_game_account(&pda).await.unwrap_err();
        assert_eq!(err.to_string(), "Account is not a Timba game");
    }

    #[tokio::test]
    async fn full_games_skip_the_chain_clock() {
        let h = harness(None);
        let pda = Address([7; 32]);
        let before = timba_common::time::now_secs();
        serve_game(&h, Some(game_account(2, 2, 1, 0, u64::MAX / 2)));
        let readiness = h.manager.evaluate_game_readiness(&pda, None).await.unwrap();
        assert!(readiness.ready);
        assert!(readiness.evaluated_at.unwrap() >= before);
        assert!(h.transport.calls_for("getSlot").is_empty());
        assert!(h.transport.calls_for("getBlockTime").is_empty());

        // Short of full, readiness depends on the chain clock.
        let h = harness(None);
        serve_game(&h, Some(game_account(1, 2, 1, 0, 60)));
        let readiness = h.manager.evaluate_game_readiness(&pda, None).await.unwrap();
        assert_eq!(readiness.evaluated_at, Some(BLOCK_TIME));
        assert_eq!(h.transport.calls_for("getBlockTime").len(), 1);
    }

    #[tokio::test]
    async fn readiness_checks_keep_expiry_timers_in_step() {
        let mut h = harness(None);
        let expiry = ExpiryTimers::new();
        h.manager.expiry = Some(expiry.clone());
        let pda = Address([7; 32]);
        let address = pda.to_base58();
        let expires_at = BLOCK_TIME + 60;
        h.transport.push("getAccountInfo", Ok(account_value(&game_account(1, 3, 1, BLOCK_TIME as u64, 60))));
        assert!(!h.manager.is_game_ready_for_completion(&pda).await.unwrap());
        assert_eq!(expiry.scheduled(&address), Some(expires_at));

        // Ready (full) or gone: nothing left to wake up for.
        h.transport.push("getAccountInfo", Ok(account_value(&game_account(3, 3, 1, BLOCK_TIME as u64, 60))));
        assert!(h.manager.is_game_ready_for_completion(&pda).await.unwrap());
        assert_eq!(expiry.scheduled(&address), None);
        expiry.schedule(&address, pda, expires_at);
        h.transport.push("getAccountInfo", Ok(json!({"value": null})));
        assert!(!h.manager.is_game_ready_for_completion(&pda).await.unwrap());
        assert_eq!(expiry.scheduled(&address), None);
    }

    #[tokio::test]
    async fn blockchain_time_falls_back_to_the_local_clock() {
        let h = harness(None);
        h.transport.push("getSlot", Err(RpcError::json_rpc(-32000, "slot unavailable")));
        let before = timba_common::time::now_secs();
        assert!(h.manager.get_blockchain_time().await >= before);
        h.transport.push("getBlockTime", Ok(Value::Null));
        assert!(h.manager.get_blockchain_time().await >= before);
        assert_eq!(h.manager.get_blockchain_time().await, BLOCK_TIME);
    }

    #[tokio::test]
    async fn resolves_context_and_readiness() {
        let h = harness(None);
        // No stored context.
        let resolution = h.manager.resolve_context_and_readiness("missing", ResolveOptions::default()).await.unwrap();
        assert_eq!(resolution, ReadinessResolution::MissingContext);
        let resolution = h
            .manager
            .resolve_context_and_readiness("missing", ResolveOptions { require_on_chain: true, ..Default::default() })
            .await
            .unwrap();
        assert_eq!(resolution, ReadinessResolution::MissingContext);

        let (address, pda, random_hash) = store_game(&h, [0x24; 32]);
        // A provided snapshot is trusted without RPC when on-chain data is optional.
        let provided = Readiness { ready: true, game_account: None, evaluated_at: Some(1) };
        let resolution = h
            .manager
            .resolve_context_and_readiness(
                &address,
                ResolveOptions { readiness: Some(provided.clone()), ..Default::default() },
            )
            .await
            .unwrap();
        let ReadinessResolution::Resolved { ready, context: ctx, readiness, prefetch_scheduled } = resolution else {
            panic!("expected resolved");
        };
        assert!(!ready, "ready requires the game account");
        assert_eq!(readiness, provided);
        assert_eq!(ctx.readiness, Some(provided.clone()));
        assert!(!prefetch_scheduled);
        assert!(h.transport.calls.lock().unwrap().is_empty());

        // Cached readiness is consumed when on-chain data is optional.
        let game = game_account(2, 2, 2, 0, 60);
        let cached = Readiness { ready: true, game_account: Some(game.clone()), evaluated_at: Some(7) };
        h.cache.lock().unwrap().insert(address.clone(), cached.clone());
        let resolution = h
            .manager
            .resolve_context_and_readiness(
                &address,
                ResolveOptions { context: Some(context(pda, random_hash, None)), ..Default::default() },
            )
            .await
            .unwrap();
        assert!(
            matches!(resolution, ReadinessResolution::Resolved { ready: true, ref readiness, .. } if *readiness == cached)
        );
        assert!(h.cache.lock().unwrap().is_empty());

        // The shared block time is fetched once and reused.
        serve_game(&h, Some(game));
        let block_time = BlockTimeCache::default();
        for _ in 0..2 {
            let resolution = h
                .manager
                .resolve_context_and_readiness(
                    &address,
                    ResolveOptions {
                        block_time_cache: Some(&block_time),
                        require_on_chain: true,
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
            assert!(matches!(resolution, ReadinessResolution::Resolved { ready: true, prefetch_scheduled: true, .. }));
        }
        assert_eq!(block_time.get(), Some(BLOCK_TIME));
        assert_eq!(h.transport.calls_for("getSlot").len(), 1);

        // An explicit block time skips the clock entirely.
        let resolution = h
            .manager
            .resolve_context_and_readiness(
                &address,
                ResolveOptions { block_time: Some(5), require_on_chain: true, ..Default::default() },
            )
            .await
            .unwrap();
        let ReadinessResolution::Resolved { readiness, .. } = resolution else { panic!("expected resolved") };
        assert_eq!(readiness.evaluated_at, Some(5));
        assert_eq!(h.transport.calls_for("getSlot").len(), 1);
    }

    #[tokio::test]
    async fn games_gone_from_chain_resolve_without_context() {
        let h = harness(None);
        let (address, _, _) = store_game(&h, [0x25; 32]);
        serve_game(&h, None);
        let resolution = h
            .manager
            .resolve_context_and_readiness(&address, ResolveOptions { require_on_chain: true, ..Default::default() })
            .await
            .unwrap();
        assert_eq!(resolution, ReadinessResolution::MissingContext);
        // Without the on-chain requirement the stale evaluation is returned.
        let resolution = h.manager.resolve_context_and_readiness(&address, ResolveOptions::default()).await.unwrap();
        assert!(matches!(resolution, ReadinessResolution::Resolved { ready: false, prefetch_scheduled: false, .. }));
    }

    #[tokio::test]
    async fn completes_games_and_reports_the_total_pot() {
        let h = harness(None);
        let (address, _, _) = store_game(&h, [0x26; 32]);
        let game = game_account(2, 2, 2, 0, 60);
        let roster = players(2);
        h.db.replace_game_players(&address, &roster).unwrap();
        serve_game(&h, Some(game.clone()));
        serve_submission(&h);

        let result = h.manager.complete_game(&address, None, None).await;
        let index = h.manager.calculate_winner_index(&SECRET, game.last_slot, 2).unwrap() as usize;
        assert_eq!(
            result,
            CompletionResult {
                success: true,
                tx_hash: Some("landed-sig".into()),
                winner_address: Some(roster[index].clone()),
                total_pot: Some(12_345),
                ..Default::default()
            }
        );
        // The signed completion carries the revealed secret.
        let sent = &h.transport.calls_for("sendTransaction")[0].1;
        let wire = base64::engine::general_purpose::STANDARD.decode(sent[0].as_str().unwrap()).unwrap();
        assert!(wire.windows(32).any(|w| w == SECRET));
        assert_eq!(h.db.get_game_status(&address).as_deref(), Some("completed"));
        assert_eq!(h.db.get_secret_key(&address), None, "secret is marked used");
        assert!(h.db.get_game_players(&address).is_empty());
        assert!(h.cache.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn missing_secret_is_a_permanent_failure() {
        let h = harness(None);
        h.db.track_game("no-secret", None, false).unwrap();
        let result = h.manager.complete_game("no-secret", None, None).await;
        assert_eq!(result, CompletionResult::failure(NO_SECRET_KEY_MESSAGE));
        let state = h.db.get_completion_attempt_state("no-secret").unwrap();
        assert_eq!(state.completion_attempts, 1);
        assert_eq!(state.completion_failure_kind, Some(CompletionFailureKind::Permanent));
    }

    #[tokio::test]
    async fn failures_are_returned_even_when_the_database_rejects_them() {
        let h = harness(None);
        h.db.track_game("no-secret", None, false).unwrap();
        fail_updates(
            h._dir.path(),
            "no_failures",
            "game_tracking",
            "NEW.completion_attempts <> OLD.completion_attempts",
        );
        let result = h.manager.complete_game("no-secret", None, None).await;
        assert_eq!(result, CompletionResult::failure(NO_SECRET_KEY_MESSAGE));
        assert_eq!(h.db.get_completion_attempt_state("no-secret").unwrap().completion_attempts, 0);
    }

    #[tokio::test]
    async fn a_landed_completion_succeeds_even_if_the_database_cannot_record_it() {
        let h = harness(None);
        let (address, _, _) = store_game(&h, [0x32; 32]);
        h.db.replace_game_players(&address, &players(1)).unwrap();
        serve_game(&h, Some(game_account(1, 1, 1, 0, 60)));
        serve_submission(&h);
        fail_updates(h._dir.path(), "no_completion", "game_tracking", "NEW.status = 'completed'");
        let result = h.manager.complete_game(&address, None, None).await;
        assert!(result.success, "{result:?}");
        assert_eq!(result.tx_hash.as_deref(), Some("landed-sig"));
        // The failed finalization rolled back as a whole, so the game stays pending.
        assert_eq!(h.db.get_game_status(&address).as_deref(), Some("pending"));
    }

    #[tokio::test]
    async fn not_ready_games_are_not_recorded() {
        let h = harness(None);
        let (address, _, _) = store_game(&h, [0x27; 32]);
        serve_game(&h, Some(game_account(1, 5, 2, BLOCK_TIME as u64, 600)));
        assert_eq!(h.manager.complete_game(&address, None, None).await, CompletionResult::not_ready());
        assert_eq!(h.db.get_completion_attempt_state(&address).unwrap().completion_attempts, 0);
    }

    #[tokio::test]
    async fn provided_readiness_without_account_consults_the_chain() {
        let h = harness(None);
        let (address, pda, random_hash) = store_game(&h, [0x28; 32]);
        let readiness = Readiness { ready: true, game_account: None, evaluated_at: Some(1) };
        h.cache.lock().unwrap().insert(address.clone(), readiness.clone());
        // The provided snapshot lacks the account, so the chain is consulted
        // and the game no longer exists there.
        serve_game(&h, None);
        let result = h.manager.complete_game(&address, Some(readiness), Some(context(pda, random_hash, None))).await;
        assert_eq!(result, CompletionResult::failure(NO_SECRET_KEY_MESSAGE));
        assert!(h.cache.lock().unwrap().is_empty(), "fatal failures clear cached readiness");
    }

    #[tokio::test]
    async fn registry_desync_marks_the_game() {
        let h = harness(None);
        let (address, _, _) = store_game(&h, [0x29; 32]);
        h.db.replace_game_players(&address, &players(1)).unwrap();
        serve_game(&h, Some(game_account(2, 2, 2, 0, 60)));
        let result = h.manager.complete_game(&address, None, None).await;
        assert_eq!(result, CompletionResult::failure("Ticket registry out of sync"));
        assert_eq!(h.db.get_game_status(&address).as_deref(), Some("desynced"));
    }

    #[tokio::test]
    async fn recovers_partial_registries_before_drawing() {
        let calls = Arc::new(AtomicUsize::new(0));
        let roster = players(2);
        let recovered = roster.clone();
        let h = harness(Some(recover_with(calls.clone(), move |_| Ok(Some(recovered.clone())))));
        let (address, _, _) = store_game(&h, [0x2a; 32]);
        h.db.replace_game_players(&address, &roster[..1]).unwrap();
        serve_game(&h, Some(game_account(2, 2, 2, 0, 60)));
        serve_submission(&h);
        let result = h.manager.complete_game(&address, None, None).await;
        assert!(result.success, "{result:?}");
        assert!(roster.contains(result.winner_address.as_ref().unwrap()));
        assert!(calls.load(Ordering::SeqCst) >= 1);
        assert_eq!(h.db.get_game_status(&address).as_deref(), Some("completed"));
    }

    #[tokio::test]
    async fn invalid_winners_are_permanent_failures() {
        let h = harness(None);
        let (address, _, _) = store_game(&h, [0x2b; 32]);
        serve_game(&h, Some(game_account(1, 1, 1, 0, 60)));
        h.db.replace_game_players(&address, &["not-an-address".to_string()]).unwrap();
        let result = h.manager.complete_game(&address, None, None).await;
        assert_eq!(result, CompletionResult::failure("Winner address is invalid"));

        // Program-derived (off-curve) winners cannot own a token account.
        let (address, pda, _) = store_game(&h, [0x2c; 32]);
        h.db.replace_game_players(&address, &[pda.to_base58()]).unwrap();
        let result = h.manager.complete_game(&address, None, None).await;
        assert_eq!(result, CompletionResult::failure("Token owner must be on the ed25519 curve"));
        let state = h.db.get_completion_attempt_state(&address).unwrap();
        assert_eq!(state.completion_failure_kind, Some(CompletionFailureKind::Permanent));
    }

    #[tokio::test]
    async fn corrupt_secrets_are_permanent_failures_without_a_transaction() {
        let h = harness(None);
        for (seed, stored) in [(0x2d, "zz".repeat(32)), (0x2e, "ab".repeat(31)), (0x2f, "ab".repeat(33))] {
            let (address, _, random_hash) = store_game(&h, [seed; 32]);
            h.db.delete_secret_key(&address).unwrap();
            h.db.save_secret_key(&address, &stored, &hex::encode(random_hash)).unwrap();
            serve_game(&h, Some(game_account(1, 1, 1, 0, 60)));
            let result = h.manager.complete_game(&address, None, None).await;
            assert_eq!(result, CompletionResult::failure("Stored secret key is corrupt"), "{stored}");
            let state = h.db.get_completion_attempt_state(&address).unwrap();
            assert_eq!(state.completion_failure_kind, Some(CompletionFailureKind::Permanent));
        }
        assert!(h.transport.calls_for("sendTransaction").is_empty());
    }

    #[tokio::test]
    async fn submission_failures_are_classified_as_transient() {
        let h = harness(None);
        let (address, _, _) = store_game(&h, [0x2d; 32]);
        h.db.replace_game_players(&address, &players(1)).unwrap();
        serve_game(&h, Some(game_account(1, 1, 1, 0, 60)));
        h.transport.on(|_, method, _| {
            (method == "getLatestBlockhash").then(|| Err(RpcError::transport("RPC request failed: connection reset")))
        });
        let result = h.manager.complete_game(&address, None, None).await;
        assert_eq!(result.error.as_deref(), Some("RPC request failed: connection reset"));
        let state = h.db.get_completion_attempt_state(&address).unwrap();
        assert_eq!(state.completion_attempts, 0);
        assert_eq!(state.completion_failure_kind, Some(CompletionFailureKind::Transient));
    }

    #[tokio::test]
    async fn expired_confirmation_returns_the_landed_signature() {
        let h = harness(None);
        h.transport.on(|_, method, _| match method {
            "getLatestBlockhash" => Some(Ok(json!({"value": {"blockhash": BLOCKHASH, "lastValidBlockHeight": 10}}))),
            "sendTransaction" => Some(Ok(json!("landed-sig"))),
            "getBlockHeight" => Some(Ok(json!(11))),
            _ => None,
        });
        // Not visible during confirmation, then confirmed when re-checked.
        h.transport.push("getSignatureStatuses", Ok(json!({"value": [null]})));
        h.transport.push(
            "getSignatureStatuses",
            Ok(json!({"value": [{"slot": 1, "confirmationStatus": "confirmed", "err": null}]})),
        );
        let game = game_account(1, 1, 1, 0, 60);
        let winner = Keypair::generate().address();
        let signature = h.manager.execute_game_completion(&game, &winner, &[0; 32], &[0; 32], 0).await.unwrap();
        assert_eq!(signature, "landed-sig");
        assert_eq!(h.transport.calls_for("sendTransaction").len(), 1);
    }

    /// The `SetComputeUnitPrice` value in each sent completion, in order.
    fn sent_priority_fees(h: &Harness) -> Vec<u64> {
        h.transport
            .calls_for("sendTransaction")
            .iter()
            .filter(|(_, params)| params[1]["skipPreflight"] == false)
            .map(|(_, params)| {
                let wire = base64::engine::general_purpose::STANDARD.decode(params[0].as_str().unwrap()).unwrap();
                // Each compiled instruction is a program index, account count, data length and data.
                let limit = [&[0u8, 5, 2][..], &COMPLETION_COMPUTE_UNIT_LIMIT.to_le_bytes()].concat();
                let at =
                    wire.windows(7).position(|w| w == &limit[..]).expect("the first instruction sets the limit") + 7;
                assert_eq!(wire[at + 1..at + 4], [0, 9, 3], "the second sets the price");
                u64::from_le_bytes(wire[at + 4..at + 12].try_into().unwrap())
            })
            .collect()
    }

    #[tokio::test]
    async fn completions_bid_the_estimated_priority_fee_and_raise_it_on_retry() {
        // Regression: completions went out without a priority fee and about half were dropped.
        let h = harness(None);
        h.transport.on(|_, method, _| match method {
            "getPriorityFeeEstimate" => Some(Ok(json!({"priorityFeeEstimate": 24_380.2}))),
            "getLatestBlockhash" => Some(Ok(json!({"value": {"blockhash": BLOCKHASH, "lastValidBlockHeight": 10}}))),
            "sendTransaction" => Some(Ok(json!("landed-sig"))),
            _ => None,
        });
        // The first transaction expires unseen; the retry lands.
        h.transport.push("getBlockHeight", Ok(json!(11)));
        h.transport.on(|_, method, _| (method == "getBlockHeight").then(|| Ok(json!(1))));
        h.transport.push("getSignatureStatuses", Ok(json!({"value": [null]})));
        h.transport.push("getSignatureStatuses", Ok(json!({"value": [null]})));
        h.transport.on(|_, method, _| {
            (method == "getSignatureStatuses")
                .then(|| Ok(json!({"value": [{"slot": 1, "confirmationStatus": "confirmed", "err": null}]})))
        });
        let game = game_account(1, 1, 1, 0, 60);
        let winner = Keypair::generate().address();
        let signature = h.manager.execute_game_completion(&game, &winner, &[0; 32], &[0; 32], 0).await.unwrap();
        assert_eq!(signature, "landed-sig");
        assert_eq!(sent_priority_fees(&h), vec![24_381, 97_524]);
        let estimate = &h.transport.calls_for("getPriorityFeeEstimate")[0].1;
        let game_pda = find_game_pda(&[0; 32], &PROGRAM_ID).to_base58();
        assert!(estimate[0]["accountKeys"].as_array().unwrap().contains(&json!(game_pda)));
    }

    #[tokio::test]
    async fn priority_fees_stay_within_bounds() {
        for (estimate, expected) in [
            (Some(json!({"priorityFeeEstimate": 3.0})), MIN_PRIORITY_FEE),
            (Some(json!({"priorityFeeEstimate": 1e12})), MAX_PRIORITY_FEE),
            (None, MIN_PRIORITY_FEE),
        ] {
            let h = harness(None);
            if let Some(estimate) = estimate {
                h.transport.push("getPriorityFeeEstimate", Ok(estimate));
            }
            serve_submission(&h);
            let game = game_account(1, 1, 1, 0, 60);
            let winner = Keypair::generate().address();
            h.manager.execute_game_completion(&game, &winner, &[0; 32], &[0; 32], 0).await.unwrap();
            assert_eq!(sent_priority_fees(&h), vec![expected]);
        }
    }

    #[test]
    fn compute_budget_instructions_match_the_program_layout() {
        let [limit, price] = compute_budget_instructions(100_000, 24_381);
        assert_eq!(limit.program_id, COMPUTE_BUDGET_PROGRAM_ID);
        assert_eq!(limit.data, [2, 0xa0, 0x86, 0x01, 0x00]);
        assert_eq!(price.data, [3, 0x3d, 0x5f, 0, 0, 0, 0, 0, 0]);
        assert!(limit.accounts.is_empty() && price.accounts.is_empty());
    }

    #[test]
    fn builds_completion_instructions() {
        let h = harness(None);
        let game = game_account(1, 1, 1, 0, 60);
        let winner = Keypair::generate().address();
        let ix = h.manager.build_completion_instruction(&game, &winner, &[3; 32], &[4; 32], 7).unwrap();
        assert_eq!(ix.program_id, PROGRAM_ID);
        assert_eq!(ix.accounts[0].address, find_game_pda(&[3; 32], &PROGRAM_ID));
        assert_eq!(&ix.data[ix.data.len() - 4..], &7u32.to_le_bytes());
        let off_curve = find_game_pda(&[3; 32], &PROGRAM_ID);
        assert!(h.manager.build_completion_instruction(&game, &off_curve, &[3; 32], &[4; 32], 0).is_err());
    }

    #[tokio::test]
    async fn attempts_skip_invalid_addresses_and_missing_context() {
        let h = harness(None);
        assert_eq!(h.manager.attempt_game_completion(AttemptOptions::new("not-a-public-key")).await.unwrap(), None);
        assert!(h.transport.calls.lock().unwrap().is_empty());
        let unknown = Address([9; 32]).to_base58();
        assert_eq!(h.manager.attempt_game_completion(AttemptOptions::new(&unknown)).await.unwrap(), None);
        assert!(h.metrics.completion_records().is_empty());
    }

    #[tokio::test]
    async fn attempts_record_not_ready_outcomes() {
        let h = harness(None);
        let (address, _, _) = store_game(&h, [0x2e; 32]);
        serve_game(&h, Some(game_account(1, 5, 2, BLOCK_TIME as u64, 600)));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let mut options = AttemptOptions::new(&address);
        options.on_result = Some(Arc::new(move |result: &CompletionResult| sink.lock().unwrap().push(result.clone())));
        let result = h.manager.attempt_game_completion(options).await.unwrap();
        assert_eq!(result, Some(CompletionResult::not_ready()));
        assert_eq!(*seen.lock().unwrap(), vec![CompletionResult::not_ready()]);
        assert_eq!(
            h.metrics.completion_records(),
            vec![CompletionRecord { game_address: address, outcome: CompletionOutcome::NotReady, error: None }]
        );
    }

    #[tokio::test]
    async fn attempts_without_log_hooks_still_record_failures() {
        let h = harness(None);
        let (address, _, _) = store_game(&h, [0x33; 32]);
        h.db.replace_game_players(&address, &["bad".to_string()]).unwrap();
        serve_game(&h, Some(game_account(1, 1, 1, 0, 60)));
        let result = h.manager.attempt_game_completion(AttemptOptions::new(&address)).await.unwrap();
        assert_eq!(result, Some(CompletionResult::failure("Winner address is invalid")));
        assert_eq!(
            h.metrics.completion_records(),
            vec![CompletionRecord {
                game_address: address,
                outcome: CompletionOutcome::Error,
                error: Some("Winner address is invalid".into())
            }]
        );
    }

    #[tokio::test]
    async fn attempts_log_success_and_failure_once() {
        let h = harness(None);
        let logged = Arc::new(Mutex::new(Vec::new()));
        let with_logs = |address: &str| {
            let (success, failure) = (logged.clone(), logged.clone());
            AttemptOptions::new(address).logs(
                move |address| {
                    success.lock().unwrap().push(format!("success:{address}"));
                    format!("success:{address}")
                },
                move |address, error| {
                    failure.lock().unwrap().push(format!("failure:{address}:{}", error.unwrap_or("")));
                    String::new()
                },
            )
        };

        let (success_game, _, _) = store_game(&h, [0x30; 32]);
        h.db.replace_game_players(&success_game, &players(1)).unwrap();
        serve_game(&h, Some(game_account(1, 1, 1, 0, 60)));
        serve_submission(&h);
        let success = h.manager.attempt_game_completion(with_logs(&success_game)).await.unwrap().unwrap();
        assert!(success.success);

        let (failure_game, _, _) = store_game(&h, [0x31; 32]);
        h.db.replace_game_players(&failure_game, &["bad".to_string()]).unwrap();
        let failure = h.manager.attempt_game_completion(with_logs(&failure_game)).await.unwrap().unwrap();
        assert_eq!(failure, CompletionResult::failure("Winner address is invalid"));

        assert_eq!(
            *logged.lock().unwrap(),
            vec![format!("success:{success_game}"), format!("failure:{failure_game}:Winner address is invalid")]
        );
        let outcomes: Vec<_> = h.metrics.completion_records().into_iter().map(|r| (r.outcome, r.error)).collect();
        assert_eq!(
            outcomes,
            vec![
                (CompletionOutcome::Success, None),
                (CompletionOutcome::Error, Some("Winner address is invalid".to_string()))
            ]
        );
    }

    #[tokio::test]
    async fn prevents_concurrent_completions_for_the_same_game() {
        let h = harness(None);
        let (address, pda, random_hash) = store_game(&h, [0x32; 32]);
        h.db.replace_game_players(&address, &players(1)).unwrap();
        let game = game_account(1, 1, 1, 0, 60);
        serve_game(&h, Some(game.clone()));
        serve_submission(&h);
        let readiness = Readiness { ready: true, game_account: Some(game), evaluated_at: Some(1) };
        let options = AttemptOptions {
            context: Some(context(pda, random_hash, None)),
            readiness: Some(readiness),
            skip_readiness_check: true,
            ..AttemptOptions::new(&address)
        };

        // An attempt already in flight blocks the second caller.
        h.manager.in_flight.lock().unwrap().insert(address.clone());
        assert_eq!(h.manager.attempt_game_completion(options.clone()).await.unwrap(), None);
        assert!(h.transport.calls_for("sendTransaction").is_empty());

        // The guard is released after an attempt finishes.
        h.manager.in_flight.lock().unwrap().clear();
        let result = h.manager.attempt_game_completion(options).await.unwrap().unwrap();
        assert!(result.success);
        assert!(h.manager.in_flight.lock().unwrap().is_empty());
        assert_eq!(h.transport.calls_for("sendTransaction").len(), 1);
        h.manager.reset_registry_prefetch_schedule(&address);
    }
}
