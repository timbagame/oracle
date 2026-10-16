//! Wire validation for the protocol's EVM HTTP schemas (`evm/http.ts`).
//!
//! The TypeScript service validates with zod; these helpers apply the same
//! rules (strict objects, integer bounds, canonical decimal uint256 strings,
//! checksummed addresses) and report the first failing path.

use alloy_primitives::{Address, Bytes, B256, U256};
use serde::Serialize;
use serde_json::{Map, Value};

/// JavaScript `Number.MAX_SAFE_INTEGER`.
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{}{message}", if path.is_empty() { String::new() } else { format!("{path}: ") })]
pub struct SchemaError {
    pub path: String,
    pub message: String,
}

pub type SchemaResult<T> = Result<T, SchemaError>;

pub(crate) fn fail<T>(path: &str, message: impl Into<String>) -> SchemaResult<T> {
    Err(SchemaError { path: path.to_string(), message: message.into() })
}

pub(crate) fn join(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_string()
    } else {
        format!("{path}.{key}")
    }
}

/// `z.strictObject`: an object with no keys outside `allowed`.
pub(crate) fn strict_object<'a>(
    value: &'a Value,
    path: &str,
    allowed: &[&str],
) -> SchemaResult<&'a Map<String, Value>> {
    let Some(object) = value.as_object() else {
        return fail(path, "Invalid input: expected object");
    };
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return fail(path, format!("Unrecognized key: \"{key}\""));
    }
    Ok(object)
}

/// A present field (zod treats a missing key as `undefined`).
pub(crate) fn required<'a>(object: &'a Map<String, Value>, path: &str, key: &str) -> SchemaResult<&'a Value> {
    match object.get(key) {
        Some(value) => Ok(value),
        None => fail(&join(path, key), "Invalid input: expected value, received undefined"),
    }
}

/// `z.number().int().min(min).max(max)`; zod integers are always safe integers.
pub(crate) fn integer(value: &Value, path: &str, min: i64, max: i64) -> SchemaResult<i64> {
    let Some(number) = value.as_number() else {
        return fail(path, "Invalid input: expected number");
    };
    let integer = if let Some(integer) = number.as_i64() {
        integer
    } else {
        match number.as_f64() {
            Some(float) if float.fract() == 0.0 && float.abs() <= MAX_SAFE_INTEGER as f64 => float as i64,
            _ => return fail(path, "Invalid input: expected int, received number"),
        }
    };
    if integer.abs() > MAX_SAFE_INTEGER {
        return fail(path, "Invalid input: expected int, received number");
    }
    if integer < min {
        return fail(path, format!("Too small: expected number to be >={min}"));
    }
    if integer > max {
        return fail(path, format!("Too big: expected number to be <={max}"));
    }
    Ok(integer)
}

pub(crate) fn string<'a>(value: &'a Value, path: &str) -> SchemaResult<&'a str> {
    value.as_str().map_or_else(|| fail(path, "Invalid input: expected string"), Ok)
}

pub(crate) fn boolean(value: &Value, path: &str) -> SchemaResult<bool> {
    value.as_bool().map_or_else(|| fail(path, "Invalid input: expected boolean"), Ok)
}

fn is_hex(text: &str) -> bool {
    text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// `/^0x[0-9a-fA-F]{40}$/` (any casing accepted, like viem's non-strict `getAddress`).
pub fn parse_address(text: &str) -> Option<Address> {
    let digits = text.strip_prefix("0x")?;
    if digits.len() != 40 || !is_hex(digits) {
        return None;
    }
    let mut bytes = [0u8; 20];
    hex::decode_to_slice(digits, &mut bytes).ok()?;
    Some(Address::from(bytes))
}

/// `/^0x[0-9a-fA-F]{64}$/`.
pub fn parse_bytes32(text: &str) -> Option<B256> {
    let digits = text.strip_prefix("0x")?;
    if digits.len() != 64 || !is_hex(digits) {
        return None;
    }
    let mut bytes = [0u8; 32];
    hex::decode_to_slice(digits, &mut bytes).ok()?;
    Some(B256::from(bytes))
}

/// `/^(0|[1-9][0-9]*)$/`, at most 78 characters and below 2^256.
pub fn parse_uint(text: &str) -> Option<U256> {
    let canonical =
        text == "0" || (!text.is_empty() && !text.starts_with('0') && text.bytes().all(|byte| byte.is_ascii_digit()));
    if !canonical || text.len() > 78 {
        return None;
    }
    U256::from_str_radix(text, 10).ok()
}

/// `addressSchema`: transforms to the checksummed address.
pub(crate) fn address(value: &Value, path: &str) -> SchemaResult<Address> {
    let text = string(value, path)?;
    parse_address(text).map_or_else(|| fail(path, "Invalid string: must match pattern"), Ok)
}

/// `uintSchema`: decimal uint256 strings only; JSON numbers are rejected.
pub(crate) fn uint(value: &Value, path: &str) -> SchemaResult<U256> {
    let text = string(value, path)?;
    parse_uint(text).map_or_else(|| fail(path, "Invalid uint256 decimal string"), Ok)
}

/// `hexSignature`: non-empty even-length hex of at most 8194 characters.
pub(crate) fn hex_signature(value: &Value, path: &str) -> SchemaResult<Bytes> {
    let text = string(value, path)?;
    if text.len() > 8194 {
        return fail(path, "Too big: expected string to have <=8194 characters");
    }
    match text.strip_prefix("0x") {
        Some(digits) if !digits.is_empty() && digits.len() % 2 == 0 && is_hex(digits) => {
            Ok(Bytes::from(hex::decode(digits).expect("validated hex")))
        }
        _ => fail(path, "Invalid string: must match pattern"),
    }
}

/// One `evmTokenSchema` entry of the deployment token policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvmToken {
    #[serde(serialize_with = "serialize_checksummed")]
    pub address: Address,
    pub symbol: String,
    pub decimals: u8,
    pub minimum_amount: String,
}

