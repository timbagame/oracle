//! Validates creator-built game transactions and co-signs them as the oracle
//! operator (port of `game-transaction-signer.ts`).

use futures::future::BoxFuture;
use timba_protocol::address::{
    ASSOCIATED_TOKEN_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID,
};
use timba_protocol::contracts::{
    ata, discriminators, find_game_pda, find_game_token_pda, find_game_vault_pda, find_oracle_pda, InitializeGameArgs,
};
use timba_protocol::transaction::{LegacyMessage, Transaction, TransactionError};
use timba_protocol::{AccountMeta, Address, ContractVersion, Instruction};

use crate::solana::keypair::verify_signature;
use crate::solana::Keypair;
use crate::token::policy::RejectionCode;

const PHANTOM_LIGHTHOUSE_PROGRAM_ID: Address = Address::from_static("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
const PHANTOM_ASSERT_OWNER_PROGRAM_ID: Address = Address::from_static("DeJBGdMFa1uynnnKiwrVioatTuHmNLpyFKnmB5kaFdzQ");
const ALLOWED_SETUP_PROGRAMS: [Address; 6] = [
    ASSOCIATED_TOKEN_PROGRAM_ID,
    SYSTEM_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    COMPUTE_BUDGET_PROGRAM_ID,
    PHANTOM_LIGHTHOUSE_PROGRAM_ID,
    PHANTOM_ASSERT_OWNER_PROGRAM_ID,
];

/// A valid initialize-game transaction rejected by the creation policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreationPolicyError {
    pub code: RejectionCode,
    pub message: String,
    pub mint: Option<String>,
    pub minimum_amount_raw: Option<String>,
    pub accepted_minimum_amount_raw: Option<String>,
    pub revision: Option<i64>,
}

impl CreationPolicyError {
    pub fn new(code: RejectionCode, message: &str, mint: &str) -> Self {
        Self {
            code,
            message: message.into(),
            mint: Some(mint.into()),
            minimum_amount_raw: None,
            accepted_minimum_amount_raw: None,
            revision: None,
        }
    }

    pub fn revision(mut self, revision: i64) -> Self {
        self.revision = Some(revision);
        self
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SignError {
    /// `TransactionPolicyError`: the message is exposed to the client.
    #[error("{0}")]
    Policy(String),
    #[error("{}", .0.message)]
    Creation(CreationPolicyError),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

fn policy(message: impl Into<String>) -> SignError {
    SignError::Policy(message.into())
}

/// Oracle state consulted while signing.
pub trait SigningHooks: Send + Sync {
    fn assert_creation_policy<'a>(
        &'a self,
        token_mint: &'a Address,
        amount: u64,
    ) -> BoxFuture<'a, Result<(), SignError>>;
    fn assert_unused_commitment(&self, game: &Address, random_hash_hex: &str) -> Result<(), SignError>;
    fn mark_commitment_signed(&self, game: &Address) -> anyhow::Result<()>;
}

pub struct SignGameTransactionOptions<'a> {
    pub contract_version: ContractVersion,
    pub program_id: Address,
    pub operator: &'a Keypair,
    pub hooks: &'a dyn SigningHooks,
}

struct ExpectedMeta<'a> {
    address: Option<&'a Address>,
    signer: bool,
    writable: bool,
    message: &'a str,
}

fn assert_meta(meta: Option<&AccountMeta>, expected: ExpectedMeta<'_>) -> Result<(), SignError> {
    match meta {
        Some(meta)
            if expected.address.is_none_or(|a| *a == meta.address)
                && meta.signer == expected.signer
                && meta.writable == expected.writable =>
        {
            Ok(())
        }
        _ => Err(policy(expected.message)),
    }
}

fn meta<'a>(address: Option<&'a Address>, signer: bool, writable: bool, message: &'a str) -> ExpectedMeta<'a> {
    ExpectedMeta { address, signer, writable, message }
}

