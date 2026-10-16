//! Ordered RPC endpoint failover (port of `rpc-endpoints.ts`) and the typed
//! RPC methods the oracle uses.

use std::collections::HashSet;
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use timba_common::{error, info, warn};
use timba_protocol::Address;
use tokio::sync::broadcast;

use super::rpc::{
    AccountInfo, BoxFuture, HttpTransport, LatestBlockhash, RpcError, RpcTransport, SignatureInfo, SignatureStatus,
    SignaturesForAddressOptions, TransactionInfo,
};

pub const RPC_RETRY_BASE_DELAY_MS: u64 = 500;
const RPC_RETRY_MAX_DELAY_MS: f64 = 30_000.0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveEndpointChange {
    pub endpoint: String,
    pub index: usize,
    pub previous_endpoint: String,
    pub previous_index: usize,
}

pub fn normalize_rpc_endpoint(endpoint: &str) -> String {
    endpoint.trim().trim_end_matches('/').to_string()
}

/// Port of `parseRpcEndpointList` (without fallback): a JSON array or a
/// comma-separated list, normalized and de-duplicated in order.
pub fn parse_rpc_endpoint_list(value: Option<&str>) -> Result<Vec<String>, String> {
    let trimmed = match value.map(str::trim) {
        Some(v) if !v.is_empty() => v,
        _ => return Err("SOLANA_NETWORK is required".into()),
    };
    let endpoints: Vec<String> = if trimmed.starts_with('[') && trimmed.ends_with(']') {
        let items: Vec<Value> = serde_json::from_str(trimmed)
            .map_err(|e| format!("Failed to parse SOLANA_NETWORK JSON array: SyntaxError: {e}"))?;
        items
            .into_iter()
            .map(|item| match item {
                Value::String(s) => s,
                Value::Null => String::new(),
                other => other.to_string(),
            })
            .collect()
    } else {
        trimmed.split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect()
    };
    let mut seen = HashSet::new();
    let unique: Vec<String> = endpoints
        .iter()
        .map(|e| normalize_rpc_endpoint(e))
        .filter(|e| !e.is_empty() && seen.insert(e.clone()))
        .collect();
    if unique.is_empty() {
        return Err("SOLANA_NETWORK resolved to an empty list".into());
    }
    Ok(unique)
}

fn compute_retry_delay_ms(attempt: usize, retry_after_ms: Option<u64>) -> u64 {
    let exponent = attempt.min(6) as i32;
    let base = RPC_RETRY_BASE_DELAY_MS as f64 * 2f64.powi(exponent);
    let jitter = rand::random::<f64>() * RPC_RETRY_BASE_DELAY_MS as f64;
    let computed = RPC_RETRY_MAX_DELAY_MS.min(base + jitter);
    // Honour Retry-After, but never sleep past the backoff cap: a huge value (an
    // exhausted monthly quota, a far-future date) would otherwise stall the scan
    // loop or a completion for hours before it tries the next endpoint.
    match retry_after_ms {
        Some(retry) => (retry as f64).min(RPC_RETRY_MAX_DELAY_MS).max(computed) as u64,
        None => computed as u64,
    }
}

type DelayFn = Arc<dyn Fn(u64) -> BoxFuture<'static, ()> + Send + Sync>;

pub struct RpcPool {
    endpoints: Vec<String>,
    active: AtomicUsize,
    transport: Arc<dyn RpcTransport>,
    delay: DelayFn,
    changes: broadcast::Sender<ActiveEndpointChange>,
}

impl RpcPool {
    pub fn new(endpoints: &[String]) -> Result<Self, String> {
        Self::with_transport(endpoints, Arc::new(HttpTransport::from_env()))
    }

