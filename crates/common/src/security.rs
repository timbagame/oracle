//! Bearer authentication and per-route fixed-window rate limiting
//! (port of `api-security.ts`).

use std::collections::HashMap;
use std::sync::Mutex;

pub const MAX_REQUEST_BODY_BYTES: usize = 16 * 1024;

const WINDOW_MS: i64 = 1_000;
const INDEXER_ROUTE_LIMIT: u32 = 100;

fn route_limit(path: &str) -> Option<(&'static str, u32)> {
    Some(match path {
        "/web/games/prepare" => ("/web/games/prepare", 10),
        "/web/games/submit" => ("/web/games/submit", 10),
        "/web/verification" => ("/web/verification", 10),
        _ if path.starts_with("/web/verification/") => ("/web/verification", 10),
        _ if path.starts_with("/web/games/") => ("/web/games/read", 100),
        "/web/config" => ("/web/config", 20),
        "/generate-hash" => ("/generate-hash", 20),
        "/sign-game-transaction" => ("/sign-game-transaction", 20),
        "/games/complete-now" => ("/games/complete-now", 50),
        "/token-policies" => ("/token-policies", 10),
        "/stats" => ("/stats", 10),
        _ if path == "/indexer" || path.starts_with("/indexer/") => ("/indexer", INDEXER_ROUTE_LIMIT),
        _ => return None,
    })
}

