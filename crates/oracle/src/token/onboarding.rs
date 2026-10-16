//! Validates a game token mint and ensures the operator owns an associated
//! token account for it (port of `token-onboarding.ts`).

use timba_protocol::address::{find_associated_token_address, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID};
use timba_protocol::plans::create_associated_token_account_idempotent_instruction;
use timba_protocol::Address;

use super::policy::normalize_token_decimals;
use crate::solana::confirm::confirm_transaction;
use crate::solana::rpc::AccountInfo;
use crate::solana::tx::sign_legacy_transaction;
use crate::solana::{Keypair, RpcPool};

const LEGACY_MINT_ACCOUNT_SIZE: usize = 82;
const MINT_DECIMALS_OFFSET: usize = 44;
const MINT_INITIALIZED_OFFSET: usize = 45;
const LEGACY_TOKEN_ACCOUNT_SIZE: usize = 165;
const TOKEN_ACCOUNT_MINT_OFFSET: usize = 0;
const TOKEN_ACCOUNT_OWNER_OFFSET: usize = 32;
const TOKEN_ACCOUNT_STATE_OFFSET: usize = 108;
const TOKEN_ACCOUNT_INITIALIZED: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedGameToken {
    pub decimals: u32,
    pub operator_token_account: Address,
    pub creation_signature: Option<String>,
}

pub fn decode_mint_decimals(mint: &Address, account: &AccountInfo) -> anyhow::Result<u32> {
    if account.owner != TOKEN_PROGRAM_ID
        || account.data.len() != LEGACY_MINT_ACCOUNT_SIZE
        || account.data[MINT_INITIALIZED_OFFSET] != 1
    {
        anyhow::bail!("Token mint must be an initialized legacy SPL Token mint: {mint}");
    }
    normalize_token_decimals(i64::from(account.data[MINT_DECIMALS_OFFSET])).map_err(anyhow::Error::msg)
}

pub fn assert_operator_token_account(
    account_address: &Address,
    account: &AccountInfo,
    mint: &Address,
    owner: &Address,
) -> anyhow::Result<()> {
    let data = &account.data;
    let valid = account.owner == TOKEN_PROGRAM_ID
        && data.len() == LEGACY_TOKEN_ACCOUNT_SIZE
        && data[TOKEN_ACCOUNT_STATE_OFFSET] == TOKEN_ACCOUNT_INITIALIZED
        && data[TOKEN_ACCOUNT_MINT_OFFSET..TOKEN_ACCOUNT_OWNER_OFFSET] == mint.as_bytes()[..]
        && data[TOKEN_ACCOUNT_OWNER_OFFSET..TOKEN_ACCOUNT_OWNER_OFFSET + 32] == owner.as_bytes()[..];
    if !valid {
        anyhow::bail!("Operator token account is invalid: {account_address}");
    }
    Ok(())
}

