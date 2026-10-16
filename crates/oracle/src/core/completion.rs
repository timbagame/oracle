//! Game readiness evaluation and completion (port of
//! `oracle-completion-manager.ts`, `game-completion-transaction-builder.ts`
//! and `oracle-accounts.ts`).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use regex::Regex;
use timba_common::{error, info, warn};
use timba_protocol::contracts::{complete_game_instruction, find_game_pda, CompleteGameInput, GameAccount};
use timba_protocol::randomness::calculate_winner;
use timba_protocol::{Address, ContractVersion, Instruction};

use super::registry::RegistrySyncManager;
use super::types::{AttemptOptions, CompletionResult, GameContext, Readiness, ReadinessResolution};
use crate::db::{CompletionFailureKind, OracleDatabase};
use crate::metrics::{CompletionOutcome, CompletionRecord, OracleMetrics};
use crate::program_client::{is_account_missing_error, ProgramClient};
use crate::solana::confirm::submit_transaction;
use crate::solana::tx::sign_legacy_transaction;
use crate::solana::{Keypair, RpcPool};

pub const SECRET_KEY_LENGTH: usize = 32;
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
        let (context, readiness) = match state {
            ReadinessResolution::MissingContext => {
                return Ok(self.record_fatal(game_address, NO_SECRET_KEY_MESSAGE));
            }
            ReadinessResolution::Resolved { ready: false, .. } => return Ok(CompletionResult::not_ready()),
            ReadinessResolution::Resolved { context, readiness, .. } => (context, readiness),
        };
        if readiness.game_account.is_none() {
            return Ok(self.record_fatal(game_address, "On-chain game account unavailable"));
        }

        let details = match self.resolve_winner_details(game_address, &readiness, &context).await? {
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
        readiness: &Readiness,
        context: &GameContext,
    ) -> anyhow::Result<Result<WinnerDetails, CompletionResult>> {
        let Some(game) = readiness.game_account.clone() else {
            return Ok(Err(self.record_fatal(game_address, "On-chain game account unavailable")));
        };
        let expected = i64::from(game.tickets_count);
        let players = match self.registry.ensure_players_in_sync(game_address, context, expected).await {
            Ok(players) => players,
            Err(message) => return Ok(Err(self.record_fatal(game_address, message))),
        };
        let secret = hex::decode(&context.secret.secret_key).unwrap_or_default();
        let winner_index = self.calculate_winner_index(&secret, game.last_slot, players.len() as u64)?;
        let Some(winner) = players.get(winner_index as usize) else {
            return Ok(Err(self.record_fatal(game_address, "Unable to determine winner")));
        };
        let Ok(winner) = Address::parse(winner) else {
            return Ok(Err(self.record_fatal(game_address, "Winner address is invalid")));
        };
        let mut secret_key = [0u8; 32];
        let len = secret.len().min(32);
        secret_key[..len].copy_from_slice(&secret[..len]);
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
        let evaluated_at = match block_time {
            Some(time) => time,
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
        let operator = self.operator.clone();
        submit_transaction(
            &self.rpc,
            move |latest| {
                Ok(sign_legacy_transaction(&operator, &[], &latest.blockhash, std::slice::from_ref(&instruction))?.1)
            },
            None,
        )
        .await
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
