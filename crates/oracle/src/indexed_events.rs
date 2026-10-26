//! Trusted program log parsing into indexer/listener events (port of
//! `parseTransactionEvents` from `indexer/solana.ts`).

use serde::Serialize;
use timba_protocol::events::{decode_program_event, get_trusted_program_data, ProgramEvent};

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameCreatedEvent {
    pub game_key: String,
    pub creator: String,
    pub game_type: String,
    pub ticket_amount: u64,
    pub total_amount: u64,
    pub max_tickets: u32,
    pub min_tickets: u32,
    pub token_mint: String,
    pub is_private: bool,
    pub created_at: u64,
    pub timeout: u64,
    pub signature: String,
    pub slot: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameCompletedEvent {
    pub game_key: String,
    pub winner: String,
    pub tickets_count: u32,
    pub winner_amount: u64,
    pub fee_amount: u64,
    pub timestamp: u64,
    pub signature: String,
    pub slot: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameClosedEvent {
    pub game_key: String,
    pub timestamp: u64,
    pub operator: bool,
    pub signature: String,
    pub slot: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MembershipKind {
    Joined,
    /// Kept as `unjoined` on the wire until services move to the new name.
    #[serde(rename = "unjoined")]
    Refunded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerMembershipEvent {
    pub kind: MembershipKind,
    pub game_key: String,
    pub player: String,
    pub tickets_count: u32,
    pub ticket_index: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moved_participant: Option<String>,
    pub timestamp: u64,
    pub signature: String,
    pub slot: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IndexedEvents {
    pub initialized: Vec<GameCreatedEvent>,
    pub completed: Vec<GameCompletedEvent>,
    pub closed: Vec<GameClosedEvent>,
    pub membership: Vec<PlayerMembershipEvent>,
}

impl IndexedEvents {
    pub fn extend(&mut self, other: IndexedEvents) {
        self.initialized.extend(other.initialized);
        self.completed.extend(other.completed);
        self.closed.extend(other.closed);
        self.membership.extend(other.membership);
    }

    pub fn is_empty(&self) -> bool {
        self.initialized.is_empty() && self.completed.is_empty() && self.closed.is_empty() && self.membership.is_empty()
    }
}

fn safe(value: u64) -> Result<u64, String> {
    if value > MAX_SAFE_INTEGER {
        return Err("Event field exceeds the safe integer range".into());
    }
    Ok(value)
}

pub fn parse_transaction_events<S: AsRef<str>>(
    signature: &str,
    slot: u64,
    logs: &[S],
    program_id: &str,
) -> Result<IndexedEvents, String> {
    let mut events = IndexedEvents::default();
    for data in get_trusted_program_data(logs, program_id) {
        let wrap = |message: String| format!("Invalid Timba event in {signature}: {message}");
        let event = decode_program_event(&data).map_err(|e| wrap(e.to_string()))?;
        let Some(event) = event else { continue };
        let signature = signature.to_string();
        let joined = matches!(event, ProgramEvent::PlayerJoined(_));
        match event {
            ProgramEvent::GameCreated(v) => events.initialized.push(GameCreatedEvent {
                game_key: v.game_key.to_base58(),
                creator: v.creator.to_base58(),
                game_type: v.game_type.name().into(),
                ticket_amount: safe(v.ticket_amount).map_err(wrap)?,
                total_amount: safe(v.total_amount).map_err(wrap)?,
                max_tickets: v.max_tickets,
                min_tickets: v.min_tickets,
                token_mint: v.token_mint.to_base58(),
                is_private: v.is_private,
                created_at: safe(v.created_at).map_err(wrap)?,
                timeout: safe(v.timeout).map_err(wrap)?,
                signature,
                slot,
            }),
            ProgramEvent::GameCompleted(v) => events.completed.push(GameCompletedEvent {
                game_key: v.game_key.to_base58(),
                winner: v.winner.to_base58(),
                tickets_count: v.tickets_count,
                winner_amount: safe(v.winner_amount).map_err(wrap)?,
                fee_amount: safe(v.fee_amount).map_err(wrap)?,
                timestamp: safe(v.timestamp).map_err(wrap)?,
                signature,
                slot,
            }),
            ProgramEvent::GameClosed(v) => events.closed.push(GameClosedEvent {
                game_key: v.game_key.to_base58(),
                timestamp: safe(v.timestamp).map_err(wrap)?,
                operator: false,
                signature,
                slot,
            }),
            ProgramEvent::OperatorGameClosed(v) => events.closed.push(GameClosedEvent {
                game_key: v.game_key.to_base58(),
                timestamp: safe(v.timestamp).map_err(wrap)?,
                operator: true,
                signature,
                slot,
            }),
            ProgramEvent::PlayerJoined(v) | ProgramEvent::PlayerRefunded(v) => {
                let kind = if joined { MembershipKind::Joined } else { MembershipKind::Refunded };
                events.membership.push(PlayerMembershipEvent {
                    kind,
                    game_key: v.game_key.to_base58(),
                    player: v.player.to_base58(),
                    tickets_count: v.tickets_count,
                    ticket_index: v.ticket_index,
                    moved_participant: v.moved_participant.map(|a| a.to_base58()),
                    timestamp: safe(v.timestamp).map_err(wrap)?,
                    signature,
                    slot,
                });
            }
            ProgramEvent::TokenFeeWithdrawn(_) => {}
        }
    }
    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use timba_protocol::events::discriminators;

    const PROGRAM: &str = "32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5";

    fn logs(payloads: &[Vec<u8>]) -> Vec<String> {
        let mut logs = vec![format!("Program {PROGRAM} invoke [1]")];
        for p in payloads {
            logs.push(format!("Program data: {}", base64::engine::general_purpose::STANDARD.encode(p)));
        }
        logs.push(format!("Program {PROGRAM} success"));
        logs
    }

    fn membership(disc: [u8; 8], tail_flag: Option<u8>) -> Vec<u8> {
        let mut d = disc.to_vec();
        d.extend([1u8; 32]);
        d.extend([2u8; 32]);
        d.extend(10u64.to_le_bytes());
        d.extend(2u32.to_le_bytes());
        d.extend(1u32.to_le_bytes());
        if let Some(flag) = tail_flag {
            d.push(flag);
            if flag == 1 {
                d.extend([3u8; 32]);
            }
        }
        d.extend(5u64.to_le_bytes());
        d.extend(6u64.to_le_bytes());
        d
    }

    #[test]
    fn parses_membership_and_closures() {
        let mut closed = discriminators::GAME_CLOSED.to_vec();
        closed.extend([1u8; 32]);
        closed.extend(9u64.to_le_bytes());
        let events = parse_transaction_events(
            "sig",
            42,
            &logs(&[
                membership(discriminators::PLAYER_JOINED, None),
                membership(discriminators::PLAYER_REFUNDED, Some(1)),
                membership(discriminators::PLAYER_UNJOINED, Some(0)),
                closed,
            ]),
            PROGRAM,
        )
        .unwrap();
        assert_eq!(events.membership.len(), 3);
        assert_eq!(events.membership[0].kind, MembershipKind::Joined);
        assert_eq!(events.membership[1].kind, MembershipKind::Refunded);
        assert!(events.membership[1].moved_participant.is_some());
        assert_eq!(events.membership[2].kind, MembershipKind::Refunded);
        assert_eq!(events.closed[0].timestamp, 9);
        assert!(!events.closed[0].operator);
        assert_eq!(events.closed[0].slot, 42);
    }

    #[test]
    fn malformed_events_fail_with_signature() {
        let mut bad = membership(discriminators::PLAYER_JOINED, None);
        bad.pop();
        let err = parse_transaction_events("sig", 1, &logs(&[bad]), PROGRAM).unwrap_err();
        assert_eq!(err, "Invalid Timba event in sig: Invalid Timba event length");
    }

    fn event(disc: [u8; 8], parts: &[&[u8]]) -> Vec<u8> {
        let mut data = disc.to_vec();
        for part in parts {
            data.extend_from_slice(part);
        }
        data
    }

    fn initialized(ticket_amount: u64) -> Vec<u8> {
        event(
            discriminators::GAME_INITIALIZED,
            &[
                &[1; 32],
                &[2; 32],
                &[1],
                &ticket_amount.to_le_bytes(),
                &20u64.to_le_bytes(),
                &5u32.to_le_bytes(),
                &2u32.to_le_bytes(),
                &[3; 32],
                &[0],
                &1_700u64.to_le_bytes(),
                &600u64.to_le_bytes(),
            ],
        )
    }

    fn b58(byte: u8) -> String {
        timba_protocol::Address([byte; 32]).to_base58()
    }

    #[test]
    fn parses_every_listener_event() {
        let completed = event(
            discriminators::GAME_COMPLETED,
            &[&[1; 32], &[4; 32], &3u32.to_le_bytes(), &90u64.to_le_bytes(), &10u64.to_le_bytes(), &7u64.to_le_bytes()],
        );
        let operator_closed = event(
            discriminators::OPERATOR_GAME_CLOSED,
            &[&[1; 32], &[2; 32], &[5; 32], &30u64.to_le_bytes(), &40u64.to_le_bytes(), &9u64.to_le_bytes()],
        );
        let withdrawn = event(discriminators::TOKEN_FEE_WITHDRAWN, &[&[5; 32], &[3; 32], &42u64.to_le_bytes()]);
        let events = parse_transaction_events(
            "sig",
            42,
            &logs(&[initialized(10), completed, operator_closed, withdrawn, vec![0; 12]]),
            PROGRAM,
        )
        .unwrap();
        assert_eq!(
            events.initialized,
            vec![GameCreatedEvent {
                game_key: b58(1),
                creator: b58(2),
                game_type: timba_protocol::contracts::GameType::Giveaway.name().into(),
                ticket_amount: 10,
                total_amount: 20,
                max_tickets: 5,
                min_tickets: 2,
                token_mint: b58(3),
                is_private: false,
                created_at: 1_700,
                timeout: 600,
                signature: "sig".into(),
                slot: 42,
            }]
        );
        assert_eq!(
            events.completed,
            vec![GameCompletedEvent {
                game_key: b58(1),
                winner: b58(4),
                tickets_count: 3,
                winner_amount: 90,
                fee_amount: 10,
                timestamp: 7,
                signature: "sig".into(),
                slot: 42,
            }]
        );
        assert_eq!(
            events.closed,
            vec![GameClosedEvent { game_key: b58(1), timestamp: 9, operator: true, signature: "sig".into(), slot: 42 }]
        );
        assert!(events.membership.is_empty(), "fee withdrawals and unknown events are ignored");
        assert!(!events.is_empty());

        let mut merged = IndexedEvents::default();
        assert!(merged.is_empty());
        merged.extend(events.clone());
        merged.extend(
            parse_transaction_events("other", 1, &logs(&[membership(discriminators::PLAYER_JOINED, None)]), PROGRAM)
                .unwrap(),
        );
        assert_eq!(merged.initialized.len(), 1);
        assert_eq!(merged.completed.len(), 1);
        assert_eq!(merged.closed.len(), 1);
        assert_eq!(merged.membership.len(), 1);

        let json = serde_json::to_value(&merged.membership[0]).unwrap();
        assert_eq!(json["kind"], "joined");
        assert_eq!(json["ticketIndex"], 1);
        assert!(json.get("movedParticipant").is_none());
    }

    #[test]
    fn rejects_unsafe_integers() {
        let err = parse_transaction_events("sig", 1, &logs(&[initialized(1 << 53)]), PROGRAM).unwrap_err();
        assert_eq!(err, "Invalid Timba event in sig: Event field exceeds the safe integer range");
        assert!(parse_transaction_events("sig", 1, &logs(&[initialized((1 << 53) - 1)]), PROGRAM).is_ok());
    }
}
