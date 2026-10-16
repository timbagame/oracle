//! Minimal Solana JSON-RPC transport and response types.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use base64::Engine;
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use timba_protocol::Address;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RpcErrorKind {
    /// Connection, TLS, DNS or timeout failures before a response arrived.
    Transport,
    /// Non-2xx HTTP status.
    Http,
    /// JSON-RPC error object returned by the node.
    JsonRpc,
    /// Unexpected response shape.
    Decode,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct RpcError {
    pub kind: RpcErrorKind,
    pub message: String,
    pub status: Option<u16>,
    pub code: Option<i64>,
    pub retry_after_ms: Option<u64>,
}

impl RpcError {
    pub fn transport(message: impl Into<String>) -> Self {
        Self { kind: RpcErrorKind::Transport, message: message.into(), status: None, code: None, retry_after_ms: None }
    }

    pub fn http(status: u16, reason: &str, retry_after_ms: Option<u64>) -> Self {
        Self {
            kind: RpcErrorKind::Http,
            message: format!("HTTP error ({status}): {reason}"),
            status: Some(status),
            code: None,
            retry_after_ms,
        }
    }

    /// Formats node errors the way `@solana/errors` does: protocol-level codes
    /// (-32700..=-32600) read `JSON-RPC error: ...`, while server errors such as a
    /// failed preflight (-32002) carry only the node's own text. Completion retry
    /// classification matches on these words, so a failed simulation must not
    /// mention "RPC" or it would be retried forever as a transient failure.
    pub fn json_rpc(code: i64, message: &str) -> Self {
        let message = if (-32700..=-32600).contains(&code) {
            format!("JSON-RPC error {code}: {message}")
        } else {
            format!("{message} (code {code})")
        };
        Self { kind: RpcErrorKind::JsonRpc, message, status: None, code: Some(code), retry_after_ms: None }
    }

    pub fn decode(message: impl Into<String>) -> Self {
        Self { kind: RpcErrorKind::Decode, message: message.into(), status: None, code: None, retry_after_ms: None }
    }

    pub fn is_rate_limit(&self) -> bool {
        static RE: OnceLock<Regex> = OnceLock::new();
        self.status == Some(429) || RE.get_or_init(|| Regex::new(r"\b429\b").unwrap()).is_match(&self.message)
    }

    /// Port of `isRetryableRpcError`: rate limits, transport failures, 5xx and
    /// messages containing transient tokens.
    pub fn is_retryable(&self) -> bool {
        const TOKENS: &[&str] = &[
            "429",
            "502",
            "503",
            "504",
            "bad gateway",
            "gateway timeout",
            "timeout",
            "timed out",
            "network request failed",
            "failed to fetch",
            "unable to connect",
            "socket hang up",
            "connection refused",
            "connection reset",
            "econnreset",
            "econnrefused",
            "temporarily unavailable",
            "tls",
        ];
        if self.is_rate_limit() || self.kind == RpcErrorKind::Transport {
            return true;
        }
        if self.status.is_some_and(|s| s >= 500) {
            return true;
        }
        let normalized = self.message.to_lowercase();
        TOKENS.iter().any(|t| normalized.contains(t))
    }
}

/// Sends one JSON-RPC request to one endpoint. Implemented over HTTP in
/// production and by in-memory fakes in tests.
pub trait RpcTransport: Send + Sync {
    fn send<'a>(&'a self, endpoint: &'a str, method: &'a str, params: Value) -> BoxFuture<'a, Result<Value, RpcError>>;
}

fn parse_retry_after(value: Option<&str>) -> Option<u64> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.bytes().all(|b| b.is_ascii_digit()) {
        // Digits beyond u64 still mean "a very long time"; the pool caps the wait.
        return Some(trimmed.parse::<u64>().unwrap_or(u64::MAX).saturating_mul(1000));
    }
    let date = chrono::DateTime::parse_from_rfc2822(trimmed).ok()?;
    Some((date.timestamp_millis() - timba_common::time::now_ms()).max(0) as u64)
}

