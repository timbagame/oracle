//! The oracle service: wires completion, events, scanning and token policy
//! together and owns the automatic-completion retry state machine (port of
//! `oracle-service.ts`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures::future::{BoxFuture, FutureExt};
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};
use timba_common::{error, info, warn};
use timba_protocol::Address;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::completion::{
    is_transient_completion_failure, BlockTimeCache, CompletionManager, CompletionManagerOptions, ReadinessCache,
};
use super::events::{
    EventHooks, EventProcessor, EventProcessorOptions, ProgramEventObserver, RegistrySyncRequest, ALL_EVENTS,
};
use super::registry::{PlayerRegistrySync, RecoverPlayerRegistry, RecoverRequest, RegistrySyncManager};
use super::scan::{ScanCompletion, ScanLoopOptions, ScanLoopRunner, ScanLoopRunnerOptions, ScanLoopSummary};
use super::signer::{
    sign_game_transaction_with_policy, CreationPolicyError, SignError, SignGameTransactionOptions, SigningHooks,
};
use super::types::{AttemptOptions, CompletionResult, GameContext, LogFn, Readiness, ReadinessResolution};
use crate::config::OracleConfig;
use crate::db::{
    CleanupCounts, CompletionFailureKind, DatabaseStats, OracleDatabase, ResetFailure, ToggleFailure,
    COMPLETION_RECOVERY_COOLDOWN_MS,
};
use crate::metrics::{CleanupRecord, OracleMetrics};
use crate::program_client::{EventName, ProgramClient};
use crate::solana::keypair::load_operator_keypair;
use crate::solana::{Keypair, RpcPool};
use crate::token::onboarding::prepare_game_token;
use crate::token::policy::{
    compute_minimum_amount_raw, normalize_mint, to_api_token_policy, RejectionCode, StoredTokenPolicy, TokenPolicy,
};
use crate::token::price::{JupiterTokenPriceResolver, TokenPriceResolver};
use crate::types::{GameSecrets, WebGameOracle};

pub const SECRET_KEY_LENGTH: usize = 32;
pub const MAX_COMPLETION_ATTEMPTS: i64 = 5;
const COMPLETION_RETRY_DELAYS_MS: [u64; 3] = [5_000, 15_000, 30_000];
const READINESS_RETRY_DELAYS_MS: [u64; 3] = [1_000, 3_000, 10_000];
pub const EVENT_LISTENER_FAILURE_MESSAGE: &str = "❌ Failed to start event listeners:";
const MAX_TRANSACTION_PAYLOAD_LENGTH: usize = 4_000;
const BOT_COMPLETED_PATH: &str = "/internal/completed";

