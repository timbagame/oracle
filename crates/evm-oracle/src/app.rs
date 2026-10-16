//! Process wiring (port of `evm/main.ts`): load configuration and secrets, validate the
//! deployment, serve the API and run oracle cycles until shutdown.

use std::future::Future;
use std::net::SocketAddr;
use std::sync::Arc;

use timba_common::Shutdown;

use crate::config::{load_config, load_secret};
use crate::protocol::schema::parse_bytes32;
use crate::server::{create_evm_router, CYCLE_FAILED_MESSAGE};
use crate::service::EvmService;
use crate::store::EvmStore;

/// Failed cycles are reported at most once per minute.
const WARNING_INTERVAL_MS: i64 = 60_000;

/// Validates the operator key file contents (`/^0x[0-9a-fA-F]{64}$/`).
pub fn parse_operator_key(text: &str) -> anyhow::Result<alloy_primitives::B256> {
    parse_bytes32(text).ok_or_else(|| anyhow::anyhow!("Invalid EVM operator key file"))
}

/// Runs `tick` every `poll_ms` until `shutdown`, warning about failures at most once a minute.
pub async fn run_cycles<F, Fut>(
    mut tick: F,
    poll_ms: u64,
    shutdown: &Shutdown,
    now_ms: impl Fn() -> i64,
    mut warn: impl FnMut(&str),
) where
    F: FnMut() -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
{
    let mut last_warning = 0;
    while !shutdown.is_triggered() {
        if tick().await.is_err() && now_ms() - last_warning > WARNING_INTERVAL_MS {
            last_warning = now_ms();
            warn(CYCLE_FAILED_MESSAGE);
        }
        if !shutdown.is_triggered() {
            shutdown.sleep(poll_ms).await;
        }
    }
}

/// Starts the oracle from `EVM_CONFIG_FILE` and returns after a graceful shutdown.
pub async fn run(config_file: Option<String>, shutdown: Shutdown) -> anyhow::Result<()> {
    let Some(path) = config_file else {
        anyhow::bail!("EVM_CONFIG_FILE is required");
    };
    let config = load_config(&path)?;
    let key = parse_operator_key(&load_secret(&config.operator_key_file)?)?;
    let deployment = format!("{}:{}:{}", config.chain_id, config.address.to_string().to_lowercase(), config.version);
    let store = EvmStore::open(&config.database, &deployment)?;
    let service = Arc::new(EvmService::new(config, key, store)?);
    service.validate_deployment().await?;
    let config = &service.config;
    let router = create_evm_router(service.clone(), load_secret(&config.api_token_file)?);
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], config.port))).await?;
    let server = {
        let shutdown = shutdown.clone();
        tokio::spawn(async move {
            axum::serve(listener, router).with_graceful_shutdown(async move { shutdown.wait().await }).await
        })
    };
    println!(
        "EVM oracle listening on port {}, chain {}, proxy {}",
        config.port,
        config.chain_id,
        config.address.to_checksum(None)
    );
    run_cycles(
        || service.tick(),
        config.poll_ms,
        &shutdown,
        timba_common::time::now_ms,
        |message| eprintln!("{message}"),
    )
    .await;
    server.await??;
    if let Ok(service) = Arc::try_unwrap(service) {
        service.into_store().close();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    #[test]
    fn operator_keys_must_be_32_byte_hex() {
        assert!(parse_operator_key(&format!("0x{}", "1".repeat(64))).is_ok());
        for invalid in ["", "0x12", &"1".repeat(66), &format!("0x{}", "g".repeat(64))] {
            assert_eq!(parse_operator_key(invalid).unwrap_err().to_string(), "Invalid EVM operator key file");
        }
    }

    #[tokio::test]
    async fn warns_once_per_minute_about_failed_cycles_and_stops_on_shutdown() {
        let shutdown = Shutdown::new();
        let ticks = Cell::new(0);
        let warnings = RefCell::new(Vec::new());
        let clock = Cell::new(1_000_000);
        run_cycles(
            || {
                ticks.set(ticks.get() + 1);
                let count = ticks.get();
                clock.set(clock.get() + 1_000);
                if count == 3 {
                    shutdown.trigger();
                }
                async move {
                    if count <= 2 {
                        anyhow::bail!("rpc unavailable");
                    }
                    Ok(())
                }
            },
            1,
            &shutdown,
            || clock.get(),
            |message| warnings.borrow_mut().push(message.to_string()),
        )
        .await;
        assert_eq!(ticks.get(), 3);
        // Two consecutive failures inside a minute produce a single warning.
        assert_eq!(*warnings.borrow(), [CYCLE_FAILED_MESSAGE]);
    }
}
