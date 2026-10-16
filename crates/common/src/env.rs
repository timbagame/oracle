//! Environment helpers (port of `env.ts`).

/// `String.prototype.trim` as Bun runs it: Unicode whitespace plus the byte order
/// mark (U+FEFF), which `str::trim` keeps. Editors on Windows add one to saved files.
pub fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// Trimmed environment value; empty strings count as unset.
pub fn read_env(key: &str) -> Option<String> {
    let value = std::env::var(key).ok()?;
    let trimmed = js_trim(&value);
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
    let parsed: f64 = match js_trim(value).parse::<f64>() {
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
        assert_eq!(parse_integer(Some("\u{feff}42 "), 5, None, None, "K"), 42);
    }

    #[test]
    fn trims_like_javascript() {
        // Bun: "\ufeff\u0085\u00a0\u3000x\u2028\n".trim() === "x", while U+200B stays.
        assert_eq!(js_trim("\u{feff}\u{85}\u{a0}\u{3000}x\u{2028}\n"), "x");
        assert_eq!(js_trim("\u{200b}x"), "\u{200b}x");
        assert_eq!(js_trim("a b"), "a b");
        assert_eq!(js_trim("\u{feff}"), "");
    }

    /// Every case mutating process-wide variables lives in this one test so
    /// they cannot race each other.
    #[test]
    fn environment_detection() {
        const KEYS: [&str; 5] = ["NODE_ENV", "BUN_ENV", "CI", "USE_FAKE_KEYPAIR", "TIMBA_ENV_TEST_VALUE"];
        let saved: Vec<(&str, Option<String>)> = KEYS.iter().map(|k| (*k, std::env::var(k).ok())).collect();
        let set = |pairs: &[(&str, &str)]| {
            for key in KEYS {
                std::env::remove_var(key);
            }
            for (key, value) in pairs {
                std::env::set_var(key, value);
            }
        };

        set(&[("TIMBA_ENV_TEST_VALUE", "  padded  ")]);
        assert_eq!(read_env("TIMBA_ENV_TEST_VALUE").as_deref(), Some("padded"));
        set(&[("TIMBA_ENV_TEST_VALUE", "   ")]);
        assert_eq!(read_env("TIMBA_ENV_TEST_VALUE"), None);
        assert_eq!(read_env("TIMBA_ENV_TEST_MISSING"), None);

        for (raw, expected) in [
            ("1", Some(true)),
            ("TRUE", Some(true)),
            ("yes", Some(true)),
            ("On", Some(true)),
            ("0", Some(false)),
            ("false", Some(false)),
            ("NO", Some(false)),
            ("off", Some(false)),
            ("maybe", None),
        ] {
            set(&[("TIMBA_ENV_TEST_VALUE", raw)]);
            assert_eq!(read_bool_env("TIMBA_ENV_TEST_VALUE"), expected, "{raw}");
        }

        set(&[]);
        assert_eq!(environment_mode(), "development");
        assert!(!is_ci_environment());
        assert!(!is_test_environment());
        assert!(!should_use_ephemeral_keypair());

        set(&[("CI", "true")]);
        assert!(is_ci_environment());
        assert_eq!(environment_mode(), "ci");
        assert!(!is_test_environment());
        assert!(should_use_ephemeral_keypair());
        set(&[("CI", "1")]);
        assert!(!is_ci_environment(), "only the literal \"true\" marks CI");

        set(&[("BUN_ENV", "Test"), ("CI", "true")]);
        assert_eq!(environment_mode(), "Test");
        assert!(is_test_environment());
        set(&[("NODE_ENV", "production"), ("BUN_ENV", "test")]);
        assert_eq!(environment_mode(), "production", "NODE_ENV takes precedence");
        assert!(!should_use_ephemeral_keypair());

        set(&[("NODE_ENV", "test"), ("USE_FAKE_KEYPAIR", "off")]);
        assert!(!should_use_ephemeral_keypair(), "explicit opt-out wins");
        set(&[("NODE_ENV", "production"), ("USE_FAKE_KEYPAIR", "yes")]);
        assert!(should_use_ephemeral_keypair(), "explicit opt-in wins");

        for (key, value) in saved {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}
