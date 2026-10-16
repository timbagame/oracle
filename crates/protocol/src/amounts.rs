//! Exact token amount helpers (`@timbagame/protocol/amounts`).

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct TokenAmountError {
    pub code: &'static str,
    pub message: String,
}

fn assert_decimals(decimals: u32) -> Result<(), TokenAmountError> {
    if decimals > 255 {
        return Err(TokenAmountError {
            code: "decimals",
            message: "Decimals must be an integer between 0 and 255".into(),
        });
    }
    Ok(())
}

/// Formats unsigned base units without rounding, including zero-decimal tokens.
pub fn format_token_amount(value: u128, decimals: u32) -> Result<String, TokenAmountError> {
    assert_decimals(decimals)?;
    if decimals == 0 {
        return Ok(value.to_string());
    }
    let d = decimals as usize;
    let digits = value.to_string();
    let padded = if digits.len() < d + 1 { format!("{}{}", "0".repeat(d + 1 - digits.len()), digits) } else { digits };
    let (whole, fraction) = padded.split_at(padded.len() - d);
    let fraction = fraction.trim_end_matches('0');
    Ok(if fraction.is_empty() { whole.to_string() } else { format!("{whole}.{fraction}") })
}

/// JS `tokensToAmount`: `Number(whole) + Number(remainder) / 10^decimals`.
pub fn tokens_to_amount(amount: u64, decimals: u32) -> f64 {
    let divisor = 10u64.pow(decimals);
    let whole = amount / divisor;
    let remainder = amount % divisor;
    whole as f64 + remainder as f64 / divisor as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats() {
        assert_eq!(format_token_amount(0, 6).unwrap(), "0");
        assert_eq!(format_token_amount(1, 6).unwrap(), "0.000001");
        assert_eq!(format_token_amount(1_500_000, 6).unwrap(), "1.5");
        assert_eq!(format_token_amount(42, 0).unwrap(), "42");
        assert!(format_token_amount(1, 256).is_err());
        assert_eq!(tokens_to_amount(1_500_000, 6), 1.5);
    }
}
