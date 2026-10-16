//! Minimal stand-ins for the zod behaviour the HTTP surfaces rely on: query
//! coercion (`z.coerce.number()`), response parsing that validates fields,
//! strips unknown keys and emits keys in schema order, and the JavaScript
//! `Number()`/`String()` conversions applied to SQLite rows.

use serde_json::{Map, Value};
use timba_protocol::validators::{is_solana_address, is_solana_signature, is_u64_string};

pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Marker for values that are not JSON numbers in JavaScript (`NaN`,
/// `Infinity`). Number schemas reject it, like zod rejects non-finite numbers.
const NOT_A_NUMBER: &str = "NaN";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Schema validation failed at {path}: {message}")]
pub struct SchemaError {
    pub path: String,
    pub message: String,
}

impl SchemaError {
    fn new(path: &str, message: impl Into<String>) -> Self {
        Self { path: if path.is_empty() { "<root>".into() } else { path.to_string() }, message: message.into() }
    }
}

/// A subset of zod schemas, enough to mirror the protocol response schemas.
#[derive(Debug)]
pub enum Schema {
    /// `SolanaAddressSchema`
    Address,
    /// `SolanaSignatureSchema`
    Signature,
    /// `Hex32Schema`
    Hex32,
    /// `U64StringSchema`
    U64String,
    /// `z.string().min(1)`
    NonEmptyString,
    /// `z.url()` (only http/https URLs are produced here)
    Url,
    /// `z.boolean()`
    Bool,
    /// `z.literal("...")`
    Literal(&'static str),
    /// `z.union([z.literal(n), ...])`
    IntLiterals(&'static [i64]),
    /// `z.enum([...])`
    Enum(&'static [&'static str]),
    /// `z.number().finite().nonnegative()`
    NonNegativeNumber,
    /// `z.number().int().nonnegative()`
    NonNegativeInteger,
    /// `z.number().int().positive()`
    PositiveInteger,
    /// `z.number().int().min(a).max(b)`
    IntegerRange(i64, i64),
    Nullable(&'static Schema),
    Optional(&'static Schema),
    Array {
        item: &'static Schema,
        min: usize,
        max: usize,
    },
    /// `z.object({...})`: unknown keys are stripped, output follows the shape order.
    Object(&'static [(&'static str, Schema)]),
}

fn safe_integer(value: &Value) -> Option<i64> {
    let number = value.as_number()?;
    if let Some(v) = number.as_i64() {
        return (v.unsigned_abs() as f64 <= MAX_SAFE_INTEGER).then_some(v);
    }
    if number.as_u64().is_some() {
        return None;
    }
    let f = number.as_f64()?;
    (f.is_finite() && f.fract() == 0.0 && f.abs() <= MAX_SAFE_INTEGER).then_some(f as i64)
}

fn finite_number(value: &Value) -> Option<f64> {
    value.as_number()?.as_f64().filter(|f| f.is_finite())
}

/// JSON number formatting that matches `JSON.stringify` for integral values.
pub fn normalize_number(value: f64) -> Value {
    if !value.is_finite() {
        return Value::Null;
    }
    if value.fract() == 0.0 && value.abs() < 9.2e18 {
        return Value::from(value as i64);
    }
    Value::from(value)
}

fn normalize_number_value(value: &Value) -> Value {
    match value.as_number() {
        Some(n) if n.is_i64() || n.is_u64() => value.clone(),
        Some(n) => normalize_number(n.as_f64().unwrap_or(f64::NAN)),
        None => value.clone(),
    }
}

fn join(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_string()
    } else {
        format!("{path}.{key}")
    }
}

fn parse_at(schema: &Schema, value: &Value, path: &str) -> Result<Value, SchemaError> {
    let string = || value.as_str().ok_or_else(|| SchemaError::new(path, "expected string"));
    match schema {
        Schema::Address => {
            let s = string()?;
            if is_solana_address(s) {
                Ok(value.clone())
            } else {
                Err(SchemaError::new(path, "invalid Solana address"))
            }
        }
        Schema::Signature => {
            let s = string()?;
            if is_solana_signature(s) {
                Ok(value.clone())
            } else {
                Err(SchemaError::new(path, "invalid Solana signature"))
            }
        }
        Schema::Hex32 => {
            let s = string()?;
            if s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()) {
                Ok(value.clone())
            } else {
                Err(SchemaError::new(path, "invalid hex32"))
            }
        }
        Schema::U64String => {
            let s = string()?;
            if is_u64_string(s) {
                Ok(value.clone())
            } else {
                Err(SchemaError::new(path, "invalid u64 string"))
            }
        }
        Schema::NonEmptyString => {
            if string()?.is_empty() {
                Err(SchemaError::new(path, "expected a non-empty string"))
            } else {
                Ok(value.clone())
            }
        }
        Schema::Url => match url::Url::parse(string()?) {
            Ok(_) => Ok(value.clone()),
            Err(_) => Err(SchemaError::new(path, "invalid URL")),
        },
        Schema::Bool => {
            if value.is_boolean() {
                Ok(value.clone())
            } else {
                Err(SchemaError::new(path, "expected boolean"))
            }
        }
        Schema::Literal(expected) => {
            if value.as_str() == Some(*expected) {
                Ok(value.clone())
            } else {
                Err(SchemaError::new(path, format!("expected literal {expected}")))
            }
        }
        Schema::IntLiterals(allowed) => match safe_integer(value) {
            Some(v) if allowed.contains(&v) => Ok(Value::from(v)),
            _ => Err(SchemaError::new(path, "unexpected literal")),
        },
        Schema::Enum(values) => match value.as_str() {
            Some(v) if values.contains(&v) => Ok(value.clone()),
            _ => Err(SchemaError::new(path, "invalid enum value")),
        },
        Schema::NonNegativeNumber => match finite_number(value) {
            Some(v) if v >= 0.0 => Ok(normalize_number_value(value)),
            _ => Err(SchemaError::new(path, "expected a non-negative finite number")),
        },
        Schema::NonNegativeInteger => match safe_integer(value) {
            Some(v) if v >= 0 => Ok(Value::from(v)),
            _ => Err(SchemaError::new(path, "expected a non-negative integer")),
        },
        Schema::PositiveInteger => match safe_integer(value) {
            Some(v) if v > 0 => Ok(Value::from(v)),
            _ => Err(SchemaError::new(path, "expected a positive integer")),
        },
        Schema::IntegerRange(min, max) => match safe_integer(value) {
            Some(v) if v >= *min && v <= *max => Ok(Value::from(v)),
            _ => Err(SchemaError::new(path, "integer out of range")),
        },
        Schema::Nullable(inner) => {
            if value.is_null() {
                Ok(Value::Null)
            } else {
                parse_at(inner, value, path)
            }
        }
        Schema::Optional(inner) => parse_at(inner, value, path),
        Schema::Array { item, min, max } => {
            let items = value.as_array().ok_or_else(|| SchemaError::new(path, "expected array"))?;
            if items.len() < *min || items.len() > *max {
                return Err(SchemaError::new(path, "array length out of range"));
            }
            items
                .iter()
                .enumerate()
                .map(|(index, item_value)| parse_at(item, item_value, &join(path, &index.to_string())))
                .collect::<Result<Vec<_>, _>>()
                .map(Value::Array)
        }
        Schema::Object(shape) => {
            let input = value.as_object().ok_or_else(|| SchemaError::new(path, "expected object"))?;
            let mut output = Map::new();
            for (key, field) in shape.iter() {
                match input.get(*key) {
                    None => {
                        if !matches!(field, Schema::Optional(_)) {
                            return Err(SchemaError::new(&join(path, key), "required"));
                        }
                    }
                    Some(field_value) => {
                        output.insert((*key).to_string(), parse_at(field, field_value, &join(path, key))?);
                    }
                }
            }
            Ok(Value::Object(output))
        }
    }
}

