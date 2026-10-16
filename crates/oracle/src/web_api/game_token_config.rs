//! Game token metadata, per-token configuration accounts and creation
//! policy checks (port of `web-api/game-token-config.ts`).

use std::collections::HashMap;
use std::sync::OnceLock;

use anyhow::{anyhow, bail, Result};
use regex::Regex;
use serde::Serialize;
use timba_protocol::address::TOKEN_PROGRAM_ID;
use timba_protocol::amounts::format_token_amount;
use timba_protocol::contracts::{find_game_token_pda, GameTokenAccount, PROGRAM_ID};
use timba_protocol::validators::{is_solana_address, is_u64_string};
use timba_protocol::Address;

use super::create_game_request::CreateGameValidationError;
use super::token_utils::{get_token_symbol, known_token, KNOWN_TOKENS};
use crate::indexer::schema::MAX_SAFE_INTEGER;
use crate::solana::rpc::AccountInfo;
use crate::solana::RpcPool;
use crate::token::policy::{evaluate_token_policy, RejectionCode, TokenPolicy};

/// `getMintSize()` of a legacy SPL Token mint.
pub const MINT_SIZE: usize = 82;
const MINT_DECIMALS_OFFSET: usize = 44;
const MINT_INITIALIZED_OFFSET: usize = 45;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameTokenMetadata {
    pub decimals: u32,
    pub symbol: String,
}

pub type GameTokenMetadataMap = HashMap<String, GameTokenMetadata>;

/// `GameTokenConfig`, serialized in the TypeScript key order.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameTokenConfig {
    pub mint: String,
    pub symbol: String,
    pub decimals: u32,
    pub minimum_amount: String,
    pub minimum_amount_raw: String,
    pub enabled: bool,
    pub price_usd: Option<f64>,
}

fn format_amount(raw: u64, decimals: u32) -> Result<String> {
    Ok(format_token_amount(u128::from(raw), decimals)?)
}

/// `decodeGameTokenMetadata`: decimals of an initialized legacy SPL mint.
pub fn decode_game_token_metadata(mint: &str, account: Option<&AccountInfo>) -> Option<GameTokenMetadata> {
    let account = account?;
    if account.owner != TOKEN_PROGRAM_ID || account.data.len() != MINT_SIZE {
        return None;
    }
    if account.data[MINT_INITIALIZED_OFFSET] != 1 {
        return None;
    }
    Some(GameTokenMetadata { decimals: u32::from(account.data[MINT_DECIMALS_OFFSET]), symbol: get_token_symbol(mint) })
}

/// `getGameTokenMetadata`: metadata for each mint that is an initialized SPL mint.
pub async fn get_game_token_metadata(rpc: &RpcPool, mints: &[Address]) -> Result<GameTokenMetadataMap> {
    if mints.is_empty() {
        return Ok(HashMap::new());
    }
    let accounts = rpc.get_multiple_accounts(mints).await?;
    Ok(mints
        .iter()
        .enumerate()
        .filter_map(|(index, mint)| {
            let mint = mint.to_base58();
            let metadata = decode_game_token_metadata(&mint, accounts.get(index).and_then(Option::as_ref))?;
            Some((mint, metadata))
        })
        .collect())
}

/// `decodeGameTokenConfig`: a v0.2 `GameToken` account of a known token.
pub fn decode_game_token_config(mint: &str, account: Option<&AccountInfo>) -> Result<GameTokenConfig> {
    let Some(token) = known_token(mint) else {
        bail!("Unsupported game token");
    };
    let unavailable = || anyhow!("{} game configuration is unavailable", token.symbol);
    let account = account.filter(|account| account.owner == PROGRAM_ID).ok_or_else(unavailable)?;
    if !GameTokenAccount::is_game_token(&account.data) {
        return Err(unavailable());
    }
    let decoded = GameTokenAccount::decode(&account.data).map_err(|_| unavailable())?;
    if decoded.token_mint.to_base58() != mint {
        return Err(unavailable());
    }
    Ok(GameTokenConfig {
        mint: mint.to_string(),
        symbol: token.symbol.to_string(),
        decimals: token.decimals,
        minimum_amount: format_amount(decoded.min_amount, token.decimals)?,
        minimum_amount_raw: decoded.min_amount.to_string(),
        enabled: decoded.enabled,
        price_usd: None,
    })
}

/// `getGameTokenConfigs`: the configuration accounts of every known token.
pub async fn get_game_token_configs(rpc: &RpcPool) -> Result<Vec<GameTokenConfig>> {
    let mints: Vec<Address> =
        KNOWN_TOKENS.iter().map(|token| Address::parse(token.mint).expect("known mint")).collect();
    let pdas: Vec<Address> = mints.iter().map(|mint| find_game_token_pda(mint, &PROGRAM_ID)).collect();
    let accounts = rpc.get_multiple_accounts(&pdas).await?;
    mints
        .iter()
        .enumerate()
        .map(|(index, mint)| decode_game_token_config(&mint.to_base58(), accounts.get(index).and_then(Option::as_ref)))
        .collect()
}