pub async fn prepare_game_token(
    rpc: &RpcPool,
    operator: &Keypair,
    mint: &Address,
) -> anyhow::Result<PreparedGameToken> {
    let mint_account =
        rpc.get_account_info(mint).await?.ok_or_else(|| anyhow::anyhow!("Token mint does not exist: {mint}"))?;
    let decimals = decode_mint_decimals(mint, &mint_account)?;

    let owner = operator.address();
    let operator_token_account = find_associated_token_address(&owner, mint, &TOKEN_PROGRAM_ID);
    if let Some(existing) = rpc.get_account_info(&operator_token_account).await? {
        assert_operator_token_account(&operator_token_account, &existing, mint, &owner)?;
        return Ok(PreparedGameToken { decimals, operator_token_account, creation_signature: None });
    }

    let latest = rpc.get_latest_blockhash().await?;
    let instruction = create_associated_token_account_idempotent_instruction(
        &owner,
        &operator_token_account,
        &owner,
        mint,
        &TOKEN_PROGRAM_ID,
    );
    debug_assert_eq!(instruction.program_id, ASSOCIATED_TOKEN_PROGRAM_ID);
    let (_, wire) = sign_legacy_transaction(operator, &[], &latest.blockhash, &[instruction])?;
    let signature = rpc.send_transaction(&wire).await?;
    confirm_transaction(rpc, &signature, &latest).await?;
    Ok(PreparedGameToken { decimals, operator_token_account, creation_signature: Some(signature) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mint_account(decimals: u8, initialized: u8) -> AccountInfo {
        let mut data = vec![0u8; LEGACY_MINT_ACCOUNT_SIZE];
        data[MINT_DECIMALS_OFFSET] = decimals;
        data[MINT_INITIALIZED_OFFSET] = initialized;
        AccountInfo { lamports: 1, owner: TOKEN_PROGRAM_ID, data, executable: false }
    }

    #[test]
    fn validates_mints_and_token_accounts() {
        let mint = Address::new([7; 32]);
        assert_eq!(decode_mint_decimals(&mint, &mint_account(6, 1)).unwrap(), 6);
        assert!(decode_mint_decimals(&mint, &mint_account(6, 0)).is_err());
        assert!(decode_mint_decimals(&mint, &mint_account(16, 1)).is_err());

        let owner = Address::new([9; 32]);
        let mut data = vec![0u8; LEGACY_TOKEN_ACCOUNT_SIZE];
        data[..32].copy_from_slice(mint.as_bytes());
        data[32..64].copy_from_slice(owner.as_bytes());
        data[TOKEN_ACCOUNT_STATE_OFFSET] = 1;
        let account = AccountInfo { lamports: 1, owner: TOKEN_PROGRAM_ID, data, executable: false };
        let ata = Address::new([1; 32]);
        assert_operator_token_account(&ata, &account, &mint, &owner).unwrap();
        assert!(assert_operator_token_account(&ata, &account, &owner, &owner).is_err());
    }

    use crate::solana::pool::testing::FakeTransport;
    use base64::Engine;
    use serde_json::{json, Value};
    use std::sync::Arc;

    const BLOCKHASH: &str = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";

    fn account_json(account: &AccountInfo) -> Value {
        json!({"value": {
            "data": [base64::engine::general_purpose::STANDARD.encode(&account.data), "base64"],
            "owner": account.owner.to_base58(),
            "lamports": account.lamports,
            "executable": account.executable
        }})
    }

    fn token_account(mint: &Address, owner: &Address) -> AccountInfo {
        let mut data = vec![0u8; LEGACY_TOKEN_ACCOUNT_SIZE];
        data[..32].copy_from_slice(mint.as_bytes());
        data[32..64].copy_from_slice(owner.as_bytes());
        data[TOKEN_ACCOUNT_STATE_OFFSET] = TOKEN_ACCOUNT_INITIALIZED;
        AccountInfo { lamports: 1, owner: TOKEN_PROGRAM_ID, data, executable: false }
    }

    /// Serves `accounts` by address (missing ones as null) plus a confirming
    /// submission pipeline.
    fn chain(accounts: Vec<(Address, AccountInfo)>) -> (Arc<FakeTransport>, RpcPool) {
        let transport = FakeTransport::new();
        let accounts: Vec<(String, Value)> =
            accounts.iter().map(|(a, info)| (a.to_base58(), account_json(info))).collect();
        transport.on(move |_, method, params| {
            (method == "getAccountInfo").then(|| {
                let address = params[0].as_str().unwrap();
                Ok(accounts
                    .iter()
                    .find(|(a, _)| a == address)
                    .map(|(_, v)| v.clone())
                    .unwrap_or(json!({"value": null})))
            })
        });
        transport.on(|_, method, _| match method {
            "getLatestBlockhash" => Some(Ok(json!({"value": {"blockhash": BLOCKHASH, "lastValidBlockHeight": 100}}))),
            "sendTransaction" => Some(Ok(json!("ata-sig"))),
            "getSignatureStatuses" => {
                Some(Ok(json!({"value": [{"slot": 1, "confirmationStatus": "confirmed", "err": null}]})))
            }
            "getBlockHeight" => Some(Ok(json!(1))),
            _ => None,
        });
        let pool = RpcPool::with_transport(&["https://a".into()], transport.clone()).unwrap();
        (transport, pool)
    }

    #[tokio::test]
    async fn prepares_existing_operator_accounts() {
        let operator = Keypair::generate();
        let mint = Address::new([7; 32]);
        let ata = find_associated_token_address(&operator.address(), &mint, &TOKEN_PROGRAM_ID);
        let (transport, rpc) =
            chain(vec![(mint, mint_account(6, 1)), (ata, token_account(&mint, &operator.address()))]);
        let prepared = prepare_game_token(&rpc, &operator, &mint).await.unwrap();
        assert_eq!(prepared, PreparedGameToken { decimals: 6, operator_token_account: ata, creation_signature: None });
        assert!(transport.calls_for("sendTransaction").is_empty());
    }

    #[tokio::test]
    async fn creates_missing_operator_accounts() {
        let operator = Keypair::generate();
        let mint = Address::new([7; 32]);
        let ata = find_associated_token_address(&operator.address(), &mint, &TOKEN_PROGRAM_ID);
        let (transport, rpc) = chain(vec![(mint, mint_account(9, 1))]);
        let prepared = prepare_game_token(&rpc, &operator, &mint).await.unwrap();
        assert_eq!(prepared.decimals, 9);
        assert_eq!(prepared.operator_token_account, ata);
        assert_eq!(prepared.creation_signature.as_deref(), Some("ata-sig"));

        let sent = transport.calls_for("sendTransaction");
        assert_eq!(sent.len(), 1);
        let transaction =
            timba_protocol::transaction::Transaction::from_base64(sent[0].1[0].as_str().unwrap()).unwrap();
        assert!(transaction.is_fully_signed());
        assert_eq!(transaction.signatures.len(), 1);
        assert_eq!(transaction.signatures[0].0, operator.address());
        let message = timba_protocol::transaction::LegacyMessage::deserialize(&transaction.message_bytes).unwrap();
        let instructions = message.decompile().unwrap();
        assert_eq!(instructions.len(), 1);
        assert_eq!(instructions[0].program_id, ASSOCIATED_TOKEN_PROGRAM_ID);
        assert_eq!(instructions[0].accounts[1].address, ata);
    }

    #[tokio::test]
    async fn rejects_missing_mints_and_foreign_accounts() {
        let operator = Keypair::generate();
        let mint = Address::new([7; 32]);
        let (_, rpc) = chain(vec![]);
        assert_eq!(
            prepare_game_token(&rpc, &operator, &mint).await.unwrap_err().to_string(),
            format!("Token mint does not exist: {mint}")
        );

        let (_, rpc) = chain(vec![(mint, mint_account(6, 0))]);
        assert_eq!(
            prepare_game_token(&rpc, &operator, &mint).await.unwrap_err().to_string(),
            format!("Token mint must be an initialized legacy SPL Token mint: {mint}")
        );

        let ata = find_associated_token_address(&operator.address(), &mint, &TOKEN_PROGRAM_ID);
        let stranger = Address::new([3; 32]);
        let (transport, rpc) = chain(vec![(mint, mint_account(6, 1)), (ata, token_account(&mint, &stranger))]);
        assert_eq!(
            prepare_game_token(&rpc, &operator, &mint).await.unwrap_err().to_string(),
            format!("Operator token account is invalid: {ata}")
        );
        assert!(transport.calls_for("sendTransaction").is_empty());
    }
}