/// Constant-time comparison of `Bearer <token>`.
pub fn has_valid_bearer_token(authorization: Option<&str>, expected: &str) -> bool {
    let Some(provided) = authorization.and_then(|a| a.strip_prefix("Bearer ")) else { return false };
    if expected.is_empty() {
        return false;
    }
    let (a, b) = (provided.as_bytes(), expected.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateLimitResult {
    pub allowed: bool,
    pub retry_after_seconds: Option<u64>,
}

pub struct RouteRateLimiter {
    windows: Mutex<HashMap<&'static str, (i64, u32)>>,
    now: Box<dyn Fn() -> i64 + Send + Sync>,
}

impl Default for RouteRateLimiter {
    fn default() -> Self {
        Self::new(Box::new(crate::time::now_ms))
    }
}

impl RouteRateLimiter {
    pub fn new(now: Box<dyn Fn() -> i64 + Send + Sync>) -> Self {
        Self { windows: Mutex::new(HashMap::new()), now }
    }

    pub fn check(&self, path: &str) -> RateLimitResult {
        let Some((path, limit)) = route_limit(path) else {
            return RateLimitResult { allowed: true, retry_after_seconds: None };
        };
        let now = (self.now)();
        let mut windows = self.windows.lock().unwrap();
        match windows.get_mut(path) {
            Some((started, count)) if now - *started < WINDOW_MS => {
                *count += 1;
                if *count <= limit {
                    return RateLimitResult { allowed: true, retry_after_seconds: None };
                }
                let remaining = WINDOW_MS - (now - *started);
                let retry = ((remaining as f64) / 1000.0).ceil().max(1.0) as u64;
                RateLimitResult { allowed: false, retry_after_seconds: Some(retry) }
            }
            _ => {
                windows.insert(path, (now, 1));
                RateLimitResult { allowed: true, retry_after_seconds: None }
            }
        }
    }
}

/// A URL safe to print: scheme, host and port only. Paths, queries and user info
/// often carry provider API keys (`?api-key=`, `/v2/<key>`).
pub fn redact_url(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else { return "[redacted]".into() };
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let host = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    let hidden = authority_end < rest.len() || host.len() < authority.len();
    format!("{scheme}://{host}{}", if hidden { "/[redacted]" } else { "" })
}

/// `Some("[redacted]")` for present secrets, for `Debug` output.
pub fn redact_secret(value: &Option<String>) -> Option<&'static str> {
    value.as_ref().map(|_| "[redacted]")
}

#[cfg(test)]
mod tests {
    #[test]
    fn redacts_url_secrets() {
        use super::redact_url;
        assert_eq!(redact_url("https://rpc.example:8899"), "https://rpc.example:8899");
        assert_eq!(
            redact_url("https://mainnet.helius-rpc.com/?api-key=abc"),
            "https://mainnet.helius-rpc.com/[redacted]"
        );
        assert_eq!(redact_url("wss://user:pass@node.example/v2/key"), "wss://node.example/[redacted]");
        assert_eq!(redact_url("https://user@node.example"), "https://node.example/[redacted]");
        assert_eq!(redact_url("not a url"), "[redacted]");
        assert_eq!(super::redact_secret(&Some("x".into())), Some("[redacted]"));
        assert_eq!(super::redact_secret(&None), None);
    }

    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::Arc;

    #[test]
    fn bearer() {
        assert!(has_valid_bearer_token(Some("Bearer abc"), "abc"));
        assert!(!has_valid_bearer_token(Some("Bearer abd"), "abc"));
        assert!(!has_valid_bearer_token(Some("abc"), "abc"));
        assert!(!has_valid_bearer_token(None, "abc"));
        assert!(!has_valid_bearer_token(Some("Bearer "), ""));
    }

    #[test]
    fn indexer_paths_share_one_window_and_unlimited_routes_store_nothing() {
        let clock = Arc::new(AtomicI64::new(0));
        let c = clock.clone();
        let limiter = RouteRateLimiter::new(Box::new(move || c.load(Ordering::SeqCst)));
        assert!(limiter.check("/indexer").allowed);
        for id in 1..100 {
            assert!(limiter.check(&format!("/indexer/{id}")).allowed);
        }
        assert!(!limiter.check("/indexer/another").allowed);
        for id in 0..10_000 {
            assert!(!limiter.check(&format!("/indexer/{id}")).allowed);
            assert!(limiter.check(&format!("/unknown/{id}")).allowed);
            assert!(limiter.check(&format!("/indexer-other/{id}")).allowed);
        }
        assert_eq!(limiter.windows.lock().expect("limiter lock").len(), 1);
        clock.store(1000, Ordering::SeqCst);
        assert!(limiter.check("/indexer/new").allowed);
        assert_eq!(limiter.windows.lock().expect("limiter lock").len(), 1);
    }

    #[test]
    fn every_limited_route_enforces_its_budget() {
        let routes = [
            ("/web/games/prepare", 10),
            ("/web/games/submit", 10),
            ("/web/games/read", 100),
            ("/web/games/example", 100),
            ("/web/verification", 10),
            ("/web/verification/example", 10),
            ("/web/config", 20),
            ("/generate-hash", 20),
            ("/sign-game-transaction", 20),
            ("/games/complete-now", 50),
            ("/token-policies", 10),
            ("/stats", 10),
            ("/indexer", 100),
            ("/indexer/example", 100),
        ];
        for (route, limit) in routes {
            let limiter = RouteRateLimiter::new(Box::new(|| 0));
            for request in 0..limit {
                assert!(limiter.check(route).allowed, "{route}: request {request}");
            }
            assert_eq!(
                limiter.check(route),
                RateLimitResult { allowed: false, retry_after_seconds: Some(1) },
                "{route}"
            );
        }
        let limiter = RouteRateLimiter::new(Box::new(|| 0));
        for (route, _) in routes {
            limiter.check(route);
        }
        assert_eq!(limiter.windows.lock().expect("limiter lock").len(), 11);
    }

    #[test]
    fn limiter_windows() {
        let clock = Arc::new(AtomicI64::new(0));
        let c = clock.clone();
        let limiter = RouteRateLimiter::new(Box::new(move || c.load(Ordering::SeqCst)));
        for _ in 0..10 {
            assert!(limiter.check("/stats").allowed);
        }
        let denied = limiter.check("/stats");
        assert_eq!(denied, RateLimitResult { allowed: false, retry_after_seconds: Some(1) });
        assert!(limiter.check("/health").allowed);
        clock.store(1000, Ordering::SeqCst);
        assert!(limiter.check("/stats").allowed);
        for _ in 0..100 {
            assert!(limiter.check("/web/games/abc").allowed);
        }
        assert!(!limiter.check("/web/games/def").allowed);
        // Every verification id shares one window.
        for _ in 0..10 {
            assert!(limiter.check("/web/verification/a").allowed);
        }
        assert!(!limiter.check("/web/verification/b").allowed);
    }
}
