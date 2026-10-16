//! Port of `@timbagame/protocol/solana/plans`: token program helpers, wrapped
//! SOL, the contract adapter and the create-game plan.

use serde::{Deserialize, Serialize};

use crate::address::{
    find_associated_token_address, ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, WRAPPED_SOL_MINT,
};
use crate::codec::DecodeError;
use crate::contracts::{
    self, find_game_pda, find_game_vault_pda, ContractVersion, GameAccount, GameType, InitializeGameAccounts,
    InitializeGameArgs,
};
use crate::instruction::{AccountMeta, Instruction};
use crate::Address;

pub const NATIVE_MINT: Address = WRAPPED_SOL_MINT;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PlanError {
    #[error("TokenOwnerOffCurveError")]
    TokenOwnerOffCurve,
    #[error("{0}")]
    Invalid(String),
}

pub fn get_associated_token_address(
    mint: &Address,
    owner: &Address,
    allow_owner_off_curve: bool,
) -> Result<Address, PlanError> {
    if !allow_owner_off_curve && owner.is_off_curve() {
        return Err(PlanError::TokenOwnerOffCurve);
    }
    Ok(find_associated_token_address(owner, mint, &TOKEN_PROGRAM_ID))
}

pub fn create_associated_token_account_idempotent_instruction(
    payer: &Address,
    associated_token: &Address,
    owner: &Address,
    mint: &Address,
    token_program: &Address,
) -> Instruction {
    Instruction {
        program_id: ASSOCIATED_TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::writable_signer(*payer),
            AccountMeta::writable(*associated_token),
            AccountMeta::readonly(*owner),
            AccountMeta::readonly(*mint),
            AccountMeta::readonly(SYSTEM_PROGRAM_ID),
            AccountMeta::readonly(*token_program),
        ],
        data: vec![1],
    }
}

pub const SYSVAR_RENT_ID: Address = Address::from_static("SysvarRent111111111111111111111111111111111");

/// `@solana-program/token` fills the optional rent sysvar account by default.
pub fn create_sync_native_instruction(account: &Address) -> Instruction {
    Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![AccountMeta::writable(*account), AccountMeta::readonly(SYSVAR_RENT_ID)],
        data: vec![17],
    }
}

pub fn transfer_sol_instruction(source: &Address, destination: &Address, lamports: u64) -> Instruction {
    let mut data = 2u32.to_le_bytes().to_vec();
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction {
        program_id: SYSTEM_PROGRAM_ID,
        accounts: vec![AccountMeta::writable_signer(*source), AccountMeta::writable(*destination)],
        data,
    }
}

pub fn is_wrapped_sol(mint: &Address) -> bool {
    mint == &NATIVE_MINT
}

pub fn build_wrap_sol_instructions(owner: &Address, amount: u64) -> Result<(Address, Vec<Instruction>), PlanError> {
    if amount == 0 {
        return Err(PlanError::Invalid("SOL amount must be positive".into()));
    }
    let token_account = get_associated_token_address(&NATIVE_MINT, owner, false)?;
    Ok((
        token_account,
        vec![
            create_associated_token_account_idempotent_instruction(
                owner,
                &token_account,
                owner,
                &NATIVE_MINT,
                &TOKEN_PROGRAM_ID,
            ),
            transfer_sol_instruction(owner, &token_account, amount),
            create_sync_native_instruction(&token_account),
        ],
    ))
}

