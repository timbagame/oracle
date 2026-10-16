//! USD token prices from the Jupiter Price API with a short cache and
//! request coalescing (port of `token-price.ts`).

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::{BoxFuture, FutureExt, Shared};
use serde_json::Value;

pub const TOKEN_PRICE_CACHE_TTL_MS: i64 = 60_000;
pub const JUPITER_PRICE_URL: &str = "https://api.jup.ag/price/v3";
const JUPITER_MAX_IDS: usize = 50;

pub trait TokenPriceResolver: Send + Sync {
    fn get_token_usd_prices<'a>(
        &'a self,
        mints: &'a [String],
        allow_partial: bool,
    ) -> BoxFuture<'a, anyhow::Result<HashMap<String, f64>>>;
}

/// Performs one GET request and returns `(status, json body)`.
pub type PriceFetcher = Arc<dyn Fn(String, String) -> BoxFuture<'static, Result<(u16, Value), String>> + Send + Sync>;

type PendingPrice = Shared<BoxFuture<'static, Result<Option<f64>, String>>>;

struct CachedPrice {
    price_usd: f64,
    expires_at: i64,
}

struct Inner {
    api_key: Option<String>,
    price_url: String,
    fetcher: PriceFetcher,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    cache: Mutex<HashMap<String, CachedPrice>>,
    in_flight: Mutex<HashMap<String, PendingPrice>>,
}

#[derive(Clone)]
pub struct JupiterTokenPriceResolver {
    inner: Arc<Inner>,
}

fn read_positive_price(entry: Option<&Value>) -> Option<f64> {
    let value = entry?.as_object()?.get("usdPrice")?;
    let price = match value {
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => js_number(text)?,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Null => 0.0,
        _ => return None,
    };
    (price.is_finite() && price > 0.0).then_some(price)
}

/// Approximates JavaScript `Number(string)` for decimal input.
fn js_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    if trimmed.eq_ignore_ascii_case("infinity") || trimmed.eq_ignore_ascii_case("nan") {
        return None;
    }
    trimmed.parse::<f64>().ok()
}

pub fn http_price_fetcher() -> PriceFetcher {
    let client =
        timba_common::http_client::client_builder().timeout(Duration::from_secs(10)).build().expect("reqwest client");
    Arc::new(move |url: String, api_key: String| {
        let client = client.clone();
        async move {
            let response = client
                .get(&url)
                .header("Accept", "application/json")
                .header("x-api-key", api_key)
                .send()
                .await
                .map_err(|error| error.to_string())?;
            let status = response.status().as_u16();
            if !response.status().is_success() {
                return Ok((status, Value::Null));
            }
            let body =
                response.json::<Value>().await.map_err(|_| "Jupiter Price API returned invalid JSON".to_string())?;
            Ok((status, body))
        }
        .boxed()
    })
}

impl JupiterTokenPriceResolver {
    pub fn new(api_key: Option<String>, price_url: impl Into<String>) -> Self {
        Self::with_fetcher(api_key, price_url, http_price_fetcher(), Arc::new(timba_common::time::now_ms))
    }

