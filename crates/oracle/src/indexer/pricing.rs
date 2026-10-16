//! USD prices for indexer and web responses (port of `indexer/pricing.ts`).
//! Prices (including misses) are cached for a minute; without an API key
//! only cached values are returned.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use futures::future::join_all;
use indexmap::{IndexMap, IndexSet};
use serde_json::Value;

use super::database::Clock;
use crate::token::price::{http_price_fetcher, PriceFetcher, JUPITER_PRICE_URL};

const MAX_IDS: usize = 50;
const CACHE_TTL_MS: i64 = 60_000;

struct CachedPrice {
    price: Option<f64>,
    expires_at: i64,
}

pub struct TokenUsdPrices {
    fetcher: PriceFetcher,
    now: Clock,
    price_url: Option<String>,
    cache: Mutex<HashMap<String, CachedPrice>>,
}

/// `encodeURIComponent`.
pub fn encode_uri_component(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                output.push(byte as char)
            }
            other => output.push_str(&format!("%{other:02X}")),
        }
    }
    output
}

/// Validates a chunk response against the TypeScript `ResponseSchema`
/// (`z.record(z.string(), z.object({ usdPrice: z.number().nullable().optional() }).passthrough())`).
fn parse_response(body: &Value) -> Option<&serde_json::Map<String, Value>> {
    let record = body.as_object()?;
    for entry in record.values() {
        let entry = entry.as_object()?;
        match entry.get("usdPrice") {
            None | Some(Value::Null) | Some(Value::Number(_)) => {}
            Some(_) => return None,
        }
    }
    Some(record)
}

impl Default for TokenUsdPrices {
    fn default() -> Self {
        Self::new()
    }
}

impl TokenUsdPrices {
    pub fn new() -> Self {
        Self::with_fetcher(http_price_fetcher(), Arc::new(timba_common::time::now_ms))
    }

    pub fn with_fetcher(fetcher: PriceFetcher, now: Clock) -> Self {
        Self { fetcher, now, price_url: None, cache: Mutex::new(HashMap::new()) }
    }

    /// Overrides the `JUPITER_PRICE_URL` environment lookup.
    pub fn with_price_url(mut self, url: impl Into<String>) -> Self {
        self.price_url = Some(url.into());
        self
    }

    /// The process-wide instance shared by the indexer and web APIs (the
    /// TypeScript cache is module-wide).
    pub fn global() -> Arc<Self> {
        static GLOBAL: OnceLock<Arc<TokenUsdPrices>> = OnceLock::new();
        GLOBAL.get_or_init(|| Arc::new(Self::new())).clone()
    }

    fn base_url(&self) -> String {
        if let Some(url) = &self.price_url {
            return url.clone();
        }
        std::env::var("JUPITER_PRICE_URL")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| JUPITER_PRICE_URL.to_string())
    }

    pub async fn get(&self, token_mints: &[String], api_key: Option<&str>) -> IndexMap<String, f64> {
        let unique: IndexSet<&String> = token_mints.iter().collect();
        let now = (self.now)();
        let mut prices = IndexMap::new();
        let missing: Vec<String> = {
            let cache = self.cache.lock().unwrap();
            unique
                .into_iter()
                .filter(|mint| match cache.get(*mint) {
                    Some(cached) if cached.expires_at > now => {
                        if let Some(price) = cached.price {
                            prices.insert((*mint).clone(), price);
                        }
                        false
                    }
                    _ => true,
                })
                .cloned()
                .collect()
        };
        let Some(api_key) = api_key.filter(|k| !k.is_empty()) else {
            return prices;
        };
        if missing.is_empty() {
            return prices;
        }

        let base = self.base_url();
        let requests = missing.chunks(MAX_IDS).map(|chunk| {
            let url = format!("{base}?ids={}", encode_uri_component(&chunk.join(",")));
            (self.fetcher)(url, api_key.to_string())
        });
        let responses = join_all(requests).await;
        let mut returned = serde_json::Map::new();
        for response in responses {
            let Ok((status, body)) = response else {
                continue;
            };
            if !(200..300).contains(&status) {
                continue;
            }
            if let Some(record) = parse_response(&body) {
                for (key, value) in record {
                    returned.insert(key.clone(), value.clone());
                }
            }
        }

        let mut cache = self.cache.lock().unwrap();
        for mint in missing {
            let candidate = returned.get(&mint).and_then(|entry| entry.get("usdPrice")).and_then(Value::as_f64);
            let price = candidate.filter(|p| p.is_finite() && *p > 0.0);
            cache.insert(mint.clone(), CachedPrice { price, expires_at: now + CACHE_TTL_MS });
            if let Some(price) = price {
                prices.insert(mint, price);
            }
        }
        prices
    }
}

