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
}
