//! Timba program versions, account decoders, PDAs and instruction builders for
//! the v0.2.0 and v0.3.0 deployments.

use std::fmt;
use std::str::FromStr;

use crate::address::{
    find_associated_token_address, ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID,
};
use crate::codec::{DecodeError, Reader};
use crate::instruction::{AccountMeta, Instruction};
use crate::Address;

/// Both supported deployments share a program id.
pub const PROGRAM_ID: Address = Address::from_static("32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ContractVersion {
    V0_2_0,
    V0_3_0,
}

pub const SUPPORTED_CONTRACT_VERSIONS: [ContractVersion; 2] = [ContractVersion::V0_2_0, ContractVersion::V0_3_0];
pub const DEFAULT_CONTRACT_VERSION: ContractVersion = ContractVersion::V0_2_0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContractCapabilities {
    pub game_token_account: bool,
    pub oracle_token_policy: bool,
    pub operator_game_closed_event: bool,
    pub direct_completion_fee_transfer: bool,
}

impl ContractVersion {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::V0_2_0 => "0.2.0",
            Self::V0_3_0 => "0.3.0",
        }
    }

    pub fn capabilities(self) -> ContractCapabilities {
        match self {
            Self::V0_2_0 => ContractCapabilities {
                game_token_account: true,
                oracle_token_policy: false,
                operator_game_closed_event: false,
                direct_completion_fee_transfer: false,
            },
            Self::V0_3_0 => ContractCapabilities {
                game_token_account: false,
                oracle_token_policy: true,
                operator_game_closed_event: true,
                direct_completion_fee_transfer: true,
            },
        }
    }

    /// Mirrors `parseContractVersion`: blank means the default version.
    pub fn parse_env(value: Option<&str>, variable_name: &str) -> Result<Self, String> {
        let version = value.map(str::trim).filter(|v| !v.is_empty()).unwrap_or("0.2.0");
        version.parse().map_err(|_| {
            format!("{variable_name} must be one of 0.2.0, 0.3.0; received {version}")
        })
    }

    pub fn idl_json(self) -> &'static str {
        match self {
            Self::V0_2_0 => include_str!("../idl/timba-v0.2.0.json"),
            Self::V0_3_0 => include_str!("../idl/timba-v0.3.0.json"),
        }
    }
}

impl FromStr for ContractVersion {
    type Err = String;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "0.2.0" => Ok(Self::V0_2_0),
            "0.3.0" => Ok(Self::V0_3_0),
            other => Err(format!("Unsupported contract version: {other}")),
        }
    }
}

impl fmt::Display for ContractVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

pub mod discriminators {
    pub const GAME_ACCOUNT: [u8; 8] = [27, 90, 166, 125, 74, 100, 121, 18];
    pub const ORACLE_ACCOUNT: [u8; 8] = [139, 194, 131, 179, 140, 179, 229, 244];
    pub const GAME_TOKEN_ACCOUNT: [u8; 8] = [146, 160, 167, 120, 232, 217, 240, 63];

    pub const COMPLETE_GAME: [u8; 8] = [105, 69, 184, 5, 143, 182, 92, 132];
    pub const INITIALIZE_GAME: [u8; 8] = [44, 62, 102, 247, 126, 208, 130, 215];
    pub const JOIN_GAME: [u8; 8] = [107, 112, 18, 38, 56, 173, 60, 128];
    pub const UNJOIN_GAME: [u8; 8] = [105, 123, 174, 143, 207, 2, 17, 206];
    pub const CLOSE_GAME: [u8; 8] = [237, 236, 157, 201, 253, 20, 248, 67];
    pub const OPERATOR_CLOSE_GAME: [u8; 8] = [156, 21, 221, 84, 94, 226, 235, 185];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GameType {
    Coinflip = 0,
    Giveaway = 1,
}

impl GameType {
    pub fn from_u8(value: u8) -> Result<Self, DecodeError> {
        match value {
            0 => Ok(Self::Coinflip),
            1 => Ok(Self::Giveaway),
            other => Err(DecodeError::new(format!(
                "Enum discriminator out of range. Expected a number in [0, 1], got {other}."
            ))),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Coinflip => "coinflip",
            Self::Giveaway => "giveaway",
        }
    }