/// `getTokenUsdPrices` over the process-wide cache.
pub async fn get_token_usd_prices(token_mints: &[String], api_key: Option<&str>) -> IndexMap<String, f64> {
    TokenUsdPrices::global().get(token_mints, api_key).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::FutureExt;
    use serde_json::json;
    use std::sync::atomic::{AtomicI64, Ordering};

    type Calls = Arc<Mutex<Vec<(String, String)>>>;

    fn fake(handler: impl Fn(&str) -> Result<(u16, Value), String> + Send + Sync + 'static) -> (PriceFetcher, Calls) {
        let calls: Calls = Arc::default();
        let recorded = calls.clone();
        let handler = Arc::new(handler);
        let fetcher: PriceFetcher = Arc::new(move |url: String, key: String| {
            recorded.lock().unwrap().push((url.clone(), key));
            let result = handler(&url);
            async move { result }.boxed()
        });
        (fetcher, calls)
    }

    fn ids(url: &str) -> Vec<String> {
        let query = url.split_once('?').unwrap().1;
        let value = url::form_urlencoded::parse(query.as_bytes()).find(|(k, _)| k == "ids").unwrap().1.into_owned();
        value.split(',').map(String::from).collect()
    }

    fn mint(n: u8) -> String {
        timba_protocol::address::Address::from_slice(&[n; 32]).unwrap().to_base58()
    }

    #[tokio::test]
    async fn returns_no_prices_without_an_api_key() {
        let (fetcher, calls) = fake(|_| Ok((200, json!({}))));
        let prices = TokenUsdPrices::with_fetcher(fetcher, Arc::new(|| 0));
        assert!(prices.get(&[mint(1)], None).await.is_empty());
        assert!(prices.get(&[mint(1)], Some("")).await.is_empty());
        assert!(calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn fetches_positive_prices_once_and_serves_repeats_from_cache() {
        let (priced, unpriced) = (mint(1), mint(2));
        let (a, b) = (priced.clone(), unpriced.clone());
        let (fetcher, calls) = fake(move |url| {
            assert!(url.contains(&encode_uri_component(&format!("{a},{b}"))));
            Ok((200, json!({ a.clone(): { "usdPrice": 1.25 }, b.clone(): { "usdPrice": 0 } })))
        });
        let prices = TokenUsdPrices::with_fetcher(fetcher, Arc::new(|| 1_000));
        let first = prices.get(&[priced.clone(), unpriced.clone(), priced.clone()], Some("secret-key")).await;
        let second = prices.get(&[priced.clone(), unpriced.clone()], Some("secret-key")).await;
        let expected: Vec<(String, f64)> = vec![(priced.clone(), 1.25)];
        assert_eq!(first.into_iter().collect::<Vec<_>>(), expected);
        assert_eq!(second.into_iter().collect::<Vec<_>>(), expected);
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].1, "secret-key");
        assert!(
            calls[0].0.starts_with("https://api.jup.ag/price/v3?ids=") || std::env::var("JUPITER_PRICE_URL").is_ok()
        );
        assert!(calls[0].0.contains("%2C"));
    }

    #[tokio::test]
    async fn refreshes_cached_prices_after_they_expire() {
        let token = mint(3);
        let price = Arc::new(AtomicI64::new(1));
        let now = Arc::new(AtomicI64::new(1_800_000_000_000));
        let (t, p) = (token.clone(), price.clone());
        let (fetcher, calls) = fake(move |_| Ok((200, json!({ t.clone(): { "usdPrice": p.load(Ordering::SeqCst) } }))));
        let clock = now.clone();
        let prices = TokenUsdPrices::with_fetcher(fetcher, Arc::new(move || clock.load(Ordering::SeqCst)));
        prices.get(std::slice::from_ref(&token), Some("key")).await;
        price.store(2, Ordering::SeqCst);
        now.fetch_add(60_001, Ordering::SeqCst);
        let refreshed = prices.get(std::slice::from_ref(&token), Some("key")).await;
        assert_eq!(refreshed.get(&token), Some(&2.0));
        assert_eq!(calls.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn splits_large_requests_and_tolerates_a_failed_chunk() {
        let tokens: Vec<String> = (0..60u8).map(|n| mint(n + 10)).collect();
        let (fetcher, calls) = fake(|url| {
            let ids = ids(url);
            if ids.len() == 10 {
                return Ok((503, Value::Null));
            }
            let body: serde_json::Map<String, Value> =
                ids.into_iter().map(|id| (id, json!({ "usdPrice": 3 }))).collect();
            Ok((200, Value::Object(body)))
        });
        let prices = TokenUsdPrices::with_fetcher(fetcher, Arc::new(|| 0));
        let result = prices.get(&tokens, Some("key")).await;
        assert_eq!(calls.lock().unwrap().len(), 2);
        assert_eq!(result.len(), 50);
        assert_eq!(result.get(&tokens[0]), Some(&3.0));
        assert!(!result.contains_key(&tokens[59]));
        // Failed chunks are cached as misses for the TTL.
        assert!(prices.get(&tokens[50..], Some("key")).await.is_empty());
        assert_eq!(calls.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn rejects_chunks_that_do_not_match_the_schema() {
        let token = mint(4);
        let t = token.clone();
        let (fetcher, _) = fake(move |_| Ok((200, json!({ t.clone(): { "usdPrice": "2" } }))));
        let prices = TokenUsdPrices::with_fetcher(fetcher, Arc::new(|| 0));
        assert!(prices.get(&[token], Some("key")).await.is_empty());
    }

    #[tokio::test]
    async fn treats_a_failed_request_as_a_cached_miss() {
        let token = mint(6);
        let (fetcher, calls) = fake(|_| Err("connection refused".into()));
        let prices = TokenUsdPrices::with_fetcher(fetcher, Arc::new(|| 0));
        assert!(prices.get(std::slice::from_ref(&token), Some("key")).await.is_empty());
        assert!(prices.get(std::slice::from_ref(&token), Some("key")).await.is_empty());
        assert_eq!(calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn the_shared_instance_serves_only_cached_prices_without_a_key() {
        assert!(Arc::ptr_eq(&TokenUsdPrices::global(), &TokenUsdPrices::global()));
        assert!(get_token_usd_prices(&[mint(99)], None).await.is_empty());
        assert!(TokenUsdPrices::default().get(&[mint(99)], Some("")).await.is_empty());
    }

    #[tokio::test]
    async fn uses_the_configured_price_url() {
        let (fetcher, calls) = fake(|_| Ok((200, json!({}))));
        let prices = TokenUsdPrices::with_fetcher(fetcher, Arc::new(|| 0)).with_price_url("https://prices.example/v9");
        prices.get(&[mint(5)], Some("key")).await;
        assert!(calls.lock().unwrap()[0].0.starts_with("https://prices.example/v9?ids="));
    }

    #[test]
    fn encodes_like_encode_uri_component() {
        assert_eq!(encode_uri_component("a,b c/é"), "a%2Cb%20c%2F%C3%A9");
        assert_eq!(encode_uri_component("A-z_0.!~*'()"), "A-z_0.!~*'()");
    }
}
