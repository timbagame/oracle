//! Known token mints (port of `web-api/token-utils.ts` and `web-api/amounts.ts`).

pub const TIMBA_MINT: &str = "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump";
pub const SOL_MINT: &str = "So11111111111111111111111111111111111111112";
pub const USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
pub const USDT_MINT: &str = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
pub const MAGAIBA_MINT: &str = "A6rSPi9JmJgVkW6BatsA6MjFYLseizPM2Fnt92coFjf4";

/// A known token: mint, symbol and decimals.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KnownToken {
    pub mint: &'static str,
    pub symbol: &'static str,
    pub decimals: u32,
}

/// `TOKEN_SYMBOLS` / `TOKEN_DECIMALS`, in declaration order.
pub const KNOWN_TOKENS: [KnownToken; 5] = [
    KnownToken { mint: TIMBA_MINT, symbol: "TIMBA", decimals: 6 },
    KnownToken { mint: SOL_MINT, symbol: "SOL", decimals: 9 },
    KnownToken { mint: USDC_MINT, symbol: "USDC", decimals: 6 },
    KnownToken { mint: USDT_MINT, symbol: "USDT", decimals: 6 },
    KnownToken { mint: MAGAIBA_MINT, symbol: "MAGAIBA", decimals: 6 },
];

pub fn known_token(mint: &str) -> Option<&'static KnownToken> {
    KNOWN_TOKENS.iter().find(|token| token.mint == mint)
}

/// `getTokenSymbol`: the known symbol, or `abcd...wxyz`.
pub fn get_token_symbol(mint: &str) -> String {
    if let Some(token) = known_token(mint) {
        return token.symbol.to_string();
    }
    let chars: Vec<char> = mint.chars().collect();
    let head: String = chars.iter().take(4).collect();
    let tail: String = chars[chars.len().saturating_sub(4)..].iter().collect();
    format!("{head}...{tail}")
}

/// `tokensToAmount` for bigint amounts: `Number(whole) + Number(remainder) / 10^decimals`.
pub fn tokens_to_amount(amount: u64, decimals: u32) -> f64 {
    // The correctly rounded `10 ** decimals`.
    let divisor_f64: f64 = format!("1e{decimals}").parse().expect("valid float literal");
    match 10u128.checked_pow(decimals) {
        Some(divisor) => {
            let amount = u128::from(amount);
            (amount / divisor) as f64 + (amount % divisor) as f64 / divisor_f64
        }
        None => amount as f64 / divisor_f64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symbols_fall_back_to_a_shortened_mint() {
        assert_eq!(get_token_symbol(USDC_MINT), "USDC");
        assert_eq!(get_token_symbol("US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx"), "US51...ELFx");
        assert_eq!(known_token(SOL_MINT).unwrap().decimals, 9);
    }

    #[test]
    fn converts_raw_amounts() {
        assert_eq!(tokens_to_amount(1_500_000, 6), 1.5);
        assert_eq!(tokens_to_amount(100, 9), 0.0000001);
        assert_eq!(tokens_to_amount(7, 0), 7.0);
        assert_eq!(tokens_to_amount(5, 30), 5e-30);
    }
}