/// A client-supplied transaction failed the signing policy
/// (`GameTransactionValidationError` / `CreationPolicyValidationError`).
#[derive(Debug, thiserror::Error)]
pub enum GameTransactionError {
    #[error("{0}")]
    Validation(String),
    #[error("{}", .0.message)]
    CreationPolicy(CreationPolicyError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RequeueFailure {
    InvalidAddress,
    MissingSecret,
    NotFound,
    Finalized,
    Unchanged,
}

impl RequeueFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidAddress => "invalid-address",
            Self::MissingSecret => "missing-secret",
            Self::NotFound => "not-found",
            Self::Finalized => "finalized",
            Self::Unchanged => "unchanged",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStats {
    #[serde(flatten)]
    pub db: DatabaseStats,
    pub event_listening: bool,
    pub active_listeners: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RetryMode {
    Transient,
    Readiness,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RetryPhase {
    Active,
    Cooldown,
}

struct CompletionRetry {
    phase: RetryPhase,
    mode: RetryMode,
    transient_attempt: usize,
    readiness_attempt: usize,
    /// Timer token plus handle; the token identifies the timer that owns the
    /// entry (the TS `current.timer !== timer` check).
    timer: Option<(u64, JoinHandle<()>)>,
    game_key: Option<Address>,
    trigger: String,
    next_eligible_at: Option<i64>,
}

enum Admission {
    Allowed,
    Cooldown(Option<i64>),
    Denied,
}

/// Aborts a timer unless it is the task currently running.
fn cancel_timer(timer: Option<(u64, JoinHandle<()>)>) {
    if let Some((_, handle)) = timer {
        if tokio::task::try_id() != Some(handle.id()) {
            handle.abort();
        }
    }
}

fn is_fallback_scan_trigger(trigger: &str) -> bool {
    trigger == "fallback scan" || trigger.starts_with("fallback scan retry")
}

fn iso_time(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

fn format_cooldown_message(next_eligible_at: Option<i64>) -> String {
    match next_eligible_at {
        Some(at) => format!("Automatic completion is temporarily paused until {}", iso_time(at)),
        None => "Automatic completion is temporarily paused".into(),
    }
}

fn log_fn(f: impl Fn(&str, Option<&str>) -> String + Send + Sync + 'static) -> Option<LogFn> {
    Some(Arc::new(f))
}

fn log_db_error<T>(result: anyhow::Result<T>, context: &str) {
    if let Err(err) = result {
        error!("{context}: {err:#}");
    }
}

pub struct OracleServiceOptions {
    pub config: OracleConfig,
    pub db: Arc<OracleDatabase>,
    pub metrics: Arc<OracleMetrics>,
    pub rpc: Arc<RpcPool>,
    pub operator: Keypair,
    pub price_resolver: Arc<dyn TokenPriceResolver>,
}

pub struct OracleService {
    config: OracleConfig,
    db: Arc<OracleDatabase>,
    metrics: Arc<OracleMetrics>,
    rpc: Arc<RpcPool>,
    operator: Arc<Keypair>,
    program: Arc<ProgramClient>,
    completion: Arc<CompletionManager>,
    events: Arc<EventProcessor>,
    scanner: Arc<ScanLoopRunner>,
    registry_sync: Arc<PlayerRegistrySync>,
    prices: Arc<dyn TokenPriceResolver>,
    http: reqwest::Client,
    readiness_cache: ReadinessCache,
    retries: Mutex<HashMap<String, CompletionRetry>>,
    next_timer: AtomicU64,
    active_runs: watch::Sender<usize>,
    closing: AtomicBool,
    failover_task: Mutex<Option<JoinHandle<()>>>,
    weak_self: Weak<OracleService>,
}

/// Decrements the active automatic-run counter when dropped.
struct RunGuard(Arc<OracleService>);

impl Drop for RunGuard {
    fn drop(&mut self) {
        self.0.active_runs.send_modify(|n| *n -= 1);
    }
}

struct ScanAdapter {
    service: Weak<OracleService>,
    completion: Arc<CompletionManager>,
}

impl ScanCompletion for ScanAdapter {
    fn resolve<'a>(
        &'a self,
        game_address: &'a str,
        block_time: &'a BlockTimeCache,
    ) -> BoxFuture<'a, anyhow::Result<ReadinessResolution>> {
        ScanCompletion::resolve(self.completion.as_ref(), game_address, block_time)
    }

    fn attempt(&self, options: AttemptOptions) -> BoxFuture<'_, anyhow::Result<Option<CompletionResult>>> {
        let service = self.service.upgrade();
        async move {
            match service {
                Some(service) => Ok(service
                    .start_automatic_completion_attempt(options, "fallback scan".into(), 0, false, RetryMode::Transient)
                    .await),
                None => Ok(None),
            }
        }
        .boxed()
    }
}

impl OracleService {
    /// Loads the operator keypair, opens the database and connects to RPC
    /// using the runtime configuration.
    pub fn create(config: OracleConfig) -> anyhow::Result<Arc<Self>> {
        let operator = load_operator_keypair(
            &config.operator_keypair_path,
            &config.operator_keypair_source,
            config.use_ephemeral_keypair,
        )
        .map_err(anyhow::Error::msg)?;
        let db = Arc::new(OracleDatabase::open(&config.database_file)?);
        Self::create_with(config, db, operator)
    }

    pub fn create_with(config: OracleConfig, db: Arc<OracleDatabase>, operator: Keypair) -> anyhow::Result<Arc<Self>> {
        let rpc = Arc::new(RpcPool::new(&config.solana_networks).map_err(anyhow::Error::msg)?);
        let prices: Arc<dyn TokenPriceResolver> =
            Arc::new(JupiterTokenPriceResolver::new(config.jupiter_api_key.clone(), config.jupiter_price_url.clone()));
        Ok(Self::new(OracleServiceOptions {
            config,
            db,
            metrics: Arc::new(OracleMetrics::new(500)),
            rpc,
            operator,
            price_resolver: prices,
        }))
    }

    pub fn new(options: OracleServiceOptions) -> Arc<Self> {
        let OracleServiceOptions { config, db, metrics, rpc, operator, price_resolver } = options;
        info!("Using Timba contract ABI {}", config.contract_version.as_str());
        let operator = Arc::new(operator);
        let program = ProgramClient::new(rpc.clone(), config.contract_version, config.solana_ws_endpoint.clone());
        let registry_sync = Arc::new(PlayerRegistrySync::new(rpc.clone(), program.program_id));
        let readiness_cache = ReadinessCache::default();

        let recover_sync = registry_sync.clone();
        let recover: RecoverPlayerRegistry = Arc::new(move |request: RecoverRequest| {
            let sync = recover_sync.clone();
            async move {
                sync.fetch_players_from_chain(&request.context.game_pda, Some(request.expected_tickets), None).await
            }
            .boxed()
        });
        let registry = Arc::new(RegistrySyncManager::new(db.clone(), Some(recover), true, None));
        let completion = Arc::new(CompletionManager::new(CompletionManagerOptions {
            contract_version: config.contract_version,
            db: db.clone(),
            metrics: metrics.clone(),
            rpc: rpc.clone(),
            program: program.clone(),
            operator: operator.clone(),
            readiness_cache: readiness_cache.clone(),
            registry,
        }));
        let events_list: Vec<EventName> = ALL_EVENTS
            .into_iter()
            .filter(|event| {
                config.contract_version != timba_protocol::ContractVersion::V0_2_0
                    || *event != EventName::OperatorGameClosed
            })
            .collect();

        let service = Arc::new_cyclic(|weak: &Weak<OracleService>| {
            let hooks: Weak<dyn EventHooks> = weak.clone();
            let events = EventProcessor::new(EventProcessorOptions {
                program: program.clone(),
                db: db.clone(),
                hooks,
                events: events_list,
                player_flush_debounce_ms: config.player_event_flush_debounce_ms,
                player_flush_max_operations: config.player_event_flush_max_operations,
                auto_complete_debounce_ms: config.auto_complete_debounce_ms,
                registry_sync_retry_delay_ms: super::events::DEFAULT_REGISTRY_SYNC_RETRY_DELAY_MS,
                registry_sync_timeout_ms: super::events::DEFAULT_REGISTRY_SYNC_TIMEOUT_MS,
            });
            let cleanup_target = weak.clone();
            let scanner = Arc::new(ScanLoopRunner::new(ScanLoopRunnerOptions {
                db: db.clone(),
                metrics: metrics.clone(),
                completion: Arc::new(ScanAdapter { service: weak.clone(), completion: completion.clone() }),
                inter_game_delay_ms: config.scan_throttle_ms,
                max_completion_attempts: MAX_COMPLETION_ATTEMPTS,
                cleanup_old_records: Arc::new(move |hours| {
                    if let Some(service) = cleanup_target.upgrade() {
                        service.cleanup_old_records(hours);
                    }
                    Ok(())
                }),
            }));
            OracleService {
                config,
                db,
                metrics,
                rpc,
                operator,
                program,
                completion,
                events,
                scanner,
                registry_sync,
                prices: price_resolver,
                http: reqwest::Client::builder().timeout(Duration::from_secs(10)).build().unwrap_or_default(),
                readiness_cache,
                retries: Mutex::new(HashMap::new()),
                next_timer: AtomicU64::new(1),
                active_runs: watch::channel(0).0,
                closing: AtomicBool::new(false),
                failover_task: Mutex::new(None),
                weak_self: weak.clone(),
            }
        });
        service.register_rpc_failover_listener();
        service
    }

    // -- accessors -----------------------------------------------------------

    pub fn config(&self) -> &OracleConfig {
        &self.config
    }

    pub fn db(&self) -> &Arc<OracleDatabase> {
        &self.db
    }

    pub fn metrics(&self) -> &Arc<OracleMetrics> {
        &self.metrics
    }

    pub fn connection(&self) -> &Arc<RpcPool> {
        &self.rpc
    }

    pub fn program(&self) -> &Arc<ProgramClient> {
        &self.program
    }

    pub fn program_id(&self) -> Address {
        self.program.program_id
    }

    pub fn operator_address(&self) -> Address {
        self.operator.address()
    }

    pub fn completion_manager(&self) -> &Arc<CompletionManager> {
        &self.completion
    }

    pub fn scan_runner(&self) -> &Arc<ScanLoopRunner> {
        &self.scanner
    }

    pub fn events(&self) -> &Arc<EventProcessor> {
        &self.events
    }

    pub fn readiness_cache(&self) -> &ReadinessCache {
        &self.readiness_cache
    }

    // -- RPC failover --------------------------------------------------------

    fn register_rpc_failover_listener(self: &Arc<Self>) {
        let mut changes = self.rpc.subscribe_endpoint_changes();
        let weak = Arc::downgrade(self);
        let task = tokio::spawn(async move {
            loop {
                let change = match changes.recv().await {
                    Ok(change) => change,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                };
                let Some(service) = weak.upgrade() else { return };
                if !service.events.is_listening() {
                    continue;
                }
                warn!(
                    "RPC endpoint changed from {} to {}; restarting event listeners.",
                    change.previous_endpoint, change.endpoint
                );
                if let Err(err) = service.restart_event_listeners_with_retries(&change.endpoint).await {
                    error!("RPC failover listener failed: {err:#}");
                }
            }
        });
        *self.failover_task.lock().unwrap() = Some(task);
    }

    async fn restart_event_listeners_with_retries(self: &Arc<Self>, endpoint: &str) -> anyhow::Result<()> {
        const MAX_ATTEMPTS: u64 = 3;
        const BASE_DELAY_MS: u64 = 250;
        let mut last_error = None;
        for attempt in 0..MAX_ATTEMPTS {
            self.events.stop_listening().await;
            match self.events.start_listening().await {
                Ok(()) => {
                    info!("Re-subscribed event listeners on {endpoint}");
                    return Ok(());
                }
                Err(err) => {
                    self.events.clear_registry_syncs();
                    let message = format!("{err:#}");
                    if attempt < MAX_ATTEMPTS - 1 {
                        let delay = BASE_DELAY_MS * (attempt + 1);
                        warn!(
                            "Failed to restart event listeners on {endpoint} (attempt {}/{MAX_ATTEMPTS}): {message}. Retrying in {delay}ms.",
                            attempt + 1
                        );
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                    } else {
                        error!("Failed to restart event listeners after switching to {endpoint}: {message}");
                    }
                    last_error = Some(err);
                }
            }
        }
        Err(last_error.unwrap_or_else(|| anyhow::anyhow!("Unknown restart failure")))
    }

    // -- registry ------------------------------------------------------------

    async fn sync_player_registry(&self, request: RegistrySyncRequest) -> bool {
        let game_pda = match request.game_key {
            Some(key) => Some(key),
            None => match self.completion.resolve_stored_game(&request.game_address) {
                Ok(stored) => stored.map(|context| context.game_pda),
                Err(err) => {
                    error!("Failed to resolve stored game {}: {err:#}", request.game_address);
                    None
                }
            },
        };
        let Some(game_pda) = game_pda else {
            warn!(
                "⚠️  Unable to reconcile players for {}; missing game PDA after {}",
                request.game_address, request.trigger
            );
            return false;
        };
        let players = match self.registry_sync.fetch_players_from_chain(&game_pda, request.expected_tickets, None).await
        {
            Ok(Some(players)) => players,
            Ok(None) => return false,
            Err(err) => {
                error!("Failed to synchronize players for {}: {err:#}", request.game_address);
                return false;
            }
        };
        if let Err(err) = self.db.replace_game_players(&request.game_address, &players) {
            error!("Failed to synchronize players for {}: {err:#}", request.game_address);
            return false;
        }
        info!("♻️  Synchronized {} players for {} after {}", players.len(), request.game_address, request.trigger);
        true
    }

    // -- listening -----------------------------------------------------------

    pub async fn start_event_listening(&self) -> anyhow::Result<()> {
        if self.events.is_listening() {
            return Ok(());
        }
        self.events.start_listening().await.inspect_err(|err| error!("{EVENT_LISTENER_FAILURE_MESSAGE} {err:#}"))
    }

    pub async fn stop_event_listening(&self) {
        if self.events.is_listening() {
            self.events.stop_listening().await;
        }
    }

    pub fn add_program_event_observer(&self, observer: ProgramEventObserver) -> u64 {
        self.events.add_program_event_observer(observer)
    }

    pub fn remove_program_event_observer(&self, id: u64) {
        self.events.remove_program_event_observer(id);
    }

    pub async fn run_scan_loop(&self, options: ScanLoopOptions) -> anyhow::Result<ScanLoopSummary> {
        self.scanner.run_scan_loop(options).await
    }

    pub async fn close(&self) {
        self.closing.store(true, Ordering::SeqCst);
        self.clear_completion_retries();
        self.stop_event_listening().await;
        self.scanner.stop();
        if let Some(task) = self.failover_task.lock().unwrap().take() {
            task.abort();
        }
        let mut runs = self.active_runs.subscribe();
        let _ = runs.wait_for(|n| *n == 0).await;
        self.program.close().await;
        self.db.close();
    }

    // -- commitments and signing ---------------------------------------------

    pub fn generate_game_secrets(&self, game_type: Option<&str>) -> anyhow::Result<GameSecrets> {
        let mut secret = [0u8; SECRET_KEY_LENGTH];
        rand::thread_rng().fill_bytes(&mut secret);
        let random_hash: [u8; 32] = Sha256::digest(secret).into();
        let game_address = self.completion.get_game_pda(&random_hash)?.to_base58();
        self.db.save_secret_key(&game_address, &hex::encode(secret), &hex::encode(random_hash))?;
        if let Err(err) = self.db.track_game(&game_address, game_type, false) {
            log_db_error(self.db.delete_secret_key(&game_address), "Failed to roll back secret key");
            return Err(err);
        }
        Ok(GameSecrets {
            random_hash: hex::encode(random_hash),
            game_address,
            oracle_operator: Some(self.operator.address().to_base58()),
        })
    }

    pub async fn sign_game_transaction(&self, tx_base64: &str) -> Result<String, GameTransactionError> {
        if tx_base64.is_empty() || tx_base64.len() > MAX_TRANSACTION_PAYLOAD_LENGTH {
            return Err(GameTransactionError::Validation("Invalid transaction payload".into()));
        }
        let options = SignGameTransactionOptions {
            contract_version: self.config.contract_version,
            program_id: self.program.program_id,
            operator: &self.operator,
            hooks: self,
        };
        match sign_game_transaction_with_policy(tx_base64, &options).await {
            Ok(signed) => Ok(signed),
            Err(SignError::Creation(err)) => Err(GameTransactionError::CreationPolicy(err)),
            Err(SignError::Policy(message)) => Err(GameTransactionError::Validation(message)),
            Err(SignError::Other(err)) => {
                warn!("Transaction could not be signed: {err:#}");
                Err(GameTransactionError::Validation("Transaction could not be signed".into()))
            }
        }
    }

    // -- token policies ------------------------------------------------------

    async fn resolve_token_policy(&self, policy: &StoredTokenPolicy) -> anyhow::Result<TokenPolicy> {
        if !policy.enabled {
            return Ok(to_api_token_policy(policy, 0));
        }
        let prices = self.prices.get_token_usd_prices(std::slice::from_ref(&policy.mint), false).await?;
        let price = prices
            .get(&policy.mint)
            .copied()
            .ok_or_else(|| anyhow::anyhow!("Token price is unavailable for {}", policy.mint))?;
        let minimum = compute_minimum_amount_raw(price, policy.decimals).map_err(anyhow::Error::msg)?;
        Ok(to_api_token_policy(policy, minimum))
    }

    async fn check_creation_policy(&self, mint: &Address, amount: u64) -> Result<(), CreationPolicyError> {
        let mint_str = mint.to_base58();
        let unavailable = |revision: Option<i64>| CreationPolicyError {
            revision,
            ..CreationPolicyError::new(
                RejectionCode::PolicyUnavailable,
                "Token creation policy is unavailable",
                &mint_str,
            )
        };
        let policy = match self.db.get_token_policy(&mint_str) {
            Ok(Some(policy)) => policy,
            Ok(None) => {
                return Err(CreationPolicyError::new(
                    RejectionCode::UnsupportedMint,
                    "Token mint is not supported",
                    &mint_str,
                ))
            }
            Err(_) => return Err(unavailable(None)),
        };
        if !policy.enabled {
            return Err(CreationPolicyError::new(RejectionCode::TokenDisabled, "Token mint is disabled", &mint_str)
                .revision(policy.revision));
        }
        let resolved = match self.resolve_token_policy(&policy).await {
            Ok(resolved) => resolved,
            Err(err) => {
                warn!("Token creation policy is unavailable for {mint_str}: {err:#}");
                return Err(unavailable(Some(policy.revision)));
            }
        };
        let accepted: u64 = resolved.accepted_minimum_amount_raw.parse().unwrap_or(u64::MAX);
        if amount < accepted {
            return Err(CreationPolicyError {
                minimum_amount_raw: Some(resolved.minimum_amount_raw),
                accepted_minimum_amount_raw: Some(resolved.accepted_minimum_amount_raw),
                ..CreationPolicyError::new(
                    RejectionCode::AmountBelowMinimum,
                    "Game amount is below the token minimum",
                    &mint_str,
                )
                .revision(policy.revision)
            });
        }
        Ok(())
    }

    pub async fn get_token_policies(&self) -> anyhow::Result<Vec<TokenPolicy>> {
        let policies = self.db.get_token_policies()?;
        let enabled: Vec<String> = policies.iter().filter(|p| p.enabled).map(|p| p.mint.clone()).collect();
        let prices = self
            .prices
            .get_token_usd_prices(&enabled, true)
            .await
            .map_err(|err| err.context("Token prices are unavailable"))?;
        let mut result = Vec::new();
        for policy in &policies {
            if !policy.enabled {
                result.push(to_api_token_policy(policy, 0));
                continue;
            }
            let Some(price) = prices.get(&policy.mint) else {
                warn!("Omitting token policy without a current price: {}", policy.mint);
                continue;
            };
            let minimum = compute_minimum_amount_raw(*price, policy.decimals).map_err(anyhow::Error::msg)?;
            result.push(to_api_token_policy(policy, minimum));
        }
        Ok(result)
    }

    pub async fn set_token_policy(&self, mint: &str, enabled: bool) -> anyhow::Result<TokenPolicy> {
        let mint = normalize_mint(mint).map_err(anyhow::Error::msg)?;
        let existing = self.db.get_token_policy(&mint)?;
        let mut decimals = existing.map(|p| p.decimals).unwrap_or(0);
        let mut minimum = 0;
        if enabled {
            let prices = self.prices.get_token_usd_prices(std::slice::from_ref(&mint), false).await?;
            let price =
                prices.get(&mint).copied().ok_or_else(|| anyhow::anyhow!("Token price is unavailable for {mint}"))?;
            let mint_address = Address::parse(&mint).map_err(|e| anyhow::anyhow!("{e}"))?;
            let prepared = prepare_game_token(&self.rpc, &self.operator, &mint_address).await?;
            decimals = prepared.decimals;
            minimum = compute_minimum_amount_raw(price, decimals).map_err(anyhow::Error::msg)?;
        }
        let policy = self.db.set_token_policy(&mint, enabled, decimals)?;
        Ok(to_api_token_policy(&policy, minimum))
    }

    // -- completion entry points ---------------------------------------------

    pub async fn complete_game(
        &self,
        game_address: &str,
        readiness: Option<Readiness>,
        context: Option<GameContext>,
    ) -> CompletionResult {
        self.completion.complete_game(game_address, readiness, context).await
    }

    fn bot_attempt_options(game_address: &str) -> AttemptOptions {
        let address = game_address.to_string();
        let mut options = AttemptOptions::new(game_address);
        options.game_key = Address::parse(game_address).ok();
        options.success_log = log_fn(move |_, _| format!("🎯 Completed game {address} after bot wake-up"));
        options.failure_log =
            log_fn(|_, error| format!("❌ Bot-triggered completion failed: {}", error.unwrap_or("Unknown error")));
        options
    }

    pub async fn complete_game_now(self: &Arc<Self>, game_address: &str) -> Option<CompletionResult> {
        let normalized = game_address.trim();
        if normalized.is_empty() {
            return Some(CompletionResult::failure("gameAddress is required"));
        }
        self.start_automatic_completion_attempt(
            Self::bot_attempt_options(normalized),
            "bot wake-up".into(),
            0,
            true,
            RetryMode::Transient,
        )
        .await
    }

    /// Wakes the automatic completion machinery without keeping the caller
    /// waiting on RPC reads and confirmation; the listener and fallback scan
    /// still own the same idempotent job if the wake-up is lost.
    pub fn queue_game_completion(self: &Arc<Self>, game_address: &str) -> Option<CompletionResult> {
        let normalized = game_address.trim();
        if normalized.is_empty() {
            return Some(CompletionResult::failure("gameAddress is required"));
        }
        let attempt = self.start_automatic_completion_attempt(
            Self::bot_attempt_options(normalized),
            "bot wake-up".into(),
            0,
            true,
            RetryMode::Transient,
        );
        tokio::spawn(attempt);
        None
    }

    /// [`Self::queue_game_completion`] for callers holding a plain reference.
    pub fn queue_completion(&self, game_address: &str) -> Option<CompletionResult> {
        self.weak_self.upgrade().and_then(|service| service.queue_game_completion(game_address))
    }

    pub fn requeue_game(&self, game_address: &str) -> Result<(), RequeueFailure> {
        let normalized = game_address.trim();
        if normalized.is_empty() {
            return Err(RequeueFailure::InvalidAddress);
        }
        let status = self.db.get_game_status(normalized).ok_or(RequeueFailure::NotFound)?;
        let pending = status == "pending" || status == "desynced";
        let finalized = status == "completed" || status == "cancelled";
        if !pending && !finalized {
            return Err(RequeueFailure::Finalized);
        }
        let mut secret = self.db.get_secret_key(normalized);
        let mut reactivated = false;
        if secret.is_none() {
            reactivated = self.db.reactivate_secret_key(normalized).unwrap_or(false);
            if reactivated {
                secret = self.db.get_secret_key(normalized);
            }
        }
        if secret.is_none() {
            return Err(RequeueFailure::MissingSecret);
        }
        let reset = match self.db.reset_completion_attempts(normalized, finalized) {
            Ok(reset) => reset,
            Err(err) => {
                error!("Failed to reset completion attempts for {normalized}: {err:#}");
                Err(ResetFailure::Unchanged)
            }
        };
        if let Err(failure) = reset {
            if reactivated {
                log_db_error(self.db.mark_secret_key_used(normalized), "Failed to restore secret key state");
            }
            return Err(match failure {
                ResetFailure::NotFound => RequeueFailure::NotFound,
                ResetFailure::Finalized => RequeueFailure::Finalized,
                ResetFailure::Unchanged => RequeueFailure::Unchanged,
            });
        }
        self.readiness_cache.lock().unwrap().remove(normalized);
        self.cancel_completion_retry(normalized);
        Ok(())
    }

    pub fn set_auto_complete_disabled(
        &self,
        game_address: &str,
        disabled: bool,
    ) -> anyhow::Result<Result<bool, ToggleFailure>> {
        let result = self.db.set_auto_complete_disabled(game_address, disabled)?;
        if result.is_ok() {
            self.readiness_cache.lock().unwrap().remove(game_address.trim());
        }
        Ok(result)
    }

    async fn try_auto_complete(self: Arc<Self>, game_key: Option<Address>, game_address: String, trigger: String) {
        if self.closing.load(Ordering::SeqCst) {
            return;
        }
        let mut options = AttemptOptions::new(&game_address);
        options.game_key = game_key;
        let (address, success_trigger) = (game_address.clone(), trigger.clone());
        options.success_log = log_fn(move |_, _| format!("🎯 Auto-completed game {address} after {success_trigger}"));
        options.failure_log =
            log_fn(|_, error| format!("❌ Auto-completion failed: {}", error.unwrap_or("Unknown error")));
        self.start_automatic_completion_attempt(options, trigger, 0, false, RetryMode::Transient).await;
    }

    // -- automatic completion state machine ----------------------------------

    fn start_automatic_completion_attempt(
        self: &Arc<Self>,
        options: AttemptOptions,
        trigger: String,
        retry_attempt: usize,
        report_cooldown_as_not_ready: bool,
        mode: RetryMode,
    ) -> BoxFuture<'static, Option<CompletionResult>> {
        let admission =
            self.admit_automatic_completion(&options.game_address, options.game_key, &trigger, retry_attempt, mode);
        match admission {
            Admission::Allowed => {}
            Admission::Cooldown(next) if report_cooldown_as_not_ready => {
                return futures::future::ready(Some(CompletionResult::not_ready_with(format_cooldown_message(next))))
                    .boxed();
            }
            Admission::Cooldown(_) | Admission::Denied => return futures::future::ready(None).boxed(),
        }
        self.active_runs.send_modify(|n| *n += 1);
        let service = self.clone();
        async move {
            let _guard = RunGuard(service.clone());
            let game_key = options.game_key;
            service.run_auto_complete_attempt(options, game_key, trigger, retry_attempt, mode).await
        }
        .boxed()
    }

    fn admit_automatic_completion(
        &self,
        game_address: &str,
        game_key: Option<Address>,
        trigger: &str,
        retry_attempt: usize,
        mode: RetryMode,
    ) -> Admission {
        if self.closing.load(Ordering::SeqCst) {
            return Admission::Denied;
        }
        let now = timba_common::time::now_ms();
        {
            let mut retries = self.retries.lock().unwrap();
            if let Some(existing) = retries.get_mut(game_address) {
                if existing.phase == RetryPhase::Cooldown {
                    if let Some(next) = existing.next_eligible_at.filter(|next| now < *next) {
                        return Admission::Cooldown(Some(next));
                    }
                    if let Some(entry) = retries.remove(game_address) {
                        cancel_timer(entry.timer);
                    }
                    log_db_error(self.db.clear_completion_retry_after(game_address), "Failed to clear retry-after");
                } else {
                    // A fresh bot/event wake-up can consume a pending readiness
                    // retry immediately instead of waiting behind a stale-read
                    // timer, while transient retries stay coalesced.
                    if retry_attempt == 0 && existing.mode == RetryMode::Readiness && existing.timer.is_some() {
                        cancel_timer(existing.timer.take());
                        existing.game_key = game_key.or(existing.game_key);
                        existing.trigger = trigger.to_string();
                        return Admission::Allowed;
                    }
                    let current_attempt = match mode {
                        RetryMode::Readiness => existing.readiness_attempt,
                        RetryMode::Transient => existing.transient_attempt,
                    };
                    let expected_retry = retry_attempt > 0
                        && existing.mode == mode
                        && current_attempt == retry_attempt
                        && existing.timer.is_none();
                    if !expected_retry {
                        return Admission::Denied;
                    }
                    existing.game_key = game_key.or(existing.game_key);
                    return Admission::Allowed;
                }
            }
        }

        let state = self.db.get_completion_attempt_state(game_address);
        if let Some(next) = state.as_ref().and_then(|s| s.completion_retry_after) {
            if now < next {
                let attempts = state.as_ref().map(|s| s.completion_attempts).unwrap_or(0).max(0) as usize;
                self.install_completion_cooldown(game_address, game_key, trigger, attempts, next);
                return Admission::Cooldown(Some(next));
            }
            log_db_error(self.db.clear_completion_retry_after(game_address), "Failed to clear retry-after");
        }
        if self.automatic_completion_stop_reason(game_address, trigger).is_some() {
            return Admission::Denied;
        }
        if retry_attempt > 0 {
            // Only the lifecycle that scheduled a retry can admit it, so stale
            // callbacks cannot start a second retry burst.
            return Admission::Denied;
        }
        self.retries.lock().unwrap().insert(
            game_address.to_string(),
            CompletionRetry {
                phase: RetryPhase::Active,
                mode,
                transient_attempt: 0,
                readiness_attempt: 0,
                timer: None,
                game_key,
                trigger: trigger.to_string(),
                next_eligible_at: None,
            },
        );
        Admission::Allowed
    }

    async fn run_auto_complete_attempt(
        self: Arc<Self>,
        options: AttemptOptions,
        game_key: Option<Address>,
        trigger: String,
        retry_attempt: usize,
        mode: RetryMode,
    ) -> Option<CompletionResult> {
        let game_address = options.game_address.clone();
        if let Some(reason) = self.automatic_completion_stop_reason(&game_address, &trigger) {
            info!("Skipping auto-complete for {game_address} after {trigger} ({reason})");
            self.cancel_completion_retry(&game_address);
            return None;
        }
        let attempt_options = if retry_attempt == 0 {
            AttemptOptions { game_key, ..options }
        } else {
            AttemptOptions {
                game_key,
                on_result: options.on_result,
                success_log: options.success_log,
                failure_log: options.failure_log,
                ..AttemptOptions::new(&game_address)
            }
        };
        let fallback = is_fallback_scan_trigger(&trigger);
        match self.attempt_game_completion(attempt_options).await {
            Ok(None) => {
                if !fallback {
                    let next = self.next_readiness_attempt(&game_address, mode, retry_attempt);
                    self.schedule_readiness_retry(&game_address, game_key, &trigger, next);
                } else if retry_attempt > 0 {
                    let next = self.next_transient_attempt(&game_address, mode, retry_attempt);
                    self.schedule_completion_retry(&game_address, game_key, &trigger, next);
                } else {
                    self.cancel_completion_retry(&game_address);
                }
                None
            }
            Ok(Some(result)) => {
                if result.success {
                    self.cancel_completion_retry(&game_address);
                } else if result.not_ready {
                    if fallback {
                        self.cancel_completion_retry(&game_address);
                    } else {
                        let next = self.next_readiness_attempt(&game_address, mode, retry_attempt);
                        self.schedule_readiness_retry(&game_address, game_key, &trigger, next);
                    }
                } else if is_transient_completion_failure(result.error.as_deref()) {
                    self.record_transient_completion_failure(&game_address);
                    let next = self.next_transient_attempt(&game_address, mode, retry_attempt);
                    self.schedule_completion_retry(&game_address, game_key, &trigger, next);
                } else {
                    self.cancel_completion_retry(&game_address);
                }
                Some(result)
            }
            Err(err) => {
                let message = format!("{err:#}");
                error!("Auto-completion attempt failed for {game_address}: {message}");
                if is_transient_completion_failure(Some(&message)) {
                    self.record_transient_completion_failure(&game_address);
                    let next = self.next_transient_attempt(&game_address, mode, retry_attempt);
                    self.schedule_completion_retry(&game_address, game_key, &trigger, next);
                } else {
                    log_db_error(
                        self.db.increment_completion_attempts(&game_address),
                        "Failed to increment completion attempts",
                    );
                    self.cancel_completion_retry(&game_address);
                }
                Some(CompletionResult::failure(message))
            }
        }
    }

    fn record_transient_completion_failure(&self, game_address: &str) {
        let state = self.db.get_completion_attempt_state(game_address);
        if state.and_then(|s| s.completion_failure_kind) != Some(CompletionFailureKind::Transient) {
            log_db_error(
                self.db.record_transient_completion_failure(game_address),
                "Failed to record transient completion failure",
            );
        }
    }

    fn automatic_completion_stop_reason(&self, game_address: &str, trigger: &str) -> Option<String> {
        if self.closing.load(Ordering::SeqCst) {
            return Some("service shutting down".into());
        }
        let state = self.db.get_completion_attempt_state(game_address)?;
        if state.auto_complete_disabled {
            return Some("auto-complete disabled".into());
        }
        let status = state.status.to_lowercase();
        if status == "completed" || status == "cancelled" {
            return Some(format!("game already {status}"));
        }
        if status == "desynced" {
            return Some("game is desynced".into());
        }
        if state.completion_attempts >= MAX_COMPLETION_ATTEMPTS
            && (!is_fallback_scan_trigger(trigger)
                || state.completion_failure_kind == Some(CompletionFailureKind::Permanent))
        {
            return Some(format!("completion attempt limit reached ({MAX_COMPLETION_ATTEMPTS})"));
        }
        None
    }

    fn next_readiness_attempt(&self, game_address: &str, mode: RetryMode, retry_attempt: usize) -> usize {
        let retries = self.retries.lock().unwrap();
        match retries.get(game_address) {
            Some(existing) if existing.phase == RetryPhase::Active && existing.readiness_attempt > 0 => {
                existing.readiness_attempt + 1
            }
            _ if mode == RetryMode::Readiness => retry_attempt + 1,
            _ => 1,
        }
    }

    fn next_transient_attempt(&self, game_address: &str, mode: RetryMode, retry_attempt: usize) -> usize {
        let retries = self.retries.lock().unwrap();
        match retries.get(game_address) {
            Some(existing) if existing.phase == RetryPhase::Active && existing.transient_attempt > 0 => {
                existing.transient_attempt + 1
            }
            _ if mode == RetryMode::Transient => retry_attempt + 1,
            _ => 1,
        }
    }

    fn schedule_completion_retry(
        self: &Arc<Self>,
        game_address: &str,
        game_key: Option<Address>,
        trigger: &str,
        attempt: usize,
    ) {
        self.schedule_retry(game_address, game_key, trigger, attempt, RetryMode::Transient);
    }

    fn schedule_readiness_retry(
        self: &Arc<Self>,
        game_address: &str,
        game_key: Option<Address>,
        trigger: &str,
        attempt: usize,
    ) {
        self.schedule_retry(game_address, game_key, trigger, attempt, RetryMode::Readiness);
    }

    fn schedule_retry(
        self: &Arc<Self>,
        game_address: &str,
        game_key: Option<Address>,
        trigger: &str,
        attempt: usize,
        mode: RetryMode,
    ) {
        if self.closing.load(Ordering::SeqCst) || self.automatic_completion_stop_reason(game_address, trigger).is_some()
        {
            self.cancel_completion_retry(game_address);
            return;
        }
        let delays: &[u64] = match mode {
            RetryMode::Transient => &COMPLETION_RETRY_DELAYS_MS,
            RetryMode::Readiness => &READINESS_RETRY_DELAYS_MS,
        };
        let Some(&delay_ms) = attempt.checked_sub(1).and_then(|index| delays.get(index)) else {
            match mode {
                RetryMode::Transient => self.enter_completion_cooldown(game_address, game_key, trigger, attempt),
                RetryMode::Readiness => {
                    self.cancel_completion_retry(game_address);
                    info!("Readiness retries exhausted for {game_address}; awaiting the next game event or scan.");
                }
            }
            return;
        };

        let mut retries = self.retries.lock().unwrap();
        let Some(existing) = retries.get_mut(game_address) else { return };
        if existing.phase != RetryPhase::Active || existing.timer.is_some() {
            return;
        }
        let token = self.next_timer.fetch_add(1, Ordering::SeqCst);
        let weak = Arc::downgrade(self);
        let address = game_address.to_string();
        let retry_trigger = trigger.to_string();
        let handle = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            let Some(service) = weak.upgrade() else { return };
            service.fire_retry(token, address, game_key, retry_trigger, attempt, mode).await;
        });
        existing.phase = RetryPhase::Active;
        existing.mode = mode;
        match mode {
            RetryMode::Transient => existing.transient_attempt = attempt,
            RetryMode::Readiness => existing.readiness_attempt = attempt,
        }
        existing.timer = Some((token, handle));
        existing.game_key = game_key.or(existing.game_key);
        existing.trigger = trigger.to_string();
        drop(retries);
        let (label, total) = match mode {
            RetryMode::Transient => ("completion", COMPLETION_RETRY_DELAYS_MS.len()),
            RetryMode::Readiness => ("readiness", READINESS_RETRY_DELAYS_MS.len()),
        };
        info!("⏳ Scheduling {label} retry {attempt}/{total} for {game_address} in {delay_ms}ms");
    }

    async fn fire_retry(
        self: Arc<Self>,
        token: u64,
        game_address: String,
        game_key: Option<Address>,
        trigger: String,
        attempt: usize,
        mode: RetryMode,
    ) {
        {
            let mut retries = self.retries.lock().unwrap();
            let Some(current) = retries.get_mut(&game_address) else { return };
            if current.timer.as_ref().map(|(t, _)| *t) != Some(token) || current.phase != RetryPhase::Active {
                return;
            }
            current.timer = None;
            current.mode = mode;
            match mode {
                RetryMode::Transient => current.transient_attempt = attempt,
                RetryMode::Readiness => current.readiness_attempt = attempt,
            }
            current.game_key = game_key.or(current.game_key);
            current.trigger = trigger.clone();
        }
        if self.automatic_completion_stop_reason(&game_address, &trigger).is_some() {
            self.cancel_completion_retry(&game_address);
            return;
        }
        let mut options = AttemptOptions::new(&game_address);
        options.game_key = game_key;
        let (address, label) = (game_address.clone(), trigger.clone());
        let (retry_trigger, kind) = match mode {
            RetryMode::Transient => (format!("{trigger} retry {attempt}"), "retry"),
            RetryMode::Readiness => (format!("{trigger} readiness retry {attempt}"), "readiness retry"),
        };
        options.success_log = log_fn(move |_, _| format!("🎯 Auto-completed game {address} after {label} {kind}"));
        let label = trigger.clone();
        options.failure_log = log_fn(move |_, error| {
            format!("❌ Auto-completion failed after {label} {kind}: {}", error.unwrap_or("Unknown error"))
        });
        self.start_automatic_completion_attempt(options, retry_trigger, attempt, false, mode).await;
    }

    fn enter_completion_cooldown(&self, game_address: &str, game_key: Option<Address>, trigger: &str, attempt: usize) {
        let now = timba_common::time::now_ms();
        let (existing_cooldown, existing_key) = {
            let retries = self.retries.lock().unwrap();
            let existing = retries.get(game_address);
            (
                existing.filter(|e| e.phase == RetryPhase::Cooldown).and_then(|e| e.next_eligible_at),
                existing.and_then(|e| e.game_key),
            )
        };
        let persisted = self.db.get_completion_attempt_state(game_address).and_then(|s| s.completion_retry_after);
        let next_eligible_at =
            existing_cooldown.unwrap_or(0).max(persisted.unwrap_or(0)).max(now + COMPLETION_RECOVERY_COOLDOWN_MS);
        if existing_cooldown.is_some_and(|at| at > now) {
            return;
        }
        if let Some(existing) = self.retries.lock().unwrap().get_mut(game_address) {
            cancel_timer(existing.timer.take());
        }
        log_db_error(
            self.db.set_completion_retry_after(game_address, next_eligible_at).map(drop),
            "Failed to persist completion cooldown",
        );
        self.install_completion_cooldown(game_address, game_key.or(existing_key), trigger, attempt, next_eligible_at);
        warn!(
            "Completion retries exhausted for {game_address}; automatic recovery is paused until {}.",
            iso_time(next_eligible_at)
        );
    }

    fn install_completion_cooldown(
        &self,
        game_address: &str,
        game_key: Option<Address>,
        trigger: &str,
        attempt: usize,
        next_eligible_at: i64,
    ) {
        let mut retries = self.retries.lock().unwrap();
        let mut readiness_attempt = 0;
        if let Some(existing) = retries.get_mut(game_address) {
            if existing.phase == RetryPhase::Cooldown
                && existing.next_eligible_at.is_some_and(|at| at >= next_eligible_at)
                && existing.timer.is_some()
            {
                return;
            }
            cancel_timer(existing.timer.take());
            readiness_attempt = existing.readiness_attempt;
        }
        let token = self.next_timer.fetch_add(1, Ordering::SeqCst);
        let delay_ms = (next_eligible_at - timba_common::time::now_ms()).max(0) as u64;
        let address = game_address.to_string();
        let weak = self.weak_self.clone();
        let handle = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            let Some(service) = weak.upgrade() else { return };
            let mut retries = service.retries.lock().unwrap();
            let owned = retries
                .get(&address)
                .is_some_and(|c| c.phase == RetryPhase::Cooldown && c.timer.as_ref().map(|(t, _)| *t) == Some(token));
            if owned {
                retries.remove(&address);
                info!("✅ Completion cooldown ended for {address}; awaiting the next recovery trigger.");
            }
        });
        retries.insert(
            game_address.to_string(),
            CompletionRetry {
                phase: RetryPhase::Cooldown,
                mode: RetryMode::Transient,
                transient_attempt: attempt,
                readiness_attempt,
                timer: Some((token, handle)),
                game_key,
                trigger: trigger.to_string(),
                next_eligible_at: Some(next_eligible_at),
            },
        );
    }

    fn cancel_completion_retry(&self, game_address: &str) {
        let entry = self.retries.lock().unwrap().remove(game_address);
        if let Some(entry) = entry {
            cancel_timer(entry.timer);
        }
    }

    fn clear_completion_retries(&self) {
        let entries: Vec<_> = self.retries.lock().unwrap().drain().collect();
        for (_, entry) in entries {
            cancel_timer(entry.timer);
        }
    }

    async fn attempt_game_completion(
        self: &Arc<Self>,
        options: AttemptOptions,
    ) -> anyhow::Result<Option<CompletionResult>> {
        let game_address = options.game_address.clone();
        let weak = Arc::downgrade(self);
        let on_result: super::types::ResultHook = Arc::new(move |result: &CompletionResult| {
            if !result.success || result.winner_address.is_none() {
                return;
            }
            let (Some(service), result, address) = (weak.upgrade(), result.clone(), game_address.clone()) else {
                return;
            };
            tokio::spawn(async move {
                if let Err(err) = service.notify_bot_of_completion(&address, &result).await {
                    warn!("Failed to notify bot of completion: {err:#}");
                }
            });
        });
        self.completion.attempt_game_completion(AttemptOptions { on_result: Some(on_result), ..options }).await
    }

    async fn notify_bot_of_completion(&self, game_address: &str, result: &CompletionResult) -> anyhow::Result<()> {
        let Some(bot_url) = self.config.bot_internal_url.as_deref().filter(|u| !u.trim().is_empty()) else {
            return Ok(());
        };
        let (Some(winner), Some(tx), Some(total_pot)) = (&result.winner_address, &result.tx_hash, result.total_pot)
        else {
            anyhow::bail!("Completed game result is missing notification data");
        };
        let url = format!("{}/{}", bot_url.trim_end_matches('/'), BOT_COMPLETED_PATH.trim_start_matches('/'));
        let response = self
            .http
            .post(url)
            .json(&serde_json::json!({
                "gameAddress": game_address,
                "winnerAddress": winner,
                "winnerTxSignature": tx,
                "totalPot": total_pot,
            }))
            .send()
            .await?;
        let status = response.status().as_u16();
        if status != 200 {
            let body: serde_json::Value = response.json().await.unwrap_or_default();
            let error = body.get("error").and_then(|e| e.as_str()).unwrap_or("undefined");
            warn!("Bot notification failed ({status}): {error}");
        }
        Ok(())
    }

    // -- maintenance ---------------------------------------------------------

    pub fn cleanup_old_records(&self, hours_old: i64) -> CleanupCounts {
        let mut result = self.db.cleanup_old_records(hours_old);
        if hours_old > 0 {
            result.deleted_secrets += self.db.cleanup_unsigned_commitments(10);
        }
        self.metrics.record_cleanup_sweep(CleanupRecord {
            hours_old,
            deleted_secrets: result.deleted_secrets as u64,
            deleted_games: result.deleted_games as u64,
            deleted_players: result.deleted_players as u64,
        });
        result
    }

    pub fn get_stats(&self) -> ServiceStats {
        ServiceStats {
            db: self.db.get_stats(),
            event_listening: self.events.is_listening(),
            active_listeners: self.events.active_listener_count(),
        }
    }
}

