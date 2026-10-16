//! Token creation policy math (port of `token-policy.ts` and protocol
//! `evaluateTokenPolicy`).

use num_bigint::BigUint;
use serde::Serialize;
use timba_protocol::Address;

pub const U64_MAX: u64 = u64::MAX;
pub const MINIMUM_GAME_USD: &str = "0.10";
pub const MINIMUM_AMOUNT_GRACE_BPS: u64 = 500;
const BASIS_POINTS: u64 = 10_000;
const MINIMUM_GAME_USD_NUMERATOR: u64 = 1;
const MINIMUM_GAME_USD_DENOMINATOR: u64 = 10;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredTokenPolicy {
    pub mint: String,
    pub enabled: bool,
    pub decimals: u32,
    pub revision: i64,
    pub effective_at_ms: i64,
}

/// API representation (`TokenPolicySchema`), fields in schema order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenPolicy {
    pub mint: String,
    pub enabled: bool,
    pub minimum_amount_raw: String,
    pub accepted_minimum_amount_raw: String,
    pub revision: i64,
    pub effective_at: String,
}

pub fn normalize_mint(value: &str) -> Result<String, String> {
    Address::parse(value.trim()).map(|a| a.to_base58()).map_err(|_| "mint must be a valid Solana address".to_string())
}

const DECIMALS_ERROR: &str = "token decimals must be an integer from 0 to 15";

pub fn normalize_token_decimals_str(value: &str) -> Result<u32, String> {
    let normalized = value.trim();
    let valid = !normalized.is_empty()
        && normalized.bytes().all(|b| b.is_ascii_digit())
        && (normalized == "0" || !normalized.starts_with('0'));
    if !valid {
        return Err(DECIMALS_ERROR.into());
    }
    normalized.parse::<u32>().ok().filter(|d| *d <= 15).ok_or_else(|| DECIMALS_ERROR.into())
}

pub fn normalize_token_decimals(value: i64) -> Result<u32, String> {
    if !(0..=15).contains(&value) {
        return Err(DECIMALS_ERROR.into());
    }
    Ok(value as u32)
}

/// Exact decimal fraction of a positive finite price, using the same
/// shortest round-trip digits as JavaScript `Number#toString`.
fn positive_decimal_fraction(value: f64) -> Result<(BigUint, BigUint), String> {
    if !value.is_finite() || value <= 0.0 {
        return Err("token USD price is invalid".into());
    }
    let formatted = format!("{value:e}");
    let (mantissa, exp) = formatted.split_once('e').ok_or("token USD price is invalid")?;
    let exp: i64 = exp.parse().map_err(|_| "token USD price is invalid")?;
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = format!("{whole}{fraction}");
    let digits = digits.trim_start_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };
    let exponent = exp - fraction.len() as i64;
    if exponent.abs() > 100 {
        return Err("token USD price exponent is invalid".into());
    }
    let number: BigUint = digits.parse().map_err(|_| "token USD price is invalid")?;
    let ten = BigUint::from(10u32);
    Ok(if exponent >= 0 {
        (number * ten.pow(exponent as u32), BigUint::from(1u32))
    } else {
        (number, ten.pow((-exponent) as u32))
    })
}

fn ceil_divide(numerator: BigUint, denominator: &BigUint) -> BigUint {
    (numerator + denominator - 1u32) / denominator
}

pub fn compute_minimum_amount_raw(price_usd: f64, decimals: u32) -> Result<u64, String> {
    let decimals = normalize_token_decimals(decimals as i64)?;
    let (numerator, denominator) = positive_decimal_fraction(price_usd)?;
    let raw = ceil_divide(
        BigUint::from(MINIMUM_GAME_USD_NUMERATOR) * denominator * BigUint::from(10u32).pow(decimals),
        &(BigUint::from(MINIMUM_GAME_USD_DENOMINATOR) * numerator),
    );
    // The numerator is positive and the quotient rounds up, so `raw` is at least 1.
    raw.try_into().map_err(|_| "dynamic minimum amount exceeds u64".to_string())
}

pub fn accepted_minimum_amount_raw(recommended: u64) -> Result<u64, String> {
    if recommended == 0 {
        return Err("recommended minimum must be positive".into());
    }
    let product = recommended as u128 * (BASIS_POINTS - MINIMUM_AMOUNT_GRACE_BPS) as u128;
    Ok(product.div_ceil(BASIS_POINTS as u128) as u64)
}

pub fn to_api_token_policy(policy: &StoredTokenPolicy, minimum_amount_raw: u64) -> TokenPolicy {
    TokenPolicy {
        mint: policy.mint.clone(),
        enabled: policy.enabled,
        minimum_amount_raw: minimum_amount_raw.to_string(),
        accepted_minimum_amount_raw: if minimum_amount_raw > 0 {
            accepted_minimum_amount_raw(minimum_amount_raw).expect("positive").to_string()
        } else {
            "0".into()
        },
        revision: policy.revision,
        effective_at: timba_common::time::iso_from_ms(policy.effective_at_ms),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectionCode {
    UnsupportedMint,
    TokenDisabled,
    AmountBelowMinimum,
    PolicyUnavailable,
}

impl RejectionCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnsupportedMint => "unsupported_mint",
            Self::TokenDisabled => "token_disabled",
            Self::AmountBelowMinimum => "amount_below_minimum",
            Self::PolicyUnavailable => "policy_unavailable",
        }
    }
}

