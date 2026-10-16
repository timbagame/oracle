//! Normalized game events decoded from contract logs (`evm/v0.1.0/events.ts`,
//! `games/events.ts`).

use alloy_primitives::{Address, Bytes, B256, U256};
use alloy_sol_types::SolEventInterface;
use serde_json::{json, Value};

use super::abi::TimbaEvents;
use super::client::{evm_domain, EvmDeployment};
use super::games::{safe_index, EvmGameReference, GameType, MembershipChange};

/// Raw log fields needed for decoding, with the chain the log was read from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvmLog {
    pub chain_id: u64,
    pub address: Address,
    pub data: Bytes,
    pub topics: Vec<B256>,
    pub removed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NormalizedGameEvent {
    Created {
        reference: EvmGameReference,
        creator: Address,
        token: Address,
        game_type: GameType,
        ticket_amount: U256,
        total_amount: U256,
        minimum_participants: u32,
        maximum_participants: u32,
        expires_at: u64,
        is_private: bool,
        commitment: B256,
    },
    Membership {
        change: MembershipChange,
        amount: Option<U256>,
    },
    Completed {
        reference: EvmGameReference,
        winner: Address,
        prize: U256,
        fee: U256,
        secret: B256,
    },
    Closed {
        reference: EvmGameReference,
        creator: Address,
        refund_amount: U256,
    },
}

fn checksum(address: &Address) -> String {
    address.to_checksum(None)
}

impl NormalizedGameEvent {
    /// The JSON shape the TypeScript service persisted (bigints as decimal strings).
    pub fn to_json(&self) -> Value {
        match self {
            Self::Created {
                reference,
                creator,
                token,
                game_type,
                ticket_amount,
                total_amount,
                minimum_participants,
                maximum_participants,
                expires_at,
                is_private,
                commitment,
            } => json!({
                "kind": "created",
                "reference": reference.to_json(),
                "creator": checksum(creator),
                "token": checksum(token),
                "gameType": game_type.as_str(),
                "ticketAmount": ticket_amount.to_string(),
                "totalAmount": total_amount.to_string(),
                "minimumParticipants": minimum_participants,
                "maximumParticipants": maximum_participants,
                "expiresAt": expires_at.to_string(),
                "isPrivate": is_private,
                "commitment": commitment.to_string(),
            }),
            Self::Membership { change, amount } => json!({
                "reference": change.reference.to_json(),
                "kind": if change.joined { "joined" } else { "refunded" },
                "player": checksum(&change.player),
                "index": change.index,
                "movedParticipant": change.moved_participant.as_ref().map(checksum),
                "amount": amount.map(|amount| amount.to_string()),
            }),
            Self::Completed { reference, winner, prize, fee, secret } => json!({
                "kind": "completed",
                "reference": reference.to_json(),
                "winner": checksum(winner),
                "prize": prize.to_string(),
                "fee": fee.to_string(),
                "secret": secret.to_string(),
            }),
            Self::Closed { reference, creator, refund_amount } => json!({
                "kind": "closed",
                "reference": reference.to_json(),
                "creator": checksum(creator),
                "refundAmount": refund_amount.to_string(),
                "closedBy": null,
            }),
        }
    }
}

/// Require logs from the selected chain; removed logs must be rolled back by the indexer.
pub fn decode_evm_game_event(deployment: &EvmDeployment, log: &EvmLog) -> anyhow::Result<Option<NormalizedGameEvent>> {
    evm_domain(deployment)?;
    if log.chain_id != deployment.chain_id {
        anyhow::bail!("Log belongs to another chain");
    }
    if log.address != deployment.address {
        return Ok(None);
    }
    if log.removed {
        anyhow::bail!("Removed log requires rollback");
    }
    match log.topics.first() {
        Some(topic) if TimbaEvents::SELECTORS.contains(&topic.0) => {}
        _ => return Ok(None),
    }
    let event = TimbaEvents::decode_raw_log(&log.topics, &log.data)?;
    let reference =
        |game_id: B256| EvmGameReference { chain_id: deployment.chain_id, deployment: deployment.address, game_id };
    Ok(Some(match event {
        TimbaEvents::GameCreated(created) => {
            let request = created.request;
            let game_type = GameType::from_code(request.gameType)?;
            NormalizedGameEvent::Created {
                reference: reference(created.gameId),
                creator: request.creator,
                token: request.token,
                game_type,
                ticket_amount: if game_type == GameType::Coinflip { request.amount } else { U256::ZERO },
                total_amount: if game_type == GameType::Giveaway { request.amount } else { U256::ZERO },
                minimum_participants: request.minPlayers,
                maximum_participants: request.maxPlayers,
                expires_at: created.expiresAt,
                is_private: request.isPrivate,
                commitment: request.commitment,
            }
        }
        TimbaEvents::PlayerJoined(joined) => NormalizedGameEvent::Membership {
            change: MembershipChange {
                reference: reference(joined.gameId),
                joined: true,
                player: joined.player,
                index: safe_index(joined.index)?,
                moved_participant: None,
            },
            amount: None,
        },
        TimbaEvents::PlayerRefunded(refunded) => NormalizedGameEvent::Membership {
            change: MembershipChange {
                reference: reference(refunded.gameId),
                joined: false,
                player: refunded.player,
                index: safe_index(refunded.removedIndex)?,
                moved_participant: (!refunded.movedParticipant.is_zero()).then_some(refunded.movedParticipant),
            },
            amount: Some(refunded.amount),
        },
        TimbaEvents::GameCompleted(completed) => NormalizedGameEvent::Completed {
            reference: reference(completed.gameId),
            winner: completed.winner,
            prize: completed.prize,
            fee: completed.fee,
            secret: completed.secret,
        },
        TimbaEvents::GameClosed(closed) => NormalizedGameEvent::Closed {
            reference: reference(closed.gameId),
            creator: closed.creator,
            refund_amount: closed.refund,
        },
        // Events without a gameId are not game events.
        _ => return Ok(None),
    }))
}
