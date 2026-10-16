//! Fallback scan over pending games (port of `oracle-scan-runner.ts`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use futures::future::{BoxFuture, FutureExt};
use timba_common::shutdown::Shutdown;
use timba_common::{error, info, warn};

use super::completion::{BlockTimeCache, CompletionManager, ResolveOptions};
use super::types::{format_completion_stats, AttemptOptions, CompletionResult, CompletionStats, ReadinessResolution};
use crate::db::OracleDatabase;
use crate::metrics::{CompletionOutcome, CompletionRecord, OracleMetrics, ScanCycleRecord};

pub const DEFAULT_DELAY_MS: u64 = 1_000;

/// The completion operations the scan needs (implemented by
/// [`CompletionManager`]; replaceable in tests).
pub trait ScanCompletion: Send + Sync {
    fn resolve<'a>(
        &'a self,
        game_address: &'a str,
        block_time: &'a BlockTimeCache,
    ) -> BoxFuture<'a, anyhow::Result<ReadinessResolution>>;
    fn attempt(&self, options: AttemptOptions) -> BoxFuture<'_, anyhow::Result<Option<CompletionResult>>>;
}

impl ScanCompletion for CompletionManager {
    fn resolve<'a>(
        &'a self,
        game_address: &'a str,
        block_time: &'a BlockTimeCache,
    ) -> BoxFuture<'a, anyhow::Result<ReadinessResolution>> {
        self.resolve_context_and_readiness(
            game_address,
            ResolveOptions { require_on_chain: true, block_time_cache: Some(block_time), ..Default::default() },
        )
        .boxed()
    }

    fn attempt(&self, options: AttemptOptions) -> BoxFuture<'_, anyhow::Result<Option<CompletionResult>>> {
        self.attempt_game_completion(options).boxed()
    }
}

pub type CleanupFn = Arc<dyn Fn(i64) -> anyhow::Result<()> + Send + Sync>;
pub type ContinueFn = Arc<dyn Fn(&CompletionStats, u64) -> bool + Send + Sync>;

pub struct ScanLoopRunnerOptions {
    pub db: Arc<OracleDatabase>,
    pub metrics: Arc<OracleMetrics>,
    pub completion: Arc<dyn ScanCompletion>,
    pub inter_game_delay_ms: u64,
    pub max_completion_attempts: i64,
    pub cleanup_old_records: CleanupFn,
}

#[derive(Clone, Default)]
pub struct ScanLoopOptions {
    pub wait_between_cycles_ms: Option<u64>,
    pub wait_for_pending_only: bool,
    pub cleanup_after_cycle_hours: Option<i64>,
    pub should_continue: Option<ContinueFn>,
    pub signal: Option<Shutdown>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScanLoopSummary {
    pub cycles: u64,
    pub total_completed: u64,
    pub total_errors: u64,
    pub total_not_ready: u64,
    pub last_stats: Option<CompletionStats>,
}

pub struct ScanLoopRunner {
    options: ScanLoopRunnerOptions,
    running: AtomicBool,
}

fn aborted(signal: Option<&Shutdown>) -> bool {
    signal.is_some_and(Shutdown::is_triggered)
}

async fn delay(ms: u64, signal: Option<&Shutdown>) {
    match signal {
        Some(signal) => signal.sleep(ms).await,
        None if ms > 0 => tokio::time::sleep(std::time::Duration::from_millis(ms)).await,
        None => {}
    }
}

impl ScanLoopRunner {
    pub fn new(options: ScanLoopRunnerOptions) -> Self {
        Self { options, running: AtomicBool::new(false) }
    }