/// UI-facing view of a game account (`TimbaGameAccount`).
#[derive(Debug, Clone, PartialEq)]
pub struct TimbaGameAccount {
    pub address: String,
    pub creator: String,
    pub game_type: GameType,
    pub token_mint: String,
    pub stake_amount: u64,
    pub prize_amount: u64,
    pub current_players: u32,
    pub min_players: u32,
    pub max_players: u32,
    pub is_private: bool,
    pub created_at: i64,
    pub expires_at: i64,
    pub creation_signature: String,
    pub last_slot: u64,
    pub participant_addresses: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerializedTimbaGameAccount {
    pub address: String,
    pub creator: String,
    #[serde(rename = "type")]
    pub game_type: String,
    pub token_mint: String,
    pub stake_amount: String,
    pub prize_amount: String,
    pub current_players: u32,
    pub min_players: u32,
    pub max_players: u32,
    pub is_private: bool,
    pub created_at: i64,
    pub expires_at: i64,
    pub last_slot: String,
    pub participant_addresses: Vec<String>,
}

pub fn map_game(address: &str, account: &GameAccount) -> TimbaGameAccount {
    let created_at = account.created_at as i64;
    TimbaGameAccount {
        address: address.to_string(),
        creator: account.creator.to_base58(),
        game_type: account.game_type,
        token_mint: account.token_mint.to_base58(),
        stake_amount: if account.game_type == GameType::Coinflip { account.ticket_amount } else { 0 },
        prize_amount: if account.game_type == GameType::Giveaway {
            account.ticket_amount
        } else {
            account.total_amount
        },
        current_players: account.tickets_count,
        min_players: account.min_tickets,
        max_players: account.max_tickets,
        is_private: account.is_private,
        created_at,
        expires_at: created_at + account.timeout as i64,
        creation_signature: String::new(),
        last_slot: account.last_slot,
        participant_addresses: account.participants.iter().map(Address::to_base58).collect(),
    }
}

pub fn decode_game(address: &str, data: &[u8]) -> Result<TimbaGameAccount, DecodeError> {
    Ok(map_game(address, &GameAccount::decode(data)?))
}

pub fn serialize_game(game: &TimbaGameAccount) -> SerializedTimbaGameAccount {
    SerializedTimbaGameAccount {
        address: game.address.clone(),
        creator: game.creator.clone(),
        game_type: game.game_type.name().to_string(),
        token_mint: game.token_mint.clone(),
        stake_amount: game.stake_amount.to_string(),
        prize_amount: game.prize_amount.to_string(),
        current_players: game.current_players,
        min_players: game.min_players,
        max_players: game.max_players,
        is_private: game.is_private,
        created_at: game.created_at,
        expires_at: game.expires_at,
        last_slot: game.last_slot.to_string(),
        participant_addresses: game.participant_addresses.clone(),
    }
}

#[derive(Debug, Clone)]
pub struct GameInstructionInput {
    pub game: Address,
    pub player: Address,
    pub token_mint: Address,
    pub token_amount: Option<u64>,
    pub authority: Option<Address>,
}

#[derive(Debug, Clone)]
pub struct GameInstructionPlan {
    pub instructions: Vec<Instruction>,
    pub player_token_account: Address,
}

#[derive(Debug, Clone, Copy)]
pub struct ContractAdapter {
    pub version: ContractVersion,
    pub program_id: Address,
}

impl ContractAdapter {
    pub fn new(version: ContractVersion, program_id: Address) -> Self {
        Self { version, program_id }
    }

    pub fn decode_game(&self, address: &str, data: &[u8]) -> Result<TimbaGameAccount, DecodeError> {
        decode_game(address, data)
    }

    fn build_plan(&self, input: &GameInstructionInput, unjoin: bool) -> Result<GameInstructionPlan, PlanError> {
        let player_token_account = get_associated_token_address(&input.token_mint, &input.player, false)?;
        let authority = input.authority.unwrap_or(input.player);
        let instruction = if unjoin {
            contracts::unjoin_game_instruction(
                self.version,
                &contracts::UnjoinGameAccounts {
                    game: input.game,
                    player: input.player,
                    authority,
                    token_mint: input.token_mint,
                    player_token_account,
                },
                &self.program_id,
            )
        } else {
            contracts::join_game_instruction(
                self.version,
                &contracts::JoinGameAccounts {
                    game: input.game,
                    player: input.player,
                    oracle_operator: None,
                    token_mint: input.token_mint,
                    player_token_account,
                },
                &self.program_id,
            )
        };
        let setup = create_associated_token_account_idempotent_instruction(
            if unjoin { &authority } else { &input.player },
            &player_token_account,
            &input.player,
            &input.token_mint,
            &TOKEN_PROGRAM_ID,
        );
        let mut instructions = vec![setup];
        if !unjoin && is_wrapped_sol(&input.token_mint) {
            let amount = input
                .token_amount
                .filter(|a| *a > 0)
                .ok_or_else(|| PlanError::Invalid("SOL joins require a positive stake amount".into()))?;
            let (_, wrap) = build_wrap_sol_instructions(&input.player, amount)?;
            instructions.extend(wrap.into_iter().skip(1));
        }
        instructions.push(instruction);
        Ok(GameInstructionPlan { instructions, player_token_account })
    }