pub fn serialize_checksummed<S: serde::Serializer>(address: &Address, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&address.to_checksum(None))
}

fn token(value: &Value, path: &str) -> SchemaResult<EvmToken> {
    let object = strict_object(value, path, &["address", "symbol", "decimals", "minimumAmount"])?;
    let address = address(required(object, path, "address")?, &join(path, "address"))?;
    let symbol_path = join(path, "symbol");
    let symbol = string(required(object, path, "symbol")?, &symbol_path)?;
    if symbol.is_empty()
        || symbol.len() > 16
        || !symbol.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return fail(&symbol_path, "Invalid string: must match pattern");
    }
    let decimals = integer(required(object, path, "decimals")?, &join(path, "decimals"), 0, 36)?;
    let minimum_path = join(path, "minimumAmount");
    let minimum = uint(required(object, path, "minimumAmount")?, &minimum_path)?;
    if minimum.is_zero() {
        return fail(&minimum_path, "Invalid input");
    }
    Ok(EvmToken { address, symbol: symbol.to_string(), decimals: decimals as u8, minimum_amount: minimum.to_string() })
}

/// `evmMetadataSchema.shape.tokens`: at least one token, unique addresses and symbols.
pub fn tokens(value: &Value, path: &str) -> SchemaResult<Vec<EvmToken>> {
    let Some(items) = value.as_array() else {
        return fail(path, "Invalid input: expected array");
    };
    if items.is_empty() {
        return fail(path, "Too small: expected array to have >=1 items");
    }
    let tokens = items
        .iter()
        .enumerate()
        .map(|(index, item)| token(item, &join(path, &index.to_string())))
        .collect::<SchemaResult<Vec<_>>>()?;
    let mut addresses = std::collections::HashSet::new();
    let mut symbols = std::collections::HashSet::new();
    for token in &tokens {
        if !addresses.insert(token.address) || !symbols.insert(token.symbol.to_lowercase()) {
            return fail(path, "Duplicate token policy");
        }
    }
    Ok(tokens)
}

/// `evmIntentSchema` output: creation terms plus the creator's proof.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvmIntent {
    pub creator: Address,
    pub token: Address,
    pub game_type: u8,
    pub amount: U256,
    pub min_players: u32,
    pub max_players: u32,
    pub timeout: u32,
    pub is_private: bool,
    pub nonce: U256,
    pub deadline: U256,
    pub proof: Bytes,
}

const INTENT_KEYS: &[&str] = &[
    "creator",
    "token",
    "gameType",
    "amount",
    "minPlayers",
    "maxPlayers",
    "timeout",
    "isPrivate",
    "nonce",
    "deadline",
    "proof",
];

pub fn parse_intent(value: &Value) -> SchemaResult<EvmIntent> {
    let object = strict_object(value, "", INTENT_KEYS)?;
    let get = |key: &str| required(object, "", key);
    let game_type = match get("gameType")?.as_number().and_then(|number| number.as_f64()) {
        Some(0.0) => 0,
        Some(1.0) => 1,
        _ => return fail("gameType", "Invalid input"),
    };
    Ok(EvmIntent {
        creator: address(get("creator")?, "creator")?,
        token: address(get("token")?, "token")?,
        game_type,
        amount: uint(get("amount")?, "amount")?,
        min_players: integer(get("minPlayers")?, "minPlayers", 1, 100)? as u32,
        max_players: integer(get("maxPlayers")?, "maxPlayers", 1, 100)? as u32,
        timeout: integer(get("timeout")?, "timeout", 300, 86_400)? as u32,
        is_private: boolean(get("isPrivate")?, "isPrivate")?,
        nonce: uint(get("nonce")?, "nonce")?,
        deadline: uint(get("deadline")?, "deadline")?,
        proof: hex_signature(get("proof")?, "proof")?,
    })
}