    pub fn from_name(value: &str) -> Option<Self> {
        match value {
            "coinflip" => Some(Self::Coinflip),
            "giveaway" => Some(Self::Giveaway),
            _ => None,
        }
    }
}

/// On-chain `Game` account. Identical layout in both supported versions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameAccount {
    pub creator: Address,
    pub game_type: GameType,
    pub ticket_amount: u64,
    pub max_tickets: u32,
    pub min_tickets: u32,
    pub tickets_count: u32,
    pub token_mint: Address,
    pub created_at: u64,
    pub timeout: u64,
    pub last_slot: u64,
    pub is_private: bool,
    pub total_amount: u64,
    pub participants: Vec<Address>,
}

fn expect_discriminator(reader: &mut Reader<'_>, expected: &[u8; 8], what: &str) -> Result<(), DecodeError> {
    let actual = reader.array::<8>()?;
    if &actual != expected {
        return Err(DecodeError::new(format!("Account is not a Timba {what}")));
    }
    Ok(())
}

impl GameAccount {
    /// Mirrors protocol `decodeGame`.
    pub fn decode(data: &[u8]) -> Result<Self, DecodeError> {
        if data.len() < 8 || data[..8] != discriminators::GAME_ACCOUNT {
            return Err(DecodeError::new("Account is not a Timba game"));
        }
        let mut r = Reader::new(data);
        r.bytes(8)?;
        let creator = r.address()?;
        let game_type = GameType::from_u8(r.u8()?)?;
        let ticket_amount = r.u64()?;
        let max_tickets = r.u32()?;
        let min_tickets = r.u32()?;
        let tickets_count = r.u32()?;
        let token_mint = r.address()?;
        let created_at = r.u64()?;
        let timeout = r.u64()?;
        let last_slot = r.u64()?;
        let is_private = r.bool()?;
        let total_amount = r.u64()?;
        let count = r.u32()? as usize;
        if count > r.remaining() / 32 {
            return Err(DecodeError::new("Codec [decode] participant vector exceeds account data"));
        }
        let participants = (0..count).map(|_| r.address()).collect::<Result<Vec<_>, _>>()?;
        if participants.len() != tickets_count as usize {
            return Err(DecodeError::new("Timba participant count does not match the game account"));
        }
        Ok(Self {
            creator,
            game_type,
            ticket_amount,
            max_tickets,
            min_tickets,
            tickets_count,
            token_mint,
            created_at,
            timeout,
            last_slot,
            is_private,
            total_amount,
            participants,
        })
    }

    #[doc(hidden)]
    pub fn encode(&self) -> Vec<u8> {
        let mut out = discriminators::GAME_ACCOUNT.to_vec();
        out.extend_from_slice(&self.creator.0);
        out.push(self.game_type as u8);
        out.extend_from_slice(&self.ticket_amount.to_le_bytes());
        out.extend_from_slice(&self.max_tickets.to_le_bytes());
        out.extend_from_slice(&self.min_tickets.to_le_bytes());
        out.extend_from_slice(&self.tickets_count.to_le_bytes());
        out.extend_from_slice(&self.token_mint.0);
        out.extend_from_slice(&self.created_at.to_le_bytes());
        out.extend_from_slice(&self.timeout.to_le_bytes());
        out.extend_from_slice(&self.last_slot.to_le_bytes());
        out.push(self.is_private as u8);
        out.extend_from_slice(&self.total_amount.to_le_bytes());
        out.extend_from_slice(&(self.participants.len() as u32).to_le_bytes());
        for p in &self.participants {
            out.extend_from_slice(&p.0);
        }
        out
    }
}

/// On-chain `Oracle` account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OracleAccount {
    pub operator: Address,
    pub fee_percentage: u8,
    pub oracle_buffer_time: u64,
    pub max_tickets: u32,
    pub max_timeout: u64,
    pub min_timeout: u64,
}

impl OracleAccount {
    pub fn decode(data: &[u8]) -> Result<Self, DecodeError> {
        let mut r = Reader::new(data);
        expect_discriminator(&mut r, &discriminators::ORACLE_ACCOUNT, "oracle")?;
        Ok(Self {
            operator: r.address()?,
            fee_percentage: r.u8()?,
            oracle_buffer_time: r.u64()?,
            max_tickets: r.u32()?,
            max_timeout: r.u64()?,
            min_timeout: r.u64()?,
        })
    }