/// Pure eligibility check (`evaluateTokenPolicy`).
pub fn evaluate_token_policy<'a>(
    policies: &'a [TokenPolicy],
    mint: &str,
    amount: Option<u64>,
) -> Result<&'a TokenPolicy, (RejectionCode, Option<&'a TokenPolicy>)> {
    let Some(policy) = policies.iter().find(|p| p.mint == mint) else {
        return Err((RejectionCode::UnsupportedMint, None));
    };
    if !policy.enabled {
        return Err((RejectionCode::TokenDisabled, Some(policy)));
    }
    if let Some(amount) = amount {
        let accepted: u64 = policy.accepted_minimum_amount_raw.parse().unwrap_or(u64::MAX);
        if amount < accepted {
            return Err((RejectionCode::AmountBelowMinimum, Some(policy)));
        }
    }
    Ok(policy)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimum_amounts() {
        // $1 token with 6 decimals: $0.10 = 100_000 raw.
        assert_eq!(compute_minimum_amount_raw(1.0, 6).unwrap(), 100_000);
        // $150 SOL with 9 decimals: ceil(1e9 / 1500).
        assert_eq!(compute_minimum_amount_raw(150.0, 9).unwrap(), 666_667);
        assert_eq!(compute_minimum_amount_raw(0.000123, 6).unwrap(), 813_008_131);
        assert_eq!(compute_minimum_amount_raw(1.5e-7, 6).unwrap(), 666_666_666_667);
        assert_eq!(compute_minimum_amount_raw(150.25, 9).unwrap(), 665_558);
        assert_eq!(compute_minimum_amount_raw(0.1, 0).unwrap(), 1);
        assert!(compute_minimum_amount_raw(0.0, 6).is_err());
        assert!(compute_minimum_amount_raw(f64::NAN, 6).is_err());
        assert!(compute_minimum_amount_raw(1e-30, 15).is_err());
        assert_eq!(compute_minimum_amount_raw(1e30, 0).unwrap(), 1);
        assert_eq!(accepted_minimum_amount_raw(100_000).unwrap(), 95_000);
        assert_eq!(accepted_minimum_amount_raw(666_667).unwrap(), 633_334);
    }

    #[test]
    fn decimals_and_mints() {
        assert_eq!(normalize_token_decimals_str(" 9 ").unwrap(), 9);
        assert!(normalize_token_decimals_str("09").is_err());
        assert!(normalize_token_decimals_str("16").is_err());
        assert!(normalize_token_decimals_str("").is_err());
        assert!(normalize_mint("nope").is_err());
        assert_eq!(
            normalize_mint(" So11111111111111111111111111111111111111112 ").unwrap(),
            "So11111111111111111111111111111111111111112"
        );
    }

    #[test]
    fn api_policy_and_evaluation() {
        let stored =
            StoredTokenPolicy { mint: "M".into(), enabled: true, decimals: 6, revision: 2, effective_at_ms: 0 };
        let api = to_api_token_policy(&stored, 100_000);
        assert_eq!(api.accepted_minimum_amount_raw, "95000");
        assert_eq!(api.effective_at, "1970-01-01T00:00:00.000Z");
        assert_eq!(to_api_token_policy(&stored, 0).accepted_minimum_amount_raw, "0");
        let policies = vec![api];
        assert!(evaluate_token_policy(&policies, "M", Some(95_000)).is_ok());
        assert_eq!(
            evaluate_token_policy(&policies, "M", Some(94_999)).unwrap_err().0,
            RejectionCode::AmountBelowMinimum
        );
        assert_eq!(evaluate_token_policy(&policies, "X", None).unwrap_err().0, RejectionCode::UnsupportedMint);
        // Without an amount only the token itself is checked.
        assert_eq!(evaluate_token_policy(&policies, "M", None).unwrap().mint, "M");
        let disabled = StoredTokenPolicy { enabled: false, ..stored };
        let policies = vec![to_api_token_policy(&disabled, 100_000)];
        let (code, policy) = evaluate_token_policy(&policies, "M", Some(u64::MAX)).unwrap_err();
        assert_eq!((code, policy.map(|p| p.revision)), (RejectionCode::TokenDisabled, Some(2)));
    }

    #[test]
    fn rejects_unusable_prices_and_minimums() {
        let err = compute_minimum_amount_raw(1e200, 6).unwrap_err();
        assert_eq!(err, "token USD price exponent is invalid");
        assert_eq!(compute_minimum_amount_raw(1e-200, 6).unwrap_err(), "token USD price exponent is invalid");
        assert_eq!(compute_minimum_amount_raw(1e-30, 15).unwrap_err(), "dynamic minimum amount exceeds u64");
        assert_eq!(accepted_minimum_amount_raw(0).unwrap_err(), "recommended minimum must be positive");
    }

    #[test]
    fn names_rejection_codes() {
        let names: Vec<_> = [
            RejectionCode::UnsupportedMint,
            RejectionCode::TokenDisabled,
            RejectionCode::AmountBelowMinimum,
            RejectionCode::PolicyUnavailable,
        ]
        .into_iter()
        .map(RejectionCode::as_str)
        .collect();
        assert_eq!(names, ["unsupported_mint", "token_disabled", "amount_below_minimum", "policy_unavailable"]);
    }
}