impl EventHooks for OracleService {
    fn try_auto_complete(
        &self,
        game_key: Option<Address>,
        game_address: String,
        trigger: String,
    ) -> BoxFuture<'static, ()> {
        let Some(service) = self.weak_self.upgrade() else { return futures::future::ready(()).boxed() };
        let key = game_key.or_else(|| Address::parse(&game_address).ok());
        service.try_auto_complete(key, game_address, trigger).boxed()
    }

    fn sync_player_registry(&self, request: RegistrySyncRequest) -> BoxFuture<'static, bool> {
        let Some(service) = self.weak_self.upgrade() else {
            return futures::future::ready(false).boxed();
        };
        async move { service.sync_player_registry(request).await }.boxed()
    }

    fn on_game_finalized(&self, game_address: &str) {
        self.cancel_completion_retry(game_address);
        self.completion.reset_registry_prefetch_schedule(game_address);
    }
}

impl SigningHooks for OracleService {
    fn assert_creation_policy<'a>(
        &'a self,
        token_mint: &'a Address,
        amount: u64,
    ) -> BoxFuture<'a, Result<(), SignError>> {
        async move { self.check_creation_policy(token_mint, amount).await.map_err(SignError::Creation) }.boxed()
    }

    fn assert_unused_commitment(&self, game: &Address, random_hash_hex: &str) -> Result<(), SignError> {
        match self.db.get_secret_key_info(&game.to_base58()) {
            Some(secret) if !secret.used && secret.random_hash == random_hash_hex => Ok(()),
            _ => Err(SignError::Policy("Random hash is not an unused oracle commitment".into())),
        }
    }

    fn mark_commitment_signed(&self, game: &Address) -> anyhow::Result<()> {
        self.db.mark_secret_key_signed(&game.to_base58())
    }
}

