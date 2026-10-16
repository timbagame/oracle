//! Environment helpers (port of `env.ts`).

/// Trimmed environment value; empty strings count as unset.
pub fn read_env(key: &str) -> Option<String> {
    let value = std::env::var(key).ok()?;
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

pub fn is_ci_environment() -> bool {
    std::env::var("CI").map(|v| v == "true").unwrap_or(false)
}

pub fn environment_mode() -> String {
    for key in ["NODE_ENV", "BUN_ENV"] {
        if let Some(value) = read_env(key) {
            return value;
        }
    }
    if is_ci_environment() {
        return "ci".into();
    }
    "development".into()
}

pub fn is_test_environment() -> bool {
    environment_mode().to_lowercase().contains("test")
}

pub fn read_bool_env(key: &str) -> Option<bool> {
    match read_env(key)?.to_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

pub fn should_use_ephemeral_keypair() -> bool {
    if let Some(explicit) = read_bool_env("USE_FAKE_KEYPAIR") {
        return explicit;
    }
    is_test_environment() || is_ci_environment()
}

/// Integer parsing with the same warnings and fallbacks as `config.ts`.
pub fn parse_integer(value: Option<&str>, default: i64, min: Option<i64>, max: Option<i64>, key: &str) -> i64 {
    let Some(value) = value else { return default };
    let parsed: f64 = match value.trim().parse::<f64>() {
        Ok(v) if v.is_finite() => v,
        _ => {
            crate::warn!("⚠️  Ignoring invalid numeric value '{value}' for {key}; using {default}.");
            return default;
        }
    };
    if parsed.fract() != 0.0 {
        crate::warn!("⚠️  {key} must be an integer, received {parsed}; using {default}.");
        return default;
    }
    let parsed = parsed as i64;
    if let Some(min) = min {
        if parsed < min {
            crate::warn!("⚠️  {key} must be >= {min}, received {parsed}; using {default}.");
            return default;
        }
    }
    if let Some(max) = max {
        if parsed > max {
            crate::warn!("⚠️  {key} must be <= {max}, received {parsed}; using {default}.");
            return default;
        }
    }
    parsed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integers() {
        assert_eq!(parse_integer(None, 5, None, None, "K"), 5);
        assert_eq!(parse_integer(Some("7"), 5, None, None, "K"), 7);
        assert_eq!(parse_integer(Some("abc"), 5, None, None, "K"), 5);
        assert_eq!(parse_integer(Some("1.5"), 5, None, None, "K"), 5);
        assert_eq!(parse_integer(Some("-1"), 5, Some(0), None, "K"), 5);
        assert_eq!(parse_integer(Some("70000"), 5, Some(0), Some(65535), "K"), 5);
        assert_eq!(parse_integer(Some("1e3"), 5, None, None, "K"), 1000);
    }
}