/// `assertGameTokenAmount`: v0.2 per-token minimum and enabled flag.
pub async fn assert_game_token_amount(rpc: &RpcPool, mint: &Address, amount: u64) -> Result<GameTokenConfig> {
    let game_token = find_game_token_pda(mint, &PROGRAM_ID);
    let account = rpc.get_account_info(&game_token).await?;
    let config = decode_game_token_config(&mint.to_base58(), account.as_ref())?;
    if !config.enabled {
        return Err(CreateGameValidationError::new(format!("{} is disabled for games", config.symbol)).into());
    }
    let minimum: u64 = config.minimum_amount_raw.parse()?;
    if amount < minimum {
        return Err(CreateGameValidationError::new(format!(
            "Minimum amount is {} {}",
            config.minimum_amount, config.symbol
        ))
        .into());
    }
    Ok(config)
}

/// `assertGameTokenPolicy`: v0.3 oracle token policy checks.
pub fn assert_game_token_policy<'a>(
    policies: &'a [TokenPolicy],
    mint: &str,
    amount: u64,
    metadata: &GameTokenMetadataMap,
) -> Result<&'a TokenPolicy> {
    let result = evaluate_token_policy(policies, mint, Some(amount));
    let (policy, code) = match result {
        Ok(policy) => (policy, None),
        Err((code, Some(policy))) => (policy, Some(code)),
        Err((_, None)) => return Err(CreateGameValidationError::new("Unsupported game token").into()),
    };
    if code == Some(RejectionCode::TokenDisabled) {
        return Err(CreateGameValidationError::new("This token is disabled for new games").into());
    }
    let Some(token) = metadata.get(mint) else {
        return Err(CreateGameValidationError::new("Unsupported game token").into());
    };
    if code == Some(RejectionCode::AmountBelowMinimum) {
        let minimum: u64 = policy.minimum_amount_raw.parse()?;
        return Err(CreateGameValidationError::new(format!(
            "Minimum amount is {} {}",
            format_amount(minimum, token.decimals)?,
            token.symbol
        ))
        .into());
    }
    Ok(policy)
}

/// `formatGameTokenPolicies`: policies of mints with metadata, with prices.
pub fn format_game_token_policies(
    policies: &[TokenPolicy],
    prices: &HashMap<String, f64>,
    metadata: &GameTokenMetadataMap,
) -> Result<Vec<GameTokenConfig>> {
    policies
        .iter()
        .filter_map(|policy| metadata.get(&policy.mint).map(|token| (policy, token)))
        .map(|(policy, token)| {
            let minimum: u64 = policy.minimum_amount_raw.parse()?;
            Ok(GameTokenConfig {
                mint: policy.mint.clone(),
                symbol: token.symbol.clone(),
                decimals: token.decimals,
                minimum_amount: format_amount(minimum, token.decimals)?,
                minimum_amount_raw: policy.minimum_amount_raw.clone(),
                enabled: policy.enabled,
                price_usd: prices.get(&policy.mint).copied(),
            })
        })
        .collect()
}

fn iso_datetime_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // zod `z.iso.datetime()`: an RFC 3339 UTC timestamp with seconds and optional fraction.
        let date = r"(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))";
        let time = r"(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?Z";
        Regex::new(&format!("^{date}T(?:{time})$")).expect("datetime regex")
    })
}

