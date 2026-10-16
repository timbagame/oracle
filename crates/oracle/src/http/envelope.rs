//! JSON response envelopes shared by the oracle HTTP surfaces
//! (`buildServicePayload` and the protocol's `ServiceEnvelopeSchema`).

use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Map, Value};

pub fn service_metadata() -> Value {
    json!({
        "name": "oracle-api",
        "version": "1.0.0",
        "environment": timba_common::env::environment_mode(),
        "uptime": timba_common::time::uptime_secs(),
    })
}

fn into_map(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// `buildServicePayload`: the given fields first, then `timestamp` and
/// `service`.
pub fn service_payload(fields: Value) -> Value {
    let mut map = into_map(fields);
    map.insert("timestamp".into(), Value::String(timba_common::time::now_iso()));
    map.insert("service".into(), service_metadata());
    Value::Object(map)
}

/// A payload validated through a protocol schema built on
/// `ServiceEnvelopeSchema`: zod emits `timestamp`, `service`, then the
/// schema's own fields.
pub fn contract_payload(fields: Value) -> Value {
    let mut map = Map::new();
    map.insert("timestamp".into(), Value::String(timba_common::time::now_iso()));
    map.insert("service".into(), service_metadata());
    map.extend(into_map(fields));
    Value::Object(map)
}

/// A JSON response with `Content-Type: application/json`.
pub fn json_response(status: StatusCode, body: &Value) -> Response {
    let mut response = (status, body.to_string()).into_response();
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
}

pub fn contract_response(fields: Value) -> Response {
    json_response(StatusCode::OK, &contract_payload(fields))
}

pub fn error_response(status: StatusCode, message: &str) -> Response {
    json_response(status, &service_payload(json!({ "success": false, "error": message })))
}

pub fn html_response(html: &str) -> Response {
    let mut response = html.to_string().into_response();
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_keys_like_typescript() {
        let payload = service_payload(json!({"success": false, "error": "x"}));
        let keys: Vec<_> = payload.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["success", "error", "timestamp", "service"]);
        let payload = contract_payload(json!({"success": true, "status": "healthy"}));
        let keys: Vec<_> = payload.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["timestamp", "service", "success", "status"]);
        let service: Vec<_> = payload["service"].as_object().unwrap().keys().cloned().collect();
        assert_eq!(service, ["name", "version", "environment", "uptime"]);
    }
}