    pub async fn scan_and_complete_active_games(&self, signal: Option<&Shutdown>) -> CompletionStats {
        let options = &self.options;
        let mut stats = CompletionStats::default();
        let pending_games = options.db.get_active_pending_games(Some(options.max_completion_attempts));
        let pending_count = pending_games.len();
        let scan_start = Instant::now();
        let record_cycle = |stats: &CompletionStats| {
            options.metrics.record_scan_cycle(ScanCycleRecord {
                duration_ms: scan_start.elapsed().as_secs_f64() * 1000.0,
                completed: stats.completed,
                errors: stats.errors,
                not_ready: stats.not_ready,
                pending: pending_count as u64,
            });
        };

        if pending_count == 0 || aborted(signal) {
            record_cycle(&stats);
            return stats;
        }
        info!("🔍 Scanning {pending_count} pending games...");

        let block_time = BlockTimeCache::default();
        for (index, game) in pending_games.iter().enumerate() {
            if aborted(signal) {
                break;
            }
            let address = game.game_address.as_str();
            let outcome: anyhow::Result<bool> = async {
                let resolution = options.completion.resolve(address, &block_time).await?;
                if aborted(signal) {
                    return Ok(true);
                }
                let (context, readiness) = match resolution {
                    ReadinessResolution::MissingContext => {
                        self.handle_missing_context(&mut stats, address, game.completion_attempts);
                        return Ok(false);
                    }
                    ReadinessResolution::Resolved { context, readiness, .. } => (context, readiness),
                };

                // Event subscriptions can miss GameInitialized across RPC
                // disconnects or restarts. A decoded on-chain game proves the
                // commitment must survive abandoned-commitment cleanup.
                options.db.mark_secret_key_committed(address)?;

                let ready = readiness.ready;
                let mut attempt = AttemptOptions::new(address);
                attempt.context = Some(context);
                attempt.readiness = Some(readiness);
                attempt.skip_readiness_check = true;
                let result = options.completion.attempt(attempt).await?;
                if aborted(signal) {
                    return Ok(true);
                }
                match &result {
                    Some(result) => {
                        update_scan_stats(&mut stats, result);
                        if result.not_ready {
                            options.db.touch_game_check(address)?;
                        }
                    }
                    None => options.db.touch_game_check(address)?,
                }
                if !ready {
                    block_time.clear();
                }
                if self.should_throttle_between_games(result.as_ref(), index, pending_count) {
                    delay(options.inter_game_delay_ms, signal).await;
                }
                Ok(false)
            }
            .await;

            match outcome {
                Ok(true) => break,
                Ok(false) => {}
                Err(err) => {
                    stats.errors += 1;
                    error!("❌ Error completing game {address}: {err:#}");
                    options.metrics.record_completion(CompletionRecord {
                        game_address: address.to_string(),
                        outcome: CompletionOutcome::Error,
                        error: Some(format!("{err:#}")),
                    });
                    // Push failing games back so we do not spin on stale timestamps.
                    if let Err(touch_error) = options.db.touch_game_check(address) {
                        error!("Failed to touch game check for {address}: {touch_error:#}");
                    }
                    block_time.clear();
                    if aborted(signal) {
                        break;
                    }
                    delay(options.inter_game_delay_ms, signal).await;
                }
            }
        }

        log_scan_results(&stats);
        record_cycle(&stats);
        stats
    }

    fn handle_missing_context(&self, stats: &mut CompletionStats, address: &str, completion_attempts: i64) {
        let options = &self.options;
        let has_secret = options.db.get_secret_key(address).is_some();
        let attempts = completion_attempts + 1;
        let max_reached = attempts >= options.max_completion_attempts;

        if has_secret && !max_reached {
            // Be patient if we have the secret; it might be RPC flakiness.
            stats.not_ready += 1;
            warn!(
                "⚠️  Game {address} account not found on-chain (attempt {attempts}/{}); retrying later.",
                options.max_completion_attempts
            );
            if let Err(err) = options.db.increment_completion_attempts(address) {
                error!("Failed to increment completion attempts for {address}: {err:#}");
            }
            if let Err(err) = options.db.touch_game_check(address) {
                error!("Failed to touch game check for {address}: {err:#}");
            }
            return;
        }

        stats.errors += 1;
        let reason = if has_secret {
            error!("⚠️  Game {address} lost its on-chain account after {attempts} attempts; marking as desynced.");
            "missing-game-account"
        } else {
            error!("❌ Game {address} is missing its secret key; marking as desynced.");
            "missing-secret"
        };
        if let Err(err) = options.db.mark_game_desynced(address) {
            error!("Failed to mark game {address} desynced: {err:#}");
        }
        options.metrics.record_completion(CompletionRecord {
            game_address: address.to_string(),
            outcome: CompletionOutcome::Error,
            error: Some(reason.to_string()),
        });
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub async fn run_scan_loop(&self, options: ScanLoopOptions) -> anyhow::Result<ScanLoopSummary> {
        if self.running.swap(true, Ordering::SeqCst) {
            anyhow::bail!("Scan loop is already running");
        }
        // Reset even when the loop future is dropped or panics; otherwise every later
        // call fails with "already running".
        struct Running<'a>(&'a AtomicBool);
        impl Drop for Running<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _running = Running(&self.running);
        let wait_between_cycles_ms = options.wait_between_cycles_ms.unwrap_or(DEFAULT_DELAY_MS);
        let signal = options.signal.as_ref();
        let should_abort = || aborted(signal) || !self.running.load(Ordering::SeqCst);

        let mut summary = ScanLoopSummary::default();
        while !should_abort() {
            summary.cycles += 1;
            let stats = self.scan_and_complete_active_games(signal).await;
            summary.total_completed += stats.completed;
            summary.total_errors += stats.errors;
            summary.total_not_ready += stats.not_ready;
            summary.last_stats = Some(stats);

            if let Some(hours) = options.cleanup_after_cycle_hours {
                if let Err(err) = (self.options.cleanup_old_records)(hours) {
                    error!("Cleanup after scan cycle failed: {err:#}");
                }
            }
            if should_abort() {
                break;
            }
            let continue_loop = match &options.should_continue {
                Some(should_continue) => should_continue(&stats, summary.cycles),
                None => stats.completed > 0 || stats.not_ready > 0 || stats.errors > 0,
            };
            if !continue_loop {
                break;
            }
            let only_errors = stats.errors > 0 && stats.completed == 0 && stats.not_ready == 0;
            let effective_delay = if options.wait_for_pending_only && !only_errors && stats.not_ready == 0 {
                0
            } else {
                wait_between_cycles_ms
            };
            if effective_delay > 0 {
                delay(effective_delay, signal).await;
            } else if options.wait_for_pending_only && options.should_continue.is_none() {
                break;
            }
        }
        Ok(summary)
    }

