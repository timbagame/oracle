//! Timba Solana oracle.

pub mod cli;
pub mod config;
pub mod core;
pub mod db;
pub mod http;
pub mod indexed_events;
pub mod indexer;
pub mod metrics;
pub mod program_client;
pub mod server;
pub mod solana;
pub mod token;
pub mod types;
pub mod web_api;

/// Serialises tests that set or depend on process environment variables
/// (`OracleConfig::from_env`, the `SOLANA_NETWORK` verification namespace).
#[cfg(test)]
pub(crate) fn env_test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}