    pub fn build_join_plan(&self, input: &GameInstructionInput) -> Result<GameInstructionPlan, PlanError> {
        self.build_plan(input, false)
    }

    pub fn build_unjoin_plan(&self, input: &GameInstructionInput) -> Result<GameInstructionPlan, PlanError> {
        self.build_plan(input, true)
    }

    pub fn build_close_plan(
        &self,
        game: &Address,
        creator: &Address,
        token_mint: &Address,
    ) -> Result<GameInstructionPlan, PlanError> {
        let creator_token_account = get_associated_token_address(token_mint, creator, false)?;
        let setup = create_associated_token_account_idempotent_instruction(
            creator,
            &creator_token_account,
            creator,
            token_mint,
            &TOKEN_PROGRAM_ID,
        );
        let close = contracts::close_game_instruction(
            self.version,
            &contracts::CloseGameAccounts {
                game: *game,
                creator: *creator,
                token_mint: *token_mint,
                creator_token_account,
            },
            &self.program_id,
        );
        Ok(GameInstructionPlan { instructions: vec![setup, close], player_token_account: creator_token_account })
    }

    pub fn has_participant(&self, game: &TimbaGameAccount, player: &Address) -> bool {
        let player = player.to_base58();
        game.participant_addresses.iter().any(|p| p == &player)
    }
}

#[derive(Debug, Clone)]
pub struct CreateGameInput {
    pub creator: Address,
    pub token_mint: Address,
    pub game_type: GameType,
    pub amount: u64,
    pub min_players: u32,
    pub max_players: u32,
    pub timeout_seconds: u64,
    pub random_hash: Vec<u8>,
    pub oracle_operator: Address,
}

#[derive(Debug, Clone)]
pub struct CreateGamePlan {
    pub game: Address,
    pub instructions: Vec<Instruction>,
}

pub fn build_create_game_plan(
    input: &CreateGameInput,
    version: ContractVersion,
    program_id: &Address,
) -> Result<CreateGamePlan, PlanError> {
    let random_hash: [u8; 32] = input
        .random_hash
        .as_slice()
        .try_into()
        .map_err(|_| PlanError::Invalid("Oracle commitment must be 32 bytes".into()))?;
    let game = find_game_pda(&random_hash, program_id);
    let game_vault = find_game_vault_pda(&input.token_mint, program_id);
    let game_vault_token_account = get_associated_token_address(&input.token_mint, &game_vault, true)?;
    let creator_token_account = get_associated_token_address(&input.token_mint, &input.creator, false)?;
    let initialize = contracts::initialize_game_instruction(
        version,
        &InitializeGameAccounts {
            game,
            creator: input.creator,
            oracle_operator: input.oracle_operator,
            token_mint: input.token_mint,
            creator_token_account,
        },
        &InitializeGameArgs {
            game_type: input.game_type,
            amount: input.amount,
            max_tickets: input.max_players,
            min_tickets: input.min_players,
            timeout: input.timeout_seconds,
            is_private: false,
            random_hash,
        },
        program_id,
    );
    let mut instructions = vec![create_associated_token_account_idempotent_instruction(
        &input.creator,
        &creator_token_account,
        &input.creator,
        &input.token_mint,
        &TOKEN_PROGRAM_ID,
    )];
    if version != ContractVersion::V0_2_0 {
        instructions.push(create_associated_token_account_idempotent_instruction(
            &input.creator,
            &game_vault_token_account,
            &game_vault,
            &input.token_mint,
            &TOKEN_PROGRAM_ID,
        ));
    }
    instructions.push(initialize);
    Ok(CreateGamePlan { game, instructions })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::PROGRAM_ID;

    fn account(game_type: GameType) -> GameAccount {
        GameAccount {
            creator: Address([1; 32]),
            game_type,
            ticket_amount: 25,
            max_tickets: 4,
            min_tickets: 2,
            tickets_count: 2,
            token_mint: Address([2; 32]),
            created_at: 1_000,
            timeout: 600,
            last_slot: u64::MAX,
            is_private: true,
            total_amount: 50,
            participants: vec![Address([3; 32]), Address([4; 32])],
        }
    }

    #[test]
    fn maps_and_serializes_games() {
        let coinflip = map_game("game", &account(GameType::Coinflip));
        assert_eq!(
            coinflip,
            TimbaGameAccount {
                address: "game".into(),
                creator: Address([1; 32]).to_base58(),
                game_type: GameType::Coinflip,
                token_mint: Address([2; 32]).to_base58(),
                stake_amount: 25,
                prize_amount: 50,
                current_players: 2,
                min_players: 2,
                max_players: 4,
                is_private: true,
                created_at: 1_000,
                expires_at: 1_600,
                creation_signature: String::new(),
                last_slot: u64::MAX,
                participant_addresses: vec![Address([3; 32]).to_base58(), Address([4; 32]).to_base58()],
            }
        );
        // Giveaways have no stake; the ticket amount is the prize.
        let giveaway = map_game("game", &account(GameType::Giveaway));
        assert_eq!((giveaway.stake_amount, giveaway.prize_amount), (0, 25));

        let serialized = serialize_game(&coinflip);
        let json = serde_json::to_value(&serialized).unwrap();
        assert_eq!(json["type"], "coinflip");
        assert_eq!(json["stakeAmount"], "25");
        assert_eq!(json["prizeAmount"], "50");
        assert_eq!(json["lastSlot"], u64::MAX.to_string(), "u64 values are strings");
        assert_eq!(json["expiresAt"], 1_600);
        assert_eq!(json["participantAddresses"].as_array().unwrap().len(), 2);
        assert_eq!(serde_json::from_value::<SerializedTimbaGameAccount>(json).unwrap(), serialized);

        let adapter = ContractAdapter::new(ContractVersion::V0_3_0, PROGRAM_ID);
        let bytes = account(GameType::Coinflip).encode();
        assert_eq!(adapter.decode_game("game", &bytes).unwrap(), coinflip);
        assert_eq!(decode_game("game", &bytes).unwrap(), coinflip);
        assert!(adapter.decode_game("game", &bytes[..10]).is_err());
        assert!(adapter.has_participant(&coinflip, &Address([4; 32])));
        assert!(!adapter.has_participant(&coinflip, &Address([1; 32])));
    }

    #[test]
    fn token_helpers_validate_owners_and_amounts() {
        let pda = crate::contracts::find_oracle_pda(&PROGRAM_ID);
        assert_eq!(get_associated_token_address(&NATIVE_MINT, &pda, false), Err(PlanError::TokenOwnerOffCurve));
        assert_eq!(PlanError::TokenOwnerOffCurve.to_string(), "TokenOwnerOffCurveError");
        let ata = get_associated_token_address(&NATIVE_MINT, &pda, true).unwrap();
        assert_eq!(ata, find_associated_token_address(&pda, &NATIVE_MINT, &TOKEN_PROGRAM_ID));

        let owner = Address::parse("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM").unwrap();
        assert_eq!(build_wrap_sol_instructions(&owner, 0).unwrap_err().to_string(), "SOL amount must be positive");
        assert!(build_wrap_sol_instructions(&pda, 1).is_err(), "off-curve owners cannot wrap SOL");
        let (account, instructions) = build_wrap_sol_instructions(&owner, 1).unwrap();
        assert_eq!(account, find_associated_token_address(&owner, &NATIVE_MINT, &TOKEN_PROGRAM_ID));
        assert!(!instructions.is_empty());
        assert!(is_wrapped_sol(&NATIVE_MINT));
        assert!(!is_wrapped_sol(&TOKEN_PROGRAM_ID));
    }
}