    pub fn with_transport(endpoints: &[String], transport: Arc<dyn RpcTransport>) -> Result<Self, String> {
        if endpoints.is_empty() {
            return Err("At least one RPC endpoint is required".into());
        }
        let mut seen = HashSet::new();
        let endpoints: Vec<String> = endpoints
            .iter()
            .map(|e| normalize_rpc_endpoint(e))
            .filter(|e| !e.is_empty() && seen.insert(e.clone()))
            .collect();
        if endpoints.is_empty() {
            return Err("SOLANA_NETWORK did not resolve to any RPC endpoints".into());
        }
        let (changes, _) = broadcast::channel(16);
        Ok(Self {
            endpoints,
            active: AtomicUsize::new(0),
            transport,
            delay: Arc::new(|ms| Box::pin(tokio::time::sleep(std::time::Duration::from_millis(ms)))),
            changes,
        })
    }

    /// Test hook replacing the rate-limit backoff sleep.
    pub fn with_delay(mut self, delay: impl Fn(u64) -> BoxFuture<'static, ()> + Send + Sync + 'static) -> Self {
        self.delay = Arc::new(delay);
        self
    }

    pub fn active_endpoint(&self) -> &str {
        &self.endpoints[self.active.load(Ordering::SeqCst).min(self.endpoints.len() - 1)]
    }

    pub fn endpoints(&self) -> &[String] {
        &self.endpoints
    }

    pub fn subscribe_endpoint_changes(&self) -> broadcast::Receiver<ActiveEndpointChange> {
        self.changes.subscribe()
    }

    fn promote(&self, index: usize) {
        let previous = self.active.swap(index, Ordering::SeqCst);
        if previous == index {
            return;
        }
        let _ = self.changes.send(ActiveEndpointChange {
            endpoint: self.endpoints[index].clone(),
            index,
            previous_endpoint: self.endpoints[previous].clone(),
            previous_index: previous,
        });
        info!("Switched Solana RPC endpoint to {} (commitment=confirmed)", self.endpoints[index]);
    }

    fn should_retry(&self, error: &RpcError, method: &str, endpoint: &str, attempt: usize) -> Option<u64> {
        let total = self.endpoints.len();
        if !error.is_retryable() || total == 1 || attempt >= total - 1 {
            error!("RPC call {method} failed on {endpoint} without fallback: {error}");
            return None;
        }
        if error.is_rate_limit() {
            let delay = compute_retry_delay_ms(attempt, error.retry_after_ms);
            warn!(
                "RPC call {method} rate limited on {endpoint}; waiting {delay}ms before retrying ({}/{total}).",
                attempt + 1
            );
            return Some(delay);
        }
        warn!("RPC call {method} failed on {endpoint}; trying next endpoint ({}/{total}).", attempt + 1);
        Some(0)
    }

    /// Runs `operation` against each endpoint starting at the active one,
    /// promoting the endpoint that succeeds.
    pub async fn with_failover<T, F, Fut>(&self, method: &str, mut operation: F) -> Result<T, RpcError>
    where
        F: FnMut(String) -> Fut,
        Fut: Future<Output = Result<T, RpcError>>,
    {
        let total = self.endpoints.len();
        let start = self.active.load(Ordering::SeqCst);
        let mut last_error = None;
        for offset in 0..total {
            let index = (start + offset) % total;
            let endpoint = self.endpoints[index].clone();
            match operation(endpoint.clone()).await {
                Ok(value) => {
                    self.promote(index);
                    return Ok(value);
                }
                Err(error) => {
                    let decision = self.should_retry(&error, method, &endpoint, offset);
                    last_error = Some(error);
                    match decision {
                        None => break,
                        Some(0) => {}
                        Some(ms) => (self.delay)(ms).await,
                    }
                }
            }
        }
        Err(last_error.unwrap_or_else(|| RpcError::transport("RPC invocation failed without specific error")))
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.with_failover(method, |endpoint| {
            let params = params.clone();
            async move { self.transport.send(&endpoint, method, params).await }
        })
        .await
    }

    // -- typed methods --------------------------------------------------------

    pub async fn get_account_info(&self, address: &Address) -> Result<Option<AccountInfo>, RpcError> {
        let result = self
            .request(
                "getAccountInfo",
                json!([address.to_base58(), { "commitment": "confirmed", "encoding": "base64" }]),
            )
            .await?;
        AccountInfo::from_value(result.get("value").unwrap_or(&Value::Null))
    }