/// Appends `rebate-address` to Helius submission URLs (`sendTransaction` only).
pub fn submission_url(endpoint: &str, rebate: Option<&str>) -> String {
    let Some(rebate) = rebate.map(str::trim).filter(|r| !r.is_empty()) else { return endpoint.to_string() };
    let Ok(mut url) = url::Url::parse(endpoint) else { return endpoint.to_string() };
    static RE: OnceLock<Regex> = OnceLock::new();
    let host = url.host_str().unwrap_or_default().to_string();
    if !RE.get_or_init(|| Regex::new(r"(?i)(^|\.)helius-rpc\.com$").unwrap()).is_match(&host) {
        return endpoint.to_string();
    }
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| k != "rebate-address")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    url.query_pairs_mut().clear().extend_pairs(pairs).append_pair("rebate-address", rebate);
    url.to_string()
}

pub struct HttpTransport {
    client: reqwest::Client,
    rebate_address: Option<String>,
    next_id: AtomicU64,
}

impl HttpTransport {
    pub fn new(rebate_address: Option<String>) -> Self {
        let client = timba_common::http_client::client_builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .build()
            .expect("HTTP client");
        Self { client, rebate_address, next_id: AtomicU64::new(1) }
    }

    pub fn from_env() -> Self {
        Self::new(timba_common::env::read_env("HELIUS_REBATE_ADDRESS"))
    }
}

impl RpcTransport for HttpTransport {
    fn send<'a>(&'a self, endpoint: &'a str, method: &'a str, params: Value) -> BoxFuture<'a, Result<Value, RpcError>> {
        Box::pin(async move {
            let url = if method == "sendTransaction" {
                submission_url(endpoint, self.rebate_address.as_deref())
            } else {
                endpoint.to_string()
            };
            let id = self.next_id.fetch_add(1, Ordering::Relaxed);
            let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
            let response = self.client.post(&url).json(&body).send().await.map_err(transport_error)?;
            let status = response.status();
            if !status.is_success() {
                let retry_after =
                    parse_retry_after(response.headers().get("retry-after").and_then(|v| v.to_str().ok()));
                return Err(RpcError::http(status.as_u16(), status.canonical_reason().unwrap_or(""), retry_after));
            }
            // A timeout or reset while reading the body is a transport failure (worth
            // failing over); only a complete body that isn't JSON is a decode error.
            let bytes = response.bytes().await.map_err(transport_error)?;
            let payload: Value = serde_json::from_slice(&bytes)
                .map_err(|e| RpcError::decode(format!("Invalid JSON-RPC response: {e}")))?;
            unwrap_response(payload)
        })
    }
}

/// Describes a reqwest failure with its whole source chain (where the "timed out"
/// or "connection reset" detail lives) but without the URL, which can carry an
/// RPC provider API key.
fn transport_error(error: reqwest::Error) -> RpcError {
    let error = error.without_url();
    let mut message = format!("RPC request failed: {error}");
    let mut source = std::error::Error::source(&error);
    while let Some(inner) = source {
        message.push_str(": ");
        message.push_str(&inner.to_string());
        source = inner.source();
    }
    RpcError::transport(message)
}