fn has_advance_nonce_instruction(instruction: Option<&Instruction>) -> bool {
    match instruction {
        Some(ix) if ix.program_id == SYSTEM_PROGRAM_ID && ix.data.len() >= 4 => {
            u32::from_le_bytes(ix.data[..4].try_into().unwrap()) == 4
        }
        _ => false,
    }
}

pub async fn sign_game_transaction_with_policy(
    tx_base64: &str,
    options: &SignGameTransactionOptions<'_>,
) -> Result<String, SignError> {
    // Decoding accepts either message version; the legacy parse below rejects v0.
    let transaction = Transaction::from_base64(tx_base64).map_err(|_| policy("Invalid transaction payload"))?;
    let message = LegacyMessage::deserialize(&transaction.message_bytes).map_err(|error| match error {
        TransactionError::UnsupportedVersion(_) => policy("Only legacy game transactions are supported"),
        _ => policy("Invalid transaction payload"),
    })?;
    let fee_payer = *message.fee_payer().ok_or_else(|| policy("Invalid transaction payload"))?;
    let instructions = message.decompile().map_err(|_| policy("Invalid transaction payload"))?;

    if has_advance_nonce_instruction(instructions.first()) {
        return Err(policy("Durable nonce transactions are not supported"));
    }

    let program_indexes: Vec<usize> =
        instructions.iter().enumerate().filter(|(_, ix)| ix.program_id == options.program_id).map(|(i, _)| i).collect();
    if program_indexes.is_empty() || program_indexes.len() > 2 {
        return Err(policy("Transaction must contain initialization and an optional creator join"));
    }

    let initialize_index = program_indexes[0];
    let initialize = &instructions[initialize_index];
    let legacy_game_token = options.contract_version == ContractVersion::V0_2_0;
    let expected_accounts = if legacy_game_token { 12 } else { 11 };
    if initialize.accounts.len() != expected_accounts || initialize.data.is_empty() {
        return Err(policy("Invalid initialize-game account list"));
    }
    if initialize.data.len() < 8 || initialize.data[..8] != discriminators::INITIALIZE_GAME {
        return Err(policy("Invalid game instruction data"));
    }
    let initialize_data =
        InitializeGameArgs::decode(&initialize.data).map_err(|_| policy("Invalid game instruction data"))?;

    let metas = &initialize.accounts;
    let offset = usize::from(legacy_game_token);
    let game = &metas[0];
    let creator = &metas[1];
    let oracle = &metas[2];
    let operator = &metas[3];
    let token_mint = &metas[4];
    let game_token = legacy_game_token.then(|| &metas[5]);
    let game_vault = &metas[5 + offset];
    let game_vault_token_account = &metas[6 + offset];
    let token_program = &metas[7 + offset];
    let associated_token_program = &metas[8 + offset];
    let creator_token_account = &metas[9 + offset];
    let system_program = &metas[10 + offset];

    assert_meta(Some(game), meta(None, false, true, "Invalid game account flags"))?;
    assert_meta(
        Some(creator),
        meta(Some(&fee_payer), true, true, "Creator must be the transaction fee payer and signer"),
    )?;
    if !operator.signer || operator.writable {
        return Err(policy("Invalid oracle operator account"));
    }
    let operator_address = options.operator.address();
    let operator_already_set = operator.address == operator_address;

    let program_id = &options.program_id;
    let expected_oracle = find_oracle_pda(program_id);
    let expected_game_token = find_game_token_pda(&token_mint.address, program_id);
    let expected_game_vault = find_game_vault_pda(&token_mint.address, program_id);
    assert_meta(Some(oracle), meta(Some(&expected_oracle), false, false, "Invalid oracle account"))?;
    assert_meta(Some(token_mint), meta(None, false, false, "Invalid token mint account flags"))?;
    if let Some(game_token) = game_token {
        assert_meta(Some(game_token), meta(Some(&expected_game_token), false, true, "Invalid game token account"))?;
    }
    assert_meta(Some(game_vault), meta(Some(&expected_game_vault), false, false, "Invalid game vault account"))?;
    if creator.address.is_off_curve() {
        return Err(SignError::Other(anyhow::anyhow!("Token owner must be on the ed25519 curve")));
    }
    let expected_vault_ata = ata(&expected_game_vault, &token_mint.address);
    let expected_creator_ata = ata(&creator.address, &token_mint.address);
    assert_meta(
        Some(game_vault_token_account),
        meta(Some(&expected_vault_ata), false, true, "Invalid game vault token account"),
    )?;
    assert_meta(Some(token_program), meta(Some(&TOKEN_PROGRAM_ID), false, false, "Invalid token program account"))?;
    assert_meta(
        Some(associated_token_program),
        meta(Some(&ASSOCIATED_TOKEN_PROGRAM_ID), false, false, "Invalid associated token program account"),
    )?;
    assert_meta(
        Some(creator_token_account),
        meta(Some(&expected_creator_ata), false, true, "Invalid creator token account"),
    )?;
    assert_meta(Some(system_program), meta(Some(&SYSTEM_PROGRAM_ID), false, false, "Invalid system program account"))?;

    let random_hash = initialize_data.random_hash;
    let expected_game = find_game_pda(&random_hash, program_id);
    if game.address != expected_game {
        return Err(policy("Game account does not match the committed random hash"));
    }
    options.hooks.assert_unused_commitment(&expected_game, &hex::encode(random_hash))?;

    let join_index = program_indexes.get(1).copied();
    if let Some(join_index) = join_index {
        if !operator_already_set {
            return Err(policy("Atomic creator join requires the creator to sign first"));
        }
        validate_creator_join(
            &instructions[join_index],
            &JoinExpectations {
                legacy_game_token,
                game: game.address,
                creator: creator.address,
                operator: operator_address,
                is_private: initialize_data.is_private,
                token_mint: token_mint.address,
                game_token: expected_game_token,
                game_vault: expected_game_vault,
                game_vault_token_account: expected_vault_ata,
                creator_token_account: expected_creator_ata,
                oracle: expected_oracle,
                program_id: *program_id,
            },
        )?;
    }

    for (index, instruction) in instructions.iter().enumerate() {
        if index == initialize_index || Some(index) == join_index {
            continue;
        }
        if !ALLOWED_SETUP_PROGRAMS.contains(&instruction.program_id) {
            return Err(policy(format!(
                "Unsupported setup instruction in game transaction: {}",
                instruction.program_id
            )));
        }
        if instruction.accounts.iter().any(|m| m.address == operator_address) {
            return Err(policy("Oracle operator cannot be referenced by setup instructions"));
        }
    }

    if operator_already_set {
        let valid = transaction
            .signature_of(&creator.address)
            .is_some_and(|signature| verify_signature(&creator.address, &transaction.message_bytes, signature));
        if !valid {
            return Err(policy("Creator signature is missing or invalid"));
        }
    }
    if !legacy_game_token {
        options.hooks.assert_creation_policy(&token_mint.address, initialize_data.amount).await?;
    }

    let mut to_sign = if operator_already_set {
        transaction
    } else {
        let mut replaced = instructions.clone();
        replaced[initialize_index].accounts[3].address = operator_address;
        let compiled = LegacyMessage::compile(&fee_payer, &message.recent_blockhash, &replaced)
            .map_err(|error| SignError::Other(anyhow::anyhow!("{error}")))?;
        Transaction::from_message(&compiled)
    };
    // Reserve retention before signing; cleanup must not remove this secret.
    options.hooks.mark_commitment_signed(&expected_game)?;
    let signature = options.operator.sign(&to_sign.message_bytes);
    to_sign
        .set_signature(&operator_address, signature)
        .map_err(|error| SignError::Other(anyhow::anyhow!("{error}")))?;
    // Recheck eligibility in case finalization raced with the signature.
    options.hooks.mark_commitment_signed(&expected_game)?;
    Ok(to_sign.to_base64())
}

