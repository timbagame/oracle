//! Deployment configuration and secret files (port of `evm/config.ts`).

use std::path::Path;

use alloy_primitives::Address;
use serde_json::Value;

use timba_protocol::evm::client::{EvmDeployment, EVM_CONTRACT_VERSION};
use timba_protocol::evm::schema::{
    self, address, fail, integer, join, required, strict_object, string, EvmToken, SchemaError, SchemaResult,
    MAX_SAFE_INTEGER,
};

#[derive(Clone, PartialEq, Eq)]
pub struct EvmConfig {
    pub chain_id: u64,
    pub address: Address,
    pub version: String,
    pub rpc_urls: Vec<String>,
    pub start_block: u64,
    pub confirmations: u32,
    pub poll_ms: u64,
    pub database: String,
    pub operator_key_file: String,
    pub api_token_file: String,
    pub port: u16,
    /// Token policy is deliberately off chain. Never authorize arbitrary contracts.
    pub tokens: Vec<EvmToken>,
}

/// RPC URLs often embed provider keys, so `Debug` shows only their hosts.
impl std::fmt::Debug for EvmConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let rpc_urls: Vec<String> = self.rpc_urls.iter().map(|url| timba_common::security::redact_url(url)).collect();
        f.debug_struct("EvmConfig")
            .field("chain_id", &self.chain_id)
            .field("address", &self.address)
            .field("version", &self.version)
            .field("rpc_urls", &rpc_urls)
            .field("start_block", &self.start_block)
            .field("confirmations", &self.confirmations)
            .field("poll_ms", &self.poll_ms)
            .field("database", &self.database)
            .field("operator_key_file", &self.operator_key_file)
            .field("api_token_file", &self.api_token_file)
            .field("port", &self.port)
            .field("tokens", &self.tokens)
            .finish()
    }
}

impl EvmConfig {
    pub fn deployment(&self) -> EvmDeployment {
        EvmDeployment { chain_id: self.chain_id, address: self.address, version: self.version.clone() }
    }
}

const CONFIG_KEYS: &[&str] = &[
    "chainId",
    "address",
    "version",
    "rpcUrls",
    "startBlock",
    "confirmations",
    "pollMs",
    "database",
    "operatorKeyFile",
    "apiTokenFile",
    "port",
    "tokens",
];

fn non_empty(value: &Value, path: &str) -> SchemaResult<String> {
    let text = string(value, path)?;
    if text.is_empty() {
        return fail(path, "Too small: expected string to have >=1 characters");
    }
    Ok(text.to_string())
}

/// `integer` with a zod `.default()` for a missing key.
fn integer_or(
    object: &serde_json::Map<String, Value>,
    key: &str,
    min: i64,
    max: i64,
    default: i64,
) -> SchemaResult<i64> {
    object.get(key).map_or(Ok(default), |value| integer(value, key, min, max))
}

/// `configSchema.parse`.
pub fn parse_config(value: &Value) -> SchemaResult<EvmConfig> {
    let object = strict_object(value, "", CONFIG_KEYS)?;
    let get = |key: &str| required(object, "", key);
    let chain_id = integer(get("chainId")?, "chainId", 1, MAX_SAFE_INTEGER)? as u64;
    let address = address(get("address")?, "address")?;
    if get("version")?.as_str() != Some(EVM_CONTRACT_VERSION) {
        return fail("version", "Invalid input: expected \"0.1.0\"");
    }
    let Some(urls) = get("rpcUrls")?.as_array() else {
        return fail("rpcUrls", "Invalid input: expected array");
    };
    if urls.is_empty() {
        return fail("rpcUrls", "Too small: expected array to have >=1 items");
    }
    let rpc_urls = urls
        .iter()
        .enumerate()
        .map(|(index, url)| {
            let path = join("rpcUrls", &index.to_string());
            let text = string(url, &path)?;
            match url::Url::parse(text) {
                Ok(_) => Ok(text.to_string()),
                Err(_) => fail(&path, "Invalid URL"),
            }
        })
        .collect::<SchemaResult<Vec<_>>>()?;
    let start_block = schema::uint(get("startBlock")?, "startBlock")?;
    if start_block > alloy_primitives::U256::from(MAX_SAFE_INTEGER) {
        return fail("startBlock", "Invalid input");
    }
    Ok(EvmConfig {
        chain_id,
        address,
        version: EVM_CONTRACT_VERSION.to_string(),
        rpc_urls,
        start_block: start_block.to::<u64>(),
        confirmations: integer_or(object, "confirmations", 1, 256, 2)? as u32,
        poll_ms: integer_or(object, "pollMs", 250, 60_000, 2_000)? as u64,
        database: non_empty(get("database")?, "database")?,
        operator_key_file: non_empty(get("operatorKeyFile")?, "operatorKeyFile")?,
        api_token_file: non_empty(get("apiTokenFile")?, "apiTokenFile")?,
        port: integer_or(object, "port", 1, 65_535, 3_002)? as u16,
        tokens: schema::tokens(get("tokens")?, "tokens")?,
    })
}

