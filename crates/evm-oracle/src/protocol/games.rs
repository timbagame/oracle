//! Chain-neutral game lifecycle decisions used by the EVM oracle (`games/index.ts`,
//! `games/workflows.ts`).

use alloy_primitives::{Address, B256};
use serde_json::{json, Value};

use super::abi::Game;
use super::schema::MAX_SAFE_INTEGER;

/// `{ chain: "evm", chainId, deployment, gameId }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvmGameReference {
    pub chain_id: u64,
    pub deployment: Address,
    pub game_id: B256,
}

impl EvmGameReference {
    /// JSON form with bigint values as decimal strings.
    pub fn to_json(&self) -> Value {
        json!({
            "chain": "evm",
            "chainId": self.chain_id.to_string(),
            "deployment": self.deployment.to_checksum(None),
            "gameId": self.game_id.to_string(),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GameStatus {
    Open,
    Completed,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GameType {
    Coinflip,
    Giveaway,
}

impl GameType {
    pub fn from_code(value: u8) -> anyhow::Result<Self> {
        match value {
            0 => Ok(Self::Coinflip),
            1 => Ok(Self::Giveaway),
            _ => anyhow::bail!("Unknown game type"),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Coinflip => "coinflip",
            Self::Giveaway => "giveaway",
        }
    }
}

/// The subset of `NormalizedGame` that lifecycle decisions read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedGame {
    pub reference: EvmGameReference,
    pub status: GameStatus,
    pub game_type: GameType,
    pub minimum_participants: u32,
    pub maximum_participants: u32,
    pub participant_count: usize,
    pub expires_at: u64,
}

/// Unknown (never created) games observe as `None`.
pub fn observe_evm_game(reference: EvmGameReference, account: &Game) -> anyhow::Result<Option<NormalizedGame>> {
    let status = match account.status {
        0 => return Ok(None),
        1 => GameStatus::Open,
        2 => GameStatus::Completed,
        3 => GameStatus::Closed,
        _ => anyhow::bail!("Unknown game status"),
    };
    Ok(Some(NormalizedGame {
        reference,
        status,
        game_type: GameType::from_code(account.gameType)?,
        minimum_participants: account.minPlayers,
        maximum_participants: account.maxPlayers,
        participant_count: account.participants.len(),
        expires_at: account.expiresAt,
    }))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Lifecycle {
    pub expired: bool,
    pub recovery_at: u128,
    pub can_join: bool,
    pub can_settle: bool,
    pub can_refund: bool,
}

/// Derived from the current Oracle buffer. Never cache this as a creation-time economic term.
pub fn game_lifecycle(game: &NormalizedGame, now: u64, buffer: u64) -> anyhow::Result<Lifecycle> {
    if buffer == 0 {
        anyhow::bail!("Invalid time or buffer");
    }
    let now = u128::from(now);
    let expires_at = u128::from(game.expires_at);
    let expired = now >= expires_at;
    let recovery_at = expires_at + u128::from(buffer);
    let count = game.participant_count as u128;
    let ready =
        count == u128::from(game.maximum_participants) || (count >= u128::from(game.minimum_participants) && expired);
    let open = game.status == GameStatus::Open;
    Ok(Lifecycle {
        expired,
        recovery_at,
        can_join: open && !expired && count < u128::from(game.maximum_participants),
        can_settle: open && ready && now < recovery_at,
        can_refund: open && expired && (!ready || now >= recovery_at),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionProgress {
    AwaitingWallet,
    Submitted,
    Confirmed,
    Failed,
}

/// Receipt summary: success flag and confirmation count (may be negative on a lagging RPC).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReceiptProgress {
    pub success: bool,
    pub confirmations: i128,
}

pub fn transaction_progress(receipt: Option<ReceiptProgress>, required: u32) -> anyhow::Result<ActionProgress> {
    if required < 1 {
        anyhow::bail!("Invalid confirmation depth");
    }
    Ok(match receipt {
        Some(receipt) if receipt.confirmations >= i128::from(required) => {
            if receipt.success {
                ActionProgress::Confirmed
            } else {
                ActionProgress::Failed
            }
        }
        _ => ActionProgress::Submitted,
    })
}

/// Joined or refunded participant, as normalized by `normalizeEvmMembership`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MembershipChange {
    pub reference: EvmGameReference,
    pub joined: bool,
    pub player: Address,
    pub index: u64,
    pub moved_participant: Option<Address>,
}

pub(crate) fn safe_index(value: alloy_primitives::U256) -> anyhow::Result<u64> {
    if value > alloy_primitives::U256::from(MAX_SAFE_INTEGER) {
        anyhow::bail!("Invalid participant index");
    }
    Ok(value.to::<u64>())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_codes_and_indexes_the_contract_never_produces() {
        let reference = EvmGameReference { chain_id: 1, deployment: Address::ZERO, game_id: B256::ZERO };
        let account = |status: u8, game_type: u8| Game {
            creator: Address::ZERO,
            token: Address::ZERO,
            gameType: game_type,
            status,
            isPrivate: false,
            minPlayers: 2,
            maxPlayers: 2,
            expiresAt: 0,
            ticketAmount: alloy_primitives::U256::ZERO,
            totalAmount: alloy_primitives::U256::ZERO,
            commitment: B256::ZERO,
            lastEntryBlock: alloy_primitives::U256::ZERO,
            participants: vec![],
        };
        let closed = observe_evm_game(reference.clone(), &account(3, 1)).unwrap().unwrap();
        assert_eq!((closed.status, closed.game_type), (GameStatus::Closed, GameType::Giveaway));
        let unknown_status = account(4, 0);
        assert_eq!(
            observe_evm_game(reference.clone(), &unknown_status).unwrap_err().to_string(),
            "Unknown game status"
        );
        let unknown_type = account(1, 2);
        assert_eq!(observe_evm_game(reference, &unknown_type).unwrap_err().to_string(), "Unknown game type");
        let max = alloy_primitives::U256::from(MAX_SAFE_INTEGER);
        assert_eq!(safe_index(max).unwrap(), MAX_SAFE_INTEGER as u64);
        assert_eq!(
            safe_index(max + alloy_primitives::U256::from(1)).unwrap_err().to_string(),
            "Invalid participant index"
        );
    }

    fn game(count: usize, min: u32, max: u32, expires_at: u64) -> NormalizedGame {
        NormalizedGame {
            reference: EvmGameReference { chain_id: 1, deployment: Address::ZERO, game_id: B256::ZERO },
            status: GameStatus::Open,
            game_type: GameType::Giveaway,
            minimum_participants: min,
            maximum_participants: max,
            participant_count: count,
            expires_at,
        }
    }

    #[test]
    fn lifecycle_settles_full_or_expired_ready_games_before_recovery() {
        let full = game_lifecycle(&game(2, 2, 2, 100), 50, 10).unwrap();
        assert!(full.can_settle && !full.can_join && !full.expired);
        let waiting = game_lifecycle(&game(1, 2, 2, 100), 50, 10).unwrap();
        assert!(!waiting.can_settle && waiting.can_join);
        let expired_ready = game_lifecycle(&game(2, 2, 3, 100), 105, 10).unwrap();
        assert!(expired_ready.can_settle && !expired_ready.can_refund);
        let recovery = game_lifecycle(&game(2, 2, 3, 100), 110, 10).unwrap();
        assert!(!recovery.can_settle && recovery.can_refund);
        let short = game_lifecycle(&game(1, 2, 3, 100), 100, 10).unwrap();
        assert!(short.can_refund && !short.can_settle);
        assert!(game_lifecycle(&game(1, 1, 1, 1), 0, 0).is_err());
    }

    #[test]
    fn transaction_progress_requires_depth() {
        let receipt = |success, confirmations| Some(ReceiptProgress { success, confirmations });
        assert_eq!(transaction_progress(None, 2).unwrap(), ActionProgress::Submitted);
        assert_eq!(transaction_progress(receipt(true, 1), 2).unwrap(), ActionProgress::Submitted);
        assert_eq!(transaction_progress(receipt(true, 2), 2).unwrap(), ActionProgress::Confirmed);
        assert_eq!(transaction_progress(receipt(false, 3), 2).unwrap(), ActionProgress::Failed);
        assert_eq!(transaction_progress(receipt(true, -1), 1).unwrap(), ActionProgress::Submitted);
        assert!(transaction_progress(None, 0).is_err());
    }
}
