//! Process entry for `timba-oracle serve` (port of `index.ts` `start()`).
//!
//! Serves the HTTP API, starts the program event listeners and supervises the
//! background workers. A worker crash stops the whole process with exit code 1
//! so the supervisor restarts it cleanly.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use futures::future::BoxFuture;
use futures::FutureExt;
use tokio::task::JoinHandle;

use timba_common::shutdown::Shutdown;
use timba_common::{error, info, warn};

use crate::config::OracleConfig;
use crate::core::scan::{ScanLoopOptions, DEFAULT_DELAY_MS};
use crate::core::service::OracleService;
use crate::http::{self, RouterOptions};
use crate::indexer::{self, IndexerDatabase, PublicIndexer};
use crate::web_api::WebGameApi;

const FALLBACK_SCAN_INTERVAL_MS: u64 = 300_000;
const VERIFICATION_INTERVAL_MS: u64 = 10_000;
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

type Worker = BoxFuture<'static, anyhow::Result<()>>;
type WorkerStart = (&'static str, Box<dyn FnOnce(Shutdown) -> Worker + Send>);

enum BackgroundExit {
    InitFailed(anyhow::Error),
    Crashed(String),
    Stopped,
}

/// Runs the oracle until a signal or a fatal error and returns the exit code.
pub async fn serve() -> anyhow::Result<i32> {
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
    let mut background_task = tokio::spawn(run_background(oracle.clone(), workers.workers, background.clone()));

    let exit_code = tokio::select! {
        signal = termination_signal() => {
            info!("\n🛑 Shutting down ({signal})...");
            0
        }
        result = &mut background_task => {
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
        result = &mut server_task => {
            match result {
                Ok(Ok(())) => error!("HTTP server stopped unexpectedly"),
                Ok(Err(err)) => error!("HTTP server failed: {err}"),
                Err(err) => error!("HTTP server task failed: {err}"),
            }
            1
        }
    };

    // `process.once` handlers: a second signal while shutting down exits at once.
    tokio::spawn(async {
        let signal = termination_signal().await;
        warn!("{signal} received again; exiting without waiting for shutdown");
        std::process::exit(if signal == "SIGINT" { 130 } else { 143 });
    });

    // stopServer(): stop accepting requests, drain the background workers,
    // close the oracle, then the indexer database. Each step is bounded by the
    // shutdown timeout.
    server_stop.trigger();
    if !server_task.is_finished() && tokio::time::timeout(SHUTDOWN_TIMEOUT, &mut server_task).await.is_err() {
        warn!("HTTP server did not stop within the shutdown timeout; proceeding with shutdown.");
        server_task.abort();
    }
    background.trigger();
    if !background_task.is_finished() && tokio::time::timeout(SHUTDOWN_TIMEOUT, &mut background_task).await.is_err() {
        warn!("Background loop did not exit within the shutdown timeout; proceeding with shutdown.");
        background_task.abort();
    }
    (workers.detach)();
    if tokio::time::timeout(SHUTDOWN_TIMEOUT, oracle.close()).await.is_err() {
        warn!("Oracle close did not complete within the shutdown timeout; proceeding with shutdown.");
        // Still checkpoint and close the database so committed secrets leave the WAL.
        oracle.db().close();
    }
    workers.indexer_db.close();
    if exit_code == 0 {
        info!("Shutdown complete");
    }
    Ok(exit_code)
}

struct Workers {
    workers: Vec<WorkerStart>,
    /// Stops program events from waking the indexer.
    detach: Box<dyn FnOnce() + Send>,
    indexer_db: Arc<IndexerDatabase>,
}

fn build_workers(oracle: &Arc<OracleService>, options: &mut RouterOptions) -> anyhow::Result<Workers> {
    let config = oracle.config();
    let indexer_db = Arc::new(
        IndexerDatabase::open(&config.indexer_database_file)
            .with_context(|| format!("Failed to open indexer database {}", config.indexer_database_file))?,
    );
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
        ("scan loop", Box::new(move |signal| scan_worker(scan_oracle, signal).boxed())),
        ("public indexer", Box::new(move |signal| async move { indexer.run(signal).await }.boxed())),
        ("verification jobs", Box::new(move |signal| verification_worker(web, jobs_db, signal).boxed())),
    ];
    let detach_oracle = oracle.clone();
    let detach = Box::new(move || detach_oracle.remove_program_event_observer(observer));
    Ok(Workers { workers, detach, indexer_db })
}

/// `initialize()` followed by the supervised background workers.
async fn run_background(oracle: Arc<OracleService>, workers: Vec<WorkerStart>, signal: Shutdown) -> BackgroundExit {
    if let Err(err) = oracle.start_event_listening().await {
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

async fn scan_worker(oracle: Arc<OracleService>, signal: Shutdown) -> anyhow::Result<()> {
    while !signal.is_triggered() {
        let options = ScanLoopOptions {
            wait_between_cycles_ms: Some(FALLBACK_SCAN_INTERVAL_MS),
            wait_for_pending_only: false,
            cleanup_after_cycle_hours: Some(48),
            should_continue: Some(Arc::new(|_, _| true)),
            signal: Some(signal.clone()),
        };
        match oracle.run_scan_loop(options).await {
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
async fn verification_worker(web: Arc<WebGameApi>, db: Arc<IndexerDatabase>, signal: Shutdown) -> anyhow::Result<()> {
    while !signal.is_triggered() {
        if let Some(job) = db.next_verification_job()? {
            let verified = web.verify(&job.signature).await;
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

async fn termination_signal() -> &'static str {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let (Ok(mut term), Ok(mut int)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) else {
            let _ = tokio::signal::ctrl_c().await;
            return "SIGINT";
        };
        tokio::select! {
            _ = term.recv() => "SIGTERM",
            _ = int.recv() => "SIGINT",
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
        "SIGINT"
    }
}