pub fn load_config(path: &str) -> anyhow::Result<EvmConfig> {
    let text = std::fs::read_to_string(path).map_err(|error| anyhow::anyhow!("{error}, open '{path}'"))?;
    let value: Value = serde_json::from_str(&text)?;
    // `schema::tokens` already rejects duplicate token addresses and symbols.
    parse_config(&value).map_err(|error: SchemaError| anyhow::anyhow!("Invalid EVM config: {error}"))
}

/// Reads a private secret: a regular file (symlinks are followed), at most 4096 bytes,
/// without group or other permissions, non-empty after trimming.
pub fn load_secret(path: &str) -> anyhow::Result<String> {
    let info = std::fs::metadata(Path::new(path)).map_err(|error| anyhow::anyhow!("{error}, stat '{path}'"))?;
    #[cfg(unix)]
    let private = {
        use std::os::unix::fs::PermissionsExt;
        info.permissions().mode() & 0o077 == 0
    };
    #[cfg(not(unix))]
    let private = true;
    if !info.is_file() || info.len() > 4096 || !private {
        anyhow::bail!("EVM secret files must be private regular files (mode 600 or 400)");
    }
    let bytes = std::fs::read(path)?;
    let text = String::from_utf8_lossy(&bytes);
    let value = timba_common::env::js_trim(&text);
    if value.is_empty() {
        anyhow::bail!("Empty EVM secret file");
    }
    Ok(value.to_string())
}