    pub fn with_fetcher(
        api_key: Option<String>,
        price_url: impl Into<String>,
        fetcher: PriceFetcher,
        now: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Self {
        let mut price_url = price_url.into();
        if price_url.is_empty() {
            price_url = JUPITER_PRICE_URL.into();
        }
        Self {
            inner: Arc::new(Inner {
                api_key,
                price_url,
                fetcher,
                now,
                cache: Mutex::new(HashMap::new()),
                in_flight: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub async fn prices(&self, mints: &[String], allow_partial: bool) -> anyhow::Result<HashMap<String, f64>> {
        let requested: BTreeSet<&String> = mints.iter().collect();
        let mut prices = HashMap::new();
        let mut missing = Vec::new();
        let now = (self.inner.now)();
        {
            let cache = self.inner.cache.lock().unwrap();
            for mint in requested {
                match cache.get(mint) {
                    Some(cached) if cached.expires_at > now => {
                        prices.insert(mint.clone(), cached.price_usd);
                    }
                    _ => missing.push(mint.clone()),
                }
            }
        }
        if missing.is_empty() {
            return Ok(prices);
        }
        let Some(api_key) = self.inner.api_key.clone() else {
            anyhow::bail!("Jupiter API key is unavailable");
        };

        let pending: Vec<(String, PendingPrice)> = {
            let mut in_flight = self.inner.in_flight.lock().unwrap();
            let to_fetch: Vec<String> = missing.iter().filter(|m| !in_flight.contains_key(*m)).cloned().collect();
            if !to_fetch.is_empty() {
                // Spawned so the fetch (and its cache fill) finishes even if every
                // waiting request is dropped, like the TypeScript promise.
                let inner = self.inner.clone();
                let mints = to_fetch.clone();
                let task = tokio::spawn(async move {
                    let _done = Settled { inner: inner.clone(), mints: mints.clone() };
                    fetch_prices(inner, mints, api_key).await
                });
                let request =
                    async move { task.await.unwrap_or_else(|error| Err(format!("Price fetch failed: {error}"))) }
                        .boxed()
                        .shared();
                for mint in to_fetch {
                    let request = request.clone();
                    let key = mint.clone();
                    let entry: BoxFuture<'static, Result<Option<f64>, String>> =
                        async move { request.await.map(|prices| prices.get(&key).copied()) }.boxed();
                    in_flight.insert(mint, entry.shared());
                }
            }
            missing.iter().map(|m| (m.clone(), in_flight[m].clone())).collect()
        };

        let resolved =
            futures::future::join_all(pending.into_iter().map(|(mint, future)| async move { (mint, future.await) }))
                .await;
        for (mint, result) in resolved {
            match result.map_err(anyhow::Error::msg)? {
                Some(price) => {
                    prices.insert(mint, price);
                }
                None if allow_partial => {}
                None => anyhow::bail!("Jupiter did not return a valid price for {mint}"),
            }
        }
        Ok(prices)
    }
}

/// Clears the in-flight entries when a fetch ends, even by panicking.
struct Settled {
    inner: Arc<Inner>,
    mints: Vec<String>,
}

impl Drop for Settled {
    fn drop(&mut self) {
        let mut in_flight = self.inner.in_flight.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        for mint in &self.mints {
            in_flight.remove(mint);
        }
    }
}

async fn fetch_prices(
    inner: Arc<Inner>,
    mints: Vec<String>,
    api_key: String,
) -> Result<Arc<HashMap<String, f64>>, String> {
    let mut prices = HashMap::new();
    for chunk in mints.chunks(JUPITER_MAX_IDS) {
        let mut url = url::Url::parse(&inner.price_url).map_err(|error| error.to_string())?;
        let retained: Vec<(String, String)> =
            url.query_pairs().filter(|(key, _)| key != "ids").map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        url.query_pairs_mut().clear().extend_pairs(retained).append_pair("ids", &chunk.join(","));
        let (status, payload) = (inner.fetcher)(url.to_string(), api_key.clone()).await?;
        if !(200..300).contains(&status) {
            return Err(format!("Jupiter Price API returned HTTP {status}"));
        }
        let Some(root) = payload.as_object() else {
            return Err("Jupiter Price API returned invalid JSON".into());
        };
        let entries = match root.get("data") {
            Some(Value::Object(data)) => data,
            _ => root,
        };
        for mint in chunk {
            let Some(price) = read_positive_price(entries.get(mint)) else { continue };
            prices.insert(mint.clone(), price);
            inner.cache.lock().unwrap().insert(
                mint.clone(),
                CachedPrice { price_usd: price, expires_at: (inner.now)() + TOKEN_PRICE_CACHE_TTL_MS },
            );
        }
    }
    Ok(Arc::new(prices))
}

impl TokenPriceResolver for JupiterTokenPriceResolver {
    fn get_token_usd_prices<'a>(
        &'a self,
        mints: &'a [String],
        allow_partial: bool,
    ) -> BoxFuture<'a, anyhow::Result<HashMap<String, f64>>> {
        self.prices(mints, allow_partial).boxed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

    fn resolver(calls: Arc<AtomicUsize>, now: Arc<AtomicI64>, body: Value) -> JupiterTokenPriceResolver {
        let fetcher: PriceFetcher = Arc::new(move |url, key| {
            calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(key, "key");
            assert!(url.contains("ids="), "{url}");
            let body = body.clone();
            async move {
                tokio::time::sleep(Duration::from_millis(5)).await;
                Ok((200, body))
            }
            .boxed()
        });
        JupiterTokenPriceResolver::with_fetcher(
            Some("key".into()),
            JUPITER_PRICE_URL,
            fetcher,
            Arc::new(move || now.load(Ordering::SeqCst)),
        )
    }

    #[tokio::test]
    async fn caches_and_coalesces() {
        let calls = Arc::new(AtomicUsize::new(0));
        let now = Arc::new(AtomicI64::new(1_000));
        let r = resolver(
            calls.clone(),
            now.clone(),
            json!({"A": {"usdPrice": 1.5}, "B": {"usdPrice": "2"}, "C": {"usdPrice": 0}}),
        );
        let mints = vec!["A".to_string(), "B".to_string()];
        let (a, b) = tokio::join!(r.prices(&mints, false), r.prices(&mints, false));
        assert_eq!(a.unwrap()["A"], 1.5);
        assert_eq!(b.unwrap()["B"], 2.0);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        r.prices(&mints, false).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        now.store(1_000 + TOKEN_PRICE_CACHE_TTL_MS + 1, Ordering::SeqCst);
        r.prices(&mints, false).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        let with_c = vec!["C".to_string()];
        assert!(r.prices(&with_c, false).await.unwrap_err().to_string().contains("valid price for C"));
        assert!(r.prices(&with_c, true).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn finishes_fetches_whose_callers_went_away() {
        let calls = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(tokio::sync::Notify::new());
        let fetcher: PriceFetcher = {
            let (calls, release) = (calls.clone(), release.clone());
            Arc::new(move |_, _| {
                calls.fetch_add(1, Ordering::SeqCst);
                let release = release.clone();
                async move {
                    release.notified().await;
                    Ok((200, json!({"A": {"usdPrice": 4}})))
                }
                .boxed()
            })
        };
        let r = JupiterTokenPriceResolver::with_fetcher(Some("k".into()), "", fetcher, Arc::new(|| 0));
        let mints = vec!["A".to_string()];
        // The caller gives up (client disconnect) while the request is in flight.
        assert!(tokio::time::timeout(Duration::from_millis(20), r.prices(&mints, false)).await.is_err());
        release.notify_one();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !r.inner.in_flight.lock().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(r.prices(&mints, false).await.unwrap()["A"], 4.0);
        assert_eq!(calls.load(Ordering::SeqCst), 1, "the second call is served from the cache");
    }

    #[tokio::test]
    async fn reports_a_panicking_fetch_and_retries_next_time() {
        let calls = Arc::new(AtomicUsize::new(0));
        let fetcher: PriceFetcher = {
            let calls = calls.clone();
            Arc::new(move |_, _| {
                let first = calls.fetch_add(1, Ordering::SeqCst) == 0;
                async move {
                    assert!(!first, "fetcher bug");
                    Ok((200, json!({"A": {"usdPrice": 1}})))
                }
                .boxed()
            })
        };
        let r = JupiterTokenPriceResolver::with_fetcher(Some("k".into()), "", fetcher, Arc::new(|| 0));
        let error = r.prices(&["A".into()], false).await.unwrap_err().to_string();
        assert!(error.starts_with("Price fetch failed"), "{error}");
        assert_eq!(r.prices(&["A".into()], false).await.unwrap()["A"], 1.0);
    }

    #[tokio::test]
    async fn requires_api_key_and_reads_data_envelope() {
        let r = JupiterTokenPriceResolver::with_fetcher(None, "", http_price_fetcher(), Arc::new(|| 0));
        assert!(r.prices(&["A".into()], false).await.unwrap_err().to_string().contains("API key"));
        let calls = Arc::new(AtomicUsize::new(0));
        let r = resolver(calls, Arc::new(AtomicI64::new(0)), json!({"data": {"A": {"usdPrice": 3}}}));
        assert_eq!(r.prices(&["A".into()], false).await.unwrap()["A"], 3.0);
    }

    #[test]
    fn reads_prices_like_javascript_numbers() {
        let price = |value: Value| read_positive_price(Some(&json!({ "usdPrice": value })));
        assert_eq!(price(json!(2.5)), Some(2.5));
        assert_eq!(price(json!(" 3 ")), Some(3.0));
        assert_eq!(price(json!(true)), Some(1.0));
        // Zero and non-prices are skipped rather than trusted.
        assert_eq!(price(json!("")), None);
        assert_eq!(price(json!(false)), None);
        assert_eq!(price(json!(null)), None);
        assert_eq!(price(json!("Infinity")), None);
        assert_eq!(price(json!("NaN")), None);
        assert_eq!(price(json!("cheap")), None);
        assert_eq!(price(json!(-1)), None);
        assert_eq!(price(json!([1])), None);
        assert_eq!(read_positive_price(Some(&json!({}))), None);
        assert_eq!(read_positive_price(Some(&json!("1"))), None);
        assert_eq!(read_positive_price(None), None);
    }

    #[tokio::test]
    async fn reports_unusable_api_responses() {
        let failing = |status, body: Value| {
            let fetcher: PriceFetcher = Arc::new(move |_, _| {
                let body = body.clone();
                async move { Ok((status, body)) }.boxed()
            });
            JupiterTokenPriceResolver::with_fetcher(Some("k".into()), "", fetcher, Arc::new(|| 0))
        };
        let error = failing(503, Value::Null).prices(&["A".into()], false).await.unwrap_err().to_string();
        assert!(error.contains("Jupiter Price API returned HTTP 503"), "{error}");
        let error = failing(200, json!([1, 2])).prices(&["A".into()], false).await.unwrap_err().to_string();
        assert!(error.contains("Jupiter Price API returned invalid JSON"), "{error}");
    }

    /// Answers each connection with the next canned response and records the requests.
    async fn http_server(responses: Vec<String>) -> (String, Arc<Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/price", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        tokio::spawn(async move {
            for response in responses {
                let Ok((mut stream, _)) = listener.accept().await else { return };
                let mut request = Vec::new();
                let mut chunk = [0u8; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    match stream.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => request.extend_from_slice(&chunk[..read]),
                    }
                }
                seen.lock().unwrap().push(String::from_utf8_lossy(&request).to_string());
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        (url, requests)
    }

    fn http_response(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    #[tokio::test]
    async fn http_fetcher_returns_status_and_json() {
        let (url, requests) = http_server(vec![
            http_response("200 OK", r#"{"A":{"usdPrice":1.5}}"#),
            http_response("429 Too Many Requests", "slow down"),
            http_response("200 OK", "not json"),
        ])
        .await;
        let fetch = http_price_fetcher();
        let (status, body) = fetch(url.clone(), "secret".into()).await.unwrap();
        assert_eq!((status, body), (200, json!({"A": {"usdPrice": 1.5}})));
        {
            let request = requests.lock().unwrap()[0].to_lowercase();
            assert!(request.contains("x-api-key: secret") && request.contains("accept: application/json"), "{request}");
        }
        // Failures keep their status and drop the body.
        assert_eq!(fetch(url.clone(), "secret".into()).await.unwrap(), (429, Value::Null));
        let error = fetch(url, "secret".into()).await.unwrap_err();
        assert_eq!(error, "Jupiter Price API returned invalid JSON");
        let error = fetch("http://127.0.0.1:1/price".into(), "secret".into()).await.unwrap_err();
        assert!(!error.is_empty());
    }
}
