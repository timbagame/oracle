//! Timba program event codecs and trusted log extraction (v0.2 and v0.3).

use std::sync::OnceLock;

use base64::Engine;
use regex::Regex;

use crate::codec::{DecodeError, Reader};
use crate::contracts::GameType;
use crate::Address;

pub mod discriminators {
    pub const GAME_INITIALIZED: [u8; 8] = [82, 221, 11, 2, 244, 52, 240, 250];
    pub const GAME_COMPLETED: [u8; 8] = [103, 26, 106, 108, 240, 191, 179, 120];
    pub const GAME_CLOSED: [u8; 8] = [178, 203, 179, 224, 43, 18, 209, 4];
    pub const PLAYER_JOINED: [u8; 8] = [39, 144, 49, 106, 108, 210, 183, 38];
    pub const PLAYER_UNJOINED: [u8; 8] = [191, 34, 140, 22, 253, 20, 237, 73];
    pub const TOKEN_FEE_WITHDRAWN: [u8; 8] = [92, 98, 195, 90, 108, 129, 244, 119];
    pub const OPERATOR_GAME_CLOSED: [u8; 8] = [236, 51, 251, 125, 251, 64, 187, 174];
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameInitialized {
    pub game_key: Address,
    pub creator: Address,
    pub game_type: GameType,
    pub ticket_amount: u64,
    pub total_amount: u64,
    pub max_tickets: u32,
    pub min_tickets: u32,
    pub token_mint: Address,
    pub is_private: bool,
    pub created_at: u64,
    pub timeout: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameCompleted {
    pub game_key: Address,
    pub winner: Address,
    pub tickets_count: u32,
    pub winner_amount: u64,
    pub fee_amount: u64,
    pub timestamp: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameClosed {
    pub game_key: Address,
    pub timestamp: u64,
}

/// `PlayerJoined` and `PlayerUnjoined` share this shape; joins never carry a
/// moved participant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlayerMembership {
    pub game_key: Address,
    pub player: Address,
    pub total_amount: u64,
    pub tickets_count: u32,
    pub ticket_index: u32,
    pub moved_participant: Option<Address>,
    pub last_slot: u64,
    pub timestamp: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenFeeWithdrawn {
    pub operator: Address,
    pub token_mint: Address,
    pub amount: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperatorGameClosed {
    pub game_key: Address,
    pub creator: Address,
    pub operator: Address,
    pub refunded_amount: u64,
    pub recovered_lamports: u64,
    pub timestamp: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProgramEvent {
    GameInitialized(GameInitialized),
    GameCompleted(GameCompleted),
    GameClosed(GameClosed),
    PlayerJoined(PlayerMembership),
    PlayerUnjoined(PlayerMembership),
    TokenFeeWithdrawn(TokenFeeWithdrawn),
    OperatorGameClosed(OperatorGameClosed),
}

impl ProgramEvent {
    pub fn name(&self) -> &'static str {
        match self {
            Self::GameInitialized(_) => "GameInitialized",
            Self::GameCompleted(_) => "GameCompleted",
            Self::GameClosed(_) => "GameClosed",
            Self::PlayerJoined(_) => "PlayerJoined",
            Self::PlayerUnjoined(_) => "PlayerUnjoined",
            Self::TokenFeeWithdrawn(_) => "TokenFeeWithdrawn",
            Self::OperatorGameClosed(_) => "OperatorGameClosed",
        }
    }

    pub fn game_key(&self) -> Option<&Address> {
        match self {
            Self::GameInitialized(e) => Some(&e.game_key),
            Self::GameCompleted(e) => Some(&e.game_key),
            Self::GameClosed(e) => Some(&e.game_key),
            Self::PlayerJoined(e) | Self::PlayerUnjoined(e) => Some(&e.game_key),
            Self::TokenFeeWithdrawn(_) => None,
            Self::OperatorGameClosed(e) => Some(&e.game_key),
        }
    }
}

fn exact<'a>(data: &'a [u8], fixed_size: usize) -> Result<Reader<'a>, DecodeError> {
    if data.len() != fixed_size + 8 {
        return Err(DecodeError::new("Invalid Timba event length"));
    }
    Ok(Reader::new(&data[8..]))
}

const MEMBERSHIP_HEAD: usize = 32 + 32 + 8 + 4 + 4;
const PLAYER_JOINED_SIZE: usize = MEMBERSHIP_HEAD + 8 + 8;

fn membership_head(r: &mut Reader<'_>) -> Result<(Address, Address, u64, u32, u32), DecodeError> {
    Ok((r.address()?, r.address()?, r.u64()?, r.u32()?, r.u32()?))
}

fn player_joined(data: &[u8]) -> Result<PlayerMembership, DecodeError> {
    let mut r = exact(data, PLAYER_JOINED_SIZE)?;
    let (game_key, player, total_amount, tickets_count, ticket_index) = membership_head(&mut r)?;
    Ok(PlayerMembership {
        game_key,
        player,
        total_amount,
        tickets_count,
        ticket_index,
        moved_participant: None,
        last_slot: r.u64()?,
        timestamp: r.u64()?,
    })
}

fn player_unjoined(data: &[u8]) -> Result<PlayerMembership, DecodeError> {
    // Historical deployments emitted membership without the moved-participant option.
    if data.len() == 104 {
        return player_joined(data);
    }
    let flag = data.get(88).copied();
    let valid = match flag {
        Some(1) => data.len() == 137,
        Some(0) => data.len() == 105,
        _ => false,
    };
    if !valid {
        return Err(DecodeError::new("Invalid PlayerUnjoined event"));
    }
    let mut r = Reader::new(&data[8..]);
    let (game_key, player, total_amount, tickets_count, ticket_index) = membership_head(&mut r)?;
    let (moved_participant, offset) =
        if flag == Some(1) { (Some(Address::from_slice(&data[89..121]).expect("32 bytes")), 121) } else { (None, 89) };
    let mut tail = Reader::new(&data[offset..]);
    Ok(PlayerMembership {
        game_key,
        player,
        total_amount,
        tickets_count,
        ticket_index,
        moved_participant,
        last_slot: tail.u64()?,
        timestamp: tail.u64()?,
    })
}

fn game_initialized(data: &[u8]) -> Result<GameInitialized, DecodeError> {
    let mut r = exact(data, 32 + 32 + 1 + 8 + 8 + 4 + 4 + 32 + 1 + 8 + 8)?;
    let game_key = r.address()?;
    let creator = r.address()?;
    let game_type = r.u8()?;
    let ticket_amount = r.u64()?;
    let total_amount = r.u64()?;
    let max_tickets = r.u32()?;
    let min_tickets = r.u32()?;
    let token_mint = r.address()?;
    let is_private = r.u8()?;
    let created_at = r.u64()?;
    let timeout = r.u64()?;
    if game_type > 1 || is_private > 1 {
        return Err(DecodeError::new("Invalid Timba event enum or boolean"));
    }
    Ok(GameInitialized {
        game_key,
        creator,
        game_type: if game_type == 0 { GameType::Coinflip } else { GameType::Giveaway },
        ticket_amount,
        total_amount,
        max_tickets,
        min_tickets,
        token_mint,
        is_private: is_private == 1,
        created_at,
        timeout,
    })
}

/// Unknown events are ignored; malformed recognized events fail.
pub fn decode_program_event(data: &[u8]) -> Result<Option<ProgramEvent>, DecodeError> {
    if data.len() < 8 {
        return Ok(None);
    }
    let disc: [u8; 8] = data[..8].try_into().expect("8 bytes");
    let event = match disc {
        discriminators::GAME_INITIALIZED => ProgramEvent::GameInitialized(game_initialized(data)?),
        discriminators::GAME_COMPLETED => {
            let mut r = exact(data, 32 + 32 + 4 + 8 + 8 + 8)?;
            ProgramEvent::GameCompleted(GameCompleted {
                game_key: r.address()?,
                winner: r.address()?,
                tickets_count: r.u32()?,
                winner_amount: r.u64()?,
                fee_amount: r.u64()?,
                timestamp: r.u64()?,
            })
        }
        discriminators::GAME_CLOSED => {
            let mut r = exact(data, 40)?;
            ProgramEvent::GameClosed(GameClosed { game_key: r.address()?, timestamp: r.u64()? })
        }
        discriminators::PLAYER_JOINED => ProgramEvent::PlayerJoined(player_joined(data)?),
        discriminators::PLAYER_UNJOINED => ProgramEvent::PlayerUnjoined(player_unjoined(data)?),
        discriminators::TOKEN_FEE_WITHDRAWN => {
            let mut r = exact(data, 72)?;
            ProgramEvent::TokenFeeWithdrawn(TokenFeeWithdrawn {
                operator: r.address()?,
                token_mint: r.address()?,
                amount: r.u64()?,
            })
        }
        discriminators::OPERATOR_GAME_CLOSED => {
            let mut r = exact(data, 32 * 3 + 24)?;
            ProgramEvent::OperatorGameClosed(OperatorGameClosed {
                game_key: r.address()?,
                creator: r.address()?,
                operator: r.address()?,
                refunded_amount: r.u64()?,
                recovered_lamports: r.u64()?,
                timestamp: r.u64()?,
            })
        }
        _ => return Ok(None),
    };
    Ok(Some(event))
}

fn invocation_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$").unwrap())
}

fn completion_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (?:success|failed:)").unwrap())
}