pub fn token_policy(config: &EvmConfig, address: Address) -> anyhow::Result<&EvmToken> {
    config.tokens.iter().find(|token| token.address == address).ok_or_else(|| anyhow::anyhow!("Unsupported EVM token"))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::os::unix::fs::PermissionsExt;

    const EXAMPLE: &str = include_str!("../config.example.json");

    fn write(dir: &tempfile::TempDir, name: &str, contents: &str, mode: u32) -> String {
        let path = dir.path().join(name);
        std::fs::write(&path, contents).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        path.to_str().unwrap().to_string()
    }

    fn example() -> Value {
        serde_json::from_str(EXAMPLE).unwrap()
    }

    #[test]
    fn rejects_unusable_rpc_lists_and_duplicate_token_policies() {
        let mut config = example();
        config["rpcUrls"] = json!("http://127.0.0.1:8545");
        assert_eq!(parse_config(&config).unwrap_err().to_string(), "rpcUrls: Invalid input: expected array");

        let mut config = example();
        let mut duplicate = config["tokens"][0].clone();
        duplicate["symbol"] = json!("COPY");
        config["tokens"].as_array_mut().unwrap().push(duplicate);
        let dir = tempfile::tempdir().unwrap();
        let file = write(&dir, "config.json", &config.to_string(), 0o600);
        assert_eq!(load_config(&file).unwrap_err().to_string(), "Invalid EVM config: tokens: Duplicate token policy");
    }

    #[test]
    fn parses_the_example_deployment_config() {
        let dir = tempfile::tempdir().unwrap();
        let config = load_config(&write(&dir, "config.json", EXAMPLE, 0o600)).unwrap();
        assert_eq!(config.chain_id, 31337);
        assert_eq!(config.confirmations, 2);
        assert_eq!(config.poll_ms, 2000);
        assert_eq!(config.port, 3002);
        assert_eq!(config.tokens.len(), 1);
    }

    #[test]
    fn debug_output_hides_rpc_keys() {
        let mut value = example();
        value["rpcUrls"] = serde_json::json!(["https://eth.example/v2/secret-key"]);
        let printed = format!("{:?}", parse_config(&value).unwrap());
        assert!(printed.contains("https://eth.example/[redacted]") && !printed.contains("secret-key"), "{printed}");
    }

    #[test]
    fn applies_defaults_for_optional_numbers() {
        let mut value = example();
        for key in ["confirmations", "pollMs", "port"] {
            value.as_object_mut().unwrap().remove(key);
        }
        let config = parse_config(&value).unwrap();
        assert_eq!((config.confirmations, config.poll_ms, config.port), (2, 2000, 3002));
    }

    #[test]
    fn rejects_duplicate_token_policies() {
        let dir = tempfile::tempdir().unwrap();
        let mut value = example();
        let token = value["tokens"][0].clone();
        value["tokens"] = Value::Array(vec![token.clone(), token]);
        let path = write(&dir, "config.json", &value.to_string(), 0o600);
        let error = load_config(&path).unwrap_err().to_string();
        assert!(error.contains("Duplicate token policy"), "{error}");
    }

    #[test]
    fn rejects_unknown_keys_and_invalid_values() {
        let mut value = example();
        value["secret"] = "nope".into();
        assert!(parse_config(&value).is_err());
        for (key, invalid) in [
            ("pollMs", Value::from(100)),
            ("confirmations", Value::from(257)),
            ("startBlock", Value::from("9007199254740992")),
            ("rpcUrls", serde_json::json!(["not a url"])),
            ("rpcUrls", serde_json::json!([])),
            ("version", Value::from("0.2.0")),
            ("database", Value::from("")),
        ] {
            let mut value = example();
            value[key] = invalid;
            assert!(parse_config(&value).is_err(), "{key} accepted");
        }
    }

    #[test]
    fn reads_a_private_secret_without_surrounding_whitespace() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_secret(&write(&dir, "secret", "  token-value\n", 0o600)).unwrap(), "token-value");
        assert_eq!(load_secret(&write(&dir, "readonly", "value", 0o400)).unwrap(), "value");
        // A byte order mark from a Windows editor is trimmed, as `String.trim` does.
        assert_eq!(load_secret(&write(&dir, "bom", "\u{feff}token-value\r\n", 0o600)).unwrap(), "token-value");
        assert_eq!(
            load_secret(&write(&dir, "only-bom", "\u{feff}\n", 0o600)).unwrap_err().to_string(),
            "Empty EVM secret file"
        );
        let latin1 = dir.path().join("latin1");
        std::fs::write(&latin1, b"caf\xe9").unwrap();
        std::fs::set_permissions(&latin1, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(load_secret(latin1.to_str().unwrap()).unwrap(), "caf\u{fffd}");
    }

    #[test]
    fn rejects_group_readable_oversized_and_empty_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let message = "EVM secret files must be private regular files (mode 600 or 400)";
        let readable = write(&dir, "readable", "token", 0o644);
        assert_eq!(load_secret(&readable).unwrap_err().to_string(), message);
        let large = write(&dir, "large", &"x".repeat(4097), 0o600);
        assert_eq!(load_secret(&large).unwrap_err().to_string(), message);
        let empty = write(&dir, "empty", "  \n", 0o600);
        assert_eq!(load_secret(&empty).unwrap_err().to_string(), "Empty EVM secret file");
        assert_eq!(load_secret(dir.path().to_str().unwrap()).unwrap_err().to_string(), message);
    }

    #[test]
    fn matches_token_addresses_regardless_of_checksum_casing() {
        let config = parse_config(&example()).unwrap();
        let token = schema::parse_address("0x2222222222222222222222222222222222222222").unwrap();
        assert_eq!(token_policy(&config, token).unwrap().symbol, "TEST");
        let other = schema::parse_address("0x3333333333333333333333333333333333333333").unwrap();
        assert_eq!(token_policy(&config, other).unwrap_err().to_string(), "Unsupported EVM token");
    }
}
