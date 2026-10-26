//! Validates creator-built game transactions and co-signs them as the oracle
//! operator (port of `game-transaction-signer.ts`).

use futures::future::BoxFuture;
use timba_protocol::address::{
    ASSOCIATED_TOKEN_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID,
};
use timba_protocol::contracts::{
    ata, create_game_account_count, discriminators, find_game_pda, find_game_token_pda, find_game_vault_pda,
    find_oracle_pda, join_game_account_count, CreateGameArgs,
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
    let version = options.contract_version;
    // v0.2 adds the game token account after the mint and the associated token program.
    let legacy = version == ContractVersion::V0_2_0;
    if initialize.accounts.len() != create_game_account_count(version) || initialize.data.is_empty() {
        return Err(policy("Invalid initialize-game account list"));
    }
    if initialize.data.len() < 8 || initialize.data[..8] != discriminators::create_game(version) {
        return Err(policy("Invalid game instruction data"));
    }
    let initialize_data =
        CreateGameArgs::decode(&initialize.data).map_err(|_| policy("Invalid game instruction data"))?;

    let mut metas = initialize.accounts.iter();
    let mut next = || metas.next().expect("account count checked");
    let game = next();
    let creator = next();
    let oracle = next();
    let operator = next();
    let token_mint = next();
    let game_token = legacy.then(&mut next);
    let game_vault = next();
    let game_vault_token_account = next();
    let token_program = next();
    let associated_token_program = legacy.then(&mut next);
    let creator_token_account = next();
    let system_program = next();

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
    if let Some(associated_token_program) = associated_token_program {
        assert_meta(
            Some(associated_token_program),
            meta(Some(&ASSOCIATED_TOKEN_PROGRAM_ID), false, false, "Invalid associated token program account"),
        )?;
    }
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
                version,
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
    if !legacy {
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
    version: ContractVersion,
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
    if join.accounts.len() != join_game_account_count(v.version) || join.data.is_empty() {
        return Err(policy("Invalid creator join instruction"));
    }
    if join.data.len() < 8 || join.data[..8] != discriminators::JOIN_GAME {
        return Err(policy("Invalid creator join instruction"));
    }
    let legacy = v.version == ContractVersion::V0_2_0;
    let mut metas = join.accounts.iter();
    let mut next = || metas.next();
    assert_meta(next(), meta(Some(&v.game), false, true, "Creator join uses an invalid game account"))?;
    // The creator pays the fee, so the compiled message always marks it writable.
    assert_meta(next(), meta(Some(&v.creator), true, true, "Creator join uses an invalid creator account"))?;
    let optional_operator = if v.is_private { &v.operator } else { &v.program_id };
    assert_meta(
        next(),
        meta(Some(optional_operator), v.is_private, false, "Creator join uses an invalid optional oracle operator"),
    )?;
    assert_meta(
        next(),
        meta(Some(&v.token_mint), false, false, "Creator join token mint does not match initialization"),
    )?;
    if legacy {
        assert_meta(next(), meta(Some(&v.game_token), false, true, "Creator join uses an invalid game token"))?;
    }
    assert_meta(next(), meta(Some(&v.game_vault), false, false, "Creator join uses an invalid game vault"))?;
    assert_meta(
        next(),
        meta(Some(&v.game_vault_token_account), false, true, "Creator join uses an invalid game vault token account"),
    )?;
    assert_meta(next(), meta(Some(&TOKEN_PROGRAM_ID), false, false, "Creator join uses an invalid token program"))?;
    if legacy {
        assert_meta(
            next(),
            meta(
                Some(&ASSOCIATED_TOKEN_PROGRAM_ID),
                false,
                false,
                "Creator join uses an invalid associated token program",
            ),
        )?;
    }
    assert_meta(
        next(),
        meta(Some(&v.creator_token_account), false, true, "Creator join uses an invalid player token account"),
    )?;
    assert_meta(next(), meta(Some(&v.oracle), false, false, "Creator join uses an invalid oracle account"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::signer_scenarios::{compute_budget, signer, swap, Options, Scenario, RANDOM_HASH};
    use futures::FutureExt;
    use serde_json::Value;
    use std::sync::Mutex;
    use timba_protocol::contracts::{PROGRAM_ID, SUPPORTED_CONTRACT_VERSIONS};

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

    fn options<'a>(
        version: ContractVersion,
        operator: &'a Keypair,
        hooks: &'a Recorder,
    ) -> SignGameTransactionOptions<'a> {
        SignGameTransactionOptions { contract_version: version, program_id: PROGRAM_ID, operator, hooks }
    }

    struct Case {
        name: String,
        tx: String,
        /// Policy error, or `None` when the transaction is signed.
        error: Option<String>,
        /// Whether the commitment was checked before the rejection.
        unused: bool,
    }

    /// Every creation the signer accepts or rejects, for one contract version.
    fn cases(version: ContractVersion) -> Vec<Case> {
        let legacy = version == ContractVersion::V0_2_0;
        let at = |v2: usize, v3: usize| if legacy { v2 } else { v3 };
        let mut cases = Vec::new();
        let mut add = |label: &str, tx: String, error: Option<&str>, unused: bool| {
            cases.push(Case { name: format!("{version} {label}"), tx, error: error.map(str::to_owned), unused });
        };
        let s = Scenario::new(version, Options::default());
        let placeholder = Scenario::new(version, Options { placeholder: true, ..Default::default() });
        let private = Scenario::new(version, Options { is_private: true, ..Default::default() });
        let (init, join) = (&s.initialize, &s.join);

        add(
            "creator-signed join",
            s.tx(&[compute_budget(), s.setup_ata(), init.clone(), join.clone()], true),
            None,
            true,
        );
        add(
            "placeholder",
            placeholder.tx(&[compute_budget(), placeholder.setup_ata(), placeholder.initialize.clone()], false),
            None,
            true,
        );
        add(
            "placeholder join",
            placeholder.tx(&[placeholder.initialize.clone(), placeholder.join.clone()], false),
            Some("Atomic creator join requires the creator to sign first"),
            true,
        );
        add("private join", private.tx(&[private.initialize.clone(), private.join.clone()], true), None, true);

        add(
            "missing creator signature",
            s.tx(std::slice::from_ref(init), false),
            Some("Creator signature is missing or invalid"),
            true,
        );
        let stake = Address::from_static("Stake11111111111111111111111111111111111111");
        add(
            "foreign setup program",
            s.tx(&[Instruction { program_id: stake, accounts: vec![], data: vec![1] }, init.clone()], true),
            Some(&format!("Unsupported setup instruction in game transaction: {stake}")),
            true,
        );
        let transfer = |operator: AccountMeta| Instruction {
            program_id: SYSTEM_PROGRAM_ID,
            accounts: vec![AccountMeta::writable_signer(s.creator_address), operator],
            data: vec![2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
        };
        // A writable reference merges into the operator's initialize meta and fails that check first.
        add(
            "setup marks operator writable",
            s.tx(&[transfer(AccountMeta::writable(s.operator.address())), init.clone()], true),
            Some("Invalid oracle operator account"),
            false,
        );
        add(
            "setup references operator",
            s.tx(&[transfer(AccountMeta::readonly(s.operator.address())), init.clone()], true),
            Some("Oracle operator cannot be referenced by setup instructions"),
            true,
        );
        let nonce = Instruction {
            program_id: SYSTEM_PROGRAM_ID,
            accounts: vec![AccountMeta::writable_signer(s.creator_address)],
            data: vec![4, 0, 0, 0],
        };
        add(
            "durable nonce",
            s.tx(&[nonce, init.clone()], true),
            Some("Durable nonce transactions are not supported"),
            false,
        );
        let shape = Some("Transaction must contain initialization and an optional creator join");
        add("no game instruction", s.tx(&[compute_budget()], true), shape, false);
        add("three game instructions", s.tx(&[init.clone(), join.clone(), join.clone()], true), shape, false);

        let mut short_list = init.clone();
        short_list.accounts.pop();
        add("wrong account count", s.tx(&[short_list], true), Some("Invalid initialize-game account list"), false);
        let mut foreign = init.clone();
        foreign.data[..8].copy_from_slice(&discriminators::JOIN_GAME);
        add("foreign discriminator", s.tx(&[foreign], true), Some("Invalid game instruction data"), false);
        let mut short_data = init.clone();
        short_data.data.truncate(20);
        add("short data", s.tx(&[short_data], true), Some("Invalid game instruction data"), false);
        let mut writable_operator = init.clone();
        writable_operator.accounts[3].writable = true;
        add("writable operator", s.tx(&[writable_operator], true), Some("Invalid oracle operator account"), false);
        add(
            "wrong vault",
            s.tx(&[swap(init, at(6, 5), s.token_mint)], true),
            Some("Invalid game vault account"),
            false,
        );
        let other = if legacy { ContractVersion::V0_3_0 } else { ContractVersion::V0_2_0 };
        let other = Scenario::new(other, Options::default());
        add(
            "version mismatch",
            other.tx(std::slice::from_ref(&other.initialize), true),
            Some("Invalid initialize-game account list"),
            false,
        );

        let mut short_join = join.clone();
        short_join.accounts.pop();
        add("bad join count", s.tx(&[init.clone(), short_join], true), Some("Invalid creator join instruction"), true);
        let mut foreign_join = join.clone();
        foreign_join.data = init.data[..8].to_vec();
        add(
            "join foreign discriminator",
            s.tx(&[init.clone(), foreign_join], true),
            Some("Invalid creator join instruction"),
            true,
        );
        add(
            "fee payer differs",
            s.finish(s.message(std::slice::from_ref(init), Some(s.operator.address())), false),
            Some("Creator must be the transaction fee payer and signer"),
            false,
        );
        add(
            "versioned transaction",
            s.versioned_tx(std::slice::from_ref(init)),
            Some("Only legacy game transactions are supported"),
            false,
        );

        // Every account the signer pins, swapped for an unrelated address.
        let stranger = signer(20).address();
        let mut pinned = vec![
            (0, "game", "Game account does not match the committed random hash"),
            (2, "oracle", "Invalid oracle account"),
            (at(7, 6), "vault token account", "Invalid game vault token account"),
            (at(8, 7), "token program", "Invalid token program account"),
            (at(10, 8), "creator token account", "Invalid creator token account"),
            (at(11, 9), "system program", "Invalid system program account"),
        ];
        if legacy {
            pinned.push((5, "game token", "Invalid game token account"));
            pinned.push((9, "associated token program", "Invalid associated token program account"));
        }
        for (index, label, error) in pinned {
            add(
                &format!("initialize with wrong {label}"),
                s.tx(&[swap(init, index, stranger)], true),
                Some(error),
                false,
            );
        }
        let mut pinned = vec![
            (0, "game", "Creator join uses an invalid game account"),
            (1, "creator", "Creator join uses an invalid creator account"),
            (2, "optional operator", "Creator join uses an invalid optional oracle operator"),
            (3, "mint", "Creator join token mint does not match initialization"),
            (at(5, 4), "vault", "Creator join uses an invalid game vault"),
            (at(6, 5), "vault token account", "Creator join uses an invalid game vault token account"),
            (at(7, 6), "token program", "Creator join uses an invalid token program"),
            (at(9, 7), "player token account", "Creator join uses an invalid player token account"),
            (at(10, 8), "oracle", "Creator join uses an invalid oracle account"),
        ];
        if legacy {
            pinned.push((4, "game token", "Creator join uses an invalid game token"));
            pinned.push((8, "associated token program", "Creator join uses an invalid associated token program"));
        }
        for (index, label, error) in pinned {
            add(
                &format!("join with wrong {label}"),
                s.tx(&[init.clone(), swap(join, index, stranger)], true),
                Some(error),
                true,
            );
        }
        cases
    }

    #[tokio::test]
    async fn enforces_the_creation_policy_for_each_version() {
        for version in SUPPORTED_CONTRACT_VERSIONS {
            let scenario = Scenario::new(version, Options::default());
            for case in cases(version) {
                let name = &case.name;
                let hooks = Recorder::default();
                let result =
                    sign_game_transaction_with_policy(&case.tx, &options(version, &scenario.operator, &hooks)).await;
                let signed = match (&result, &case.error) {
                    (Ok(signed), None) => Some(signed),
                    (Err(SignError::Policy(message)), Some(expected)) => {
                        assert_eq!(message, expected, "{name}");
                        None
                    }
                    (result, _) => panic!("{name}: unexpected {result:?}"),
                };
                let game = scenario.game.to_base58();
                let unused = if case.unused { vec![(game.clone(), hex::encode(RANDOM_HASH))] } else { vec![] };
                assert_eq!(*hooks.unused.lock().unwrap(), unused, "{name}");
                let marks = if signed.is_some() { vec![game.clone(), game] } else { vec![] };
                assert_eq!(*hooks.marks.lock().unwrap(), marks, "{name}");
                // Only v0.3 enforces the oracle token policy.
                let policy = if signed.is_some() && version == ContractVersion::V0_3_0 {
                    vec![(scenario.token_mint.to_base58(), "250".to_string())]
                } else {
                    vec![]
                };
                assert_eq!(*hooks.policy.lock().unwrap(), policy, "{name}");
                if let Some(signed) = signed {
                    let signed = Transaction::from_base64(signed).unwrap();
                    let message = LegacyMessage::deserialize(&signed.message_bytes).unwrap();
                    let instructions = message.decompile().unwrap();
                    let create = instructions.iter().find(|ix| ix.program_id == PROGRAM_ID).unwrap();
                    assert_eq!(create.accounts[3].address, scenario.operator.address(), "{name}");
                    let verifies = |key: Address| {
                        signed.signature_of(&key).is_some_and(|sig| verify_signature(&key, &signed.message_bytes, sig))
                    };
                    assert!(verifies(scenario.operator.address()), "{name}");
                    // Placeholder creations go back to the creator to sign last.
                    let creator_signed = !name.ends_with(" placeholder");
                    assert_eq!(verifies(scenario.creator.address()), creator_signed, "{name}");
                }
            }
        }
    }

    #[tokio::test]
    async fn rejects_creators_off_the_curve() {
        for version in SUPPORTED_CONTRACT_VERSIONS {
            let s =
                Scenario::new(version, Options { creator_off_curve: true, placeholder: true, ..Default::default() });
            let hooks = Recorder::default();
            let err = sign_game_transaction_with_policy(
                &s.tx(std::slice::from_ref(&s.initialize), false),
                &options(version, &s.operator, &hooks),
            )
            .await
            .unwrap_err();
            assert!(matches!(err, SignError::Other(_)), "{err:?}");
            assert!(hooks.unused.lock().unwrap().is_empty());
        }
    }

    /// The scenarios rebuild the TypeScript generator's v0.2 transactions byte for byte.
    #[test]
    fn scenarios_match_the_typescript_generator() {
        let (fixture, _) = fixture();
        let mut matched = 0;
        for case in cases(ContractVersion::V0_2_0) {
            let Some(expected) = fixture["cases"].as_array().unwrap().iter().find(|c| c["name"] == case.name) else {
                continue;
            };
            assert_eq!(case.tx, expected["txBase64"].as_str().unwrap(), "{}", case.name);
            matched += 1;
        }
        assert_eq!(matched, 6);
    }

    async fn sign_scenario(scenario: Options, join: bool, hooks: &Recorder) -> Result<String, SignError> {
        let s = Scenario::new(ContractVersion::V0_3_0, scenario);
        let mut instructions = vec![s.initialize.clone()];
        if join {
            instructions.push(s.join.clone());
        }
        let tx = s.tx(&instructions, !scenario.placeholder);
        sign_game_transaction_with_policy(&tx, &options(ContractVersion::V0_3_0, &s.operator, hooks)).await
    }

    #[tokio::test]
    async fn rejects_a_legacy_message_cut_off_after_its_signers() {
        // One empty signature, then a header and account key but no blockhash or instructions.
        let mut bytes = vec![1u8];
        bytes.extend([0u8; 64]);
        bytes.extend([1u8, 0, 0, 1]);
        bytes.extend([4u8; 32]);
        let (_, operator) = fixture();
        let hooks = Recorder::default();
        let options = SignGameTransactionOptions {
            contract_version: ContractVersion::V0_3_0,
            program_id: PROGRAM_ID,
            operator: &operator,
            hooks: &hooks,
        };
        let tx = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes);
        let err = sign_game_transaction_with_policy(&tx, &options).await.unwrap_err();
        assert_eq!(err.to_string(), "Invalid transaction payload");
    }

    #[tokio::test]
    async fn hook_rejections_stop_signing() {
        let placeholder = Options { placeholder: true, ..Default::default() };
        let reused = Recorder { reused: true, ..Default::default() };
        let err = sign_scenario(placeholder, false, &reused).await.unwrap_err();
        assert_eq!(err.to_string(), "Game commitment has already been used");
        assert!(reused.marks.lock().unwrap().is_empty() && reused.policy.lock().unwrap().is_empty());

        let rejected = Recorder { rejected: true, ..Default::default() };
        let err = sign_scenario(placeholder, false, &rejected).await.unwrap_err();
        assert!(matches!(&err, SignError::Creation(e) if e.code == RejectionCode::AmountBelowMinimum), "{err:?}");
        assert!(rejected.marks.lock().unwrap().is_empty(), "nothing is reserved for a rejected game");

        for call in [1, 2] {
            let racing = Recorder { fail_mark: Some(call), ..Default::default() };
            let err = sign_scenario(Options::default(), true, &racing).await.unwrap_err();
            assert!(
                matches!(&err, SignError::Other(e) if e.to_string() == "Game was finalized while signing"),
                "{err:?}"
            );
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

    /// Differential cases generated by running the TypeScript signer. Its v0.3
    /// cases predate the v0.3 renames, so only v0.2 behavior is compared.
    #[tokio::test]
    async fn matches_typescript_signer() {
        let (fixture, operator) = fixture();
        for case in fixture["cases"].as_array().unwrap().iter().filter(|c| c["version"] == "0.2.0") {
            let name = case["name"].as_str().unwrap();
            let hooks = Recorder::default();
            let options = SignGameTransactionOptions {
                contract_version: case["version"].as_str().unwrap().parse().unwrap(),
                program_id: PROGRAM_ID,
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
