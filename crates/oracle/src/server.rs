//! Process entry for `timba-oracle serve` (port of `index.ts` `start()`).
//!
//! Serves the HTTP API, starts the program event listeners and supervises the
//! background workers. A worker crash stops the whole process with exit code 1
//! so the supervisor restarts it cleanly.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use futures::future::BoxFuture;
use futures::FutureExt;
use tokio::task::JoinHandle;

use timba_common::shutdown::Shutdown;
use timba_common::signal::on_termination;
use timba_common::{error, info, warn};

use crate::config::OracleConfig;
use crate::core::scan::{ScanLoopOptions, ScanLoopSummary, DEFAULT_DELAY_MS};
use crate::core::service::OracleService;
use crate::http::{self, RouterOptions};
use crate::indexer::{self, IndexerDatabase, PublicIndexer};
use crate::web_api::WebGameApi;

const FALLBACK_SCAN_INTERVAL_MS: u64 = 300_000;
const VERIFICATION_INTERVAL_MS: u64 = 10_000;
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

type Worker = BoxFuture<'static, anyhow::Result<()>>;
type WorkerStart = (&'static str, Box<dyn FnOnce(Shutdown) -> Worker + Send>);

#[derive(Debug)]
enum BackgroundExit {
    InitFailed(anyhow::Error),
    Crashed(String),
    Stopped,
}

/// Runs the oracle until a signal or a fatal error and returns the exit code.
pub async fn serve() -> anyhow::Result<i32> {
    let stop = Shutdown::new();
    let signalled = stop.clone();
    on_termination(move |signal| {
        info!("\n🛑 Shutting down ({signal})...");
        signalled.trigger();
    });

    let config = OracleConfig::global().map_err(anyhow::Error::msg)?.clone();
    let port = config.oracle_port;
    let api_token = config
        .api_token
        .clone()
        .filter(|token| !token.is_empty())
        .context("ORACLE_API_TOKEN is required to start the oracle API")?;

    let oracle = OracleService::create(config)?;
    let mut options = RouterOptions::new(Some(api_token));
    let workers = build_workers(&oracle, &mut options)?;
    let app = http::router(oracle.clone(), options);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .with_context(|| format!("Failed to bind port {port}"))?;
    info!("🔮 Oracle API running on http://localhost:{port}");

    let server_stop = Shutdown::new();
    let mut server_task: JoinHandle<std::io::Result<()>> = {
        let stop = server_stop.clone();
        tokio::spawn(async move { timba_common::http::serve(listener, app, async move { stop.wait().await }).await })
    };

    let background = Shutdown::new();
    let init = {
        let oracle = oracle.clone();
        async move { oracle.start_event_listening().await }.boxed()
    };
    let mut background_task = tokio::spawn(run_background(init, workers.workers, background.clone()));

    let exit_code = supervise(&stop, &mut background_task, &mut server_task).await;

    // stopServer(): stop accepting requests, drain the background workers,
    // close the oracle, then the indexer database. Each step is bounded by the
    // shutdown timeout.
    server_stop.trigger();
    stop_task(&mut server_task, SHUTDOWN_TIMEOUT, "HTTP server").await;
    background.trigger();
    stop_task(&mut background_task, SHUTDOWN_TIMEOUT, "Background loop").await;
    (workers.detach)();
    // On timeout, still checkpoint and close the database so committed secrets leave the WAL.
    bounded(oracle.close(), SHUTDOWN_TIMEOUT, "Oracle close", || oracle.db().close()).await;
    workers.indexer_db.close();
    if exit_code == 0 {
        info!("Shutdown complete");
    }
    Ok(exit_code)
}

/// Waits for a stop request, a background exit or a server exit, and returns
/// the process exit code (0 only for a requested stop).
async fn supervise(
    stop: &Shutdown,
    background: &mut JoinHandle<BackgroundExit>,
    server: &mut JoinHandle<std::io::Result<()>>,
) -> i32 {
    tokio::select! {
        _ = stop.wait() => 0,
        result = background => {
            match result {
                Ok(BackgroundExit::InitFailed(err)) => error!("Oracle initialization failed. Stopping server. {err:#}"),
                Ok(BackgroundExit::Crashed(err)) => {
                    error!("Background worker crashed; stopping the oracle so it restarts cleanly: {err}")
                }
                Ok(BackgroundExit::Stopped) => warn!("Background workers stopped unexpectedly"),
                Err(err) => error!("Background supervisor failed: {err}"),
            }
            1
        }
        result = server => {
            match result {
                Ok(Ok(())) => error!("HTTP server stopped unexpectedly"),
                Ok(Err(err)) => error!("HTTP server failed: {err}"),
                Err(err) => error!("HTTP server task failed: {err}"),
            }
            1
        }
    }
}

/// Waits up to `timeout` for `task` to finish, then aborts it.
async fn stop_task<T>(task: &mut JoinHandle<T>, timeout: Duration, name: &str) {
    if !task.is_finished() && tokio::time::timeout(timeout, &mut *task).await.is_err() {
        warn!("{name} did not stop within the shutdown timeout; proceeding with shutdown.");
        task.abort();
    }
}

/// Runs `step` for at most `timeout`, then gives up on it and runs `fallback`.
async fn bounded(step: impl Future<Output = ()>, timeout: Duration, name: &str, fallback: impl FnOnce()) {
    if tokio::time::timeout(timeout, step).await.is_err() {
        warn!("{name} did not complete within the shutdown timeout; proceeding with shutdown.");
        fallback();
    }
}

struct Workers {
    workers: Vec<WorkerStart>,
    /// Stops program events from waking the indexer.
    detach: Box<dyn FnOnce() + Send>,
    indexer_db: Arc<IndexerDatabase>,
}

fn build_workers(oracle: &Arc<OracleService>, options: &mut RouterOptions) -> anyhow::Result<Workers> {
    let config = oracle.config();
    let indexer_db = Arc::new(IndexerDatabase::open(&config.indexer_database_file)?);
    let indexer = Arc::new(PublicIndexer::new(
        indexer_db.clone(),
        oracle.connection().clone(),
        oracle.program_id(),
        config.indexer_poll_interval_ms,
    ));
    let wake = indexer.clone();
    let observer = oracle.add_program_event_observer(Arc::new(move || wake.request_catch_up()));
    let web = Arc::new(WebGameApi::new(oracle.clone(), indexer_db.clone(), config));
    options.indexer = Some(indexer::api::router(indexer_db.clone(), config.jupiter_api_key.clone()));
    options.web = Some(web.clone().router());

    let scan_oracle = oracle.clone();
    let jobs_db = indexer_db.clone();
    let workers: Vec<WorkerStart> = vec![
        (
            "scan loop",
            Box::new(move |signal| {
                let scan = move |options| {
                    let oracle = scan_oracle.clone();
                    async move { oracle.run_scan_loop(options).await }.boxed()
                };
                scan_worker(scan, signal).boxed()
            }),
        ),
        ("public indexer", Box::new(move |signal| async move { indexer.run(signal).await }.boxed())),
        (
            "verification jobs",
            Box::new(move |signal| {
                let verify = move |signature: String| {
                    let web = web.clone();
                    async move { web.verify(&signature).await }.boxed()
                };
                verification_worker(verify, jobs_db, signal).boxed()
            }),
        ),
    ];
    let detach_oracle = oracle.clone();
    let detach = Box::new(move || detach_oracle.remove_program_event_observer(observer));
    Ok(Workers { workers, detach, indexer_db })
}

/// `initialize()` followed by the supervised background workers.
async fn run_background(init: Worker, workers: Vec<WorkerStart>, signal: Shutdown) -> BackgroundExit {
    if let Err(err) = init.await {
        return BackgroundExit::InitFailed(err);
    }
    info!("Oracle services initialized");
    if signal.is_triggered() {
        return BackgroundExit::Stopped;
    }

    // Each worker handles its own cycle errors, so an error or panic here is a
    // crash: stop the sibling workers and report it once all have exited.
    // Failures after the stop signal are workers stopping, not crashes.
    let handles: Vec<_> = workers
        .into_iter()
        .map(|(name, start)| {
            let signal = signal.clone();
            let handle = tokio::spawn(start(signal.clone()));
            async move {
                let failure = match handle.await {
                    Ok(Ok(())) => None,
                    Ok(Err(err)) => Some(format!("{name}: {err:#}")),
                    Err(err) => Some(format!("{name}: {err}")),
                };
                match failure {
                    Some(failure) if !signal.is_triggered() => {
                        signal.trigger();
                        Some(failure)
                    }
                    _ => None,
                }
            }
        })
        .collect();
    let crash = futures::future::join_all(handles).await.into_iter().flatten().next();
    match crash {
        Some(crash) => BackgroundExit::Crashed(crash),
        None => BackgroundExit::Stopped,
    }
}

/// Keeps the fallback scan loop running until shutdown, restarting it after
/// an unexpected exit or failure.
async fn scan_worker<F>(scan: F, signal: Shutdown) -> anyhow::Result<()>
where
    F: Fn(ScanLoopOptions) -> BoxFuture<'static, anyhow::Result<ScanLoopSummary>>,
{
    while !signal.is_triggered() {
        let options = ScanLoopOptions {
            wait_between_cycles_ms: Some(FALLBACK_SCAN_INTERVAL_MS),
            wait_for_pending_only: false,
            cleanup_after_cycle_hours: Some(48),
            should_continue: Some(Arc::new(|_, _| true)),
            signal: Some(signal.clone()),
        };
        match scan(options).await {
            Ok(_) if signal.is_triggered() => break,
            Ok(_) => warn!("Background scan loop exited unexpectedly; restarting..."),
            Err(_) if signal.is_triggered() => break,
            Err(err) => error!("Background scan loop failed: {err:#}"),
        }
        signal.sleep(DEFAULT_DELAY_MS).await;
    }
    Ok(())
}

/// Backfills one queued verification every ten seconds. A failed job is
/// rescheduled; a database error is a crash.
async fn verification_worker<F>(verify: F, db: Arc<IndexerDatabase>, signal: Shutdown) -> anyhow::Result<()>
where
    F: Fn(String) -> BoxFuture<'static, anyhow::Result<()>>,
{
    while !signal.is_triggered() {
        if let Some(job) = db.next_verification_job()? {
            let verified = verify(job.signature.clone()).await;
            if !signal.is_triggered() {
                match verified {
                    Ok(()) => db.finish_verification_job(&job.signature)?,
                    Err(_) => db.retry_verification_job(&job.signature, job.attempts)?,
                }
            }
        }
        signal.sleep(VERIFICATION_INTERVAL_MS).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use super::*;

    fn pending<T: Send + 'static>() -> JoinHandle<T> {
        tokio::spawn(std::future::pending())
    }

    fn worker(
        name: &'static str,
        run: impl FnOnce(Shutdown) -> BoxFuture<'static, anyhow::Result<()>> + Send + 'static,
    ) -> WorkerStart {
        (name, Box::new(run))
    }

    fn ok_init() -> Worker {
        async { Ok(()) }.boxed()
    }

    #[tokio::test]
    async fn a_stop_request_exits_zero_and_anything_else_exits_one() {
        let stop = Shutdown::new();
        stop.trigger();
        assert_eq!(supervise(&stop, &mut pending(), &mut pending()).await, 0);

        let idle = Shutdown::new();
        for exit in [
            BackgroundExit::InitFailed(anyhow::anyhow!("no websocket")),
            BackgroundExit::Crashed("scan loop: boom".into()),
            BackgroundExit::Stopped,
        ] {
            let mut background = tokio::spawn(async move { exit });
            assert_eq!(supervise(&idle, &mut background, &mut pending()).await, 1);
        }
        let mut panicked = tokio::spawn(async { panic!("supervisor bug") });
        assert_eq!(supervise(&idle, &mut panicked, &mut pending()).await, 1);

        for result in [Ok(()), Err(std::io::Error::other("accept failed"))] {
            let mut server = tokio::spawn(async move { result });
            assert_eq!(supervise(&idle, &mut pending(), &mut server).await, 1);
        }
        let mut panicked = tokio::spawn(async { panic!("server bug") });
        assert_eq!(supervise(&idle, &mut pending(), &mut panicked).await, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn shutdown_steps_give_up_after_the_timeout() {
        let mut done = tokio::spawn(async {});
        tokio::task::yield_now().await;
        stop_task(&mut done, SHUTDOWN_TIMEOUT, "done").await;

        let mut slow = tokio::spawn(async { tokio::time::sleep(Duration::from_millis(10)).await });
        let started = tokio::time::Instant::now();
        stop_task(&mut slow, SHUTDOWN_TIMEOUT, "slow").await;
        assert_eq!(started.elapsed(), Duration::from_millis(10), "finished within the timeout");

        let mut stuck = pending::<()>();
        let started = tokio::time::Instant::now();
        stop_task(&mut stuck, SHUTDOWN_TIMEOUT, "stuck").await;
        assert_eq!(started.elapsed(), SHUTDOWN_TIMEOUT);
        assert!(stuck.await.unwrap_err().is_cancelled());

        let fell_back = AtomicUsize::new(0);
        bounded(async {}, SHUTDOWN_TIMEOUT, "quick", || {
            fell_back.fetch_add(1, Ordering::SeqCst);
        })
        .await;
        assert_eq!(fell_back.load(Ordering::SeqCst), 0);
        bounded(std::future::pending(), SHUTDOWN_TIMEOUT, "hung", || {
            fell_back.fetch_add(1, Ordering::SeqCst);
        })
        .await;
        assert_eq!(fell_back.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn initialization_failures_and_early_stops_skip_the_workers() {
        let never = || worker("never", |_| panic!("must not start"));
        let failed = run_background(async { anyhow::bail!("no websocket") }.boxed(), vec![never()], Shutdown::new());
        assert!(matches!(failed.await, BackgroundExit::InitFailed(err) if err.to_string() == "no websocket"));

        let stopped = Shutdown::new();
        stopped.trigger();
        assert!(matches!(run_background(ok_init(), vec![never()], stopped).await, BackgroundExit::Stopped));
    }

    #[tokio::test]
    async fn a_failing_worker_stops_its_siblings_and_is_reported() {
        let sibling_stopped = Arc::new(AtomicUsize::new(0));
        let seen = sibling_stopped.clone();
        let workers = vec![
            worker("sibling", move |signal| {
                async move {
                    signal.wait().await;
                    seen.fetch_add(1, Ordering::SeqCst);
                    // Failing while stopping is not a second crash.
                    anyhow::bail!("interrupted")
                }
                .boxed()
            }),
            worker("scan loop", |_| async { Err(anyhow::anyhow!("database is locked").context("cycle")) }.boxed()),
        ];
        let exit = run_background(ok_init(), workers, Shutdown::new()).await;
        assert!(matches!(&exit, BackgroundExit::Crashed(m) if m == "scan loop: cycle: database is locked"), "{exit:?}");
        assert_eq!(sibling_stopped.load(Ordering::SeqCst), 1);

        let panicking = vec![worker("indexer", |_| async { panic!("index out of bounds") }.boxed())];
        let exit = run_background(ok_init(), panicking, Shutdown::new()).await;
        assert!(
            matches!(&exit, BackgroundExit::Crashed(m) if m.starts_with("indexer: task") && m.contains("panicked")),
            "{exit:?}"
        );
    }

    #[tokio::test]
    async fn workers_that_finish_cleanly_stop_the_background_loop() {
        let workers = vec![worker("a", |_| async { Ok(()) }.boxed()), worker("b", |_| async { Ok(()) }.boxed())];
        assert!(matches!(run_background(ok_init(), workers, Shutdown::new()).await, BackgroundExit::Stopped));
    }

    #[tokio::test(start_paused = true)]
    async fn the_scan_worker_restarts_the_loop_until_shutdown() {
        let signal = Shutdown::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let (stop, count) = (signal.clone(), calls.clone());
        let scan = move |options: ScanLoopOptions| {
            let call = count.fetch_add(1, Ordering::SeqCst);
            assert_eq!(options.wait_between_cycles_ms, Some(FALLBACK_SCAN_INTERVAL_MS));
            assert_eq!(options.cleanup_after_cycle_hours, Some(48));
            assert!((options.should_continue.unwrap())(&Default::default(), 0));
            let stop = stop.clone();
            async move {
                match call {
                    0 => Ok(ScanLoopSummary::default()),
                    1 => anyhow::bail!("rpc down"),
                    _ => {
                        stop.trigger();
                        Ok(ScanLoopSummary::default())
                    }
                }
            }
            .boxed()
        };
        let started = tokio::time::Instant::now();
        scan_worker(scan, signal).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        assert_eq!(started.elapsed(), Duration::from_millis(2 * DEFAULT_DELAY_MS));

        let signal = Shutdown::new();
        let stop = signal.clone();
        let failing = move |_| {
            let stop = stop.clone();
            async move {
                stop.trigger();
                anyhow::bail!("aborted by shutdown")
            }
            .boxed()
        };
        scan_worker(failing, signal).await.unwrap();
    }

    fn jobs(path: &std::path::Path) -> Vec<(String, i64)> {
        let conn = rusqlite::Connection::open(path).unwrap();
        let mut stmt = conn.prepare("SELECT signature,attempts FROM verification_jobs ORDER BY signature").unwrap();
        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).unwrap().map(Result::unwrap).collect()
    }

    /// Triggers a new shutdown signal after `ms` of (paused) time.
    fn stop_after(ms: u64) -> Shutdown {
        let signal = Shutdown::new();
        let stop = signal.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            stop.trigger();
        });
        signal
    }

    #[tokio::test(start_paused = true)]
    async fn the_verification_worker_finishes_or_reschedules_jobs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("indexer.sqlite");
        // Jobs are due a minute after queueing; follow the paused tokio clock.
        let start = tokio::time::Instant::now();
        let wall_clock: crate::indexer::database::Clock = Arc::new(move || start.elapsed().as_millis() as i64);
        let options = crate::indexer::IndexerDatabaseOptions { wall_clock: Some(wall_clock), ..Default::default() };
        let db = Arc::new(IndexerDatabase::open_with_options(&path, options).unwrap());
        db.queue_verification("good").unwrap();
        db.queue_verification("bad").unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let verify = move |signature: String| {
            log.lock().unwrap().push(signature.clone());
            async move {
                match signature.as_str() {
                    "good" => Ok(()),
                    _ => anyhow::bail!("not finalized"),
                }
            }
            .boxed()
        };
        // Both are due at 60s and run one per interval; the retry is not due yet at 75s.
        verification_worker(verify, db.clone(), stop_after(75_000)).await.unwrap();
        assert_eq!(seen.lock().unwrap().len(), 2);
        assert_eq!(jobs(&path), vec![("bad".to_string(), 1)]);

        // Results that arrive during shutdown are dropped.
        db.queue_verification("late").unwrap();
        let signal = Shutdown::new();
        let stop = signal.clone();
        let verify = move |_| {
            stop.trigger();
            async { Ok(()) }.boxed()
        };
        verification_worker(verify, db.clone(), signal).await.unwrap();
        assert_eq!(jobs(&path), vec![("bad".to_string(), 1), ("late".to_string(), 0)]);

        db.close();
        let err = verification_worker(|_| async { Ok(()) }.boxed(), db, Shutdown::new()).await.unwrap_err();
        assert_eq!(err.to_string(), "Indexer database is closed");
    }
}