struct JoinExpectations {
    legacy_game_token: bool,
    game: Address,
    creator: Address,
    operator: Address,
    is_private: bool,
    token_mint: Address,
    game_token: Address,
    game_vault: Address,
    game_vault_token_account: Address,
    creator_token_account: Address,
    oracle: Address,
    program_id: Address,
}

fn validate_creator_join(join: &Instruction, v: &JoinExpectations) -> Result<(), SignError> {
    let expected_accounts = if v.legacy_game_token { 11 } else { 10 };
    if join.accounts.len() != expected_accounts || join.data.is_empty() {
        return Err(policy("Invalid creator join instruction"));
    }
    if join.data.len() < 8 || join.data[..8] != discriminators::JOIN_GAME {
        return Err(policy("Invalid creator join instruction"));
    }
    let m = |i: usize| join.accounts.get(i);
    let offset = usize::from(v.legacy_game_token);
    assert_meta(m(0), meta(Some(&v.game), false, true, "Creator join uses an invalid game account"))?;
    assert_meta(m(1), meta(Some(&v.creator), true, true, "Creator join uses an invalid creator account"))?;
    let optional_operator = if v.is_private { &v.operator } else { &v.program_id };
    assert_meta(
        m(2),
        meta(Some(optional_operator), v.is_private, false, "Creator join uses an invalid optional oracle operator"),
    )?;
    assert_meta(
        m(3),
        meta(Some(&v.token_mint), false, false, "Creator join token mint does not match initialization"),
    )?;
    if v.legacy_game_token {
        assert_meta(m(4), meta(Some(&v.game_token), false, true, "Creator join uses an invalid game token"))?;
    }
    assert_meta(m(4 + offset), meta(Some(&v.game_vault), false, false, "Creator join uses an invalid game vault"))?;
    assert_meta(
        m(5 + offset),
        meta(Some(&v.game_vault_token_account), false, true, "Creator join uses an invalid game vault token account"),
    )?;
    assert_meta(
        m(6 + offset),
        meta(Some(&TOKEN_PROGRAM_ID), false, false, "Creator join uses an invalid token program"),
    )?;
    assert_meta(
        m(7 + offset),
        meta(Some(&ASSOCIATED_TOKEN_PROGRAM_ID), false, false, "Creator join uses an invalid associated token program"),
    )?;
    assert_meta(
        m(8 + offset),
        meta(Some(&v.creator_token_account), false, true, "Creator join uses an invalid player token account"),
    )?;
    assert_meta(m(9 + offset), meta(Some(&v.oracle), false, false, "Creator join uses an invalid oracle account"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::FutureExt;
    use serde_json::Value;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Recorder {
        marks: Mutex<Vec<String>>,
        unused: Mutex<Vec<(String, String)>>,
        policy: Mutex<Vec<(String, String)>>,
        reused: bool,
        rejected: bool,
        /// Fails the n-th `mark_commitment_signed` call (1-based).
        fail_mark: Option<usize>,
    }

    impl SigningHooks for Recorder {
        fn assert_creation_policy<'a>(
            &'a self,
            mint: &'a Address,
            amount: u64,
        ) -> BoxFuture<'a, Result<(), SignError>> {
            self.policy.lock().unwrap().push((mint.to_base58(), amount.to_string()));
            let result = if self.rejected {
                let error = CreationPolicyError::new(RejectionCode::AmountBelowMinimum, "Amount is too low", "mint");
                Err(SignError::Creation(error))
            } else {
                Ok(())
            };
            async move { result }.boxed()
        }
        fn assert_unused_commitment(&self, game: &Address, hash: &str) -> Result<(), SignError> {
            self.unused.lock().unwrap().push((game.to_base58(), hash.to_string()));
            if self.reused {
                return Err(policy("Game commitment has already been used"));
            }
            Ok(())
        }
        fn mark_commitment_signed(&self, game: &Address) -> anyhow::Result<()> {
            let mut marks = self.marks.lock().unwrap();
            marks.push(game.to_base58());
            if self.fail_mark == Some(marks.len()) {
                anyhow::bail!("Game was finalized while signing");
            }
            Ok(())
        }
    }

    fn fixture() -> (Value, Keypair) {
        let fixture: Value = serde_json::from_str(include_str!("../../tests/fixtures/signer.json")).unwrap();
        let bytes: Vec<u8> =
            fixture["operatorKeypair"].as_array().unwrap().iter().map(|b| b.as_u64().unwrap() as u8).collect();
        let operator = Keypair::from_bytes(&bytes).unwrap();
        (fixture, operator)
    }

    /// Signs the fixture case `name` (a v0.3.0 transaction the TypeScript signer accepted) with `hooks`.
    async fn sign_case(name: &str, hooks: &Recorder) -> Result<String, SignError> {
        let (fixture, operator) = fixture();
        let case = fixture["cases"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap();
        assert!(case["expected"].get("ok").is_some(), "{name} must be a signable case");
        let options = SignGameTransactionOptions {
            contract_version: ContractVersion::V0_3_0,
            program_id: timba_protocol::contracts::PROGRAM_ID,
            operator: &operator,
            hooks,
        };
        sign_game_transaction_with_policy(case["txBase64"].as_str().unwrap(), &options).await
    }

    #[tokio::test]
    async fn hook_rejections_stop_signing() {
        let reused = Recorder { reused: true, ..Default::default() };
        let err = sign_case("0.3.0 placeholder", &reused).await.unwrap_err();
        assert_eq!(err.to_string(), "Game commitment has already been used");
        assert!(reused.marks.lock().unwrap().is_empty() && reused.policy.lock().unwrap().is_empty());

        let rejected = Recorder { rejected: true, ..Default::default() };
        let err = sign_case("0.3.0 placeholder", &rejected).await.unwrap_err();
        assert!(matches!(&err, SignError::Creation(e) if e.code == RejectionCode::AmountBelowMinimum), "{err:?}");
        assert!(rejected.marks.lock().unwrap().is_empty(), "nothing is reserved for a rejected game");

        for call in [1, 2] {
            let racing = Recorder { fail_mark: Some(call), ..Default::default() };
            let err = sign_case("0.3.0 creator-signed join", &racing).await.unwrap_err();
            assert!(matches!(&err, SignError::Other(e) if e.to_string() == "Game was finalized while signing"));
            assert_eq!(racing.marks.lock().unwrap().len(), call, "stops at the failing reservation");
        }
    }

    fn pairs(value: &Value) -> Vec<(String, String)> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|p| (p[0].as_str().unwrap().to_string(), p[1].as_str().unwrap().to_string()))
            .collect()
    }

    /// Differential cases generated by running the TypeScript signer.
    #[tokio::test]
    async fn matches_typescript_signer() {
        let (fixture, operator) = fixture();
        for case in fixture["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let hooks = Recorder::default();
            let options = SignGameTransactionOptions {
                contract_version: case["version"].as_str().unwrap().parse().unwrap(),
                program_id: timba_protocol::contracts::PROGRAM_ID,
                operator: &operator,
                hooks: &hooks,
            };
            let result = sign_game_transaction_with_policy(case["txBase64"].as_str().unwrap(), &options).await;
            let expected = &case["expected"];
            match (result, expected.get("ok")) {
                (Ok(signed), Some(ok)) => assert_eq!(signed, ok.as_str().unwrap(), "{name}"),
                (Err(error), None) => {
                    let is_policy = matches!(error, SignError::Policy(_));
                    assert_eq!(is_policy, expected["policy"].as_bool().unwrap(), "{name}: {error}");
                    if is_policy {
                        assert_eq!(error.to_string(), expected["error"].as_str().unwrap(), "{name}");
                    }
                }
                (result, _) => panic!("{name}: unexpected {result:?}"),
            }
            let marks: Vec<String> =
                case["marks"].as_array().unwrap().iter().map(|m| m.as_str().unwrap().to_string()).collect();
            assert_eq!(*hooks.marks.lock().unwrap(), marks, "{name}");
            assert_eq!(*hooks.unused.lock().unwrap(), pairs(&case["unused"]), "{name}");
            assert_eq!(*hooks.policy.lock().unwrap(), pairs(&case["policy"]), "{name}");
        }
    }
}