    pub async fn get_multiple_accounts(&self, addresses: &[Address]) -> Result<Vec<Option<AccountInfo>>, RpcError> {
        if addresses.is_empty() {
            return Ok(Vec::new());
        }
        let keys: Vec<String> = addresses.iter().map(Address::to_base58).collect();
        let result = self
            .request("getMultipleAccounts", json!([keys, { "commitment": "confirmed", "encoding": "base64" }]))
            .await?;
        let values = result
            .get("value")
            .and_then(Value::as_array)
            .ok_or_else(|| RpcError::decode("getMultipleAccounts returned no value"))?;
        values.iter().map(AccountInfo::from_value).collect()
    }

    pub async fn get_latest_blockhash(&self) -> Result<LatestBlockhash, RpcError> {
        let result = self.request("getLatestBlockhash", json!([{ "commitment": "confirmed" }])).await?;
        let value = &result["value"];
        let blockhash = value["blockhash"]
            .as_str()
            .and_then(|b| Address::parse(b).ok())
            .ok_or_else(|| RpcError::decode("Invalid blockhash"))?;
        let last_valid_block_height =
            value["lastValidBlockHeight"].as_u64().ok_or_else(|| RpcError::decode("Invalid lastValidBlockHeight"))?;
        Ok(LatestBlockhash { blockhash, last_valid_block_height })
    }

    pub async fn send_transaction(&self, wire_base64: &str) -> Result<String, RpcError> {
        let result = self
            .request(
                "sendTransaction",
                json!([wire_base64, {
                    "encoding": "base64",
                    "maxRetries": 3,
                    "preflightCommitment": "confirmed",
                    "skipPreflight": false
                }]),
            )
            .await?;
        result.as_str().map(String::from).ok_or_else(|| RpcError::decode("sendTransaction returned no signature"))
    }

    pub async fn get_signature_statuses(
        &self,
        signatures: &[String],
    ) -> Result<Vec<Option<SignatureStatus>>, RpcError> {
        let result =
            self.request("getSignatureStatuses", json!([signatures, { "searchTransactionHistory": true }])).await?;
        serde_json::from_value(result.get("value").cloned().unwrap_or(Value::Null))
            .map_err(|e| RpcError::decode(format!("Invalid signature statuses: {e}")))
    }

    pub async fn get_block_height(&self) -> Result<u64, RpcError> {
        let result = self.request("getBlockHeight", json!([{ "commitment": "confirmed" }])).await?;
        result.as_u64().ok_or_else(|| RpcError::decode("Invalid block height"))
    }

    pub async fn get_slot(&self) -> Result<u64, RpcError> {
        let result = self.request("getSlot", json!([{ "commitment": "confirmed" }])).await?;
        result.as_u64().ok_or_else(|| RpcError::decode("Invalid slot"))
    }

    pub async fn get_block_time(&self, slot: u64) -> Result<Option<i64>, RpcError> {
        let result = self.request("getBlockTime", json!([slot])).await?;
        Ok(result.as_i64())
    }

    pub async fn get_signatures_for_address(
        &self,
        address: &Address,
        options: &SignaturesForAddressOptions,
    ) -> Result<Vec<SignatureInfo>, RpcError> {
        let mut config = serde_json::Map::new();
        if let Some(before) = &options.before {
            config.insert("before".into(), json!(before));
        }
        config.insert("commitment".into(), json!("confirmed"));
        if let Some(limit) = options.limit {
            config.insert("limit".into(), json!(limit));
        }
        if let Some(until) = &options.until {
            config.insert("until".into(), json!(until));
        }
        let result = self.request("getSignaturesForAddress", json!([address.to_base58(), config])).await?;
        serde_json::from_value(result).map_err(|e| RpcError::decode(format!("Invalid signatures response: {e}")))
    }

    pub async fn get_transaction(&self, signature: &str) -> Result<Option<TransactionInfo>, RpcError> {
        let result = self
            .request(
                "getTransaction",
                json!([signature, {
                    "commitment": "confirmed",
                    "encoding": "json",
                    "maxSupportedTransactionVersion": 0
                }]),
            )
            .await?;
        Ok(TransactionInfo::from_value(result))
    }
}

