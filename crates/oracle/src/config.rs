//! Runtime configuration from the environment (port of `config.ts`).

use std::path::Path;
use std::sync::OnceLock;

use timba_common::env::{environment_mode, parse_integer, read_env, should_use_ephemeral_keypair};
use timba_common::secrets::{read_protected_secret, resolve_path};
use timba_protocol::ContractVersion;

use crate::solana::pool::parse_rpc_endpoint_list;

pub const DEFAULT_ORACLE_PORT: u16 = 3001;

/// `ORACLE_PORT` as `serve` reads it (shared with the health probe).
pub fn oracle_port_from_env() -> u16 {
    parse_integer(read_env("ORACLE_PORT").as_deref(), DEFAULT_ORACLE_PORT as i64, Some(0), Some(65535), "ORACLE_PORT")
        as u16
}
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
        let operator_keypair_source =
            read_env("OPERATOR_KEYPAIR_PATH").or_else(|| read_env("ORACLE_KEYPAIR_PATH")).unwrap_or_else(|| {
                if Path::new(&resolve_path(DEFAULT_KEYPAIR_FILE)).exists() {
                    DEFAULT_KEYPAIR_FILE.into()
                } else {
                    LEGACY_KEYPAIR_FILE.into()
                }
            });
        let operator_keypair_path = resolve_path(&operator_keypair_source).to_string_lossy().into_owned();
        let oracle_port = oracle_port_from_env();
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

    const KEYS: [&str; 19] = [
        "SOLANA_NETWORK",
        "SOLANA_WS_ENDPOINT",
        "OPERATOR_KEYPAIR_PATH",
        "ORACLE_KEYPAIR_PATH",
        "ORACLE_PORT",
        "CONTRACT_VERSION",
        "DATABASE_FILE",
        "INDEXER_DATABASE_FILE",
        "INDEXER_POLL_INTERVAL_MS",
        "ORACLE_SCAN_THROTTLE_MS",
        "ORACLE_PLAYER_EVENT_FLUSH_DEBOUNCE_MS",
        "ORACLE_PLAYER_EVENT_FLUSH_MAX_OPERATIONS",
        "ORACLE_AUTOCOMPLETE_DEBOUNCE_MS",
        "BOT_INTERNAL_URL",
        "ORACLE_API_TOKEN_FILE",
        "ORACLE_API_TOKEN",
        "JUPITER_API_KEY_FILE",
        "JUPITER_API_KEY",
        "JUPITER_PRICE_URL",
    ];

    /// Runs `body` with exactly `vars` set among the configuration keys,
    /// restoring the previous environment afterwards.
    fn with_env<R>(vars: &[(&str, &str)], body: impl FnOnce() -> R) -> R {
        let _guard = crate::env_test_lock();
        let saved: Vec<(&str, Option<String>)> = KEYS.iter().map(|k| (*k, std::env::var(k).ok())).collect();
        for key in KEYS {
            std::env::remove_var(key);
        }
        for (key, value) in vars {
            std::env::set_var(key, value);
        }
        let result = body();
        for (key, value) in saved {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        result
    }

    #[test]
    fn loads_defaults_from_the_environment() {
        let config =
            with_env(&[("SOLANA_NETWORK", "https://a.example, https://b.example")], OracleConfig::from_env).unwrap();
        assert_eq!(config.contract_version, ContractVersion::V0_2_0);
        assert_eq!(config.solana_networks.len(), 2);
        assert_eq!(config.solana_network, config.solana_networks[0]);
        assert!(config.solana_network.starts_with("https://a.example"));
        assert_eq!(config.solana_ws_endpoint, None);
        assert_eq!(config.oracle_port, DEFAULT_ORACLE_PORT);
        assert_eq!(config.database_file, DEFAULT_DATABASE_FILE);
        assert_eq!(config.indexer_database_file, DEFAULT_INDEXER_DATABASE_FILE);
        assert_eq!(config.indexer_poll_interval_ms, 300_000);
        assert!(
            config.operator_keypair_source == DEFAULT_KEYPAIR_FILE
                || config.operator_keypair_source == LEGACY_KEYPAIR_FILE
        );
        assert!(Path::new(&config.operator_keypair_path).is_absolute());
        assert_eq!(config.scan_throttle_ms, 0);
        assert_eq!(config.player_event_flush_debounce_ms, 100);
        assert_eq!(config.player_event_flush_max_operations, 500);
        assert_eq!(config.auto_complete_debounce_ms, 500);
        assert_eq!(config.bot_internal_url.as_deref(), Some("http://bot:3002"));
        assert_eq!(config.api_token, None);
        assert_eq!(config.jupiter_api_key, None);
        assert_eq!(config.jupiter_price_url, "https://api.jup.ag/price/v3");
        assert_eq!(config.environment, timba_common::env::environment_mode());
    }

    #[test]
    fn loads_overrides_from_the_environment() {
        let dir = tempfile::tempdir().unwrap();
        let token_file = dir.path().join("token");
        std::fs::write(&token_file, " file-token \n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&token_file, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let token_path = token_file.to_str().unwrap().to_string();
        let config = with_env(
            &[
                ("SOLANA_NETWORK", "https://rpc.example"),
                ("SOLANA_WS_ENDPOINT", "wss://ws.example"),
                ("ORACLE_KEYPAIR_PATH", "/keys/operator.json"),
                ("ORACLE_PORT", "4000"),
                ("CONTRACT_VERSION", " 0.3.0 "),
                ("DATABASE_FILE", "/data/o.sqlite"),
                ("INDEXER_DATABASE_FILE", "/data/i.sqlite"),
                ("INDEXER_POLL_INTERVAL_MS", "6000"),
                ("ORACLE_SCAN_THROTTLE_MS", "25"),
                ("ORACLE_PLAYER_EVENT_FLUSH_DEBOUNCE_MS", "0"),
                ("ORACLE_PLAYER_EVENT_FLUSH_MAX_OPERATIONS", "10"),
                ("ORACLE_AUTOCOMPLETE_DEBOUNCE_MS", "5"),
                ("BOT_INTERNAL_URL", "http://bot.internal"),
                ("ORACLE_API_TOKEN_FILE", &token_path),
                ("ORACLE_API_TOKEN", "ignored-when-a-file-is-set"),
                ("JUPITER_API_KEY", " jup-key "),
                ("JUPITER_PRICE_URL", "https://prices.example"),
            ],
            OracleConfig::from_env,
        )
        .unwrap();
        assert_eq!(config.contract_version, ContractVersion::V0_3_0);
        assert_eq!(config.solana_ws_endpoint.as_deref(), Some("wss://ws.example"));
        assert_eq!(config.operator_keypair_source, "/keys/operator.json");
        assert_eq!(config.operator_keypair_path, "/keys/operator.json");
        assert_eq!(config.oracle_port, 4000);
        assert_eq!(config.database_file, "/data/o.sqlite");
        assert_eq!(config.indexer_database_file, "/data/i.sqlite");
        assert_eq!(config.indexer_poll_interval_ms, 6_000);
        assert_eq!(config.scan_throttle_ms, 25);
        assert_eq!(config.player_event_flush_debounce_ms, 0);
        assert_eq!(config.player_event_flush_max_operations, 10);
        assert_eq!(config.auto_complete_debounce_ms, 5);
        assert_eq!(config.bot_internal_url.as_deref(), Some("http://bot.internal"));
        assert_eq!(config.api_token.as_deref(), Some("file-token"));
        assert_eq!(config.jupiter_api_key.as_deref(), Some("jup-key"));
        assert_eq!(config.jupiter_price_url, "https://prices.example");

        // OPERATOR_KEYPAIR_PATH wins over the legacy variable.
        let config = with_env(
            &[
                ("SOLANA_NETWORK", "https://rpc.example"),
                ("OPERATOR_KEYPAIR_PATH", "/keys/new.json"),
                ("ORACLE_KEYPAIR_PATH", "/keys/old.json"),
                ("ORACLE_API_TOKEN", "env-token"),
            ],
            OracleConfig::from_env,
        )
        .unwrap();
        assert_eq!(config.operator_keypair_source, "/keys/new.json");
        assert_eq!(config.api_token.as_deref(), Some("env-token"));
    }

    #[test]
    fn invalid_values_fall_back_or_fail() {
        let config = with_env(
            &[
                ("SOLANA_NETWORK", "https://rpc.example"),
                ("ORACLE_PORT", "70000"),
                ("INDEXER_POLL_INTERVAL_MS", "100"),
                ("ORACLE_SCAN_THROTTLE_MS", "-5"),
                ("ORACLE_PLAYER_EVENT_FLUSH_MAX_OPERATIONS", "0"),
                ("ORACLE_AUTOCOMPLETE_DEBOUNCE_MS", "soon"),
            ],
            OracleConfig::from_env,
        )
        .unwrap();
        assert_eq!(config.oracle_port, DEFAULT_ORACLE_PORT);
        assert_eq!(config.indexer_poll_interval_ms, 300_000);
        assert_eq!(config.scan_throttle_ms, 0);
        assert_eq!(config.player_event_flush_max_operations, 500);
        assert_eq!(config.auto_complete_debounce_ms, 500);

        assert_eq!(with_env(&[], OracleConfig::from_env).unwrap_err(), "SOLANA_NETWORK is required");
        let err = with_env(&[("SOLANA_NETWORK", "https://rpc.example"), ("CONTRACT_VERSION", "9.9.9")], || {
            OracleConfig::from_env()
        })
        .unwrap_err();
        assert_eq!(err, "CONTRACT_VERSION must be one of 0.2.0, 0.3.0; received 9.9.9");
        let err = with_env(
            &[("SOLANA_NETWORK", "https://rpc.example"), ("JUPITER_API_KEY_FILE", "/definitely/missing/key")],
            OracleConfig::from_env,
        )
        .unwrap_err();
        assert!(err.contains("Jupiter API key file could not be read"), "{err}");
    }

    #[test]
    fn global_config_is_loaded_once() {
        let first = with_env(&[("SOLANA_NETWORK", "https://rpc.example")], || {
            OracleConfig::global().map(|c| c as *const OracleConfig)
        });
        let second = OracleConfig::global().map(|c| c as *const OracleConfig);
        assert_eq!(first, second);
    }
}
