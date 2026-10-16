//! `timba-evm-oracle`: the opt-in EVM oracle. Configured by `EVM_CONFIG_FILE`.

use timba_common::Shutdown;
use timba_evm_oracle::app;

/// Resolves on SIGINT or SIGTERM.
async fn signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut terminate = signal(SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

#[tokio::main]
async fn main() {
    let shutdown = Shutdown::new();
    {
        let shutdown = shutdown.clone();
        tokio::spawn(async move {
            signal().await;
            shutdown.trigger();
            // Handlers are installed once; a second signal stops immediately.
            signal().await;
            std::process::exit(130);
        });
    }
    let config_file = std::env::var("EVM_CONFIG_FILE").ok().filter(|path| !path.is_empty());
    if let Err(error) = app::run(config_file, shutdown).await {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}