#[cfg(test)]
pub mod testing {
    //! Scriptable in-memory transport for unit tests.

    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    pub type Handler = Box<dyn Fn(&str, &str, &Value) -> Option<Result<Value, RpcError>> + Send + Sync>;

    #[derive(Default)]
    pub struct FakeTransport {
        pub calls: Mutex<Vec<(String, String, Value)>>,
        queued: Mutex<VecDeque<(String, Result<Value, RpcError>)>>,
        handlers: Mutex<Vec<Handler>>,
    }

    impl FakeTransport {
        pub fn new() -> Arc<Self> {
            Arc::new(Self::default())
        }

        /// Queues a one-shot response for the next call of `method`.
        pub fn push(&self, method: &str, response: Result<Value, RpcError>) {
            self.queued.lock().unwrap().push_back((method.to_string(), response));
        }

        /// Adds a fallback handler consulted when nothing is queued.
        pub fn on(
            &self,
            handler: impl Fn(&str, &str, &Value) -> Option<Result<Value, RpcError>> + Send + Sync + 'static,
        ) {
            self.handlers.lock().unwrap().push(Box::new(handler));
        }

        pub fn calls_for(&self, method: &str) -> Vec<(String, Value)> {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, m, _)| m == method)
                .map(|(e, _, p)| (e.clone(), p.clone()))
                .collect()
        }
    }

    impl RpcTransport for FakeTransport {
        fn send<'a>(
            &'a self,
            endpoint: &'a str,
            method: &'a str,
            params: Value,
        ) -> BoxFuture<'a, Result<Value, RpcError>> {
            self.calls.lock().unwrap().push((endpoint.to_string(), method.to_string(), params.clone()));
            let queued = {
                let mut queue = self.queued.lock().unwrap();
                queue.iter().position(|(m, _)| m == method).and_then(|i| queue.remove(i)).map(|(_, r)| r)
            };
            let response =
                queued.or_else(|| self.handlers.lock().unwrap().iter().find_map(|h| h(endpoint, method, &params)));
            Box::pin(async move {
                response.unwrap_or_else(|| Err(RpcError::decode(format!("unexpected RPC call {method}"))))
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::FakeTransport;
    use super::*;

    #[test]
    fn parses_endpoint_lists() {
        assert_eq!(
            parse_rpc_endpoint_list(Some(" https://a/, https://b ,https://a ")).unwrap(),
            vec!["https://a", "https://b"]
        );
        assert_eq!(
            parse_rpc_endpoint_list(Some(r#"["https://x//", "", "https://y"]"#)).unwrap(),
            vec!["https://x", "https://y"]
        );
        // Non-string items are kept as their JSON text; nulls are dropped.
        assert_eq!(
            parse_rpc_endpoint_list(Some(r#"["https://x", null, 8899, {"a": 1}]"#)).unwrap(),
            vec!["https://x", "8899", r#"{"a":1}"#]
        );
        assert!(parse_rpc_endpoint_list(None).unwrap_err().contains("required"));
        assert!(parse_rpc_endpoint_list(Some("[nope]")).unwrap_err().contains("JSON array"));
        assert!(parse_rpc_endpoint_list(Some(" , ")).unwrap_err().contains("empty list"));
    }

    #[test]
    fn needs_at_least_one_usable_endpoint() {
        let transport = FakeTransport::new();
        let none = RpcPool::with_transport(&[], transport.clone()).err().unwrap();
        assert_eq!(none, "At least one RPC endpoint is required");
        let blank = RpcPool::with_transport(&[" ".into(), "/".into()], transport.clone()).err().unwrap();
        assert_eq!(blank, "SOLANA_NETWORK did not resolve to any RPC endpoints");
        let pool = RpcPool::with_transport(&["https://a/".into(), "https://a".into(), "https://b".into()], transport);
        assert_eq!(pool.unwrap().endpoints(), ["https://a", "https://b"]);
    }

    #[tokio::test]
    async fn empty_account_batches_skip_the_network() {
        let transport = FakeTransport::new();
        let pool = RpcPool::with_transport(&["https://a".into()], transport.clone()).unwrap();
        assert!(pool.get_multiple_accounts(&[]).await.unwrap().is_empty());
        assert!(transport.calls_for("getMultipleAccounts").is_empty());
    }

    #[tokio::test]
    async fn fails_over_and_promotes() {
        let transport = FakeTransport::new();
        transport.on(|endpoint, _, _| {
            Some(if endpoint == "https://a" {
                Err(RpcError::http(503, "Service Unavailable", None))
            } else {
                Ok(json!(42))
            })
        });
        let pool = RpcPool::with_transport(&["https://a".into(), "https://b".into()], transport.clone()).unwrap();
        let mut changes = pool.subscribe_endpoint_changes();
        assert_eq!(pool.get_slot().await.unwrap(), 42);
        assert_eq!(pool.active_endpoint(), "https://b");
        assert_eq!(changes.try_recv().unwrap().index, 1);
        // Next call starts at the promoted endpoint.
        pool.get_slot().await.unwrap();
        assert_eq!(transport.calls_for("getSlot").last().unwrap().0, "https://b");
    }

    #[tokio::test]
    async fn non_retryable_errors_do_not_fail_over() {
        let transport = FakeTransport::new();
        transport.on(|_, _, _| Some(Err(RpcError::json_rpc(-32602, "Invalid params"))));
        let pool = RpcPool::with_transport(&["https://a".into(), "https://b".into()], transport.clone()).unwrap();
        assert!(pool.get_slot().await.is_err());
        assert_eq!(transport.calls_for("getSlot").len(), 1);
    }

    #[tokio::test]
    async fn rate_limits_wait_before_next_endpoint() {
        let transport = FakeTransport::new();
        transport.push("getSlot", Err(RpcError::http(429, "Too Many Requests", Some(2_000))));
        transport.push("getSlot", Ok(json!(1)));
        let waited = Arc::new(std::sync::Mutex::new(Vec::new()));
        let w = waited.clone();
        let pool = RpcPool::with_transport(&["https://a".into(), "https://b".into()], transport).unwrap().with_delay(
            move |ms| {
                w.lock().unwrap().push(ms);
                Box::pin(async {})
            },
        );
        assert_eq!(pool.get_slot().await.unwrap(), 1);
        assert!(waited.lock().unwrap()[0] >= 2_000);
    }

    #[tokio::test]
    async fn caps_retry_after_and_backs_off_without_it() {
        let transport = FakeTransport::new();
        transport.push("getSlot", Err(RpcError::http(429, "Too Many Requests", Some(u64::MAX))));
        transport.push("getSlot", Err(RpcError::http(429, "Too Many Requests", None)));
        transport.push("getSlot", Ok(json!(7)));
        let waited = Arc::new(std::sync::Mutex::new(Vec::new()));
        let w = waited.clone();
        let endpoints = ["https://a".into(), "https://b".into(), "https://c".into()];
        let pool = RpcPool::with_transport(&endpoints, transport).unwrap().with_delay(move |ms| {
            w.lock().unwrap().push(ms);
            Box::pin(async {})
        });
        assert_eq!(pool.get_slot().await.unwrap(), 7);
        let waited = waited.lock().unwrap().clone();
        assert_eq!(waited[0], RPC_RETRY_MAX_DELAY_MS as u64, "Retry-After is capped");
        // Second attempt without Retry-After: base 500ms * 2^1 plus up to 500ms jitter.
        assert!((1_000..1_500).contains(&waited[1]), "{waited:?}");
    }

    #[test]
    fn retry_delay_never_exceeds_the_cap() {
        for attempt in 0..20 {
            for retry_after in [None, Some(0), Some(1), Some(29_999), Some(30_001), Some(u64::MAX)] {
                let delay = compute_retry_delay_ms(attempt, retry_after);
                assert!(delay <= RPC_RETRY_MAX_DELAY_MS as u64, "{attempt} {retry_after:?} -> {delay}");
                assert!(delay >= retry_after.unwrap_or(0).min(RPC_RETRY_MAX_DELAY_MS as u64));
            }
        }
    }
}