    #[doc(hidden)]
    pub fn encode(&self) -> Vec<u8> {
        let mut out = discriminators::ORACLE_ACCOUNT.to_vec();
        out.extend_from_slice(&self.operator.0);
        out.push(self.fee_percentage);
        out.extend_from_slice(&self.oracle_buffer_time.to_le_bytes());
        out.extend_from_slice(&self.max_tickets.to_le_bytes());
        out.extend_from_slice(&self.max_timeout.to_le_bytes());
        out.extend_from_slice(&self.min_timeout.to_le_bytes());
        out
    }
}

/// v0.2.0 `GameToken` account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameTokenAccount {
    pub token_mint: Address,
    pub vault_bump: u8,
    pub min_amount: u64,
    pub fee_amount: u64,
    pub enabled: bool,
}

impl GameTokenAccount {
    pub fn is_game_token(data: &[u8]) -> bool {
        data.len() >= 8 && data[..8] == discriminators::GAME_TOKEN_ACCOUNT
    }

    pub fn decode(data: &[u8]) -> Result<Self, DecodeError> {
        let mut r = Reader::new(data);
        expect_discriminator(&mut r, &discriminators::GAME_TOKEN_ACCOUNT, "game token")?;
        Ok(Self {
            token_mint: r.address()?,
            vault_bump: r.u8()?,
            min_amount: r.u64()?,
            fee_amount: r.u64()?,
            enabled: r.bool()?,
        })
    }

    #[doc(hidden)]
    pub fn encode(&self) -> Vec<u8> {
        let mut out = discriminators::GAME_TOKEN_ACCOUNT.to_vec();
        out.extend_from_slice(&self.token_mint.0);
        out.push(self.vault_bump);
        out.extend_from_slice(&self.min_amount.to_le_bytes());
        out.extend_from_slice(&self.fee_amount.to_le_bytes());
        out.push(self.enabled as u8);
        out
    }
}

// ---------------------------------------------------------------------------
// PDAs
// ---------------------------------------------------------------------------

pub fn find_game_pda(random_hash: &[u8; 32], program_id: &Address) -> Address {
    Address::find_program_address(&[b"game", random_hash], program_id)
        .expect("game PDA")
        .0
}

pub fn find_oracle_pda(program_id: &Address) -> Address {
    Address::find_program_address(&[b"oracle"], program_id).expect("oracle PDA").0
}

pub fn find_game_vault_pda(token_mint: &Address, program_id: &Address) -> Address {
    Address::find_program_address(&[b"game_vault", &token_mint.0], program_id)
        .expect("game vault PDA")
        .0
}

pub fn find_game_token_pda(token_mint: &Address, program_id: &Address) -> Address {
    Address::find_program_address(&[b"game_token", &token_mint.0], program_id)
        .expect("game token PDA")
        .0
}