/// `TokenPoliciesResponseSchema.shape.policies.parse`.
pub fn validate_token_policies(policies: &[TokenPolicy]) -> Result<()> {
    for (index, policy) in policies.iter().enumerate() {
        let valid = is_solana_address(&policy.mint)
            && is_u64_string(&policy.minimum_amount_raw)
            && is_u64_string(&policy.accepted_minimum_amount_raw)
            && policy.revision >= 0
            && policy.revision as f64 <= MAX_SAFE_INTEGER
            && iso_datetime_re().is_match(&policy.effective_at);
        if !valid {
            bail!("Invalid token policy at index {index}");
        }
        let minimum: u64 = policy.minimum_amount_raw.parse()?;
        let accepted: u64 = policy.accepted_minimum_amount_raw.parse()?;
        if accepted > minimum {
            bail!("Invalid token policy at index {index}: accepted minimum must not exceed the recommended minimum");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::solana::pool::testing::FakeTransport;
    use crate::web_api::token_utils::{TIMBA_MINT, USDC_MINT};
    use base64::Engine;
    use serde_json::{json, Value};
    use std::sync::Arc;
    use timba_protocol::contracts::discriminators;

    const UNKNOWN_MINT: &str = "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx";

    fn policy() -> TokenPolicy {
        TokenPolicy {
            mint: TIMBA_MINT.into(),
            enabled: true,
            minimum_amount_raw: "25034000001".into(),
            accepted_minimum_amount_raw: "23782300001".into(),
            revision: 3,
            effective_at: "2026-09-02T12:00:00.000Z".into(),
        }
    }

    fn metadata() -> GameTokenMetadataMap {
        HashMap::from([(TIMBA_MINT.to_string(), GameTokenMetadata { symbol: "TIMBA".into(), decimals: 6 })])
    }

    fn account(data: Vec<u8>, owner: Address) -> AccountInfo {
        AccountInfo { lamports: 1, owner, data, executable: false }
    }

    fn game_token_data(mint: &str, enabled: bool, min_amount: u64) -> Vec<u8> {
        let mut data = vec![0u8; 58];
        data[..8].copy_from_slice(&discriminators::GAME_TOKEN_ACCOUNT);
        data[8..40].copy_from_slice(&Address::parse(mint).unwrap().0);
        data[40] = 255;
        data[41..49].copy_from_slice(&min_amount.to_le_bytes());
        data[57] = u8::from(enabled);
        data
    }

    fn message(error: anyhow::Error) -> String {
        match error.downcast_ref::<CreateGameValidationError>() {
            Some(validation) => validation.public_message.clone(),
            None => error.to_string(),
        }
    }

    #[test]
    fn decodes_the_v0_2_game_token_account_layout() {
        let mut data = game_token_data(TIMBA_MINT, true, 25_034_000_001);
        data[40] = 1;
        let config = decode_game_token_config(TIMBA_MINT, Some(&account(data, PROGRAM_ID))).unwrap();
        assert_eq!(config.minimum_amount, "25034.000001");
        assert_eq!(config.minimum_amount_raw, "25034000001");
        assert!(config.enabled);
        assert_eq!(config.symbol, "TIMBA");
    }

    #[test]
    fn formats_oracle_policy_without_floating_point_conversion() {
        let prices = HashMap::from([(TIMBA_MINT.to_string(), 0.000004)]);
        let formatted = format_game_token_policies(&[policy()], &prices, &metadata()).unwrap();
        assert_eq!(
            crate::indexer::schema::to_js_json(&serde_json::to_value(&formatted).unwrap()),
            format!(
                r#"[{{"mint":"{TIMBA_MINT}","symbol":"TIMBA","decimals":6,"minimumAmount":"25034.000001","minimumAmountRaw":"25034000001","enabled":true,"priceUsd":0.000004}}]"#
            )
        );
    }

    #[test]
    fn keeps_disabled_dynamic_tokens_displayable() {
        let unknown = TokenPolicy { mint: UNKNOWN_MINT.into(), enabled: false, ..policy() };
        let formatted = format_game_token_policies(&[unknown.clone(), policy()], &HashMap::new(), &metadata()).unwrap();
        assert_eq!(formatted.len(), 1);
        assert_eq!((formatted[0].mint.as_str(), formatted[0].enabled), (TIMBA_MINT, true));
        assert_eq!(formatted[0].price_usd, None);
        let own = HashMap::from([(UNKNOWN_MINT.to_string(), GameTokenMetadata { symbol: "TEST".into(), decimals: 8 })]);
        let formatted = format_game_token_policies(&[unknown], &HashMap::new(), &own).unwrap();
        assert_eq!((formatted[0].mint.as_str(), formatted[0].enabled), (UNKNOWN_MINT, false));
    }

    #[test]
    fn uses_mint_account_decimals_and_a_safe_symbol_fallback() {
        let mut data = vec![0u8; 82];
        data[44] = 8;
        data[45] = 1;
        assert_eq!(
            decode_game_token_metadata(UNKNOWN_MINT, Some(&account(data.clone(), TOKEN_PROGRAM_ID))),
            Some(GameTokenMetadata { decimals: 8, symbol: "US51...ELFx".into() })
        );
        assert_eq!(decode_game_token_metadata(UNKNOWN_MINT, Some(&account(data.clone(), PROGRAM_ID))), None);
        assert_eq!(decode_game_token_metadata(UNKNOWN_MINT, None), None);
        data[45] = 0;
        assert_eq!(decode_game_token_metadata(UNKNOWN_MINT, Some(&account(data, TOKEN_PROGRAM_ID))), None);
    }

    #[test]
    fn rejects_disabled_tokens_and_amounts_below_the_grace_band() {
        let accepted: u64 = policy().accepted_minimum_amount_raw.parse().unwrap();
        let disabled = [TokenPolicy { enabled: false, ..policy() }];
        let error = assert_game_token_policy(&disabled, TIMBA_MINT, 30_000_000_000, &metadata()).unwrap_err();
        assert_eq!(message(error), "This token is disabled for new games");
        let policies = [policy()];
        let error = assert_game_token_policy(&policies, TIMBA_MINT, accepted - 1, &metadata()).unwrap_err();
        assert_eq!(message(error), "Minimum amount is 25034.000001 TIMBA");
        assert_eq!(assert_game_token_policy(&policies, TIMBA_MINT, accepted, &metadata()).unwrap(), &policies[0]);
        let error = assert_game_token_policy(&policies, USDC_MINT, accepted, &metadata()).unwrap_err();
        assert_eq!(message(error), "Unsupported game token");
        let error = assert_game_token_policy(&policies, TIMBA_MINT, accepted, &HashMap::new()).unwrap_err();
        assert_eq!(message(error), "Unsupported game token");
    }

    #[test]
    fn validates_token_policies_like_the_protocol_schema() {
        assert!(validate_token_policies(&[policy()]).is_ok());
        for broken in [
            TokenPolicy { accepted_minimum_amount_raw: "25034000002".into(), ..policy() },
            TokenPolicy { mint: "nope".into(), ..policy() },
            TokenPolicy { revision: -1, ..policy() },
            TokenPolicy { effective_at: "2026-09-02T12:00:00+00:00".into(), ..policy() },
            TokenPolicy { effective_at: "2026-02-30T12:00:00Z".into(), ..policy() },
            TokenPolicy { minimum_amount_raw: "1.5".into(), ..policy() },
        ] {
            assert!(validate_token_policies(&[broken]).is_err());
        }
        assert!(
            validate_token_policies(&[TokenPolicy { effective_at: "2028-02-29T00:00:00Z".into(), ..policy() }]).is_ok()
        );
    }

    fn rpc_with(data: Option<Vec<u8>>) -> RpcPool {
        let transport = FakeTransport::new();
        let value = data.map_or(Value::Null, |data| {
            json!({
                "data": [base64::engine::general_purpose::STANDARD.encode(&data), "base64"],
                "owner": PROGRAM_ID.to_base58(), "lamports": 1, "executable": false, "space": data.len()
            })
        });
        transport.push("getAccountInfo", Ok(json!({ "context": { "slot": 1 }, "value": value })));
        RpcPool::with_transport(&["http://rpc.test".into()], transport as Arc<_>).unwrap()
    }

    #[tokio::test]
    async fn accepts_an_amount_at_the_enabled_token_minimum() {
        let mint = Address::parse(TIMBA_MINT).unwrap();
        let rpc = rpc_with(Some(game_token_data(TIMBA_MINT, true, 5_000_000)));
        let config = assert_game_token_amount(&rpc, &mint, 5_000_000).await.unwrap();
        assert_eq!((config.symbol.as_str(), config.minimum_amount.as_str()), ("TIMBA", "5"));
    }

    #[tokio::test]
    async fn rejects_disabled_tokens_and_amounts_below_the_minimum() {
        let mint = Address::parse(TIMBA_MINT).unwrap();
        let error = assert_game_token_amount(&rpc_with(Some(game_token_data(TIMBA_MINT, false, 1))), &mint, 10)
            .await
            .unwrap_err();
        assert_eq!(
            error.downcast_ref::<CreateGameValidationError>().unwrap().public_message,
            "TIMBA is disabled for games"
        );
        let error =
            assert_game_token_amount(&rpc_with(Some(game_token_data(TIMBA_MINT, true, 5_000_000))), &mint, 4_999_999)
                .await
                .unwrap_err();
        assert_eq!(
            error.downcast_ref::<CreateGameValidationError>().unwrap().public_message,
            "Minimum amount is 5 TIMBA"
        );
    }

    #[tokio::test]
    async fn treats_a_missing_or_foreign_configuration_account_as_unavailable() {
        let mint = Address::parse(TIMBA_MINT).unwrap();
        let error = assert_game_token_amount(&rpc_with(None), &mint, 1).await.unwrap_err();
        assert_eq!(error.to_string(), "TIMBA game configuration is unavailable");
        assert!(error.downcast_ref::<CreateGameValidationError>().is_none());
        let other = account(game_token_data(USDC_MINT, true, 1), PROGRAM_ID);
        let error = decode_game_token_config(TIMBA_MINT, Some(&other)).unwrap_err();
        assert_eq!(error.to_string(), "TIMBA game configuration is unavailable");
        let foreign = account(game_token_data(TIMBA_MINT, true, 1), TOKEN_PROGRAM_ID);
        assert!(decode_game_token_config(TIMBA_MINT, Some(&foreign)).is_err());
        assert_eq!(decode_game_token_config(UNKNOWN_MINT, None).unwrap_err().to_string(), "Unsupported game token");
    }
}
