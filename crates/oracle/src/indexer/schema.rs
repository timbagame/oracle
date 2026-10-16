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
        Value::Number(n) if n.is_f64() => js_number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::Number(n) => n.to_string(),
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

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

/// JavaScript `Number.prototype.toString()` (`String(number)`).
pub fn js_number_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if value == 0.0 {
        return "0".into();
    }
    let sign = if value < 0.0 { "-" } else { "" };
    // `{:e}` yields the shortest round-trip digits, like ECMAScript's Number::toString.
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific.split_once('e').expect("exponent");
    let exponent: i32 = exponent.parse().expect("exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exponent + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let mantissa = if k == 1 { digits } else { format!("{}.{}", &digits[..1], &digits[1..]) };
        let e = n - 1;
        format!("{mantissa}e{}{}", if e < 0 { '-' } else { '+' }, e.abs())
    };
    format!("{sign}{body}")
}

struct JsFormatter;

impl serde_json::ser::Formatter for JsFormatter {
    fn write_f64<W: ?Sized + std::io::Write>(&mut self, writer: &mut W, value: f64) -> std::io::Result<()> {
        writer.write_all(js_number_to_string(value).as_bytes())
    }
}

/// `JSON.stringify(value)`: like `serde_json::to_string`, but floats use the
/// JavaScript number formatting (`0.000004`, not `4e-6`).
pub fn to_js_json(value: &Value) -> String {
    use serde::Serialize;
    let mut output = Vec::new();
    let mut serializer = serde_json::Serializer::with_formatter(&mut output, JsFormatter);
    value.serialize(&mut serializer).expect("JSON values always serialize");
    String::from_utf8(output).expect("JSON output is UTF-8")
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
        assert_eq!(js_string(&json!(0.000004)), json!("0.000004"));
    }

    #[test]
    fn numbers_format_like_javascript() {
        for (value, expected) in [
            (0.000004, "0.000004"),
            (0.000001, "0.000001"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (0.1, "0.1"),
            (1.0, "1"),
            (-2.5, "-2.5"),
            (123456.5, "123456.5"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (1.2345e22, "1.2345e+22"),
            (-0.0, "0"),
        ] {
            assert_eq!(js_number_to_string(value), expected);
        }
        assert_eq!(
            to_js_json(&json!({"a": 0.000004, "b": [1, 2.5e-5], "c": "x"})),
            r#"{"a":0.000004,"b":[1,0.000025],"c":"x"}"#
        );
    }

    fn rejection(schema: &Schema, value: Value) -> String {
        parse(schema, &value).unwrap_err().message
    }

    #[test]
    fn string_schemas_reject_malformed_values() {
        let address = bs58::encode([7u8; 32]).into_string();
        let signature = bs58::encode([7u8; 64]).into_string();
        assert_eq!(parse(&Schema::Address, &json!(address)).unwrap(), json!(address));
        assert_eq!(parse(&Schema::Signature, &json!(signature)).unwrap(), json!(signature));
        assert_eq!(rejection(&Schema::Address, json!("not-an-address")), "invalid Solana address");
        assert_eq!(rejection(&Schema::Address, json!(5)), "expected string");
        assert_eq!(rejection(&Schema::Signature, json!(address)), "invalid Solana signature");
        let hex = "ab".repeat(32);
        assert_eq!(parse(&Schema::Hex32, &json!(hex)).unwrap(), json!(hex));
        assert_eq!(rejection(&Schema::Hex32, json!("ab")), "invalid hex32");
        assert_eq!(rejection(&Schema::Hex32, json!("zz".repeat(32))), "invalid hex32");
        assert_eq!(parse(&Schema::U64String, &json!("18446744073709551615")).unwrap(), json!("18446744073709551615"));
        assert_eq!(rejection(&Schema::U64String, json!("18446744073709551616")), "invalid u64 string");
        assert_eq!(rejection(&Schema::U64String, json!("-1")), "invalid u64 string");
        assert_eq!(parse(&Schema::NonEmptyString, &json!("x")).unwrap(), json!("x"));
        assert_eq!(rejection(&Schema::NonEmptyString, json!("")), "expected a non-empty string");
        assert_eq!(parse(&Schema::Url, &json!("https://example.com/a")).unwrap(), json!("https://example.com/a"));
        assert_eq!(rejection(&Schema::Url, json!("not a url")), "invalid URL");
    }

    #[test]
    fn literal_and_enum_schemas_only_accept_listed_values() {
        assert_eq!(parse(&Schema::Bool, &json!(false)).unwrap(), json!(false));
        assert_eq!(rejection(&Schema::Bool, json!(0)), "expected boolean");
        assert_eq!(parse(&Schema::Literal("ok"), &json!("ok")).unwrap(), json!("ok"));
        assert_eq!(rejection(&Schema::Literal("ok"), json!("no")), "expected literal ok");
        let ints = Schema::IntLiterals(&[1, 2]);
        assert_eq!(parse(&ints, &json!(2.0)).unwrap(), json!(2));
        assert_eq!(rejection(&ints, json!(3)), "unexpected literal");
        assert_eq!(rejection(&ints, json!("1")), "unexpected literal");
        let colors = Schema::Enum(&["red", "blue"]);
        assert_eq!(parse(&colors, &json!("blue")).unwrap(), json!("blue"));
        assert_eq!(rejection(&colors, json!("green")), "invalid enum value");
        assert_eq!(rejection(&colors, json!(1)), "invalid enum value");
    }

    #[test]
    fn number_schemas_enforce_safe_integer_ranges() {
        assert_eq!(parse(&Schema::PositiveInteger, &json!(3)).unwrap(), json!(3));
        assert_eq!(rejection(&Schema::PositiveInteger, json!(0)), "expected a positive integer");
        assert_eq!(rejection(&Schema::PositiveInteger, json!(1.5)), "expected a positive integer");
        assert_eq!(rejection(&Schema::NonNegativeInteger, json!(-1)), "expected a non-negative integer");
        // Integers beyond 2^53 are not representable as JavaScript numbers.
        assert_eq!(
            rejection(&Schema::NonNegativeInteger, json!(9_007_199_254_740_993i64)),
            "expected a non-negative integer"
        );
        assert_eq!(rejection(&Schema::NonNegativeInteger, json!(u64::MAX)), "expected a non-negative integer");
        assert_eq!(rejection(&Schema::NonNegativeInteger, json!(1e300)), "expected a non-negative integer");
        let range = Schema::IntegerRange(2, 4);
        assert_eq!(parse(&range, &json!(4)).unwrap(), json!(4));
        assert_eq!(rejection(&range, json!(1)), "integer out of range");
        assert_eq!(rejection(&range, json!(5)), "integer out of range");
        assert_eq!(parse(&Schema::NonNegativeNumber, &json!(2.5)).unwrap(), json!(2.5));
        assert_eq!(parse(&Schema::NonNegativeNumber, &json!(4.0)).unwrap(), json!(4));
        assert_eq!(rejection(&Schema::NonNegativeNumber, json!("1")), "expected a non-negative finite number");
    }

    #[test]
    fn wrappers_and_collections_report_the_failing_path() {
        let nullable = Schema::Nullable(&Schema::Bool);
        assert_eq!(parse(&nullable, &Value::Null).unwrap(), Value::Null);
        assert_eq!(parse(&nullable, &json!(true)).unwrap(), json!(true));
        assert_eq!(rejection(&nullable, json!(1)), "expected boolean");
        static LIST: Schema = array(&Schema::PositiveInteger);
        assert_eq!(parse(&LIST, &json!([1, 2])).unwrap(), json!([1, 2]));
        assert_eq!(parse(&LIST, &json!([])).unwrap(), json!([]));
        assert_eq!(rejection(&LIST, json!("x")), "expected array");
        let error = parse(&LIST, &json!([1, 0])).unwrap_err();
        assert_eq!((error.path.as_str(), error.message.as_str()), ("1", "expected a positive integer"));
        let bounded = Schema::Array { item: &Schema::Bool, min: 1, max: 2 };
        assert_eq!(rejection(&bounded, json!([])), "array length out of range");
        assert_eq!(rejection(&bounded, json!([true, true, true])), "array length out of range");
        let error = parse(&SHAPE, &json!({})).unwrap_err();
        assert_eq!((error.path.as_str(), error.message.as_str()), ("b", "required"));
        assert_eq!(
            parse(&SHAPE, &json!([])).unwrap_err().to_string(),
            "Schema validation failed at <root>: expected object"
        );
    }

    #[test]
    fn normalizes_numbers_like_json_stringify() {
        assert_eq!(normalize_number(f64::NAN), Value::Null);
        assert_eq!(normalize_number(f64::INFINITY), Value::Null);
        assert_eq!(normalize_number(3.0), json!(3));
        assert_eq!(normalize_number(0.5), json!(0.5));
        assert_eq!(normalize_number(1e19), json!(1e19));
        // Non-numbers pass through the output normalizer untouched.
        assert_eq!(normalize_number_value(&json!("x")), json!("x"));
        assert_eq!(normalize_number_value(&json!(7.0)), json!(7));
        assert_eq!(normalize_number_value(&json!(u64::MAX)), json!(u64::MAX));
    }

    #[test]
    fn javascript_number_parsing_handles_edge_literals() {
        assert_eq!(js_to_number("Infinity"), f64::INFINITY);
        assert_eq!(js_to_number("+Infinity"), f64::INFINITY);
        assert_eq!(js_to_number("0b101"), 5.0);
        assert_eq!(js_to_number("0o17"), 15.0);
        assert!(js_to_number("0xzz").is_nan());
        assert!(js_to_number("0b102").is_nan());
        assert_eq!(js_to_number("1e+2"), 100.0);
        assert_eq!(js_to_number("1E-2"), 0.01);
        assert!(js_to_number("1e+").is_nan());
        assert!(js_to_number(".").is_nan());
        // JavaScript trims Unicode spaces as well as ASCII ones.
        assert_eq!(js_to_number("\u{a0}7\u{2003}"), 7.0);
        assert_eq!(js_to_number("\u{feff}\u{3000}8\u{2028}"), 8.0);
        assert_eq!(js_to_number("\u{1680}\u{202f}\u{205f}9\u{200a}"), 9.0);
        assert!(js_to_number("1\u{200b}").is_nan());
    }

    #[test]
    fn row_values_convert_like_javascript() {
        assert_eq!(js_number(&json!(true)), json!(1));
        assert_eq!(js_number(&json!(false)), json!(0));
        assert_eq!(js_number(&json!(u64::MAX)), json!(u64::MAX));
        assert_eq!(js_number(&json!("abc")), json!("NaN"));
        assert_eq!(js_number(&json!("Infinity")), json!("NaN"));
        assert_eq!(js_number(&json!([1])), json!("NaN"));
        assert_eq!(js_number(&json!({})), json!("NaN"));
        assert_eq!(js_string(&json!(true)), json!("true"));
        assert_eq!(js_string(&json!("s")), json!("s"));
        assert_eq!(js_string(&json!([1, "a"])), json!("[1,\"a\"]"));
        assert_eq!(js_string(&json!(-7)), json!("-7"));
    }

    #[test]
    fn query_parameters_are_validated_like_the_zod_schemas() {
        let address = bs58::encode([9u8; 32]).into_string();
        assert_eq!(address_param(Some(&address), true), Ok(Some(address.clone())));
        assert_eq!(address_param(None, false), Ok(None));
        assert_eq!(address_param(None, true), Err(InvalidQuery));
        assert_eq!(address_param(Some("nope"), false), Err(InvalidQuery));
        assert_eq!(enum_param(None, &["a", "b"], Some("a")), Ok(Some("a".into())));
        assert_eq!(enum_param(None, &["a", "b"], None), Ok(None));
        assert_eq!(enum_param(Some("b"), &["a", "b"], Some("a")), Ok(Some("b".into())));
        assert_eq!(enum_param(Some("c"), &["a", "b"], Some("a")), Err(InvalidQuery));
        assert_eq!(coerce_int(Some("9007199254740992"), 0, 0, None), Err(InvalidQuery));
        assert_eq!(coerce_int(Some("Infinity"), 0, 0, None), Err(InvalidQuery));
    }

    #[test]
    fn formats_special_floats_like_javascript() {
        assert_eq!(js_number_to_string(f64::NAN), "NaN");
        assert_eq!(js_number_to_string(f64::INFINITY), "Infinity");
        assert_eq!(js_number_to_string(f64::NEG_INFINITY), "-Infinity");
    }
}
