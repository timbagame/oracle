//! Runtime configuration from the environment (port of `config.ts`).

use std::path::Path;
use std::sync::OnceLock;

use timba_common::env::{environment_mode, parse_integer, read_env, should_use_ephemeral_keypair};
use timba_common::secrets::{read_protected_secret, resolve_path};
use timba_protocol::ContractVersion;

use crate::solana::pool::parse_rpc_endpoint_list;

pub const DEFAULT_ORACLE_PORT: u16 = 3001;
const DEFAULT_DATABASE_FILE: &str = "oracle.sqlite";
const DEFAULT_INDEXER_DATABASE_FILE: &str = "indexer.sqlite";
const DEFAULT_KEYPAIR_FILE: &str = "operator-keypair.json";
const LEGACY_KEYPAIR_FILE: &str = "admin-keypair.json";

#[derive(Debug, Clone)]
pub struct OracleConfig {
    pub contract_version: ContractVersion,
    pub solana_network: String,
    pub solana_networks: Vec<String>,
    pub solana_ws_endpoint: Option<String>,
    pub oracle_port: u16,
    pub database_file: String,
    pub indexer_database_file: String,
    pub indexer_poll_interval_ms: u64,
    pub operator_keypair_path: String,
    pub operator_keypair_source: String,
    pub scan_throttle_ms: u64,
    pub player_event_flush_debounce_ms: u64,
    pub player_event_flush_max_operations: usize,
    pub auto_complete_debounce_ms: u64,
    pub use_ephemeral_keypair: bool,
    pub environment: String,
    pub bot_internal_url: Option<String>,
    pub api_token: Option<String>,
    pub jupiter_api_key: Option<String>,
    pub jupiter_price_url: String,
}

fn non_negative(key: &str, default: i64) -> u64 {
    parse_integer(read_env(key).as_deref(), default, Some(0), None, key) as u64
}

fn secret(file_key: &str, value_key: &str, label: &str) -> Result<Option<String>, String> {
    match read_env(file_key) {
        Some(file) => read_protected_secret(&file, label).map(Some),
        None => Ok(read_env(value_key)),
    }
}

impl OracleConfig {
    pub fn from_env() -> Result<Self, String> {
        let environment = environment_mode();
        let solana_networks = parse_rpc_endpoint_list(read_env("SOLANA_NETWORK").as_deref())?;
        let solana_network = solana_networks[0].clone();
        let operator_keypair_source = read_env("OPERATOR_KEYPAIR_PATH")
            .or_else(|| read_env("ORACLE_KEYPAIR_PATH"))
            .unwrap_or_else(|| {
                if Path::new(&resolve_path(DEFAULT_KEYPAIR_FILE)).exists() {
                    DEFAULT_KEYPAIR_FILE.into()
                } else {
                    LEGACY_KEYPAIR_FILE.into()
                }
            });
        let operator_keypair_path = resolve_path(&operator_keypair_source).to_string_lossy().into_owned();
        let oracle_port = parse_integer(
            read_env("ORACLE_PORT").as_deref(),
            DEFAULT_ORACLE_PORT as i64,
            Some(0),
            Some(65535),
            "ORACLE_PORT",
        ) as u16;
        Ok(Self {
            contract_version: ContractVersion::parse_env(read_env("CONTRACT_VERSION").as_deref(), "CONTRACT_VERSION")?,
            solana_network,
            solana_networks,
            solana_ws_endpoint: read_env("SOLANA_WS_ENDPOINT"),
            oracle_port,
            database_file: read_env("DATABASE_FILE").unwrap_or_else(|| DEFAULT_DATABASE_FILE.into()),
            indexer_database_file: read_env("INDEXER_DATABASE_FILE")
                .unwrap_or_else(|| DEFAULT_INDEXER_DATABASE_FILE.into()),
            indexer_poll_interval_ms: parse_integer(
                read_env("INDEXER_POLL_INTERVAL_MS").as_deref(),
                300_000,
                Some(5_000),
                None,
                "INDEXER_POLL_INTERVAL_MS",
            ) as u64,
            operator_keypair_path,
            operator_keypair_source,
            scan_throttle_ms: non_negative("ORACLE_SCAN_THROTTLE_MS", 0),
            player_event_flush_debounce_ms: non_negative("ORACLE_PLAYER_EVENT_FLUSH_DEBOUNCE_MS", 100),
            player_event_flush_max_operations: parse_integer(
                read_env("ORACLE_PLAYER_EVENT_FLUSH_MAX_OPERATIONS").as_deref(),
                500,
                Some(1),
                None,
                "ORACLE_PLAYER_EVENT_FLUSH_MAX_OPERATIONS",
            ) as usize,
            auto_complete_debounce_ms: non_negative("ORACLE_AUTOCOMPLETE_DEBOUNCE_MS", 500),
            use_ephemeral_keypair: should_use_ephemeral_keypair(),
            environment,
            bot_internal_url: Some(read_env("BOT_INTERNAL_URL").unwrap_or_else(|| "http://bot:3002".into())),
            api_token: secret("ORACLE_API_TOKEN_FILE", "ORACLE_API_TOKEN", "Oracle API token file")?,
            jupiter_api_key: secret("JUPITER_API_KEY_FILE", "JUPITER_API_KEY", "Jupiter API key file")?,
            jupiter_price_url: read_env("JUPITER_PRICE_URL").unwrap_or_else(|| "https://api.jup.ag/price/v3".into()),
        })
    }

