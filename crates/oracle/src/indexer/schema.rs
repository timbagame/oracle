//! The JavaScript `Number()`/`String()` conversions applied to SQLite rows, on top of
//! `timba_protocol::schema` (the zod behaviour the HTTP surfaces rely on).

use serde_json::Value;
pub use timba_protocol::schema::{
    js_number_to_string, js_to_number, normalize_number, parse, to_js_json, QueryParams, Schema, SchemaError,
    MAX_SAFE_INTEGER,
};

/// Marker for values that are not JSON numbers in JavaScript (`NaN`,
/// `Infinity`). Number schemas reject it, like zod rejects non-finite numbers.
const NOT_A_NUMBER: &str = "NaN";

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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn number_schemas_reject_the_nan_marker() {
        static AMOUNT: Schema = Schema::Object(&[("b", Schema::NonNegativeNumber)]);
        assert!(parse(&AMOUNT, &json!({"b": js_number(&json!("abc"))})).is_err());
        assert!(parse(&AMOUNT, &json!({"b": js_number(&json!("2"))})).is_ok());
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
}
