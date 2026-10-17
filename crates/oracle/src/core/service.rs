//! The oracle service: wires completion, events, scanning and token policy
//! together and owns the automatic-completion retry state machine (port of
//! `oracle-service.ts`).

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures::future::{BoxFuture, FutureExt};
use rand::Rng;
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
use super::expiry::ExpiryTimers;
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

impl From<ResetFailure> for RequeueFailure {
    fn from(failure: ResetFailure) -> Self {
        match failure {
            ResetFailure::NotFound => Self::NotFound,
            ResetFailure::Finalized => Self::Finalized,
            ResetFailure::Unchanged => Self::Unchanged,
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
    expiry: Arc<ExpiryTimers>,
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
        let expiry = ExpiryTimers::new();

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
            expiry: Some(expiry.clone()),
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
                http: timba_common::http_client::client_builder()
                    .timeout(Duration::from_secs(10))
                    .build()
                    .unwrap_or_default(),
                readiness_cache,
                expiry: expiry.clone(),
                retries: Mutex::new(HashMap::new()),
                next_timer: AtomicU64::new(1),
                active_runs: watch::channel(0).0,
                closing: AtomicBool::new(false),
                failover_task: Mutex::new(None),
                weak_self: weak.clone(),
            }
        });
        let weak = Arc::downgrade(&service);
        expiry.set_callback(Arc::new(move |game_address, game_key| match weak.upgrade() {
            Some(service) => service.try_auto_complete(Some(game_key), game_address, "expiry".into()).boxed(),
            None => futures::future::ready(()).boxed(),
        }));
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
        let endpoint = self.rpc.endpoint_label(endpoint);
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
        self.expiry.clear();
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
        rand::rng().fill_bytes(&mut secret);
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

    /// Prices an enabled policy; callers handle disabled ones themselves.
    async fn resolve_token_policy(&self, policy: &StoredTokenPolicy) -> anyhow::Result<TokenPolicy> {
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
            return Err(failure.into());
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
        let triggered = std::time::Instant::now();
        options.success_log = log_fn(move |_, _| {
            let elapsed = triggered.elapsed().as_millis();
            format!("🎯 Auto-completed game {address} after {success_trigger} in {elapsed}ms")
        });
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
        // The guard exists before the future is first polled, so a run dropped
        // unpolled (runtime shutdown) still releases its slot for close().
        self.active_runs.send_modify(|n| *n += 1);
        let guard = RunGuard(self.clone());
        let service = self.clone();
        async move {
            let _guard = guard;
            let game_address = options.game_address.clone();
            let game_key = options.game_key;
            let run = service.clone().run_auto_complete_attempt(options, game_key, trigger, retry_attempt, mode);
            match AssertUnwindSafe(run).catch_unwind().await {
                Ok(result) => result,
                Err(_) => {
                    // Without this the Active retry entry would deny every later
                    // trigger for the game until a restart.
                    error!("Auto-completion attempt for {game_address} panicked");
                    service.cancel_completion_retry(&game_address);
                    log_db_error(
                        service.db.increment_completion_attempts(&game_address),
                        "Failed to increment completion attempts",
                    );
                    None
                }
            }
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
        // The map was unlocked for the database reads above; another trigger may
        // have been admitted meanwhile, and only one lifecycle may own the game.
        let mut retries = self.retries.lock().unwrap();
        if retries.contains_key(game_address) {
            return Admission::Denied;
        }
        retries.insert(
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
        // The hook only lives as long as this attempt, which borrows the service.
        let service = self.clone();
        let on_result: super::types::ResultHook = Arc::new(move |result: &CompletionResult| {
            if !result.success || result.winner_address.is_none() {
                return;
            }
            let (service, result, address) = (service.clone(), result.clone(), game_address.clone());
            // Counted as a run so `close()` waits for it: CLI commands exit right
            // after closing, and Bun likewise let pending notifications finish.
            service.active_runs.send_modify(|n| *n += 1);
            let guard = RunGuard(service.clone());
            tokio::spawn(async move {
                let _guard = guard;
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
        // The future may run after the service is gone, so it upgrades when polled.
        let weak = self.weak_self.clone();
        async move {
            match weak.upgrade() {
                Some(service) => service.sync_player_registry(request).await,
                None => false,
            }
        }
        .boxed()
    }

    fn on_game_finalized(&self, game_address: &str) {
        self.cancel_completion_retry(game_address);
        self.expiry.cancel(game_address);
        self.events.cancel_registry_sync(game_address);
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
    use crate::core::testing::{count_rows, exec_sql, harness, harness_with, Harness, MINT_A, MINT_B};
    use crate::solana::rpc::RpcError;

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

    // -- ported oracle-service.ts cases -----------------------------------------

    use crate::core::scan::ScanLoopOptions;
    use base64::Engine;
    use futures::{SinkExt, StreamExt};
    use serde_json::{json, Value};
    use std::sync::atomic::AtomicUsize;
    use timba_protocol::contracts::{GameAccount, GameType, PROGRAM_ID};
    use timba_protocol::events::discriminators;
    use timba_protocol::ContractVersion;
    use tokio_tungstenite::tungstenite::Message;

    const BLOCK_TIME: i64 = 1_700_000_000;
    const BLOCKHASH: &str = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";

    fn serve_chain(h: &Harness) {
        h.transport.on(|_, method, _| match method {
            "getSlot" => Some(Ok(json!(100))),
            "getBlockTime" => Some(Ok(json!(BLOCK_TIME))),
            "getLatestBlockhash" => Some(Ok(json!({"value": {"blockhash": BLOCKHASH, "lastValidBlockHeight": 100}}))),
            "sendTransaction" => Some(Ok(json!("landed-sig"))),
            "getSignatureStatuses" => {
                Some(Ok(json!({"value": [{"slot": 1, "confirmationStatus": "confirmed", "err": null}]})))
            }
            "getBlockHeight" => Some(Ok(json!(1))),
            _ => None,
        });
    }

    fn game_value(tickets: u32, max: u32, min: u32, created_at: u64, timeout: u64) -> Value {
        let game = GameAccount {
            creator: Keypair::generate().address(),
            game_type: GameType::Coinflip,
            ticket_amount: 10,
            max_tickets: max,
            min_tickets: min,
            tickets_count: tickets,
            token_mint: Address([2; 32]),
            created_at,
            timeout,
            last_slot: 99,
            is_private: false,
            total_amount: 12_345,
            participants: (0..tickets).map(|i| Address([i as u8 + 10; 32])).collect(),
        };
        json!({"value": {
            "data": [base64::engine::general_purpose::STANDARD.encode(game.encode()), "base64"],
            "owner": PROGRAM_ID.to_base58(),
            "lamports": 1,
            "executable": false
        }})
    }

    fn serve_game(h: &Harness, value: Value) {
        h.transport.on(move |_, method, _| (method == "getAccountInfo").then(|| Ok(value.clone())));
    }

    fn ready_game(h: &Harness) -> (String, Vec<String>) {
        serve_chain(h);
        serve_game(h, game_value(2, 2, 2, 0, 60));
        let game = tracked_game(h);
        let roster: Vec<String> = (0..2).map(|_| Keypair::generate().address().to_base58()).collect();
        h.service.db.replace_game_players(&game, &roster).unwrap();
        (game, roster)
    }

    fn pending_game(h: &Harness) -> String {
        serve_chain(h);
        serve_game(h, game_value(1, 5, 2, BLOCK_TIME as u64, 600));
        let game = tracked_game(h);
        h.service.db.replace_game_players(&game, &[Keypair::generate().address().to_base58()]).unwrap();
        game
    }

    fn account_calls(h: &Harness) -> usize {
        h.transport.calls_for("getAccountInfo").len()
    }

    fn retry_entry<R>(h: &Harness, game: &str, read: impl FnOnce(&CompletionRetry) -> R) -> R {
        read(h.service.retries.lock().unwrap().get(game).expect("retry entry"))
    }

    fn active_entry(mode: RetryMode, attempt: usize, timer: Option<(u64, JoinHandle<()>)>) -> CompletionRetry {
        CompletionRetry {
            phase: RetryPhase::Active,
            mode,
            transient_attempt: if mode == RetryMode::Transient { attempt } else { 0 },
            readiness_attempt: if mode == RetryMode::Readiness { attempt } else { 0 },
            timer,
            game_key: None,
            trigger: "test".into(),
            next_eligible_at: None,
        }
    }

    async fn eventually(mut check: impl FnMut() -> bool) {
        for _ in 0..500 {
            if check() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("condition not reached");
    }

    /// Local bot endpoint capturing completion notifications.
    async fn bot_server(status: u16) -> (String, tokio::sync::mpsc::UnboundedReceiver<Value>) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let app = axum::Router::new().route(
            BOT_COMPLETED_PATH,
            axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                let tx = tx.clone();
                async move {
                    tx.send(body).unwrap();
                    (axum::http::StatusCode::from_u16(status).unwrap(), axum::Json(json!({"error": "bot offline"})))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}/"), rx)
    }

    /// Local logs-subscription endpoint counting `logsSubscribe` requests.
    async fn ws_server() -> (String, Arc<AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let subscriptions = Arc::new(AtomicUsize::new(0));
        let counter = subscriptions.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let counter = counter.clone();
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else { return };
                    while let Some(Ok(message)) = ws.next().await {
                        let Ok(request) = serde_json::from_str::<Value>(message.to_text().unwrap_or_default()) else {
                            continue;
                        };
                        if request["method"] == "logsSubscribe" {
                            counter.fetch_add(1, Ordering::SeqCst);
                            let reply = json!({"jsonrpc": "2.0", "id": request["id"], "result": 1});
                            if ws.send(Message::Text(reply.to_string().into())).await.is_err() {
                                return;
                            }
                        }
                    }
                });
            }
        });
        (format!("ws://{addr}"), subscriptions)
    }

    fn joined_log(game: &Address, player: &str, ticket_index: u32) -> String {
        let mut data = discriminators::PLAYER_JOINED.to_vec();
        data.extend_from_slice(&game.0);
        data.extend_from_slice(&Address::parse(player).unwrap().0);
        data.extend_from_slice(&10u64.to_le_bytes());
        data.extend_from_slice(&(ticket_index + 1).to_le_bytes());
        data.extend_from_slice(&ticket_index.to_le_bytes());
        data.extend_from_slice(&5u64.to_le_bytes());
        data.extend_from_slice(&6u64.to_le_bytes());
        format!("Program data: {}", base64::engine::general_purpose::STANDARD.encode(data))
    }

    #[tokio::test]
    async fn accessors_stats_and_maintenance() {
        let h = harness();
        assert_eq!(h.service.config().contract_version, ContractVersion::V0_2_0);
        assert!(h.service.db().is_open());
        assert_eq!(h.service.metrics().cleanup_sweeps().len(), 0);
        assert_eq!(h.service.connection().active_endpoint(), "https://a");
        assert_eq!(h.service.program().program_id, PROGRAM_ID);
        assert_eq!(OracleService::program_id(&h.service), PROGRAM_ID);
        assert_eq!(h.service.completion_manager().program_id(), PROGRAM_ID);
        assert!(!h.service.events().is_listening());
        assert!(h.service.readiness_cache().lock().unwrap().is_empty());
        let _ = h.service.scan_runner();

        let oracle: &dyn WebGameOracle = h.service.as_ref();
        assert_eq!(oracle.program_id(), PROGRAM_ID);
        assert_eq!(oracle.rpc().active_endpoint(), "https://a");
        let secrets = oracle.generate_game_secrets(Some("dice")).await.unwrap();
        assert_eq!(h.service.db.get_game_type(&secrets.game_address).as_deref(), Some("dice"));
        assert_eq!(oracle.sign_game_transaction("").await.unwrap_err().to_string(), "Invalid transaction payload");
        h.service.db.set_token_policy(MINT_A, true, 9).unwrap();
        assert_eq!(oracle.token_policies().await.unwrap()[0].mint, MINT_A);

        let stats = h.service.get_stats();
        assert_eq!(stats.db.total_secrets, 1);
        assert_eq!(stats.db.pending_games, 1);
        assert!(!stats.event_listening);
        assert_eq!(stats.active_listeners, 0);
        let json = serde_json::to_value(stats).unwrap();
        assert_eq!(json["totalSecrets"], 1);
        assert_eq!(json["eventListening"], false);
        assert_eq!(json["activeListeners"], 0);

        for (failure, text) in [
            (RequeueFailure::InvalidAddress, "invalid-address"),
            (RequeueFailure::MissingSecret, "missing-secret"),
            (RequeueFailure::NotFound, "not-found"),
            (RequeueFailure::Finalized, "finalized"),
            (RequeueFailure::Unchanged, "unchanged"),
        ] {
            assert_eq!(failure.as_str(), text);
            assert_eq!(serde_json::to_value(failure).unwrap(), json!(text));
        }
        assert_eq!(format_cooldown_message(None), "Automatic completion is temporarily paused");

        assert_eq!(h.service.cleanup_old_records(24), CleanupCounts::default());
        h.service.cleanup_old_records(-1);
        let sweeps: Vec<i64> = h.service.metrics().cleanup_sweeps().iter().map(|s| s.hours_old).collect();
        assert_eq!(sweeps, vec![24, -1]);
    }

    #[tokio::test]
    async fn completes_ready_games_and_notifies_the_bot() {
        let (url, mut bodies) = bot_server(200).await;
        let mut config = OracleConfig::for_tests();
        config.bot_internal_url = Some(url);
        let h = harness_with(config, Keypair::generate(), &["https://a"]);
        let (game, roster) = ready_game(&h);

        let result = h.service.complete_game_now(&game).await.unwrap();
        assert!(result.success, "{result:?}");
        let winner = result.winner_address.clone().unwrap();
        assert!(roster.contains(&winner));
        assert!(h.service.retries.lock().unwrap().is_empty());
        assert_eq!(h.service.db.get_game_status(&game).as_deref(), Some("completed"));

        let body = tokio::time::timeout(Duration::from_secs(5), bodies.recv()).await.unwrap().unwrap();
        assert_eq!(
            body,
            json!({"gameAddress": game, "winnerAddress": winner, "winnerTxSignature": "landed-sig", "totalPot": 12_345})
        );
        // Finished games are not admitted again.
        assert_eq!(h.service.complete_game_now(&game).await, None);
    }

    #[tokio::test]
    async fn close_waits_for_bot_notifications() {
        // The bot answers slowly; `close()` must not return before it is told.
        let (tx, mut bodies) = tokio::sync::mpsc::unbounded_channel();
        let app = axum::Router::new().route(
            BOT_COMPLETED_PATH,
            axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                let tx = tx.clone();
                async move {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    tx.send(body).unwrap();
                    axum::http::StatusCode::OK
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut config = OracleConfig::for_tests();
        config.bot_internal_url = Some(url);
        let h = harness_with(config, Keypair::generate(), &["https://a"]);
        let (game, _) = ready_game(&h);

        assert!(h.service.complete_game_now(&game).await.unwrap().success);
        h.service.close().await;
        assert_eq!(bodies.try_recv().unwrap()["gameAddress"], game.as_str());
    }

    #[tokio::test]
    async fn bot_notification_failures() {
        let (url, mut bodies) = bot_server(500).await;
        let mut config = OracleConfig::for_tests();
        config.bot_internal_url = Some(url);
        let h = harness_with(config, Keypair::generate(), &["https://a"]);
        let result = CompletionResult {
            success: true,
            winner_address: Some("w".into()),
            tx_hash: Some("sig".into()),
            total_pot: Some(5),
            ..Default::default()
        };
        // A non-200 response is logged, not raised.
        h.service.notify_bot_of_completion("g", &result).await.unwrap();
        assert_eq!(bodies.recv().await.unwrap()["gameAddress"], "g");

        let incomplete = CompletionResult { tx_hash: None, ..result.clone() };
        assert_eq!(
            h.service.notify_bot_of_completion("g", &incomplete).await.unwrap_err().to_string(),
            "Completed game result is missing notification data"
        );

        let mut config = OracleConfig::for_tests();
        config.bot_internal_url = Some("http://127.0.0.1:1".into());
        let offline = harness_with(config, Keypair::generate(), &["https://a"]);
        assert!(offline.service.notify_bot_of_completion("g", &result).await.is_err());

        let mut config = OracleConfig::for_tests();
        config.bot_internal_url = Some("  ".into());
        let blank = harness_with(config, Keypair::generate(), &["https://a"]);
        blank.service.notify_bot_of_completion("g", &incomplete).await.unwrap();
    }

    #[tokio::test]
    async fn wake_ups_require_an_address_and_queue_in_the_background() {
        let h = harness();
        for address in ["", "   "] {
            let required = Some(CompletionResult::failure("gameAddress is required"));
            assert_eq!(h.service.complete_game_now(address).await, required);
            assert_eq!(h.service.queue_game_completion(address), required);
            assert_eq!(h.service.queue_completion(address), required);
        }

        let (game, _) = ready_game(&h);
        assert_eq!(h.service.queue_completion(&format!("  {game}  ")), None);
        eventually(|| h.service.db.get_game_status(&game).as_deref() == Some("completed")).await;

        let (other, _) = ready_game(&h);
        assert_eq!(h.service.queue_game_completion(&other), None);
        eventually(|| h.service.db.get_game_status(&other).as_deref() == Some("completed")).await;
        h.service.close().await;
    }

    #[tokio::test(start_paused = true)]
    async fn readiness_retries_back_off_and_exhaust() {
        let h = harness();
        let game = pending_game(&h);

        let result = h.service.complete_game_now(&game).await.unwrap();
        assert!(result.not_ready && !result.success, "{result:?}");
        retry_entry(&h, &game, |entry| {
            assert_eq!(entry.mode, RetryMode::Readiness);
            assert_eq!(entry.readiness_attempt, 1);
            assert!(entry.timer.is_some());
        });
        let calls = account_calls(&h);

        // A fresh wake-up consumes the pending readiness retry immediately.
        let result = h.service.complete_game_now(&game).await.unwrap();
        assert!(result.not_ready);
        assert!(account_calls(&h) > calls);
        retry_entry(&h, &game, |entry| {
            assert_eq!(entry.readiness_attempt, 2);
            assert_eq!(entry.trigger, "bot wake-up");
        });

        // The remaining retries fire on their own and then give up.
        let calls = account_calls(&h);
        tokio::time::sleep(Duration::from_millis(2_900)).await;
        assert_eq!(account_calls(&h), calls);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(account_calls(&h) > calls, "readiness retry 2 fired");
        retry_entry(&h, &game, |entry| assert_eq!(entry.readiness_attempt, 3));
        tokio::time::sleep(Duration::from_secs(11)).await;
        assert!(h.service.retries.lock().unwrap().is_empty(), "readiness retries exhausted");
        let state = h.service.db.get_completion_attempt_state(&game).unwrap();
        assert_eq!(state.completion_attempts, 0);
        assert_eq!(state.completion_retry_after, None);
    }

    #[tokio::test(start_paused = true)]
    async fn games_with_their_minimum_players_complete_at_expiry_without_a_scan() {
        let h = harness();
        // The chain clock is driven by the test; the timer runs on paused tokio time.
        let chain_time = Arc::new(std::sync::atomic::AtomicI64::new(BLOCK_TIME));
        let clock = chain_time.clone();
        h.transport.on(move |_, method, _| {
            (method == "getBlockTime").then(|| Ok(json!(clock.load(std::sync::atomic::Ordering::SeqCst))))
        });
        let timeout = 60;
        let created_at = timba_common::time::now_secs() as u64 - 5;
        serve_chain(&h);
        serve_game(&h, game_value(2, 5, 2, created_at, timeout));
        let game = tracked_game(&h);
        let roster: Vec<String> = (0..2).map(|_| Keypair::generate().address().to_base58()).collect();
        h.service.db.replace_game_players(&game, &roster).unwrap();
        let expires_at = (created_at + timeout) as i64;

        let result = h.service.complete_game_now(&game).await.unwrap();
        assert!(result.not_ready, "{result:?}");
        assert_eq!(h.service.expiry.scheduled(&game), Some(expires_at));

        // Readiness retries run out long before the game expires.
        tokio::time::sleep(Duration::from_secs(30)).await;
        assert!(h.service.retries.lock().unwrap().is_empty());
        assert_eq!(h.service.db.get_game_status(&game).as_deref(), Some("pending"));

        chain_time.store(expires_at, std::sync::atomic::Ordering::SeqCst);
        tokio::time::sleep(Duration::from_secs(25)).await;
        assert_eq!(h.service.db.get_game_status(&game).as_deref(), Some("pending"), "not before the deadline");
        tokio::time::sleep(Duration::from_secs(10)).await;
        assert_eq!(h.service.db.get_game_status(&game).as_deref(), Some("completed"));
        assert_eq!(h.service.expiry.scheduled(&game), None);
        h.service.close().await;
    }

    #[tokio::test]
    async fn finalized_and_closed_services_drop_expiry_timers() {
        let h = harness();
        serve_chain(&h);
        serve_game(&h, game_value(1, 5, 1, BLOCK_TIME as u64, 600));
        let game = tracked_game(&h);
        h.service.complete_game_now(&game).await.unwrap();
        assert!(h.service.expiry.scheduled(&game).is_some());
        h.service.on_game_finalized(&game);
        assert_eq!(h.service.expiry.scheduled(&game), None);

        h.service.complete_game_now(&game).await.unwrap();
        assert!(h.service.expiry.scheduled(&game).is_some());
        h.service.close().await;
        assert_eq!(h.service.expiry.scheduled(&game), None);
    }

    #[tokio::test(start_paused = true)]
    async fn expiry_timers_outliving_the_service_do_nothing() {
        let h = harness();
        let expiry = h.service.expiry.clone();
        drop(h);
        expiry.schedule("gone", Address([1; 32]), 0);
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert_eq!(expiry.scheduled("gone"), None);
    }

    #[tokio::test(start_paused = true)]
    async fn transient_retries_escalate_into_a_cooldown() {
        let h = harness();
        let game = tracked_game(&h);
        h.transport.on(|_, method, _| {
            (method == "getAccountInfo").then(|| Err(RpcError::transport("RPC request failed: connection reset")))
        });

        let result = h.service.complete_game_now(&game).await.unwrap();
        assert!(is_transient_completion_failure(result.error.as_deref()), "{result:?}");
        assert_eq!(retry_entry(&h, &game, |e| e.transient_attempt), 1);
        let first = account_calls(&h);

        tokio::time::sleep(Duration::from_millis(5_100)).await;
        assert!(account_calls(&h) > first, "retry 1 fired after 5s");
        assert_eq!(retry_entry(&h, &game, |e| e.transient_attempt), 2);
        tokio::time::sleep(Duration::from_secs(50)).await;

        let next = retry_entry(&h, &game, |entry| {
            assert_eq!(entry.phase, RetryPhase::Cooldown);
            assert_eq!(entry.transient_attempt, 4);
            entry.next_eligible_at.unwrap()
        });
        let state = h.service.db.get_completion_attempt_state(&game).unwrap();
        assert_eq!(state.completion_retry_after, Some(next));
        assert_eq!(state.completion_failure_kind, Some(CompletionFailureKind::Transient));
        assert!(next >= timba_common::time::now_ms() + COMPLETION_RECOVERY_COOLDOWN_MS - 60_000);

        let calls = account_calls(&h);
        let result = h.service.complete_game_now(&game).await.unwrap();
        assert_eq!(result, CompletionResult::not_ready_with(format_cooldown_message(Some(next))));
        assert_eq!(account_calls(&h), calls, "cooldown wake-ups do not touch the chain");

        // Entering the cooldown again while it is active changes nothing.
        h.service.enter_completion_cooldown(&game, None, "again", 5);
        assert_eq!(retry_entry(&h, &game, |e| e.next_eligible_at), Some(next));

        tokio::time::sleep(Duration::from_millis((COMPLETION_RECOVERY_COOLDOWN_MS + 60_000) as u64)).await;
        assert!(h.service.retries.lock().unwrap().is_empty(), "cooldown ended");
    }

    #[tokio::test]
    async fn failed_simulations_count_as_permanent_failures() {
        let h = harness();
        let (game, _) = ready_game(&h);
        let simulation = "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1771";
        h.transport.push("sendTransaction", Err(RpcError::json_rpc(-32002, simulation)));
        let result = h.service.complete_game_now(&game).await.unwrap();
        assert!(!result.success && !result.not_ready, "{result:?}");
        assert!(result.error.as_deref().unwrap().contains("custom program error"), "{result:?}");
        assert!(!is_transient_completion_failure(result.error.as_deref()), "{result:?}");
        assert!(h.service.retries.lock().unwrap().is_empty());
        let state = h.service.db.get_completion_attempt_state(&game).unwrap();
        assert_eq!(state.completion_attempts, 1);
        assert_eq!(state.completion_failure_kind, Some(CompletionFailureKind::Permanent));
    }

    #[tokio::test]
    async fn permanent_errors_stop_retrying() {
        let h = harness();
        let game = tracked_game(&h);
        // Protocol-level JSON-RPC errors stay transient, as in the TypeScript oracle.
        assert!(is_transient_completion_failure(Some(&RpcError::json_rpc(-32602, "invalid param").to_string())));
        serve_game(&h, token_account_value(&PROGRAM_ID, vec![0; 3]));
        let result = h.service.complete_game_now(&game).await.unwrap();
        assert!(!result.success && !result.not_ready, "{result:?}");
        assert!(!is_transient_completion_failure(result.error.as_deref()), "{result:?}");
        assert!(h.service.retries.lock().unwrap().is_empty());
        let state = h.service.db.get_completion_attempt_state(&game).unwrap();
        assert_eq!(state.completion_attempts, 1);
        assert_eq!(state.completion_failure_kind, Some(CompletionFailureKind::Permanent));
    }

    #[tokio::test]
    async fn stop_reasons_for_finalized_games() {
        let h = harness();
        let completed = tracked_game(&h);
        h.service.db.mark_game_completed(&completed).unwrap();
        assert_eq!(
            h.service.automatic_completion_stop_reason(&completed, "x").as_deref(),
            Some("game already completed")
        );
        let cancelled = tracked_game(&h);
        h.service.db.mark_game_closed(&cancelled).unwrap();
        assert_eq!(
            h.service.automatic_completion_stop_reason(&cancelled, "x").as_deref(),
            Some("game already cancelled")
        );
        let desynced = tracked_game(&h);
        h.service.db.mark_game_desynced(&desynced).unwrap();
        assert_eq!(h.service.automatic_completion_stop_reason(&desynced, "x").as_deref(), Some("game is desynced"));
        for game in [&completed, &cancelled, &desynced] {
            assert_eq!(h.service.complete_game_now(game).await, None);
        }

        // A game finalized between admission and the attempt is skipped.
        let racing = pending_game(&h);
        let attempt = h.service.start_automatic_completion_attempt(
            AttemptOptions::new(&racing),
            "player joined".into(),
            0,
            false,
            RetryMode::Transient,
        );
        assert!(h.service.retries.lock().unwrap().contains_key(&racing));
        h.service.db.mark_game_completed(&racing).unwrap();
        assert_eq!(attempt.await, None);
        assert!(!h.service.retries.lock().unwrap().contains_key(&racing));
    }

    #[tokio::test]
    async fn a_panicking_attempt_releases_the_game() {
        let h = harness();
        let (game, _) = ready_game(&h);
        // A bug in a log formatter panics inside the attempt.
        let options = AttemptOptions {
            success_log: Some(Arc::new(|_: &str, _: Option<&str>| -> String { panic!("simulated bug in a log hook") })),
            ..AttemptOptions::new(&game)
        };
        let attempt = h.service.start_automatic_completion_attempt(
            options,
            "player joined".into(),
            0,
            false,
            RetryMode::Transient,
        );
        assert_eq!(attempt.await, None);
        assert!(!h.service.retries.lock().unwrap().contains_key(&game), "retry entry released");
        // Only the bot notification spawned before the panic may still be counted.
        let mut runs = h.service.active_runs.subscribe();
        tokio::time::timeout(Duration::from_secs(5), runs.wait_for(|n| *n == 0)).await.unwrap().unwrap();
        assert_eq!(h.service.db.get_completion_attempt_state(&game).unwrap().completion_attempts, 1);
    }

    #[tokio::test]
    async fn dropping_an_unpolled_attempt_releases_its_run_slot() {
        let h = harness();
        let game = pending_game(&h);
        let attempt = h.service.start_automatic_completion_attempt(
            AttemptOptions::new(&game),
            "player joined".into(),
            0,
            false,
            RetryMode::Transient,
        );
        assert_eq!(*h.service.active_runs.borrow(), 1);
        drop(attempt);
        assert_eq!(*h.service.active_runs.borrow(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_triggers_admit_one_lifecycle() {
        for _ in 0..20 {
            let h = harness();
            let game = pending_game(&h);
            let barrier = Arc::new(std::sync::Barrier::new(8));
            let handles: Vec<_> = (0..8)
                .map(|_| {
                    let (service, game, barrier) = (h.service.clone(), game.clone(), barrier.clone());
                    std::thread::spawn(move || {
                        barrier.wait();
                        service.admit_automatic_completion(&game, None, "player joined", 0, RetryMode::Transient)
                    })
                })
                .collect();
            let allowed =
                handles.into_iter().map(|h| h.join().unwrap()).filter(|a| matches!(a, Admission::Allowed)).count();
            assert_eq!(allowed, 1);
        }
    }

    #[tokio::test]
    async fn requeue_reactivates_finalized_games() {
        let h = harness();
        let game = tracked_game(&h);
        h.service.db.finalize_completed_game(&game).unwrap();
        assert_eq!(h.service.db.get_secret_key(&game), None);
        h.service.retries.lock().unwrap().insert(game.clone(), active_entry(RetryMode::Transient, 1, None));
        h.service
            .readiness_cache
            .lock()
            .unwrap()
            .insert(game.clone(), Readiness { ready: false, game_account: None, evaluated_at: None });

        assert_eq!(h.service.requeue_game(&format!(" {game} ")), Ok(()));
        assert_eq!(h.service.db.get_game_status(&game).as_deref(), Some("pending"));
        assert!(h.service.db.get_secret_key(&game).is_some(), "secret reactivated");
        assert!(h.service.retries.lock().unwrap().is_empty());
        assert!(h.service.readiness_cache.lock().unwrap().is_empty());

        // Toggling auto-complete also drops the cached readiness.
        h.service
            .readiness_cache
            .lock()
            .unwrap()
            .insert(game.clone(), Readiness { ready: false, game_account: None, evaluated_at: None });
        assert_eq!(h.service.set_auto_complete_disabled(&game, true).unwrap(), Ok(true));
        assert!(h.service.readiness_cache.lock().unwrap().is_empty());
        assert!(h.service.set_auto_complete_disabled("unknown", true).unwrap().is_err());
    }

    #[tokio::test]
    async fn admission_rules() {
        let h = harness();
        let game = pending_game(&h);

        // Retries are only admitted for the lifecycle that scheduled them.
        let retry = |attempt: usize, mode: RetryMode| {
            h.service.start_automatic_completion_attempt(
                AttemptOptions::new(&game),
                "player joined retry".into(),
                attempt,
                true,
                mode,
            )
        };
        assert_eq!(retry(1, RetryMode::Transient).await, None);
        assert!(h.service.retries.lock().unwrap().is_empty());
        h.service.retries.lock().unwrap().insert(game.clone(), active_entry(RetryMode::Transient, 2, None));
        assert_eq!(retry(1, RetryMode::Transient).await, None, "stale attempt number");
        assert_eq!(retry(2, RetryMode::Readiness).await, None, "different mode");
        let result = retry(2, RetryMode::Transient).await.unwrap();
        assert!(result.not_ready, "expected retry runs");
        h.service.cancel_completion_retry(&game);

        // An expired cooldown is cleared and the attempt proceeds.
        h.service.retries.lock().unwrap().insert(
            game.clone(),
            CompletionRetry {
                phase: RetryPhase::Cooldown,
                next_eligible_at: Some(timba_common::time::now_ms() - 1),
                ..active_entry(RetryMode::Transient, 4, None)
            },
        );
        let result = h.service.complete_game_now(&game).await.unwrap();
        assert!(result.not_ready);
        assert!(result.error.as_deref().is_none_or(|e| !e.contains("temporarily paused")), "{result:?}");
        assert_eq!(retry_entry(&h, &game, |e| e.mode), RetryMode::Readiness);
        h.service.cancel_completion_retry(&game);

        // A persisted cooldown that already elapsed is cleared as well.
        assert!(h.service.db.set_completion_retry_after(&game, timba_common::time::now_ms() + 30).unwrap());
        tokio::time::sleep(Duration::from_millis(60)).await;
        let result = h.service.complete_game_now(&game).await.unwrap();
        assert!(result.not_ready);
        assert_eq!(h.service.db.get_completion_attempt_state(&game).unwrap().completion_retry_after, None);
        h.service.clear_completion_retries();
    }

    #[tokio::test]
    async fn fired_retries_check_ownership() {
        let h = harness();
        let game = tracked_game(&h);
        h.transport.on(|_, method, _| {
            (method == "getAccountInfo").then(|| Err(RpcError::transport("RPC request failed: connection reset")))
        });

        // No entry: nothing happens.
        h.service.clone().fire_retry(1, game.clone(), None, "t".into(), 1, RetryMode::Transient).await;
        assert_eq!(account_calls(&h), 0);

        // A timer that no longer owns the entry is ignored.
        let parked = tokio::spawn(futures::future::pending::<()>());
        h.service
            .retries
            .lock()
            .unwrap()
            .insert(game.clone(), active_entry(RetryMode::Transient, 1, Some((99, parked))));
        h.service.clone().fire_retry(1, game.clone(), None, "t".into(), 1, RetryMode::Transient).await;
        assert_eq!(account_calls(&h), 0);
        assert_eq!(retry_entry(&h, &game, |e| e.timer.as_ref().map(|(t, _)| *t)), Some(99));
        h.service.cancel_completion_retry(&game);

        // The owning timer runs the next attempt and schedules the following one.
        let parked = tokio::spawn(futures::future::pending::<()>());
        h.service
            .retries
            .lock()
            .unwrap()
            .insert(game.clone(), active_entry(RetryMode::Transient, 1, Some((7, parked))));
        let key = Address::parse(&game).ok();
        h.service.clone().fire_retry(7, game.clone(), key, "player joined".into(), 1, RetryMode::Transient).await;
        assert_eq!(account_calls(&h), 1);
        retry_entry(&h, &game, |entry| {
            assert_eq!(entry.transient_attempt, 2);
            assert_eq!(entry.trigger, "player joined retry 1");
            assert_eq!(entry.game_key, key);
            assert!(entry.timer.is_some());
        });

        // Games that stopped in the meantime drop their retry.
        let parked = tokio::spawn(futures::future::pending::<()>());
        h.service
            .retries
            .lock()
            .unwrap()
            .insert(game.clone(), active_entry(RetryMode::Readiness, 1, Some((8, parked))));
        h.service.db.mark_game_desynced(&game).unwrap();
        h.service.clone().fire_retry(8, game.clone(), None, "t".into(), 1, RetryMode::Readiness).await;
        assert!(h.service.retries.lock().unwrap().is_empty());
        assert_eq!(account_calls(&h), 1);

        // Scheduling for a stopped game cancels instead.
        h.service.retries.lock().unwrap().insert(game.clone(), active_entry(RetryMode::Readiness, 1, None));
        h.service.schedule_readiness_retry(&game, None, "t", 2);
        assert!(h.service.retries.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn schedule_retry_guards() {
        let h = harness();
        let game = tracked_game(&h);
        // Without an entry there is nothing to schedule.
        h.service.schedule_completion_retry(&game, None, "t", 1);
        assert!(h.service.retries.lock().unwrap().is_empty());
        // An entry with a pending timer keeps it.
        let parked = tokio::spawn(futures::future::pending::<()>());
        h.service
            .retries
            .lock()
            .unwrap()
            .insert(game.clone(), active_entry(RetryMode::Transient, 1, Some((42, parked))));
        h.service.schedule_completion_retry(&game, None, "t", 2);
        assert_eq!(retry_entry(&h, &game, |e| (e.transient_attempt, e.timer.as_ref().map(|(t, _)| *t))), (1, Some(42)));
        // Exhausted readiness retries drop the entry.
        h.service.schedule_readiness_retry(&game, None, "t", READINESS_RETRY_DELAYS_MS.len() + 1);
        assert!(h.service.retries.lock().unwrap().is_empty());
        h.service.close().await;
        h.service.retries.lock().unwrap().insert(game.clone(), active_entry(RetryMode::Transient, 1, None));
        h.service.schedule_completion_retry(&game, None, "t", 2);
        assert!(h.service.retries.lock().unwrap().is_empty(), "closing services cancel retries");
    }

    #[tokio::test]
    async fn cooldown_timers_release_only_their_own_entries() {
        let h = harness();
        let game = tracked_game(&h);
        let soon = timba_common::time::now_ms() + 20;
        h.service.install_completion_cooldown(&game, None, "t", 4, soon);
        let token = retry_entry(&h, &game, |e| e.timer.as_ref().map(|(t, _)| *t));
        // Re-installing an equal or earlier deadline keeps the running timer.
        h.service.install_completion_cooldown(&game, None, "t", 4, soon - 5);
        assert_eq!(retry_entry(&h, &game, |e| e.timer.as_ref().map(|(t, _)| *t)), token);
        eventually(|| h.service.retries.lock().unwrap().is_empty()).await;

        // A timer whose entry was replaced leaves the new entry alone.
        h.service.install_completion_cooldown(&game, None, "t", 4, timba_common::time::now_ms() + 20);
        h.service.retries.lock().unwrap().insert(game.clone(), active_entry(RetryMode::Readiness, 2, None));
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(retry_entry(&h, &game, |e| e.readiness_attempt), 2);

        // Installing over an active entry keeps its readiness progress.
        h.service.install_completion_cooldown(&game, None, "t", 4, timba_common::time::now_ms() + 60_000);
        retry_entry(&h, &game, |entry| {
            assert_eq!(entry.phase, RetryPhase::Cooldown);
            assert_eq!(entry.readiness_attempt, 2);
        });
        h.service.clear_completion_retries();
    }

    #[tokio::test]
    async fn fallback_scan_adapter() {
        let h = harness();
        let game = pending_game(&h);
        let adapter = ScanAdapter { service: Arc::downgrade(&h.service), completion: h.service.completion.clone() };
        let block_time = BlockTimeCache::default();
        match adapter.resolve(&game, &block_time).await.unwrap() {
            ReadinessResolution::Resolved { ready, .. } => assert!(!ready),
            ReadinessResolution::MissingContext => panic!("context expected"),
        }
        // Fallback scans do not schedule readiness retries.
        let result = adapter.attempt(AttemptOptions::new(&game)).await.unwrap().unwrap();
        assert!(result.not_ready);
        assert!(h.service.retries.lock().unwrap().is_empty());
        // Unknown games resolve to nothing and are not retried.
        assert_eq!(adapter.attempt(AttemptOptions::new("unknown")).await.unwrap(), None);
        assert!(h.service.retries.lock().unwrap().is_empty());

        // Event-driven attempts without context schedule a readiness retry.
        h.service.clone().try_auto_complete(None, "unknown".into(), "player joined".into()).await;
        assert_eq!(retry_entry(&h, "unknown", |e| (e.mode, e.readiness_attempt)), (RetryMode::Readiness, 1));
        h.service.cancel_completion_retry("unknown");

        // A fallback scan retry without context keeps the transient burst going.
        h.service.retries.lock().unwrap().insert("unknown".into(), active_entry(RetryMode::Transient, 1, None));
        let result = h
            .service
            .start_automatic_completion_attempt(
                AttemptOptions::new("unknown"),
                "fallback scan retry 1".into(),
                1,
                false,
                RetryMode::Transient,
            )
            .await;
        assert_eq!(result, None);
        assert_eq!(retry_entry(&h, "unknown", |e| e.transient_attempt), 2);
        h.service.clear_completion_retries();

        let orphan = ScanAdapter { service: Weak::new(), completion: h.service.completion.clone() };
        assert_eq!(orphan.attempt(AttemptOptions::new(&game)).await.unwrap(), None);
    }

    #[tokio::test]
    async fn scan_loop_completes_games_and_cleans_up() {
        let h = harness();
        let (game, _) = ready_game(&h);
        let summary = h
            .service
            .run_scan_loop(ScanLoopOptions {
                wait_between_cycles_ms: Some(0),
                wait_for_pending_only: false,
                cleanup_after_cycle_hours: Some(24),
                should_continue: Some(Arc::new(|_, _| false)),
                signal: None,
            })
            .await
            .unwrap();
        assert_eq!(summary.cycles, 1);
        assert_eq!(summary.total_completed, 1);
        assert_eq!(h.service.db.get_game_status(&game).as_deref(), Some("completed"));
        assert_eq!(h.service.metrics().cleanup_sweeps().iter().map(|s| s.hours_old).collect::<Vec<_>>(), vec![24]);
    }

    #[tokio::test]
    async fn event_hooks_sync_registries_and_trigger_completion() {
        let h = harness();
        let hooks: &dyn EventHooks = h.service.as_ref();
        let request = |game: &str, key: Option<Address>| RegistrySyncRequest {
            game_address: game.to_string(),
            expected_tickets: Some(2),
            trigger: "test".into(),
            game_key: key,
        };

        let game = tracked_game(&h);
        let pda = Address::parse(&game).unwrap();
        let roster: Vec<String> = (0..2).map(|_| Keypair::generate().address().to_base58()).collect();
        let program = PROGRAM_ID.to_base58();
        let logs = vec![
            format!("Program {program} invoke [1]"),
            joined_log(&pda, &roster[0], 0),
            joined_log(&pda, &roster[1], 1),
            format!("Program {program} success"),
        ];
        h.transport.push("getSignaturesForAddress", Ok(json!([{"signature": "s1", "slot": 10}])));
        h.transport.push("getTransaction", Ok(json!({"slot": 10, "meta": {"err": null, "logMessages": logs}})));
        assert!(hooks.sync_player_registry(request(&game, None)).await, "stored PDA resolved");
        assert_eq!(h.service.db.get_game_players(&game), roster);

        // No history: nothing to replace.
        h.transport.push("getSignaturesForAddress", Ok(json!([])));
        assert!(!hooks.sync_player_registry(request(&game, Some(pda))).await);
        // RPC failures are reported as unsuccessful syncs.
        h.transport.push("getSignaturesForAddress", Err(RpcError::transport("RPC request failed: down")));
        assert!(!hooks.sync_player_registry(request(&game, Some(pda))).await);
        // Unknown games have no PDA to read.
        assert!(!hooks.sync_player_registry(request("unknown", None)).await);
        // Corrupt stored hashes cannot be resolved.
        h.service.db.save_secret_key("corrupt", &hex::encode([1u8; 32]), "zz").unwrap();
        h.service.db.track_game("corrupt", None, false).unwrap();
        assert!(!hooks.sync_player_registry(request("corrupt", None)).await);

        // Storage failures are reported too.
        h.transport.push("getSignaturesForAddress", Ok(json!([{"signature": "s1", "slot": 10}])));
        h.transport.push("getTransaction", Ok(json!({"slot": 10, "meta": {"err": null, "logMessages": logs}})));
        h.service.db.close();
        assert!(!hooks.sync_player_registry(request(&game, Some(pda))).await);
    }

    #[tokio::test]
    async fn event_hook_auto_completion_uses_the_parsed_key() {
        let h = harness();
        let game = pending_game(&h);
        let hooks: &dyn EventHooks = h.service.as_ref();
        hooks.try_auto_complete(None, game.clone(), "player joined".into()).await;
        retry_entry(&h, &game, |entry| {
            assert_eq!(entry.mode, RetryMode::Readiness);
            assert_eq!(entry.game_key, Address::parse(&game).ok());
            assert_eq!(entry.trigger, "player joined");
        });
        hooks.on_game_finalized(&game);
        assert!(h.service.retries.lock().unwrap().is_empty());

        // Closing services ignore event-driven attempts.
        h.service.close().await;
        h.service.clone().try_auto_complete(None, game.clone(), "player joined".into()).await;
        assert!(h.service.retries.lock().unwrap().is_empty());
    }

    fn fixture_operator() -> (Keypair, Value) {
        let fixture: Value = serde_json::from_str(include_str!("../../tests/fixtures/signer.json")).unwrap();
        let bytes: Vec<u8> =
            fixture["operatorKeypair"].as_array().unwrap().iter().map(|b| b.as_u64().unwrap() as u8).collect();
        (Keypair::from_bytes(&bytes).unwrap(), fixture)
    }

    fn fixture_case<'a>(fixture: &'a Value, name: &str) -> &'a Value {
        fixture["cases"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap()
    }

    const FIXTURE_GAME: &str = "Aad42Q3ngADSVorsbTQmpiKaMfu8jBSPya65iJF8Kfox";
    const FIXTURE_HASH: &str = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";

    fn signing_harness(version: ContractVersion, hash: &str) -> (Harness, Value) {
        let (operator, fixture) = fixture_operator();
        let mut config = OracleConfig::for_tests();
        config.contract_version = version;
        let h = harness_with(config, operator, &["https://a"]);
        h.service.db.save_secret_key(FIXTURE_GAME, &hex::encode([7u8; 32]), hash).unwrap();
        h.service.db.track_game(FIXTURE_GAME, None, false).unwrap();
        (h, fixture)
    }

    #[tokio::test]
    async fn signs_commitments_through_the_service() {
        let (h, fixture) = signing_harness(ContractVersion::V0_2_0, FIXTURE_HASH);
        let case = fixture_case(&fixture, "0.2.0 placeholder");
        let signed = h.service.sign_game_transaction(case["txBase64"].as_str().unwrap()).await.unwrap();
        assert_eq!(signed, case["expected"]["ok"].as_str().unwrap());

        // A commitment that cannot be marked signed is rejected generically.
        let (h, _) = signing_harness(ContractVersion::V0_2_0, FIXTURE_HASH);
        h.service.db.mark_game_completed(FIXTURE_GAME).unwrap();
        let err = h.service.sign_game_transaction(case["txBase64"].as_str().unwrap()).await.unwrap_err();
        assert!(matches!(err, GameTransactionError::Validation(_)));
        assert_eq!(err.to_string(), "Transaction could not be signed");

        // Hashes must match the stored commitment.
        let (h, _) = signing_harness(ContractVersion::V0_2_0, &hex::encode([9u8; 32]));
        let err = h.service.sign_game_transaction(case["txBase64"].as_str().unwrap()).await.unwrap_err();
        assert_eq!(err.to_string(), "Random hash is not an unused oracle commitment");

        // 0.3.0 creations go through the token policy.
        let (h, fixture) = signing_harness(ContractVersion::V0_3_0, FIXTURE_HASH);
        let case = fixture_case(&fixture, "0.3.0 placeholder");
        let err = h.service.sign_game_transaction(case["txBase64"].as_str().unwrap()).await.unwrap_err();
        match &err {
            GameTransactionError::CreationPolicy(policy) => assert_eq!(policy.code, RejectionCode::UnsupportedMint),
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(err.to_string(), "Token mint is not supported");
    }

    fn token_account_value(owner: &Address, data: Vec<u8>) -> Value {
        json!({"value": {
            "data": [base64::engine::general_purpose::STANDARD.encode(data), "base64"],
            "owner": owner.to_base58(),
            "lamports": 1,
            "executable": false
        }})
    }

    #[tokio::test]
    async fn sets_token_policies() {
        use timba_protocol::address::{find_associated_token_address, TOKEN_PROGRAM_ID};
        let h = harness();
        let mint = Address::parse(MINT_A).unwrap();
        let operator = h.service.operator_address();
        let ata = find_associated_token_address(&operator, &mint, &TOKEN_PROGRAM_ID);
        let mut mint_data = vec![0u8; 82];
        mint_data[44] = 9;
        mint_data[45] = 1;
        let mut ata_data = vec![0u8; 165];
        ata_data[..32].copy_from_slice(mint.as_bytes());
        ata_data[32..64].copy_from_slice(operator.as_bytes());
        ata_data[108] = 1;
        let (mint_value, ata_value) =
            (token_account_value(&TOKEN_PROGRAM_ID, mint_data), token_account_value(&TOKEN_PROGRAM_ID, ata_data));
        let (mint_key, ata_key) = (mint.to_base58(), ata.to_base58());
        h.transport.on(move |_, method, params| {
            (method == "getAccountInfo").then(|| {
                let address = params[0].as_str().unwrap();
                Ok(if address == mint_key {
                    mint_value.clone()
                } else if address == ata_key {
                    ata_value.clone()
                } else {
                    json!({"value": null})
                })
            })
        });

        let enabled = h.service.set_token_policy(MINT_A, true).await.unwrap();
        assert_eq!(enabled.mint, MINT_A);
        assert!(enabled.enabled);
        assert_ne!(enabled.minimum_amount_raw, "0");
        assert_eq!(h.service.db.get_token_policy(MINT_A).unwrap().unwrap().decimals, 9);

        let disabled = h.service.set_token_policy(MINT_A, false).await.unwrap();
        assert!(!disabled.enabled);
        assert_eq!(h.service.db.get_token_policy(MINT_A).unwrap().unwrap().decimals, 9, "decimals survive disabling");
        assert_eq!(disabled.minimum_amount_raw, "0");
        let policies = h.service.get_token_policies().await.unwrap();
        assert_eq!(policies.len(), 1, "disabled policies are listed");
        assert!(!policies[0].enabled);

        assert!(h.service.set_token_policy("not a mint", true).await.is_err());
        assert_eq!(h.service.set_token_policy(MINT_B, true).await.unwrap_err().to_string(), "missing price");
        assert!(h.service.db.get_token_policy(MINT_B).unwrap().is_none());

        h.service.db.close();
        let err = h.service.check_creation_policy(&mint, 1).await.unwrap_err();
        assert_eq!(err.code, RejectionCode::PolicyUnavailable);
        assert_eq!(err.revision, None);
    }

    #[tokio::test]
    async fn event_listeners_follow_rpc_failover() {
        let (url, subscriptions) = ws_server().await;
        let mut config = OracleConfig::for_tests();
        config.solana_ws_endpoint = Some(url);
        let h = harness_with(config, Keypair::generate(), &["https://a", "https://b"]);

        h.service.start_event_listening().await.unwrap();
        h.service.start_event_listening().await.unwrap();
        let stats = h.service.get_stats();
        assert!(stats.event_listening);
        assert!(stats.active_listeners > 0);
        assert_eq!(subscriptions.load(Ordering::SeqCst), 1);
        let observer = h.service.add_program_event_observer(Arc::new(|| {}));
        h.service.remove_program_event_observer(observer);

        h.transport.on(|endpoint, method, _| {
            (endpoint == "https://a" && method == "getSlot")
                .then(|| Err(RpcError::http(503, "Service Unavailable", None)))
        });
        h.transport.on(|_, method, _| (method == "getSlot").then(|| Ok(json!(7))));
        assert_eq!(h.service.connection().get_slot().await.unwrap(), 7);
        assert_eq!(h.service.connection().active_endpoint(), "https://b");
        eventually(|| subscriptions.load(Ordering::SeqCst) == 2).await;
        eventually(|| h.service.get_stats().event_listening).await;

        h.service.stop_event_listening().await;
        assert!(!h.service.get_stats().event_listening);
        h.service.stop_event_listening().await;
        h.service.close().await;
        assert!(!h.service.db().is_open());
    }

    #[tokio::test]
    async fn listener_restarts_give_up_after_three_attempts() {
        let mut config = OracleConfig::for_tests();
        config.solana_ws_endpoint = Some("ws://127.0.0.1:1".into());
        let h = harness_with(config, Keypair::generate(), &["https://a", "https://b"]);
        assert!(h.service.start_event_listening().await.is_err());
        assert!(!h.service.get_stats().event_listening);
        assert!(h.service.restart_event_listeners_with_retries("https://b").await.is_err());

        // Failovers while not listening leave the listeners alone.
        h.transport.on(|endpoint, method, _| {
            (endpoint == "https://a" && method == "getSlot").then(|| Err(RpcError::http(503, "unavailable", None)))
        });
        h.transport.on(|_, method, _| (method == "getSlot").then(|| Ok(json!(1))));
        assert_eq!(h.service.connection().get_slot().await.unwrap(), 1);
        tokio::task::yield_now().await;
        assert!(!h.service.get_stats().event_listening);
    }

    #[test]
    fn reset_failures_map_onto_requeue_failures() {
        assert_eq!(RequeueFailure::from(ResetFailure::NotFound), RequeueFailure::NotFound);
        assert_eq!(RequeueFailure::from(ResetFailure::Finalized), RequeueFailure::Finalized);
        assert_eq!(RequeueFailure::from(ResetFailure::Unchanged), RequeueFailure::Unchanged);
    }

    #[tokio::test]
    async fn requeue_failures_are_reported_and_undone() {
        let h = harness();
        let dir = h._dir.path();

        // A status outside the known lifecycle cannot be requeued.
        let odd = tracked_game(&h);
        exec_sql(dir, &format!("UPDATE game_tracking SET status = 'archived' WHERE game_address = '{odd}'"));
        assert_eq!(h.service.requeue_game(&odd), Err(RequeueFailure::Finalized));

        // A storage failure while resetting leaves the counters alone.
        let busy = tracked_game(&h);
        h.service.db.increment_completion_attempts(&busy).unwrap();
        let reset = "BEFORE UPDATE ON game_tracking WHEN NEW.completion_attempts = 0 AND OLD.completion_attempts > 0";
        exec_sql(dir, &format!("CREATE TRIGGER no_reset {reset} BEGIN SELECT RAISE(ABORT, 'disk full'); END;"));
        assert_eq!(h.service.requeue_game(&busy), Err(RequeueFailure::Unchanged));
        assert_eq!(h.service.db.get_completion_attempt_state(&busy).unwrap().completion_attempts, 1);

        // So does an update that silently matches nothing.
        exec_sql(dir, "DROP TRIGGER no_reset");
        exec_sql(dir, &format!("CREATE TRIGGER skip_reset {reset} BEGIN SELECT RAISE(IGNORE); END;"));
        assert_eq!(h.service.requeue_game(&busy), Err(RequeueFailure::Unchanged));
        assert_eq!(h.service.db.get_completion_attempt_state(&busy).unwrap().completion_attempts, 1);
        exec_sql(dir, "DROP TRIGGER skip_reset");
        assert_eq!(h.service.requeue_game(&busy), Ok(()));

        // A secret reactivated for a finalized game is put back when the reset fails.
        let done = tracked_game(&h);
        h.service.db.finalize_completed_game(&done).unwrap();
        exec_sql(
            dir,
            "CREATE TRIGGER keep_done BEFORE UPDATE ON game_tracking \
             WHEN NEW.status = 'pending' AND OLD.status = 'completed' \
             BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
        );
        assert_eq!(h.service.requeue_game(&done), Err(RequeueFailure::Unchanged));
        assert_eq!(h.service.db.get_secret_key(&done), None, "secret is used up again");
        assert_eq!(h.service.db.get_game_status(&done).as_deref(), Some("completed"));
    }

    #[tokio::test]
    async fn failed_tracking_rolls_back_the_new_secret() {
        let h = harness();
        let dir = h._dir.path();
        exec_sql(
            dir,
            "CREATE TRIGGER no_tracking BEFORE INSERT ON game_tracking BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
        );
        let err = h.service.generate_game_secrets(None).unwrap_err();
        assert!(format!("{err:#}").contains("disk full"), "{err:#}");
        assert_eq!(count_rows(dir, "secret_keys"), 0, "the unusable commitment is removed");

        // When the rollback fails too, the original error still surfaces.
        exec_sql(
            dir,
            "CREATE TRIGGER keep_secrets BEFORE DELETE ON secret_keys BEGIN SELECT RAISE(ABORT, 'read-only'); END;",
        );
        let err = h.service.generate_game_secrets(None).unwrap_err();
        assert!(format!("{err:#}").contains("disk full"), "{err:#}");
        assert_eq!(count_rows(dir, "secret_keys"), 1);
    }

    #[tokio::test]
    async fn complete_game_resolves_readiness_itself() {
        let h = harness();
        let (game, roster) = ready_game(&h);
        let result = h.service.complete_game(&game, None, None).await;
        assert!(result.success, "{result:?}");
        assert!(roster.contains(&result.winner_address.unwrap()));
        assert_eq!(h.service.db.get_game_status(&game).as_deref(), Some("completed"));
    }

    #[tokio::test]
    async fn missing_registries_are_recovered_from_chain_history() {
        let h = harness();
        let (game, roster) = ready_game(&h);
        h.service.db.replace_game_players(&game, &[]).unwrap();
        let pda = Address::parse(&game).unwrap();
        let program = PROGRAM_ID.to_base58();
        let logs = vec![
            format!("Program {program} invoke [1]"),
            joined_log(&pda, &roster[0], 0),
            joined_log(&pda, &roster[1], 1),
            format!("Program {program} success"),
        ];
        h.transport.push("getSignaturesForAddress", Ok(json!([{"signature": "s1", "slot": 10}])));
        h.transport.push("getTransaction", Ok(json!({"slot": 10, "meta": {"err": null, "logMessages": logs}})));

        let result = h.service.complete_game_now(&game).await.unwrap();
        assert!(result.success, "{result:?}");
        assert!(roster.contains(&result.winner_address.unwrap()), "the winner comes from the recovered roster");
        assert_eq!(h.transport.calls_for("getSignaturesForAddress").len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn transient_submission_failures_schedule_the_next_retry() {
        let h = harness();
        // Registered first, so it wins over the chain fixtures.
        h.transport.on(|_, method, _| {
            (method == "sendTransaction").then(|| Err(RpcError::transport("RPC request failed: connection reset")))
        });
        let (game, _) = ready_game(&h);
        let parked = tokio::spawn(futures::future::pending::<()>());
        h.service
            .retries
            .lock()
            .unwrap()
            .insert(game.clone(), active_entry(RetryMode::Transient, 1, Some((7, parked))));

        h.service.clone().fire_retry(7, game.clone(), None, "player joined".into(), 1, RetryMode::Transient).await;
        assert!(!h.transport.calls_for("sendTransaction").is_empty());
        retry_entry(&h, &game, |entry| {
            assert_eq!(entry.transient_attempt, 2);
            assert_eq!(entry.trigger, "player joined retry 1");
            assert!(entry.timer.is_some());
        });
        let state = h.service.db.get_completion_attempt_state(&game).unwrap();
        assert_eq!(state.completion_failure_kind, Some(CompletionFailureKind::Transient));
        assert_eq!(h.service.db.get_game_status(&game).as_deref(), Some("pending"));
    }

    #[tokio::test]
    async fn retry_counters_continue_from_the_attempt_in_flight() {
        let h = harness();
        // Without an entry the counter follows the retry that is running.
        assert_eq!(h.service.next_transient_attempt("g", RetryMode::Transient, 3), 4);
        assert_eq!(h.service.next_transient_attempt("g", RetryMode::Readiness, 3), 1);
        assert_eq!(h.service.next_readiness_attempt("g", RetryMode::Readiness, 3), 4);
        assert_eq!(h.service.next_readiness_attempt("g", RetryMode::Transient, 3), 1);
        // An active entry's own counter wins.
        h.service.retries.lock().unwrap().insert("g".into(), active_entry(RetryMode::Transient, 2, None));
        assert_eq!(h.service.next_transient_attempt("g", RetryMode::Transient, 9), 3);
        assert_eq!(h.service.next_readiness_attempt("g", RetryMode::Transient, 9), 1);
    }

    #[tokio::test]
    async fn offline_bots_do_not_undo_completions() {
        let mut config = OracleConfig::for_tests();
        config.bot_internal_url = Some("http://127.0.0.1:1".into());
        let h = harness_with(config, Keypair::generate(), &["https://a"]);
        let (game, _) = ready_game(&h);
        let result = h.service.complete_game_now(&game).await.unwrap();
        assert!(result.success, "{result:?}");
        // `close()` waits for the failed notification instead of hanging on it.
        h.service.close().await;
        assert_eq!(*h.service.active_runs.borrow(), 0);
    }

    #[tokio::test]
    async fn registry_syncs_outliving_the_service_do_nothing() {
        let h = harness();
        let hooks: &dyn EventHooks = h.service.as_ref();
        let sync = hooks.sync_player_registry(RegistrySyncRequest {
            game_address: "g".into(),
            expected_tickets: Some(2),
            trigger: "test".into(),
            game_key: None,
        });
        let service = Arc::downgrade(&h.service);
        drop(h);
        assert!(service.upgrade().is_none(), "the pending sync does not keep the service alive");
        assert!(!sync.await);
    }

    #[tokio::test]
    async fn lagging_behind_failovers_keeps_the_listener_alive() {
        let (url, subscriptions) = ws_server().await;
        let mut config = OracleConfig::for_tests();
        config.solana_ws_endpoint = Some(url);
        let h = harness_with(config, Keypair::generate(), &["https://a", "https://b"]);
        h.service.start_event_listening().await.unwrap();
        assert_eq!(subscriptions.load(Ordering::SeqCst), 1);

        // More switches than the channel holds, before the listener task runs again.
        let failing = Arc::new(Mutex::new(String::new()));
        let current = failing.clone();
        h.transport.on(move |endpoint, method, _| {
            (method == "getSlot").then(|| {
                if endpoint == *current.lock().unwrap() {
                    Err(RpcError::http(503, "unavailable", None))
                } else {
                    Ok(json!(1))
                }
            })
        });
        for _ in 0..20 {
            *failing.lock().unwrap() = h.service.connection().active_endpoint().to_string();
            h.service.connection().get_slot().await.unwrap();
        }
        eventually(|| subscriptions.load(Ordering::SeqCst) > 1).await;
        eventually(|| h.service.get_stats().event_listening).await;
    }

    #[tokio::test]
    async fn failed_failover_restarts_leave_the_listeners_stopped() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else { return };
                    while let Some(Ok(Message::Text(text))) = socket.next().await {
                        let request: Value = serde_json::from_str(&text).unwrap();
                        let ack = json!({ "jsonrpc": "2.0", "id": request["id"], "result": 1 });
                        let _ = socket.send(Message::Text(ack.to_string().into())).await;
                    }
                });
            }
        });
        let mut config = OracleConfig::for_tests();
        config.solana_ws_endpoint = Some(url);
        let h = harness_with(config, Keypair::generate(), &["https://a", "https://b"]);
        h.service.start_event_listening().await.unwrap();
        // The websocket node goes away before the failover.
        server.abort();
        let _ = server.await;

        h.transport.on(|endpoint, method, _| {
            (endpoint == "https://a" && method == "getSlot").then(|| Err(RpcError::http(503, "unavailable", None)))
        });
        h.transport.on(|_, method, _| (method == "getSlot").then(|| Ok(json!(1))));
        assert_eq!(h.service.connection().get_slot().await.unwrap(), 1);
        // Three restart attempts with 250 ms and 500 ms pauses in between.
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        assert!(!h.service.get_stats().event_listening);
    }
}