pub fn unwrap_response(payload: Value) -> Result<Value, RpcError> {
    if let Some(error) = payload.get("error").filter(|e| !e.is_null()) {
        let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
        let message = error.get("message").and_then(Value::as_str).unwrap_or("Unknown JSON-RPC error");
        return Err(RpcError::json_rpc(code, message));
    }
    payload.get("result").cloned().ok_or_else(|| RpcError::decode("JSON-RPC response has no result"))
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountInfo {
    pub lamports: u64,
    pub owner: Address,
    pub data: Vec<u8>,
    pub executable: bool,
}

impl AccountInfo {
    pub fn from_value(value: &Value) -> Result<Option<Self>, RpcError> {
        if value.is_null() {
            return Ok(None);
        }
        let encoded = value
            .get("data")
            .and_then(|d| d.get(0))
            .and_then(Value::as_str)
            .ok_or_else(|| RpcError::decode("Account data is not base64 encoded"))?;
        let data = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| RpcError::decode("Account data is not valid base64"))?;
        let owner = value
            .get("owner")
            .and_then(Value::as_str)
            .and_then(|o| Address::parse(o).ok())
            .ok_or_else(|| RpcError::decode("Account owner is invalid"))?;
        Ok(Some(Self {
            lamports: value.get("lamports").and_then(Value::as_u64).unwrap_or(0),
            owner,
            data,
            executable: value.get("executable").and_then(Value::as_bool).unwrap_or(false),
        }))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LatestBlockhash {
    pub blockhash: Address,
    pub last_valid_block_height: u64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureStatus {
    #[serde(default)]
    pub slot: u64,
    #[serde(default)]
    pub err: Option<Value>,
    #[serde(default)]
    pub confirmation_status: Option<String>,
}

impl SignatureStatus {
    pub fn is_confirmed(&self) -> bool {
        matches!(self.confirmation_status.as_deref(), Some("confirmed" | "finalized"))
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureInfo {
    pub signature: String,
    pub slot: u64,
    #[serde(default)]
    pub err: Option<Value>,
    #[serde(default)]
    pub block_time: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct SignaturesForAddressOptions {
    pub before: Option<String>,
    pub until: Option<String>,
    pub limit: Option<u32>,
}

/// `getTransaction` (json encoding) result. `raw` keeps the full payload for
/// callers that inspect the message.
#[derive(Debug, Clone, PartialEq)]
pub struct TransactionInfo {
    pub slot: u64,
    pub block_time: Option<i64>,
    pub err: Option<Value>,
    pub log_messages: Vec<String>,
    pub raw: Value,
}

impl TransactionInfo {
    pub fn from_value(value: Value) -> Option<Self> {
        if value.is_null() {
            return None;
        }
        let meta = value.get("meta").cloned().unwrap_or(Value::Null);
        Some(Self {
            slot: value.get("slot").and_then(Value::as_u64).unwrap_or(0),
            block_time: value.get("blockTime").and_then(Value::as_i64),
            err: meta.get("err").filter(|e| !e.is_null()).cloned(),
            log_messages: meta
                .get("logMessages")
                .and_then(Value::as_array)
                .map(|logs| logs.iter().filter_map(|l| l.as_str().map(String::from)).collect())
                .unwrap_or_default(),
            raw: value,
        })
    }

    /// Static account keys followed by loaded writable and readonly addresses.
    pub fn account_keys(&self) -> Vec<String> {
        let message = &self.raw["transaction"]["message"];
        let mut keys: Vec<String> = message["accountKeys"]
            .as_array()
            .map(|a| a.iter().filter_map(|k| k.as_str().map(String::from)).collect())
            .unwrap_or_default();
        for field in ["writable", "readonly"] {
            if let Some(list) = self.raw["meta"]["loadedAddresses"][field].as_array() {
                keys.extend(list.iter().filter_map(|k| k.as_str().map(String::from)));
            }
        }
        keys
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retryable_classification() {
        assert!(RpcError::http(429, "Too Many Requests", None).is_rate_limit());
        assert!(RpcError::http(503, "Service Unavailable", None).is_retryable());
        assert!(!RpcError::http(400, "Bad Request", None).is_retryable());
        assert!(RpcError::transport("error sending request").is_retryable());
        assert!(!RpcError::json_rpc(-32602, "Invalid params").is_retryable());
        assert!(RpcError::json_rpc(-32603, "upstream timed out").is_retryable());
    }

    #[test]
    fn rebate_only_for_helius() {
        assert_eq!(
            submission_url("https://mainnet.helius-rpc.com/?api-key=x", Some("R")),
            "https://mainnet.helius-rpc.com/?api-key=x&rebate-address=R"
        );
        assert_eq!(
            submission_url("https://api.mainnet-beta.solana.com", Some("R")),
            "https://api.mainnet-beta.solana.com"
        );
        assert_eq!(submission_url("https://mainnet.helius-rpc.com", None), "https://mainnet.helius-rpc.com");
        assert_eq!(submission_url("https://evilhelius-rpc.com", Some("R")), "https://evilhelius-rpc.com");
    }

    #[test]
    fn retry_after() {
        assert_eq!(parse_retry_after(Some("3")), Some(3000));
        assert_eq!(parse_retry_after(Some(" ")), None);
        assert_eq!(parse_retry_after(Some("Wed, 21 Oct 2015 07:28:00 GMT")), Some(0));
        assert_eq!(parse_retry_after(Some("18446744073709552")), Some(u64::MAX));
        assert_eq!(parse_retry_after(Some("99999999999999999999999")), Some(u64::MAX));
        assert_eq!(parse_retry_after(Some("Fri, 01 Jan 9999 00:00:00 GMT")).map(|ms| ms > 86_400_000), Some(true));
        assert_eq!(parse_retry_after(Some("soon")), None);
    }

    #[test]
    fn unwraps_errors() {
        let err = unwrap_response(json!({"error": {"code": -32002, "message": "Blockhash not found"}})).unwrap_err();
        assert_eq!(err.message, "Blockhash not found (code -32002)");
        assert_eq!(unwrap_response(json!({"result": 5})).unwrap(), json!(5));
    }

    /// Local JSON-RPC endpoint answering by method name and recording the
    /// request ids and paths it saw.
    async fn rpc_server() -> (String, std::sync::Arc<std::sync::Mutex<Vec<(String, Value)>>>) {
        use axum::http::{HeaderMap, StatusCode, Uri};
        use axum::response::IntoResponse;
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let record = seen.clone();
        let app =
            axum::Router::new().fallback(axum::routing::post(move |uri: Uri, axum::Json(body): axum::Json<Value>| {
                let record = record.clone();
                async move {
                    record.lock().unwrap().push((uri.to_string(), body.clone()));
                    let id = body["id"].clone();
                    match body["method"].as_str().unwrap_or_default() {
                        "getSlot" => axum::Json(json!({"jsonrpc": "2.0", "id": id, "result": 42})).into_response(),
                        "getBalance" => axum::Json(
                            json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32602, "message": "bad params"}}),
                        )
                        .into_response(),
                        "getHealth" => {
                            let mut headers = HeaderMap::new();
                            headers.insert("retry-after", "3".parse().unwrap());
                            (StatusCode::TOO_MANY_REQUESTS, headers, "slow down").into_response()
                        }
                        "getVersion" => "definitely not json".into_response(),
                        "sendTransaction" => {
                            axum::Json(json!({"jsonrpc": "2.0", "id": id, "result": "sig"})).into_response()
                        }
                        _ => StatusCode::BAD_GATEWAY.into_response(),
                    }
                }
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}/rpc"), seen)
    }

    #[tokio::test]
    async fn http_transport_round_trips() {
        let (endpoint, seen) = rpc_server().await;
        let transport = HttpTransport::new(Some("Rebate111".into()));

        assert_eq!(transport.send(&endpoint, "getSlot", json!([])).await.unwrap(), json!(42));

        let err = transport.send(&endpoint, "getBalance", json!(["x"])).await.unwrap_err();
        assert_eq!(err.kind, RpcErrorKind::JsonRpc);
        assert_eq!(err.code, Some(-32602));
        assert_eq!(err.to_string(), "JSON-RPC error -32602: bad params");

        let err = transport.send(&endpoint, "getHealth", json!([])).await.unwrap_err();
        assert_eq!(err.kind, RpcErrorKind::Http);
        assert_eq!(err.status, Some(429));
        assert_eq!(err.retry_after_ms, Some(3_000));
        assert!(err.is_rate_limit());
        assert_eq!(err.to_string(), "HTTP error (429): Too Many Requests");

        let err = transport.send(&endpoint, "getVersion", json!([])).await.unwrap_err();
        assert_eq!(err.kind, RpcErrorKind::Decode);
        assert!(err.to_string().starts_with("Invalid JSON-RPC response:"), "{err}");

        let err = transport.send(&endpoint, "getIdentity", json!([])).await.unwrap_err();
        assert_eq!((err.status, err.retry_after_ms), (Some(502), None));
        assert!(err.is_retryable());

        // Rebates only apply to Helius endpoints, so the local URL is unchanged.
        assert_eq!(transport.send(&endpoint, "sendTransaction", json!(["tx"])).await.unwrap(), json!("sig"));

        let requests = seen.lock().unwrap().clone();
        assert_eq!(requests.len(), 6);
        assert!(requests.iter().all(|(path, _)| path == "/rpc"));
        let ids: Vec<u64> = requests.iter().map(|(_, body)| body["id"].as_u64().unwrap()).collect();
        assert_eq!(ids, vec![1, 2, 3, 4, 5, 6], "ids increase per request");
        assert_eq!(requests[0].1, json!({"jsonrpc": "2.0", "id": 1, "method": "getSlot", "params": []}));
    }

    #[tokio::test]
    async fn http_transport_reports_connection_failures() {
        let transport = HttpTransport::from_env();
        let err = transport.send("http://127.0.0.1:1/?api-key=secret-key", "getSlot", json!([])).await.unwrap_err();
        assert_eq!(err.kind, RpcErrorKind::Transport);
        assert!(err.to_string().starts_with("RPC request failed: "), "{err}");
        assert!(!err.to_string().contains("secret-key"), "the URL must not leak: {err}");
        assert!(err.is_retryable());
        assert_eq!(RpcError::decode("odd").kind, RpcErrorKind::Decode);
    }

    #[tokio::test]
    async fn http_transport_fails_over_when_the_body_is_cut_off() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 4096];
            let _ = socket.read(&mut request).await;
            // Promise 100 bytes, send one, then hang up mid-body.
            let _ = socket.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\n{").await;
        });
        let transport = HttpTransport::new(None);
        let err =
            transport.send(&format!("http://{addr}/?api-key=secret-key"), "getSlot", json!([])).await.unwrap_err();
        assert_eq!(err.kind, RpcErrorKind::Transport, "{err}");
        assert!(err.is_retryable(), "{err}");
        assert!(!err.to_string().contains("secret-key"), "{err}");
    }

    #[test]
    fn transaction_account_keys_include_loaded_addresses() {
        let info = TransactionInfo::from_value(json!({
            "slot": 9,
            "blockTime": 1_700,
            "transaction": {"message": {"accountKeys": ["a", "b", 3]}},
            "meta": {"err": {"InstructionError": [0, "Custom"]}, "logMessages": ["x"], "loadedAddresses": {"writable": ["c"], "readonly": ["d", null]}}
        }))
        .unwrap();
        assert_eq!(info.slot, 9);
        assert_eq!(info.block_time, Some(1_700));
        assert!(info.err.is_some());
        assert_eq!(info.log_messages, vec!["x"]);
        assert_eq!(info.account_keys(), vec!["a", "b", "c", "d"]);

        let bare = TransactionInfo::from_value(json!({"meta": {"err": null}})).unwrap();
        assert_eq!((bare.slot, bare.block_time, bare.err.clone()), (0, None, None));
        assert!(bare.account_keys().is_empty());
        assert!(TransactionInfo::from_value(Value::Null).is_none());
    }
}
