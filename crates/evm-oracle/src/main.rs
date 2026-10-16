//! `timba-evm-oracle`: the opt-in EVM oracle. Configured by `EVM_CONFIG_FILE`.

use timba_common::signal::on_termination;
use timba_common::Shutdown;
use timba_evm_oracle::app;

#[tokio::main]
async fn main() {
    let shutdown = Shutdown::new();
    let stop = shutdown.clone();
    on_termination(move |_| stop.trigger());
    let config_file = std::env::var("EVM_CONFIG_FILE").ok().filter(|path| !path.is_empty());
    if let Err(error) = app::run(config_file, shutdown).await {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}