impl WebGameOracle for OracleService {
    fn rpc(&self) -> Arc<RpcPool> {
        self.rpc.clone()
    }

    fn program_id(&self) -> Address {
        self.program.program_id
    }

    fn generate_game_secrets<'a>(&'a self, game_type: Option<&'a str>) -> BoxFuture<'a, anyhow::Result<GameSecrets>> {
        futures::future::ready(OracleService::generate_game_secrets(self, game_type)).boxed()
    }

    fn sign_game_transaction<'a>(&'a self, tx_base64: &'a str) -> BoxFuture<'a, anyhow::Result<String>> {
        async move { OracleService::sign_game_transaction(self, tx_base64).await.map_err(anyhow::Error::new) }.boxed()
    }

    fn token_policies(&self) -> BoxFuture<'_, anyhow::Result<Vec<TokenPolicy>>> {
        self.get_token_policies().boxed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::solana::pool::testing::FakeTransport;
    use crate::solana::rpc::RpcError;

    struct FixedPrices(HashMap<String, f64>);

    impl TokenPriceResolver for FixedPrices {
        fn get_token_usd_prices<'a>(
            &'a self,
            mints: &'a [String],
            allow_partial: bool,
        ) -> BoxFuture<'a, anyhow::Result<HashMap<String, f64>>> {
            let found: HashMap<_, _> = mints.iter().filter_map(|m| self.0.get(m).map(|p| (m.clone(), *p))).collect();
            let result = if !allow_partial && found.len() != mints.len() {
                Err(anyhow::anyhow!("missing price"))
            } else {
                Ok(found)
            };
            futures::future::ready(result).boxed()
        }
    }

    struct Harness {
        _dir: tempfile::TempDir,
        transport: Arc<FakeTransport>,
        service: Arc<OracleService>,
    }

    const MINT_A: &str = "So11111111111111111111111111111111111111112";
    const MINT_B: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

    fn harness() -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(OracleDatabase::open(dir.path().join("o.sqlite").to_str().unwrap()).unwrap());
        let transport = FakeTransport::new();
        let rpc = Arc::new(
            RpcPool::with_transport(&["https://a".into()], transport.clone())
                .unwrap()
                .with_delay(|_| futures::future::ready(()).boxed()),
        );
        let service = OracleService::new(OracleServiceOptions {
            config: OracleConfig::for_tests(),
            db,
            metrics: Arc::new(OracleMetrics::new(10)),
            rpc,
            operator: Keypair::generate(),
            price_resolver: Arc::new(FixedPrices(HashMap::from([(MINT_A.to_string(), 150.0)]))),
        });
        Harness { _dir: dir, transport, service }
    }

    fn tracked_game(h: &Harness) -> String {
        h.service.generate_game_secrets(None).unwrap().game_address
    }

    #[tokio::test]
    async fn generates_and_tracks_secrets() {
        let h = harness();
        let secrets = h.service.generate_game_secrets(Some("coinflip")).unwrap();
        let hash = hex::decode(&secrets.random_hash).unwrap();
        assert_eq!(secrets.game_address, h.service.completion.get_game_pda(&hash).unwrap().to_base58());
        assert_eq!(secrets.oracle_operator, Some(h.service.operator_address().to_base58()));
        let stored = h.service.db.get_secret_key(&secrets.game_address).unwrap();
        let secret = hex::decode(stored.secret_key).unwrap();
        assert_eq!(hex::encode(Sha256::digest(secret)), secrets.random_hash);
        assert_eq!(h.service.db.get_game_type(&secrets.game_address).as_deref(), Some("coinflip"));
        assert_eq!(h.service.db.get_game_status(&secrets.game_address).as_deref(), Some("pending"));
    }

    #[tokio::test]
    async fn rejects_invalid_payloads() {
        let h = harness();
        for payload in [String::new(), "A".repeat(4_001)] {
            let err = h.service.sign_game_transaction(&payload).await.unwrap_err();
            assert_eq!(err.to_string(), "Invalid transaction payload");
        }
        let err = h.service.sign_game_transaction("not base64!").await.unwrap_err();
        assert!(matches!(err, GameTransactionError::Validation(_)));
    }

    #[tokio::test]
    async fn requeue_reports_reasons() {
        let h = harness();
        assert_eq!(h.service.requeue_game("  "), Err(RequeueFailure::InvalidAddress));
        assert_eq!(h.service.requeue_game("unknown"), Err(RequeueFailure::NotFound));
        let game = tracked_game(&h);
        h.service.db.increment_completion_attempts(&game).unwrap();
        assert_eq!(h.service.requeue_game(&game), Ok(()));
        assert_eq!(h.service.db.get_completion_attempt_state(&game).unwrap().completion_attempts, 0);
        h.service.db.track_game("orphan", None, false).unwrap();
        assert_eq!(h.service.requeue_game("orphan"), Err(RequeueFailure::MissingSecret));
    }

    #[tokio::test]
    async fn token_policies_and_creation_checks() {
        let h = harness();
        h.service.db.set_token_policy(MINT_A, true, 9).unwrap();
        h.service.db.set_token_policy(MINT_B, true, 6).unwrap();
        let policies = h.service.get_token_policies().await.unwrap();
        assert_eq!(policies.len(), 1, "mints without a price are omitted");
        assert_eq!(policies[0].mint, MINT_A);

        let mint_a = Address::parse(MINT_A).unwrap();
        let err = h.service.check_creation_policy(&mint_a, 1).await.unwrap_err();
        assert_eq!(err.code, RejectionCode::AmountBelowMinimum);
        assert_eq!(err.accepted_minimum_amount_raw.as_deref(), Some(policies[0].accepted_minimum_amount_raw.as_str()));
        let accepted: u64 = policies[0].accepted_minimum_amount_raw.parse().unwrap();
        h.service.check_creation_policy(&mint_a, accepted).await.unwrap();

        let mint_b = Address::parse(MINT_B).unwrap();
        let err = h.service.check_creation_policy(&mint_b, 1_000_000).await.unwrap_err();
        assert_eq!(err.code, RejectionCode::PolicyUnavailable);
        let unknown = Address([9; 32]);
        let err = h.service.check_creation_policy(&unknown, 1).await.unwrap_err();
        assert_eq!(err.code, RejectionCode::UnsupportedMint);
        h.service.db.set_token_policy(MINT_A, false, 9).unwrap();
        let err = h.service.check_creation_policy(&mint_a, accepted).await.unwrap_err();
        assert_eq!(err.code, RejectionCode::TokenDisabled);
        assert_eq!(err.revision, Some(2));
    }

    #[tokio::test]
    async fn transient_failures_schedule_retries_and_coalesce() {
        let h = harness();
        let game = tracked_game(&h);
        h.transport.on(|_, method, _| {
            (method == "getAccountInfo").then(|| Err(RpcError::transport("RPC request failed: connection reset")))
        });
        let result = h.service.complete_game_now(&game).await.unwrap();
        assert!(!result.success && !result.not_ready);
        assert!(is_transient_completion_failure(result.error.as_deref()), "{result:?}");
        {
            let retries = h.service.retries.lock().unwrap();
            let entry = retries.get(&game).expect("retry scheduled");
            assert_eq!(entry.phase, RetryPhase::Active);
            assert_eq!(entry.transient_attempt, 1);
            assert!(entry.timer.is_some());
        }
        let state = h.service.db.get_completion_attempt_state(&game).unwrap();
        assert_eq!(state.completion_failure_kind, Some(CompletionFailureKind::Transient));
        // A second wake-up while a transient retry is pending is coalesced.
        assert_eq!(h.service.complete_game_now(&game).await, None);

        h.service.on_game_finalized(&game);
        assert!(h.service.retries.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn exhausted_retries_enter_cooldown() {
        let h = harness();
        let game = tracked_game(&h);
        h.service.retries.lock().unwrap().insert(
            game.clone(),
            CompletionRetry {
                phase: RetryPhase::Active,
                mode: RetryMode::Transient,
                transient_attempt: 3,
                readiness_attempt: 0,
                timer: None,
                game_key: None,
                trigger: "test".into(),
                next_eligible_at: None,
            },
        );
        h.service.schedule_completion_retry(&game, None, "test", 4);
        let next = h.service.db.get_completion_attempt_state(&game).unwrap().completion_retry_after.unwrap();
        assert!(next > timba_common::time::now_ms());
        assert_eq!(h.service.retries.lock().unwrap().get(&game).unwrap().phase, RetryPhase::Cooldown);

        let result = h.service.complete_game_now(&game).await.unwrap();
        assert!(result.not_ready);
        assert_eq!(result.error, Some(format_cooldown_message(Some(next))));
        // Event-driven attempts are silently skipped during cooldown.
        h.service.clone().try_auto_complete(None, game.clone(), "player joined".into()).await;

        // A restart restores the persisted cooldown.
        h.service.clear_completion_retries();
        let result = h.service.complete_game_now(&game).await.unwrap();
        assert!(result.not_ready);
        assert_eq!(h.service.retries.lock().unwrap().get(&game).unwrap().phase, RetryPhase::Cooldown);
    }

    #[tokio::test]
    async fn stop_reasons() {
        let h = harness();
        let game = tracked_game(&h);
        assert_eq!(h.service.automatic_completion_stop_reason(&game, "x"), None);
        for _ in 0..MAX_COMPLETION_ATTEMPTS {
            h.service.db.increment_completion_attempts(&game).unwrap();
        }
        assert_eq!(
            h.service.automatic_completion_stop_reason(&game, "player joined").as_deref(),
            Some("completion attempt limit reached (5)")
        );
        // Permanent failures stop the fallback scan as well.
        assert!(h.service.automatic_completion_stop_reason(&game, "fallback scan").is_some());
        h.service.set_auto_complete_disabled(&game, true).unwrap().unwrap();
        assert_eq!(h.service.automatic_completion_stop_reason(&game, "x").as_deref(), Some("auto-complete disabled"));
        h.service.close().await;
        assert_eq!(h.service.automatic_completion_stop_reason(&game, "x").as_deref(), Some("service shutting down"));
        assert_eq!(h.service.complete_game_now(&game).await, None);
    }

    #[test]
    fn fallback_triggers() {
        assert!(is_fallback_scan_trigger("fallback scan"));
        assert!(is_fallback_scan_trigger("fallback scan retry 2"));
        assert!(!is_fallback_scan_trigger("player joined retry 1"));
        assert_eq!(
            format_cooldown_message(Some(0)),
            "Automatic completion is temporarily paused until 1970-01-01T00:00:00.000Z"
        );
    }

    #[tokio::test]
    async fn notifies_bot() {
        let h = harness();
        let result = CompletionResult { success: true, winner_address: Some("w".into()), ..Default::default() };
        // No bot URL configured: nothing to do.
        h.service.notify_bot_of_completion("g", &result).await.unwrap();
    }
}
