//! Creator-built game transactions for signer tests, mirroring
//! `tests/fixtures/generators/signer.mjs` with the protocol crate's builders.

use base64::Engine;
use timba_protocol::address::{
    ASSOCIATED_TOKEN_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID,
};
use timba_protocol::contracts::{
    ata, create_game_instruction, find_game_pda, find_game_token_pda, join_game_instruction, CreateGameAccounts,
    CreateGameArgs, GameType, JoinGameAccounts, PROGRAM_ID,
};
use timba_protocol::transaction::{encode_short_u16, LegacyMessage, Transaction};
use timba_protocol::{AccountMeta, Address, ContractVersion, Instruction};

use crate::solana::Keypair;

const BLOCKHASH: Address = Address::from_static("4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM");
pub const RANDOM_HASH: [u8; 32] = {
    let mut hash = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        hash[i] = i as u8 + 1;
        i += 1;
    }
    hash
};

/// The generator's deterministic key `n`.
pub fn signer(n: u8) -> Keypair {
    Keypair::from_seed(std::array::from_fn(|i| (i as u8).wrapping_mul(7).wrapping_add(n)))
}

#[derive(Default, Clone, Copy)]
pub struct Options {
    pub is_private: bool,
    pub placeholder: bool,
    pub creator_off_curve: bool,
}

pub struct Scenario {
    pub version: ContractVersion,
    pub creator: Keypair,
    pub operator: Keypair,
    pub creator_address: Address,
    pub token_mint: Address,
    pub game: Address,
    pub initialize: Instruction,
    pub join: Instruction,
}

impl Scenario {
    pub fn new(version: ContractVersion, options: Options) -> Self {
        let (creator, operator, placeholder) = (signer(1), signer(2), signer(3));
        let token_mint = signer(4).address();
        let creator_address = if options.creator_off_curve {
            find_game_token_pda(&signer(9).address(), &PROGRAM_ID)
        } else {
            creator.address()
        };
        let game = find_game_pda(&RANDOM_HASH, &PROGRAM_ID);
        let creator_token_account = ata(&creator_address, &token_mint);
        let initialize = create_game_instruction(
            version,
            &CreateGameAccounts {
                game,
                creator: creator_address,
                oracle_operator: if options.placeholder { placeholder.address() } else { operator.address() },
                token_mint,
                creator_token_account,
            },
            &CreateGameArgs {
                game_type: GameType::Coinflip,
                amount: 250,
                max_tickets: 2,
                min_tickets: 2,
                timeout: 60,
                is_private: options.is_private,
                random_hash: RANDOM_HASH,
            },
            &PROGRAM_ID,
        );
        let join = join_game_instruction(
            version,
            &JoinGameAccounts {
                game,
                player: creator_address,
                oracle_operator: options.is_private.then(|| operator.address()),
                token_mint,
                player_token_account: creator_token_account,
            },
            &PROGRAM_ID,
        );
        Self { version, creator, operator, creator_address, token_mint, game, initialize, join }
    }

    /// Idempotent creation of the creator's token account.
    pub fn setup_ata(&self) -> Instruction {
        let creator_token_account = self.initialize.accounts[self.initialize.accounts.len() - 2].address;
        Instruction {
            program_id: ASSOCIATED_TOKEN_PROGRAM_ID,
            accounts: vec![
                AccountMeta::writable_signer(self.creator_address),
                AccountMeta::writable(creator_token_account),
                AccountMeta::readonly(self.creator_address),
                AccountMeta::readonly(self.token_mint),
                AccountMeta::readonly(SYSTEM_PROGRAM_ID),
                AccountMeta::readonly(TOKEN_PROGRAM_ID),
            ],
            data: vec![1],
        }
    }

    pub fn message(&self, instructions: &[Instruction], fee_payer: Option<Address>) -> LegacyMessage {
        LegacyMessage::compile(&fee_payer.unwrap_or(self.creator_address), &BLOCKHASH, instructions).unwrap()
    }

    /// Base64 wire transaction, optionally signed by the creator.
    pub fn tx(&self, instructions: &[Instruction], sign: bool) -> String {
        self.finish(self.message(instructions, None), sign)
    }

    pub fn finish(&self, message: LegacyMessage, sign: bool) -> String {
        let mut transaction = Transaction::from_message(&message);
        if sign {
            let signature = self.creator.sign(&transaction.message_bytes);
            transaction.set_signature(&self.creator_address, signature).unwrap();
        }
        transaction.to_base64()
    }

    /// The same message as a v0 transaction with no lookup tables.
    pub fn versioned_tx(&self, instructions: &[Instruction]) -> String {
        let legacy = self.message(instructions, None).serialize();
        let mut message = vec![0x80];
        message.extend(legacy);
        message.push(0);
        let mut bytes = Vec::new();
        encode_short_u16(&mut bytes, usize::from(message[1]));
        for _ in 0..message[1] {
            bytes.extend([0u8; 64]);
        }
        bytes.extend(message);
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }
}

pub fn compute_budget() -> Instruction {
    Instruction { program_id: COMPUTE_BUDGET_PROGRAM_ID, accounts: vec![], data: vec![2, 64, 66, 15, 0] }
}

pub fn swap(instruction: &Instruction, index: usize, address: Address) -> Instruction {
    let mut swapped = instruction.clone();
    swapped.accounts[index].address = address;
    swapped
}