fn data_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^Program data: ((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$").unwrap()
    })
}

/// Only accept events emitted while the requested program owns the active
/// invocation frame.
pub fn get_trusted_program_data<S: AsRef<str>>(logs: &[S], program_id: &str) -> Vec<Vec<u8>> {
    let mut stack: Vec<Option<String>> = Vec::new();
    let mut result = Vec::new();
    for log in logs {
        let log = log.as_ref();
        if let Some(caps) = invocation_re().captures(log) {
            let depth = match caps[2].parse::<u64>() {
                Ok(depth) if (1..=64).contains(&depth) => depth as usize,
                _ => continue,
            };
            stack.resize(depth - 1, None);
            stack.push(Some(caps[1].to_string()));
            continue;
        }
        if let Some(caps) = completion_re().captures(log) {
            if matches!(stack.last(), Some(Some(top)) if top == &caps[1]) {
                stack.pop();
            }
            continue;
        }
        if !matches!(stack.last(), Some(Some(top)) if top == program_id) {
            continue;
        }
        let Some(caps) = data_re().captures(log) else { continue };
        let encoded = &caps[1];
        if encoded.is_empty() {
            continue;
        }
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) {
            if bytes.len() >= 8 {
                result.push(bytes);
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn discriminators_match_idl() {
        for json in [include_str!("../idl/timba-v0.2.0.json"), include_str!("../idl/timba-v0.3.0.json")] {
            let idl: Value = serde_json::from_str(json).unwrap();
            for event in idl["events"].as_array().unwrap() {
                let bytes: Vec<u8> =
                    event["discriminator"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u8).collect();
                let expected = match event["name"].as_str().unwrap() {
                    "GameInitialized" => discriminators::GAME_INITIALIZED,
                    "GameCompleted" => discriminators::GAME_COMPLETED,
                    "GameClosed" => discriminators::GAME_CLOSED,
                    "PlayerJoined" => discriminators::PLAYER_JOINED,
                    "PlayerUnjoined" => discriminators::PLAYER_UNJOINED,
                    "TokenFeeWithdrawn" => discriminators::TOKEN_FEE_WITHDRAWN,
                    "OperatorGameClosed" => discriminators::OPERATOR_GAME_CLOSED,
                    _ => continue,
                };
                assert_eq!(bytes, expected);
            }
        }
    }

    fn membership_bytes(disc: [u8; 8], moved: Option<Option<[u8; 32]>>) -> Vec<u8> {
        let mut data = disc.to_vec();
        data.extend_from_slice(&[1; 32]);
        data.extend_from_slice(&[2; 32]);
        data.extend_from_slice(&50u64.to_le_bytes());
        data.extend_from_slice(&3u32.to_le_bytes());
        data.extend_from_slice(&1u32.to_le_bytes());
        match moved {
            None => {}
            Some(None) => data.push(0),
            Some(Some(addr)) => {
                data.push(1);
                data.extend_from_slice(&addr);
            }
        }
        data.extend_from_slice(&99u64.to_le_bytes());
        data.extend_from_slice(&1234u64.to_le_bytes());
        data
    }

    #[test]
    fn decodes_membership_variants() {
        let joined = membership_bytes(discriminators::PLAYER_JOINED, None);
        assert_eq!(joined.len(), 104);
        let Some(ProgramEvent::PlayerJoined(event)) = decode_program_event(&joined).unwrap() else { panic!() };
        assert_eq!((event.ticket_index, event.last_slot, event.timestamp), (1, 99, 1234));

        let legacy = membership_bytes(discriminators::PLAYER_UNJOINED, None);
        let Some(ProgramEvent::PlayerUnjoined(event)) = decode_program_event(&legacy).unwrap() else { panic!() };
        assert_eq!(event.moved_participant, None);

        let none = membership_bytes(discriminators::PLAYER_UNJOINED, Some(None));
        assert_eq!(none.len(), 105);
        let Some(ProgramEvent::PlayerUnjoined(event)) = decode_program_event(&none).unwrap() else { panic!() };
        assert_eq!((event.moved_participant, event.timestamp), (None, 1234));

        let moved = membership_bytes(discriminators::PLAYER_UNJOINED, Some(Some([7; 32])));
        assert_eq!(moved.len(), 137);
        let Some(ProgramEvent::PlayerUnjoined(event)) = decode_program_event(&moved).unwrap() else { panic!() };
        assert_eq!(event.moved_participant, Some(Address([7; 32])));
        assert_eq!(event.last_slot, 99);

        let mut bad = none.clone();
        bad[88] = 2;
        assert!(decode_program_event(&bad).is_err());
        assert!(decode_program_event(&joined[..100]).is_err());
        assert_eq!(decode_program_event(&[0u8; 16]).unwrap(), None);
    }

    #[test]
    fn trusted_program_data_respects_invocation_frames() {
        let program = "32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5";
        let other = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        let payload = base64::engine::general_purpose::STANDARD.encode([5u8; 12]);
        let logs = vec![
            format!("Program data: {payload}"),
            format!("Program {program} invoke [1]"),
            format!("Program data: {payload}"),
            format!("Program {other} invoke [2]"),
            format!("Program data: {payload}"),
            format!("Program {other} success"),
            format!("Program data: AAAA"),
            format!("Program data: {payload}"),
            format!("Program {program} success"),
            format!("Program data: {payload}"),
        ];
        let data = get_trusted_program_data(&logs, program);
        assert_eq!(data.len(), 2);
        assert!(data.iter().all(|d| d == &[5u8; 12]));
    }

    fn with_disc(disc: [u8; 8], parts: &[&[u8]]) -> Vec<u8> {
        let mut data = disc.to_vec();
        for part in parts {
            data.extend_from_slice(part);
        }
        data
    }

    fn initialized(game_type: u8, is_private: u8) -> Vec<u8> {
        with_disc(
            discriminators::GAME_INITIALIZED,
            &[
                &[1; 32],
                &[2; 32],
                &[game_type],
                &10u64.to_le_bytes(),
                &20u64.to_le_bytes(),
                &5u32.to_le_bytes(),
                &2u32.to_le_bytes(),
                &[3; 32],
                &[is_private],
                &1_700u64.to_le_bytes(),
                &600u64.to_le_bytes(),
            ],
        )
    }

    #[test]
    fn decodes_fixed_size_events() {
        let Some(ProgramEvent::GameInitialized(event)) = decode_program_event(&initialized(0, 1)).unwrap() else {
            panic!()
        };
        assert_eq!(
            event,
            GameInitialized {
                game_key: Address([1; 32]),
                creator: Address([2; 32]),
                game_type: GameType::Coinflip,
                ticket_amount: 10,
                total_amount: 20,
                max_tickets: 5,
                min_tickets: 2,
                token_mint: Address([3; 32]),
                is_private: true,
                created_at: 1_700,
                timeout: 600,
            }
        );
        let Some(ProgramEvent::GameInitialized(event)) = decode_program_event(&initialized(1, 0)).unwrap() else {
            panic!()
        };
        assert_eq!((event.game_type, event.is_private), (GameType::Giveaway, false));
        for bad in [initialized(2, 0), initialized(0, 2)] {
            assert_eq!(decode_program_event(&bad).unwrap_err().to_string(), "Invalid Timba event enum or boolean");
        }

        let completed = with_disc(
            discriminators::GAME_COMPLETED,
            &[&[1; 32], &[4; 32], &3u32.to_le_bytes(), &90u64.to_le_bytes(), &10u64.to_le_bytes(), &7u64.to_le_bytes()],
        );
        assert_eq!(
            decode_program_event(&completed).unwrap(),
            Some(ProgramEvent::GameCompleted(GameCompleted {
                game_key: Address([1; 32]),
                winner: Address([4; 32]),
                tickets_count: 3,
                winner_amount: 90,
                fee_amount: 10,
                timestamp: 7,
            }))
        );

        let closed = with_disc(discriminators::GAME_CLOSED, &[&[1; 32], &8u64.to_le_bytes()]);
        assert_eq!(
            decode_program_event(&closed).unwrap(),
            Some(ProgramEvent::GameClosed(GameClosed { game_key: Address([1; 32]), timestamp: 8 }))
        );

        let withdrawn = with_disc(discriminators::TOKEN_FEE_WITHDRAWN, &[&[5; 32], &[3; 32], &42u64.to_le_bytes()]);
        assert_eq!(
            decode_program_event(&withdrawn).unwrap(),
            Some(ProgramEvent::TokenFeeWithdrawn(TokenFeeWithdrawn {
                operator: Address([5; 32]),
                token_mint: Address([3; 32]),
                amount: 42,
            }))
        );

        let operator_closed = with_disc(
            discriminators::OPERATOR_GAME_CLOSED,
            &[&[1; 32], &[2; 32], &[5; 32], &30u64.to_le_bytes(), &40u64.to_le_bytes(), &9u64.to_le_bytes()],
        );
        assert_eq!(
            decode_program_event(&operator_closed).unwrap(),
            Some(ProgramEvent::OperatorGameClosed(OperatorGameClosed {
                game_key: Address([1; 32]),
                creator: Address([2; 32]),
                operator: Address([5; 32]),
                refunded_amount: 30,
                recovered_lamports: 40,
                timestamp: 9,
            }))
        );

        // Lengths are exact for every fixed-size event.
        for data in [&completed, &closed, &withdrawn, &operator_closed, &initialized(0, 0)] {
            assert_eq!(
                decode_program_event(&data[..data.len() - 1]).unwrap_err().to_string(),
                "Invalid Timba event length"
            );
        }
        assert_eq!(decode_program_event(&[1, 2, 3]).unwrap(), None);
    }

    #[test]
    fn names_and_game_keys() {
        let membership = PlayerMembership {
            game_key: Address([1; 32]),
            player: Address([2; 32]),
            total_amount: 0,
            tickets_count: 1,
            ticket_index: 0,
            moved_participant: None,
            last_slot: 0,
            timestamp: 0,
        };
        let Some(initialized) = decode_program_event(&initialized(0, 0)).unwrap() else { panic!() };
        let events = [
            (initialized, "GameInitialized", Some(Address([1; 32]))),
            (
                ProgramEvent::GameCompleted(GameCompleted {
                    game_key: Address([1; 32]),
                    winner: Address([2; 32]),
                    tickets_count: 1,
                    winner_amount: 0,
                    fee_amount: 0,
                    timestamp: 0,
                }),
                "GameCompleted",
                Some(Address([1; 32])),
            ),
            (
                ProgramEvent::GameClosed(GameClosed { game_key: Address([1; 32]), timestamp: 0 }),
                "GameClosed",
                Some(Address([1; 32])),
            ),
            (ProgramEvent::PlayerJoined(membership.clone()), "PlayerJoined", Some(Address([1; 32]))),
            (ProgramEvent::PlayerUnjoined(membership), "PlayerUnjoined", Some(Address([1; 32]))),
            (
                ProgramEvent::TokenFeeWithdrawn(TokenFeeWithdrawn {
                    operator: Address([5; 32]),
                    token_mint: Address([3; 32]),
                    amount: 1,
                }),
                "TokenFeeWithdrawn",
                None,
            ),
            (
                ProgramEvent::OperatorGameClosed(OperatorGameClosed {
                    game_key: Address([1; 32]),
                    creator: Address([2; 32]),
                    operator: Address([5; 32]),
                    refunded_amount: 0,
                    recovered_lamports: 0,
                    timestamp: 0,
                }),
                "OperatorGameClosed",
                Some(Address([1; 32])),
            ),
        ];
        for (event, name, key) in events {
            assert_eq!(event.name(), name);
            assert_eq!(event.game_key().copied(), key, "{name}");
        }
    }

    #[test]
    fn trusted_program_data_ignores_invalid_frames_and_payloads() {
        let program = "32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5";
        let payload = base64::engine::general_purpose::STANDARD.encode([5u8; 12]);
        let logs = vec![
            // Depths outside 1..=64 are not invocation frames.
            format!("Program {program} invoke [0]"),
            format!("Program data: {payload}"),
            format!("Program {program} invoke [65]"),
            format!("Program data: {payload}"),
            format!("Program {program} invoke [1]"),
            "Program data: ".to_string(),
            "Program data: not base64!".to_string(),
            "Program log: hello".to_string(),
            format!("Program data: {payload}"),
            format!("Program {program} failed: custom error"),
            format!("Program data: {payload}"),
        ];
        assert_eq!(get_trusted_program_data(&logs, program), vec![vec![5u8; 12]]);
    }
}