/// `schema.parse(value)`.
pub fn parse(schema: &Schema, value: &Value) -> Result<Value, SchemaError> {
    parse_at(schema, value, "")
}

/// Unbounded array of `item` (`z.array(item)`).
pub const fn array(item: &'static Schema) -> Schema {
    Schema::Array { item, min: 0, max: usize::MAX }
}

// ---------------------------------------------------------------------------
// JavaScript conversions
// ---------------------------------------------------------------------------

fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

fn is_decimal_literal(s: &str) -> bool {
    let bytes = s.as_bytes();
    let mut i = 0;
    if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
        i += 1;
    }
    let mut digits = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
        digits += 1;
    }
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return false;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
            i += 1;
        }
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    i == bytes.len()
}

/// JavaScript `Number(string)`.
pub fn js_to_number(input: &str) -> f64 {
    let s = input.trim_matches(is_js_whitespace);
    if s.is_empty() {
        return 0.0;
    }
    match s {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let radix = match s.get(..2) {
        Some("0x" | "0X") => Some(16),
        Some("0o" | "0O") => Some(8),
        Some("0b" | "0B") => Some(2),
        _ => None,
    };
    if let Some(radix) = radix {
        let digits = &s[2..];
        if digits.is_empty() {
            return f64::NAN;
        }
        let mut value = 0f64;
        for c in digits.chars() {
            match c.to_digit(radix) {
                Some(d) => value = value * radix as f64 + d as f64,
                None => return f64::NAN,
            }
        }
        return value;
    }
    if !is_decimal_literal(s) {
        return f64::NAN;
    }
    s.parse::<f64>().unwrap_or(f64::NAN)
}

/// JavaScript `Number(value)` for SQLite row values.
pub fn js_number(value: &Value) -> Value {
    let number = match value {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) if n.is_i64() || n.is_u64() => return value.clone(),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => js_to_number(s),
        _ => f64::NAN,
    };
    if number.is_finite() {
        normalize_number(number)
    } else {
        Value::String(NOT_A_NUMBER.into())
    }
}