/// Associated token account using the classic token program (the IDL default).
pub fn ata(owner: &Address, mint: &Address) -> Address {
    find_associated_token_address(owner, mint, &TOKEN_PROGRAM_ID)
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

/// Token context accounts shared by every game instruction. v0.2 inserts the
/// writable `game_token` account after the mint.
fn token_context(version: ContractVersion, mint: &Address, program_id: &Address) -> Vec<AccountMeta> {
    let vault = find_game_vault_pda(mint, program_id);
    let mut metas = vec![AccountMeta::readonly(*mint)];
    if version == ContractVersion::V0_2_0 {
        metas.push(AccountMeta::writable(find_game_token_pda(mint, program_id)));
    }
    metas.push(AccountMeta::readonly(vault));
    metas.push(AccountMeta::writable(find_associated_token_address(&vault, mint, &TOKEN_PROGRAM_ID)));
    metas.push(AccountMeta::readonly(TOKEN_PROGRAM_ID));
    metas.push(AccountMeta::readonly(ASSOCIATED_TOKEN_PROGRAM_ID));
    metas
}

pub struct CompleteGameInput {
    pub game: Address,
    pub token_mint: Address,
    pub oracle_operator: Address,
    pub winner: Address,
    pub creator: Address,
    pub random_hash: [u8; 32],
    pub secret_key: [u8; 32],
    pub winner_index: u32,
}

pub fn complete_game_instruction(
    version: ContractVersion,
    input: &CompleteGameInput,
    program_id: &Address,
) -> Instruction {
    let mut accounts = vec![AccountMeta::writable(input.game)];
    accounts.extend(token_context(version, &input.token_mint, program_id));
    accounts.push(AccountMeta::readonly(find_oracle_pda(program_id)));
    accounts.push(AccountMeta::readonly_signer(input.oracle_operator));
    accounts.push(AccountMeta::readonly(input.winner));
    accounts.push(AccountMeta::writable(input.creator));
    accounts.push(AccountMeta::writable(ata(&input.winner, &input.token_mint)));
    if version == ContractVersion::V0_3_0 {
        accounts.push(AccountMeta::writable(ata(&input.oracle_operator, &input.token_mint)));
    }
    let mut data = discriminators::COMPLETE_GAME.to_vec();
    data.extend_from_slice(&input.random_hash);
    data.extend_from_slice(&input.secret_key);
    data.extend_from_slice(&input.winner_index.to_le_bytes());
    Instruction { program_id: *program_id, accounts, data }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InitializeGameArgs {
    pub game_type: GameType,
    pub amount: u64,
    pub max_tickets: u32,
    pub min_tickets: u32,
    pub timeout: u64,
    pub is_private: bool,
    pub random_hash: [u8; 32],
}

pub const INITIALIZE_GAME_DATA_LEN: usize = 8 + 1 + 8 + 4 + 4 + 8 + 1 + 32;

impl InitializeGameArgs {
    pub fn encode(&self) -> Vec<u8> {
        let mut data = discriminators::INITIALIZE_GAME.to_vec();
        data.push(self.game_type as u8);
        data.extend_from_slice(&self.amount.to_le_bytes());
        data.extend_from_slice(&self.max_tickets.to_le_bytes());
        data.extend_from_slice(&self.min_tickets.to_le_bytes());
        data.extend_from_slice(&self.timeout.to_le_bytes());
        data.push(self.is_private as u8);
        data.extend_from_slice(&self.random_hash);
        data
    }

    /// Mirrors the generated instruction data decoder (trailing bytes ignored).
    pub fn decode(data: &[u8]) -> Result<Self, DecodeError> {
        let mut r = Reader::new(data);
        let disc = r.array::<8>()?;
        if disc != discriminators::INITIALIZE_GAME {
            return Err(DecodeError::new("Instruction is not initialize_game"));
        }
        Ok(Self {
            game_type: GameType::from_u8(r.u8()?)?,
            amount: r.u64()?,
            max_tickets: r.u32()?,
            min_tickets: r.u32()?,
            timeout: r.u64()?,
            is_private: r.bool()?,
            random_hash: r.array()?,
        })
    }
}

pub struct InitializeGameAccounts {
    pub game: Address,
    pub creator: Address,
    pub oracle_operator: Address,
    pub token_mint: Address,
    pub creator_token_account: Address,
}

pub fn initialize_game_account_metas(
    version: ContractVersion,
    accounts: &InitializeGameAccounts,
    program_id: &Address,
) -> Vec<AccountMeta> {
    let mut metas = vec![
        AccountMeta::writable(accounts.game),
        AccountMeta::writable_signer(accounts.creator),
        AccountMeta::readonly(find_oracle_pda(program_id)),
        AccountMeta::readonly_signer(accounts.oracle_operator),
    ];
    metas.extend(token_context(version, &accounts.token_mint, program_id));
    metas.push(AccountMeta::writable(accounts.creator_token_account));
    metas.push(AccountMeta::readonly(SYSTEM_PROGRAM_ID));
    metas
}

pub fn initialize_game_instruction(
    version: ContractVersion,
    accounts: &InitializeGameAccounts,
    args: &InitializeGameArgs,
    program_id: &Address,
) -> Instruction {
    Instruction {
        program_id: *program_id,
        accounts: initialize_game_account_metas(version, accounts, program_id),
        data: args.encode(),
    }
}

pub fn initialize_game_account_count(version: ContractVersion) -> usize {
    match version {
        ContractVersion::V0_2_0 => 12,
        ContractVersion::V0_3_0 => 11,
    }
}

pub struct JoinGameAccounts {
    pub game: Address,
    pub player: Address,
    /// `None` uses the program id placeholder for the optional account.
    pub oracle_operator: Option<Address>,
    pub token_mint: Address,
    pub player_token_account: Address,
}

pub fn join_game_account_metas(
    version: ContractVersion,
    accounts: &JoinGameAccounts,
    program_id: &Address,
) -> Vec<AccountMeta> {
    let mut metas = vec![
        AccountMeta::writable(accounts.game),
        AccountMeta::writable_signer(accounts.player),
        match accounts.oracle_operator {
            Some(operator) => AccountMeta::readonly_signer(operator),
            None => AccountMeta::readonly(*program_id),
        },
    ];
    metas.extend(token_context(version, &accounts.token_mint, program_id));
    metas.push(AccountMeta::writable(accounts.player_token_account));
    metas.push(AccountMeta::readonly(find_oracle_pda(program_id)));
    metas
}

pub fn join_game_instruction(version: ContractVersion, accounts: &JoinGameAccounts, program_id: &Address) -> Instruction {
    Instruction {
        program_id: *program_id,
        accounts: join_game_account_metas(version, accounts, program_id),
        data: discriminators::JOIN_GAME.to_vec(),
    }
}

pub fn join_game_account_count(version: ContractVersion) -> usize {
    match version {
        ContractVersion::V0_2_0 => 11,
        ContractVersion::V0_3_0 => 10,
    }
}

pub struct UnjoinGameAccounts {
    pub game: Address,
    pub player: Address,
    pub authority: Address,
    pub token_mint: Address,
    pub player_token_account: Address,
}

pub fn unjoin_game_instruction(
    version: ContractVersion,
    accounts: &UnjoinGameAccounts,
    program_id: &Address,
) -> Instruction {
    let mut metas = vec![
        AccountMeta::writable(accounts.game),
        AccountMeta::readonly(accounts.player),
        AccountMeta::readonly_signer(accounts.authority),
        AccountMeta::readonly(find_oracle_pda(program_id)),
    ];
    metas.extend(token_context(version, &accounts.token_mint, program_id));
    metas.push(AccountMeta::writable(accounts.player_token_account));
    Instruction { program_id: *program_id, accounts: metas, data: discriminators::UNJOIN_GAME.to_vec() }
}

pub struct CloseGameAccounts {
    pub game: Address,
    pub creator: Address,
    pub token_mint: Address,
    pub creator_token_account: Address,
}

pub fn close_game_instruction(version: ContractVersion, accounts: &CloseGameAccounts, program_id: &Address) -> Instruction {
    let mut metas = vec![
        AccountMeta::writable(accounts.game),
        AccountMeta::writable_signer(accounts.creator),
        AccountMeta::readonly(find_oracle_pda(program_id)),
    ];
    metas.extend(token_context(version, &accounts.token_mint, program_id));
    metas.push(AccountMeta::writable(accounts.creator_token_account));
    Instruction { program_id: *program_id, accounts: metas, data: discriminators::CLOSE_GAME.to_vec() }
}

pub fn operator_close_game_instruction(
    game: &Address,
    oracle_operator: &Address,
    token_mint: &Address,
    creator: &Address,
    program_id: &Address,
) -> Instruction {
    let mut metas = vec![
        AccountMeta::writable(*game),
        AccountMeta::writable_signer(*oracle_operator),
        AccountMeta::readonly(find_oracle_pda(program_id)),
    ];
    metas.extend(token_context(ContractVersion::V0_3_0, token_mint, program_id));
    metas.push(AccountMeta::readonly(*creator));
    metas.push(AccountMeta::writable(ata(creator, token_mint)));
    Instruction { program_id: *program_id, accounts: metas, data: discriminators::OPERATOR_CLOSE_GAME.to_vec() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn idl(version: ContractVersion) -> Value {
        serde_json::from_str(version.idl_json()).unwrap()
    }

    fn disc(value: &Value) -> Vec<u8> {
        value["discriminator"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u8).collect()
    }

    fn find<'a>(list: &'a Value, name: &str) -> &'a Value {
        list.as_array().unwrap().iter().find(|v| v["name"] == name).unwrap()
    }

    #[test]
    fn discriminators_match_idl() {
        for version in SUPPORTED_CONTRACT_VERSIONS {
            let idl = idl(version);
            assert_eq!(idl["address"], PROGRAM_ID.to_base58());
            let ix = &idl["instructions"];
            assert_eq!(disc(find(ix, "complete_game")), discriminators::COMPLETE_GAME);
            assert_eq!(disc(find(ix, "initialize_game")), discriminators::INITIALIZE_GAME);
            assert_eq!(disc(find(ix, "join_game")), discriminators::JOIN_GAME);
            assert_eq!(disc(find(ix, "unjoin_game")), discriminators::UNJOIN_GAME);
            assert_eq!(disc(find(ix, "close_game")), discriminators::CLOSE_GAME);
            let accounts = &idl["accounts"];
            assert_eq!(disc(find(accounts, "Game")), discriminators::GAME_ACCOUNT);
            assert_eq!(disc(find(accounts, "Oracle")), discriminators::ORACLE_ACCOUNT);
        }
        let v3 = idl(ContractVersion::V0_3_0);
        assert_eq!(disc(find(&v3["instructions"], "operator_close_game")), discriminators::OPERATOR_CLOSE_GAME);
        let v2 = idl(ContractVersion::V0_2_0);
        assert_eq!(disc(find(&v2["accounts"], "GameToken")), discriminators::GAME_TOKEN_ACCOUNT);
    }

    #[test]
    fn game_layout_matches_idl_field_order() {
        for version in SUPPORTED_CONTRACT_VERSIONS {
            let idl = idl(version);
            let game = find(&idl["types"], "Game");
            let names: Vec<&str> =
                game["type"]["fields"].as_array().unwrap().iter().map(|f| f["name"].as_str().unwrap()).collect();
            assert_eq!(
                names,
                [
                    "creator", "game_type", "ticket_amount", "max_tickets", "min_tickets", "tickets_count",
                    "token_mint", "created_at", "timeout", "last_slot", "is_private", "total_amount",
                    "participants"
                ]
            );
            let oracle = find(&idl["types"], "Oracle");
            let names: Vec<&str> =
                oracle["type"]["fields"].as_array().unwrap().iter().map(|f| f["name"].as_str().unwrap()).collect();
            assert_eq!(
                names,
                ["operator", "fee_percentage", "oracle_buffer_time", "max_tickets", "max_timeout", "min_timeout"]
            );
        }
    }

    #[test]
    fn game_round_trip_and_validation() {
        let game = GameAccount {
            creator: Address([1; 32]),
            game_type: GameType::Giveaway,
            ticket_amount: 5,
            max_tickets: 10,
            min_tickets: 2,
            tickets_count: 2,
            token_mint: Address([2; 32]),
            created_at: 100,
            timeout: 60,
            last_slot: 77,
            is_private: true,
            total_amount: 10,
            participants: vec![Address([3; 32]), Address([4; 32])],
        };
        let bytes = game.encode();
        assert_eq!(GameAccount::decode(&bytes).unwrap(), game);
        let mut bad = bytes.clone();
        bad[0] ^= 1;
        assert!(GameAccount::decode(&bad).is_err());
        let mut bad_type = bytes.clone();
        bad_type[40] = 2;
        assert!(GameAccount::decode(&bad_type).is_err());
        let mut mismatch = game.clone();
        mismatch.tickets_count = 3;
        assert!(GameAccount::decode(&mismatch.encode()).is_err());
        assert!(GameAccount::decode(&bytes[..bytes.len() - 1]).is_err());
    }

    #[test]
    fn instruction_account_counts() {
        let accounts = InitializeGameAccounts {
            game: Address([1; 32]),
            creator: Address([2; 32]),
            oracle_operator: Address([3; 32]),
            token_mint: Address([4; 32]),
            creator_token_account: Address([5; 32]),
        };
        for version in SUPPORTED_CONTRACT_VERSIONS {
            assert_eq!(
                initialize_game_account_metas(version, &accounts, &PROGRAM_ID).len(),
                initialize_game_account_count(version)
            );
            let join = JoinGameAccounts {
                game: Address([1; 32]),
                player: Address([2; 32]),
                oracle_operator: None,
                token_mint: Address([4; 32]),
                player_token_account: Address([5; 32]),
            };
            assert_eq!(join_game_account_metas(version, &join, &PROGRAM_ID).len(), join_game_account_count(version));
        }
        let args = InitializeGameArgs {
            game_type: GameType::Coinflip,
            amount: 42,
            max_tickets: 2,
            min_tickets: 2,
            timeout: 3600,
            is_private: false,
            random_hash: [9; 32],
        };
        let data = args.encode();
        assert_eq!(data.len(), INITIALIZE_GAME_DATA_LEN);
        assert_eq!(InitializeGameArgs::decode(&data).unwrap(), args);
    }
}
