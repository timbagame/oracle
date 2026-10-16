use std::sync::OnceLock;
use std::time::Instant;

use chrono::{SecondsFormat, TimeZone, Utc};

static PROCESS_START: OnceLock<Instant> = OnceLock::new();

/// Records the process start; call first thing in `main`.
pub fn mark_process_start() {
    PROCESS_START.get_or_init(Instant::now);
}

/// Seconds since [`mark_process_start`] (Node's `process.uptime()`).
pub fn uptime_secs() -> f64 {
    PROCESS_START.get_or_init(Instant::now).elapsed().as_secs_f64()
}

/// JavaScript `new Date().toISOString()`.
pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

pub fn now_secs() -> i64 {
    Utc::now().timestamp()
}

/// `new Date(ms).toISOString()`.
pub fn iso_from_ms(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms)
        .single()
        .map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn iso_format() {
        assert_eq!(super::iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(super::iso_from_ms(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
    }
}