/// JavaScript `String(value)` for SQLite row values.
pub fn js_string(value: &Value) -> Value {
    Value::String(match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(_) => normalize_number_value(value).to_string(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    })
}

// ---------------------------------------------------------------------------
// Query parameters
// ---------------------------------------------------------------------------

/// Decoded `URLSearchParams`.
#[derive(Debug, Clone, Default)]
pub struct QueryParams {
    entries: Vec<(String, String)>,
}

impl QueryParams {
    pub fn parse(query: Option<&str>) -> Self {
        let entries = query
            .map(|q| url::form_urlencoded::parse(q.as_bytes()).map(|(k, v)| (k.into_owned(), v.into_owned())).collect())
            .unwrap_or_default();
        Self { entries }
    }

    /// `Object.fromEntries(searchParams)[key]` (the last value wins).
    pub fn last(&self, key: &str) -> Option<&str> {
        self.entries.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    /// `searchParams.get(key)` (the first value wins).
    pub fn first(&self, key: &str) -> Option<&str> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }
}

/// Marker error for query values the protocol schema rejects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidQuery;

/// `z.coerce.number().int().min(min).max(max).default(default)`.
pub fn coerce_int(value: Option<&str>, default: i64, min: i64, max: Option<i64>) -> Result<i64, InvalidQuery> {
    let Some(raw) = value else { return Ok(default) };
    let number = js_to_number(raw);
    if !number.is_finite() || number.fract() != 0.0 || number.abs() > MAX_SAFE_INTEGER {
        return Err(InvalidQuery);
    }
    let number = number as i64;
    if number < min || max.is_some_and(|max| number > max) {
        return Err(InvalidQuery);
    }
    Ok(number)
}

/// `SolanaAddressSchema` (optionally `.optional()`).
pub fn address_param(value: Option<&str>, required: bool) -> Result<Option<String>, InvalidQuery> {
    match value {
        None if required => Err(InvalidQuery),
        None => Ok(None),
        Some(v) if is_solana_address(v) => Ok(Some(v.to_string())),
        Some(_) => Err(InvalidQuery),
    }
}