    pub fn should_throttle_between_games(&self, result: Option<&CompletionResult>, index: usize, total: usize) -> bool {
        if self.options.inter_game_delay_ms == 0 || index + 1 >= total {
            return false;
        }
        result.is_none_or(|result| !result.success)
    }
}

pub fn update_scan_stats(stats: &mut CompletionStats, result: &CompletionResult) {
    if result.success {
        stats.completed += 1;
    } else if result.not_ready {
        stats.not_ready += 1;
    } else {
        stats.errors += 1;
    }
}

fn log_scan_results(stats: &CompletionStats) {
    let formatted = format_completion_stats(stats);
    if !formatted.is_empty() {
        info!("📊 Scan: {formatted}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::types::{GameContext, Readiness};
    use crate::db::SecretKeyData;
    use std::sync::Mutex;
    use std::time::Duration;

    struct FakeCompletion {
        resolutions: Mutex<Vec<anyhow::Result<ReadinessResolution>>>,
        attempts: Mutex<Vec<String>>,
        result: CompletionResult,
    }

    impl ScanCompletion for FakeCompletion {
        fn resolve<'a>(
            &'a self,
            _game: &'a str,
            block_time: &'a BlockTimeCache,
        ) -> BoxFuture<'a, anyhow::Result<ReadinessResolution>> {
            block_time.set(1);
            let next = self.resolutions.lock().unwrap().remove(0);
            async move { next }.boxed()
        }
        fn attempt(&self, options: AttemptOptions) -> BoxFuture<'_, anyhow::Result<Option<CompletionResult>>> {
            self.attempts.lock().unwrap().push(options.game_address);
            let result = self.result.clone();
            async move { Ok(Some(result)) }.boxed()
        }
    }

    fn resolved(ready: bool) -> ReadinessResolution {
        ReadinessResolution::Resolved {
            ready,
            context: GameContext {
                game_pda: timba_protocol::Address([1; 32]),
                secret: SecretKeyData { secret_key: "s".into(), random_hash: "h".into() },
                random_hash: [0; 32],
                readiness: None,
            },
            readiness: Readiness { ready, game_account: None, evaluated_at: Some(1) },
            prefetch_scheduled: false,
        }
    }

    fn setup(
        resolutions: Vec<anyhow::Result<ReadinessResolution>>,
        result: CompletionResult,
    ) -> (tempfile::TempDir, Arc<OracleDatabase>, Arc<FakeCompletion>, Arc<OracleMetrics>, ScanLoopRunner) {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(OracleDatabase::open(dir.path().join("o.sqlite").to_str().unwrap()).unwrap());
        let completion =
            Arc::new(FakeCompletion { resolutions: Mutex::new(resolutions), attempts: Mutex::default(), result });
        let metrics = Arc::new(OracleMetrics::new(10));
        let runner = ScanLoopRunner::new(ScanLoopRunnerOptions {
            db: db.clone(),
            metrics: metrics.clone(),
            completion: completion.clone(),
            inter_game_delay_ms: 0,
            max_completion_attempts: 2,
            cleanup_old_records: Arc::new(|_| Ok(())),
        });
        (dir, db, completion, metrics, runner)
    }

