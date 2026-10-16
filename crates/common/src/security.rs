//! Bearer authentication and per-route fixed-window rate limiting
//! (port of `api-security.ts`).

use std::collections::HashMap;
use std::sync::Mutex;

pub const MAX_REQUEST_BODY_BYTES: usize = 16 * 1024;

const WINDOW_MS: i64 = 1_000;
const INDEXER_ROUTE_LIMIT: u32 = 100;

fn route_limit(path: &str) -> Option<u32> {
    let limit = match path {
        "/web/verification" => 10,
        "/web/games/prepare" => 10,
        "/web/games/submit" => 10,
        "/web/games/read" => 100,
        "/web/config" => 20,
        "/generate-hash" => 20,
        "/sign-game-transaction" => 20,
        "/games/complete-now" => 50,
        "/token-policies" => 10,
        "/stats" => 10,
        _ if path == "/indexer" || path.starts_with("/indexer/") => INDEXER_ROUTE_LIMIT,
        _ => return None,
    };
    Some(limit)
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
    windows: Mutex<HashMap<String, (i64, u32)>>,
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
        let path = if path.starts_with("/web/verification/") {
            "/web/verification"
        } else if path.starts_with("/web/games/") && path != "/web/games/prepare" && path != "/web/games/submit" {
            "/web/games/read"
        } else {
            path
        };
        let Some(limit) = route_limit(path) else {
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
                windows.insert(path.to_string(), (now, 1));
                RateLimitResult { allowed: true, retry_after_seconds: None }
            }
        }
    }
}

#[cfg(test)]
mod tests {
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
    }
}