/// `z.enum(values)` with an optional default.
pub fn enum_param(value: Option<&str>, values: &[&str], default: Option<&str>) -> Result<Option<String>, InvalidQuery> {
    match value {
        None => Ok(default.map(String::from)),
        Some(v) if values.contains(&v) => Ok(Some(v.to_string())),
        Some(_) => Err(InvalidQuery),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn number_coercion_matches_javascript() {
        assert_eq!(js_to_number(""), 0.0);
        assert_eq!(js_to_number("  12 "), 12.0);
        assert_eq!(js_to_number("0x10"), 16.0);
        assert_eq!(js_to_number("1e2"), 100.0);
        assert_eq!(js_to_number(".5"), 0.5);
        assert_eq!(js_to_number("5."), 5.0);
        assert_eq!(js_to_number("-Infinity"), f64::NEG_INFINITY);
        assert!(js_to_number("abc").is_nan());
        assert!(js_to_number("inf").is_nan());
        assert!(js_to_number("1e").is_nan());
        assert!(js_to_number("0x").is_nan());
        assert!(js_to_number("-0x10").is_nan());
    }

    #[test]
    fn coerces_query_integers() {
        assert_eq!(coerce_int(None, 50, 1, Some(100)), Ok(50));
        assert_eq!(coerce_int(Some("10"), 50, 1, Some(100)), Ok(10));
        assert_eq!(coerce_int(Some("5.0"), 50, 1, Some(100)), Ok(5));
        assert_eq!(coerce_int(Some(""), 0, 0, None), Ok(0));
        assert!(coerce_int(Some(""), 50, 1, Some(100)).is_err());
        assert!(coerce_int(Some("abc"), 50, 1, Some(100)).is_err());
        assert!(coerce_int(Some("1.5"), 50, 1, Some(100)).is_err());
        assert!(coerce_int(Some("101"), 50, 1, Some(100)).is_err());
        assert!(coerce_int(Some("-1"), 0, 0, None).is_err());
    }

    #[test]
    fn query_params_follow_url_search_params() {
        let q = QueryParams::parse(Some("a=1&a=2&b=x+y&c=%20"));
        assert_eq!(q.last("a"), Some("2"));
        assert_eq!(q.first("a"), Some("1"));
        assert_eq!(q.last("b"), Some("x y"));
        assert_eq!(q.last("c"), Some(" "));
        assert_eq!(q.last("d"), None);
    }

    static SHAPE: Schema = Schema::Object(&[
        ("b", Schema::NonNegativeNumber),
        ("a", Schema::Optional(&Schema::Nullable(&Schema::Bool))),
        ("c", Schema::Optional(&Schema::NonNegativeInteger)),
    ]);

    #[test]
    fn objects_strip_reorder_and_validate() {
        let parsed = parse(&SHAPE, &json!({"a": null, "x": 1, "b": 2.0})).unwrap();
        assert_eq!(serde_json::to_string(&parsed).unwrap(), r#"{"b":2,"a":null}"#);
        assert!(parse(&SHAPE, &json!({"a": true})).is_err());
        assert!(parse(&SHAPE, &json!({"b": -1})).is_err());
        assert!(parse(&SHAPE, &json!({"b": 1, "c": 1.5})).is_err());
        assert!(parse(&SHAPE, &json!({"b": js_number(&json!("abc"))})).is_err());
    }

    #[test]
    fn javascript_conversions() {
        assert_eq!(js_number(&json!(null)), json!(0));
        assert_eq!(js_number(&json!("12")), json!(12));
        assert_eq!(js_number(&json!(2.5)), json!(2.5));
        assert_eq!(js_string(&json!(5)), json!("5"));
        assert_eq!(js_string(&json!(5.0)), json!("5"));
        assert_eq!(js_string(&json!(null)), json!("null"));
    }
}