/// `evmPrivateJoinSchema` output. `deadline` keeps the caller's decimal text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvmPrivateJoin {
    pub game_id: B256,
    pub player: Address,
    pub deadline: String,
    pub proof: Bytes,
}

pub fn parse_private_join(value: &Value) -> SchemaResult<EvmPrivateJoin> {
    let object = strict_object(value, "", &["gameId", "player", "deadline", "proof"])?;
    let get = |key: &str| required(object, "", key);
    let game_id = string(get("gameId")?, "gameId")?;
    let game_id = parse_bytes32(game_id).map_or_else(|| fail("gameId", "Invalid string: must match pattern"), Ok)?;
    let deadline = get("deadline")?;
    uint(deadline, "deadline")?;
    Ok(EvmPrivateJoin {
        game_id,
        player: address(get("player")?, "player")?,
        deadline: deadline.as_str().unwrap_or_default().to_string(),
        proof: hex_signature(get("proof")?, "proof")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid_intent() -> Value {
        json!({
            "creator": format!("0x{}", "11".repeat(20)),
            "token": format!("0x{}", "22".repeat(20)),
            "gameType": 0,
            "amount": "1",
            "minPlayers": 2,
            "maxPlayers": 2,
            "timeout": 3600,
            "isPrivate": false,
            "nonce": "0",
            "deadline": "12345",
            "proof": "0x12",
        })
    }

    fn with(base: &Value, key: &str, value: Value) -> Value {
        let mut next = base.clone();
        next[key] = value;
        next
    }

    #[test]
    fn authorization_wire_validation_rejects_overflow_numbers_and_excessive_limits() {
        let valid = valid_intent();
        assert!(parse_intent(&valid).is_ok());
        let overflow = U256::MAX.to_string();
        let too_long = format!("{overflow}0");
        let two_pow_256 = "115792089237316195423570985008687907853269984665640564039457584007913129639936";
        for (key, value) in [
            ("amount", json!(two_pow_256)),
            ("amount", json!(too_long)),
            ("amount", json!(1)),
            ("amount", json!("01")),
            ("maxPlayers", json!(101)),
            ("timeout", json!(86_401)),
            ("timeout", json!(3600.5)),
            ("gameType", json!(2)),
            ("proof", json!("0x1")),
            ("proof", json!("0x")),
            ("secret", json!("never accepted")),
        ] {
            assert!(parse_intent(&with(&valid, key, value)).is_err(), "{key} accepted");
        }
        assert!(parse_intent(&with(&valid, "amount", json!(overflow))).is_ok());
        assert!(parse_intent(&with(&valid, "timeout", json!(3600.0))).is_ok());
    }

    #[test]
    fn intent_checksums_addresses() {
        let intent =
            parse_intent(&with(&valid_intent(), "creator", json!("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")))
                .unwrap();
        assert_eq!(intent.creator.to_checksum(None), "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa");
    }

    #[test]
    fn private_join_keeps_the_deadline_text() {
        let input = json!({
            "gameId": format!("0x{}", "Ab".repeat(32)),
            "player": format!("0x{}", "33".repeat(20)),
            "deadline": "900",
            "proof": "0xabcd",
        });
        let parsed = parse_private_join(&input).unwrap();
        assert_eq!(parsed.deadline, "900");
        assert!(parse_private_join(&with(&input, "gameId", json!("0x12"))).is_err());
        assert!(parse_private_join(&with(&input, "deadline", json!(900))).is_err());
    }

    #[test]
    fn token_policy_rejects_duplicates_case_insensitively() {
        let token = |address: &str, symbol: &str| json!({ "address": address, "symbol": symbol, "decimals": 18, "minimumAmount": "1" });
        let a = format!("0x{}", "22".repeat(20));
        let b = format!("0x{}", "23".repeat(20));
        assert!(tokens(&json!([token(&a, "A"), token(&b, "B")]), "tokens").is_ok());
        let error = tokens(&json!([token(&a, "A"), token(&b, "a")]), "tokens").unwrap_err();
        assert_eq!(error.to_string(), "tokens: Duplicate token policy");
        assert!(tokens(&json!([]), "tokens").is_err());
        let zero = json!([{ "address": a, "symbol": "A", "decimals": 18, "minimumAmount": "0" }]);
        assert!(tokens(&zero, "tokens").is_err());
        let symbol = json!([{ "address": a, "symbol": "A B", "decimals": 18, "minimumAmount": "1" }]);
        assert!(tokens(&symbol, "tokens").is_err());
    }
}