    fn track(db: &OracleDatabase, game: &str, with_secret: bool) {
        if with_secret {
            db.save_secret_key(game, "secret", "hash").unwrap();
        }
        db.track_game(game, None, true).unwrap();
    }

    #[tokio::test]
    async fn completes_ready_games() {
        let success = CompletionResult { success: true, ..Default::default() };
        let (_dir, db, completion, metrics, runner) = setup(vec![Ok(resolved(true))], success);
        track(&db, "g1", true);
        let stats = runner.scan_and_complete_active_games(None).await;
        assert_eq!(stats, CompletionStats { completed: 1, errors: 0, not_ready: 0 });
        assert_eq!(completion.attempts.lock().unwrap().clone(), vec!["g1".to_string()]);
        // Committed secrets survive the abandoned-commitment sweep.
        assert_eq!(db.cleanup_unsigned_commitments(-1), 0);
        assert_eq!(metrics.scan_cycles().len(), 1);
    }

    #[tokio::test]
    async fn handles_missing_context() {
        let (_dir, db, _completion, metrics, runner) = setup(
            vec![
                Ok(ReadinessResolution::MissingContext),
                Ok(ReadinessResolution::MissingContext),
                Ok(ReadinessResolution::MissingContext),
            ],
            CompletionResult::default(),
        );
        track(&db, "patient", true);
        track(&db, "orphan", false);
        let stats = runner.scan_and_complete_active_games(None).await;
        assert_eq!(stats, CompletionStats { completed: 0, errors: 1, not_ready: 1 });
        assert_eq!(db.get_game_status("orphan").as_deref(), Some("desynced"));
        assert_eq!(db.get_completion_attempt_state("patient").unwrap().completion_attempts, 1);
        // The second miss reaches the attempt limit.
        let stats = runner.scan_and_complete_active_games(None).await;
        assert_eq!(stats.errors, 1);
        assert_eq!(db.get_game_status("patient").as_deref(), Some("desynced"));
        let errors: Vec<_> = metrics.completion_records().into_iter().filter_map(|r| r.error).collect();
        assert_eq!(errors, vec!["missing-secret".to_string(), "missing-game-account".to_string()]);
    }

    #[tokio::test]
    async fn counts_resolution_errors() {
        let (_dir, db, _completion, _metrics, runner) =
            setup(vec![Err(anyhow::anyhow!("RPC request failed: boom"))], CompletionResult::default());
        track(&db, "g1", true);
        let stats = runner.scan_and_complete_active_games(None).await;
        assert_eq!(stats.errors, 1);
    }

    #[tokio::test]
    async fn loop_stops_when_idle_and_rejects_reentry() {
        let (_dir, _db, _completion, _metrics, runner) = setup(vec![], CompletionResult::default());
        let summary = runner.run_scan_loop(ScanLoopOptions::default()).await.unwrap();
        assert_eq!(summary.cycles, 1);
        assert_eq!(summary.last_stats, Some(CompletionStats::default()));

        let signal = Shutdown::new();
        let calls = Arc::new(Mutex::new(0u64));
        let counter = calls.clone();
        let trigger = signal.clone();
        let options = ScanLoopOptions {
            wait_between_cycles_ms: Some(1),
            should_continue: Some(Arc::new(move |_, cycle| {
                *counter.lock().unwrap() = cycle;
                if cycle == 3 {
                    trigger.trigger();
                }
                true
            })),
            signal: Some(signal),
            ..Default::default()
        };
        let summary = runner.run_scan_loop(options).await.unwrap();
        assert_eq!(summary.cycles, 3);
        assert_eq!(*calls.lock().unwrap(), 3);
        assert!(!runner.is_running());
    }

    #[tokio::test(start_paused = true)]
    async fn a_dropped_loop_can_be_started_again() {
        let (_dir, _db, _completion, _metrics, runner) = setup(vec![], CompletionResult::default());
        let options = || ScanLoopOptions {
            wait_between_cycles_ms: Some(60_000),
            should_continue: Some(Arc::new(|_, _| true)),
            ..Default::default()
        };
        // Cancel the loop while it waits between cycles.
        assert!(tokio::time::timeout(Duration::from_secs(1), runner.run_scan_loop(options())).await.is_err());
        assert!(!runner.is_running(), "the running flag is reset when the loop is dropped");
        let again = tokio::time::timeout(Duration::from_secs(1), runner.run_scan_loop(options())).await;
        assert!(again.is_err(), "a second loop starts instead of failing with 'already running'");
    }
}