    /// Process-wide configuration, loaded once.
    pub fn global() -> Result<&'static OracleConfig, String> {
        static CONFIG: OnceLock<Result<OracleConfig, String>> = OnceLock::new();
        CONFIG.get_or_init(Self::from_env).as_ref().map_err(Clone::clone)
    }

    /// Configuration suitable for unit tests (no environment access).
    pub fn for_tests() -> Self {
        Self {
            contract_version: ContractVersion::V0_2_0,
            solana_network: "http://localhost:8899".into(),
            solana_networks: vec!["http://localhost:8899".into()],
            solana_ws_endpoint: None,
            oracle_port: 0,
            database_file: ":memory:".into(),
            indexer_database_file: ":memory:".into(),
            indexer_poll_interval_ms: 300_000,
            operator_keypair_path: "operator-keypair.json".into(),
            operator_keypair_source: "operator-keypair.json".into(),
            scan_throttle_ms: 0,
            player_event_flush_debounce_ms: 0,
            player_event_flush_max_operations: 500,
            auto_complete_debounce_ms: 0,
            use_ephemeral_keypair: true,
            environment: "test".into(),
            bot_internal_url: None,
            api_token: Some("test-token".into()),
            jupiter_api_key: None,
            jupiter_price_url: "https://api.jup.ag/price/v3".into(),
        }
    }
}

pub const MAX_GAME_TYPE_LENGTH: usize = 128;

/// Port of `normalizeGameType` (lengths in UTF-16 code units like JS).
pub fn normalize_game_type(raw: Option<&str>, allow_truncate: bool) -> Result<Option<String>, String> {
    let Some(raw) = raw else { return Ok(None) };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let normalized = trimmed.to_lowercase();
    let units: Vec<u16> = normalized.encode_utf16().collect();
    if units.len() <= MAX_GAME_TYPE_LENGTH {
        return Ok(Some(normalized));
    }
    if allow_truncate {
        return Ok(Some(String::from_utf16_lossy(&units[..MAX_GAME_TYPE_LENGTH])));
    }
    Err(format!("gameType must be at most {MAX_GAME_TYPE_LENGTH} characters"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn game_types() {
        assert_eq!(normalize_game_type(Some("  CoinFlip "), false).unwrap(), Some("coinflip".into()));
        assert_eq!(normalize_game_type(Some("   "), false).unwrap(), None);
        assert_eq!(normalize_game_type(None, false).unwrap(), None);
        let long = "a".repeat(129);
        assert!(normalize_game_type(Some(&long), false).is_err());
        assert_eq!(normalize_game_type(Some(&long), true).unwrap().unwrap().len(), 128);
    }
}
