//! Finalized game verification from chain history (port of
//! `web-api/verification.ts`). Only finalized, complete, internally
//! consistent chain records produce a verification record.

use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use indexmap::IndexMap;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use timba_protocol::contracts::{discriminators::COMPLETE_GAME, find_game_pda, PROGRAM_ID};
use timba_protocol::events::{
    decode_program_event, get_trusted_program_data, GameCompleted, GameInitialized, ProgramEvent,
};
use timba_protocol::randomness::calculate_winner;
use timba_protocol::validators::is_solana_signature;
use timba_protocol::Address;

use super::game_token_config::get_game_token_metadata;
use super::token_utils::{get_token_symbol, tokens_to_amount};
use crate::indexer::schema::{array, parse, Schema};
use crate::solana::rpc::SignatureInfo;
use crate::solana::RpcPool;

const TIMEOUT: Duration = Duration::from_secs(120);
const HISTORY_PAGES: usize = 20;
const HISTORY_PAGE_SIZE: u32 = 100;

/// `isValidSignature`.
pub fn is_valid_signature(value: &str) -> bool {
    is_solana_signature(value)
}

static GAME_TYPE: Schema = Schema::Enum(&["coinflip", "giveaway"]);
static ADDRESS: Schema = Schema::Address;
static BOOL: Schema = Schema::Bool;
static NON_NEGATIVE_NUMBER: Schema = Schema::NonNegativeNumber;
static NON_NEGATIVE_INTEGER: Schema = Schema::NonNegativeInteger;
static SIGNATURE: Schema = Schema::Signature;
static PARTICIPANT: Schema = Schema::Object(&[
    ("address", Schema::Address),
    ("ticketCount", Schema::NonNegativeInteger),
    ("ticketIndices", array(&NON_NEGATIVE_INTEGER)),
]);

/// `FinalizedVerifiedGameSchema` (`VerifiedGameSchema` with the proof fields required).
pub static FINALIZED_VERIFIED_GAME: Schema = Schema::Object(&[
    ("gameKey", Schema::Address),
    ("signature", Schema::Signature),
    ("timestamp", Schema::NonNegativeInteger),
    ("gameType", Schema::Optional(&GAME_TYPE)),
    ("creator", Schema::Optional(&ADDRESS)),
    ("isPrivate", Schema::Optional(&BOOL)),
    ("ticketAmount", Schema::Optional(&NON_NEGATIVE_NUMBER)),
    ("totalAmount", Schema::Optional(&NON_NEGATIVE_NUMBER)),
    ("maxTickets", Schema::Optional(&NON_NEGATIVE_INTEGER)),
    ("createdAt", Schema::Optional(&NON_NEGATIVE_INTEGER)),
    ("participants", array(&PARTICIPANT)),
    ("totalTickets", Schema::NonNegativeInteger),
    ("winner", Schema::Address),
    ("winnerTicketIndex", Schema::NonNegativeInteger),
    ("prizeAmount", Schema::NonNegativeNumber),
    ("feeAmount", Schema::NonNegativeNumber),
    ("tokenMint", Schema::Address),
    ("tokenSymbol", Schema::NonEmptyString),
    ("tokenDecimals", Schema::IntegerRange(0, 255)),
    ("randomValue", Schema::U64String),
    ("secretKey", Schema::Hex32),
    ("randomHash", Schema::Hex32),
    ("transactionSignatures", Schema::Array { item: &SIGNATURE, min: 1, max: 2001 }),
    ("lastSlot", Schema::U64String),
    (
        "calculationBreakdown",
        Schema::Object(&[
            ("randomValue", Schema::U64String),
            ("totalTickets", Schema::NonNegativeInteger),
            ("winnerIndex", Schema::NonNegativeInteger),
            ("formula", Schema::NonEmptyString),
        ]),
    ),
    ("explorerUrl", Schema::Url),
]);

/// Replays joins and swap-remove unjoins in transaction and log order;
/// timestamps are not an ordering key. Returns the participants and the
/// last membership slot.
pub fn replay_participants(events: &[ProgramEvent], game_key: &Address) -> Result<(Vec<Address>, u64)> {
    let mut participants: Vec<Address> = Vec::new();
    let mut last_slot = 0u64;
    for event in events {
        if event.game_key() != Some(game_key) {
            continue;
        }
        let membership = match event {
            ProgramEvent::PlayerJoined(joined) => {
                if joined.ticket_index as usize != participants.len() {
                    bail!("Incomplete join history");
                }
                participants.push(joined.player);
                joined
            }
            ProgramEvent::PlayerUnjoined(unjoined) => {
                let index = unjoined.ticket_index as usize;
                if participants.get(index) != Some(&unjoined.player) {
                    bail!("Incomplete unjoin history");
                }
                let last = participants.pop().expect("non-empty");
                if index < participants.len() {
                    participants[index] = last;
                }
                unjoined
            }
            _ => continue,
        };
        last_slot = membership.last_slot;
        if participants.len() != membership.tickets_count as usize {
            bail!("Incomplete ticket history");
        }
    }
    Ok((participants, last_slot))
}

struct FinalizedTransaction {
    slot: u64,
    logs: Vec<String>,
    raw: Value,
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// A successful transaction with logs (`tx?.meta && !meta.err && meta.logMessages`).
fn finalized_transaction(raw: Value) -> Option<FinalizedTransaction> {
    let meta = raw.get("meta").filter(|meta| js_truthy(meta))?;
    if meta.get("err").is_some_and(js_truthy) {
        return None;
    }
    let logs: Vec<String> =
        meta.get("logMessages")?.as_array()?.iter().map(|log| log.as_str().unwrap_or_default().to_string()).collect();
    let slot = raw.get("slot").and_then(Value::as_u64).unwrap_or(0);
    Some(FinalizedTransaction { slot, logs, raw })
}

async fn load_transaction(rpc: &RpcPool, signature: &str) -> Result<Option<FinalizedTransaction>> {
    let raw = rpc
        .request(
            "getTransaction",
            json!([signature, { "commitment": "finalized", "encoding": "json", "maxSupportedTransactionVersion": 0 }]),
        )
        .await?;
    Ok(finalized_transaction(raw))
}

fn decode_events(logs: &[String], program_id: &str) -> Result<Vec<ProgramEvent>> {
    let mut events = Vec::new();
    for data in get_trusted_program_data(logs, program_id) {
        if let Some(event) = decode_program_event(&data).map_err(|error| anyhow!("{error}"))? {
            events.push(event);
        }
    }
    Ok(events)
}

fn account_keys(raw: &Value) -> Vec<String> {
    let strings = |value: &Value| -> Vec<String> {
        value
            .as_array()
            .map(|list| list.iter().map(|k| k.as_str().unwrap_or_default().to_string()).collect())
            .unwrap_or_default()
    };
    let mut keys = strings(&raw["transaction"]["message"]["accountKeys"]);
    keys.extend(strings(&raw["meta"]["loadedAddresses"]["writable"]));
    keys.extend(strings(&raw["meta"]["loadedAddresses"]["readonly"]));
    keys
}

struct Reveal {
    commitment: [u8; 32],
    secret: [u8; 32],
    submitted_winner: u32,
}

/// The revealed commitment of the `complete_game` instruction for `game_key`.
fn find_reveal(raw: &Value, program_id: &str, game_key: &str) -> Result<Option<Reveal>> {
    let keys = account_keys(raw);
    let key_at = |index: Option<u64>| index.and_then(|i| keys.get(i as usize)).map(String::as_str);
    let empty = Vec::new();
    let instructions = raw["transaction"]["message"]["instructions"].as_array().unwrap_or(&empty);
    for instruction in instructions {
        if key_at(instruction["programIdIndex"].as_u64()) != Some(program_id)
            || key_at(instruction["accounts"][0].as_u64()) != Some(game_key)
        {
            continue;
        }
        let encoded = instruction["data"].as_str().unwrap_or_default();
        let data = bs58::decode(encoded).into_vec().map_err(|error| anyhow!("Invalid instruction data: {error}"))?;
        if data.len() < 76 || data[..8] != COMPLETE_GAME {
            continue;
        }
        return Ok(Some(Reveal {
            commitment: data[8..40].try_into().expect("32 bytes"),
            secret: data[40..72].try_into().expect("32 bytes"),
            submitted_winner: u32::from_le_bytes(data[72..76].try_into().expect("4 bytes")),
        }));
    }
    Ok(None)
}

/// `verifyGameTransaction`: reconstructs and checks a finalized completion,
/// bounded by a 120 second budget.
pub async fn verify_game_transaction(rpc: &RpcPool, program_id: &Address, value: &str) -> Result<Value> {
    if !is_valid_signature(value) {
        bail!("Invalid signature");
    }
    tokio::time::timeout(TIMEOUT, verify(rpc, program_id, value))
        .await
        .map_err(|_| anyhow!("The operation was aborted due to timeout"))?
}

async fn verify(rpc: &RpcPool, program_id: &Address, value: &str) -> Result<Value> {
    let program = program_id.to_base58();
    let completed_tx =
        load_transaction(rpc, value).await?.ok_or_else(|| anyhow!("Finalized transaction unavailable"))?;
    let completed: GameCompleted = decode_events(&completed_tx.logs, &program)?
        .into_iter()
        .find_map(|event| match event {
            ProgramEvent::GameCompleted(completed) => Some(completed),
            _ => None,
        })
        .ok_or_else(|| anyhow!("Not a completed game"))?;
    let game_key = completed.game_key.to_base58();

    let reveal = find_reveal(&completed_tx.raw, &program, &game_key)?;
    let Some(Reveal { commitment, secret, submitted_winner }) = reveal.filter(|reveal| {
        Sha256::digest(reveal.secret).as_slice() == reveal.commitment
            && find_game_pda(&reveal.commitment, &PROGRAM_ID) == completed.game_key
    }) else {
        bail!("Invalid revealed commitment");
    };

    let completed_slot = completed_tx.slot;
    let mut transactions: IndexMap<String, FinalizedTransaction> = IndexMap::new();
    transactions.insert(value.to_string(), completed_tx);
    let mut before: Option<String> = None;
    let mut initialized: Option<GameInitialized> = None;
    // Bounded backfill. Refuse to invent a result if archived history exceeds the budget or is missing.
    for _ in 0..HISTORY_PAGES {
        if initialized.is_some() {
            break;
        }
        let mut options = serde_json::Map::new();
        options.insert("limit".into(), json!(HISTORY_PAGE_SIZE));
        if let Some(before) = &before {
            options.insert("before".into(), json!(before));
        }
        options.insert("commitment".into(), json!("finalized"));
        let page = rpc.request("getSignaturesForAddress", json!([game_key, options])).await?;
        let signatures: Vec<SignatureInfo> = serde_json::from_value(page)?;
        let Some(last) = signatures.last() else {
            break;
        };
        for info in &signatures {
            if info.err.as_ref().is_some_and(js_truthy) || info.slot > completed_slot || info.signature == value {
                continue;
            }
            let tx = load_transaction(rpc, &info.signature)
                .await?
                .ok_or_else(|| anyhow!("Incomplete transaction history"))?;
            let init = decode_events(&tx.logs, &program)?.into_iter().find_map(|event| match event {
                ProgramEvent::GameInitialized(init) if init.game_key == completed.game_key => Some(init),
                _ => None,
            });
            transactions.insert(info.signature.clone(), tx);
            if init.is_some() {
                initialized = init;
            }
        }
        before = Some(last.signature.clone());
    }
    let Some(initialized) = initialized else {
        bail!("Initialization history unavailable");
    };

    let mut ordered: Vec<(String, FinalizedTransaction)> = transactions.into_iter().collect();
    ordered.sort_by_key(|(_, tx)| tx.slot);
    let mut positions: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut slots: Vec<u64> = ordered.iter().map(|(_, tx)| tx.slot).collect();
    slots.dedup();
    for slot in slots {
        let same_slot: Vec<&String> = ordered.iter().filter(|(_, tx)| tx.slot == slot).map(|(sig, _)| sig).collect();
        if same_slot.len() < 2 {
            continue;
        }
        let block = rpc
            .request(
                "getBlock",
                json!([slot, { "commitment": "finalized", "transactionDetails": "signatures", "rewards": false }]),
            )
            .await?;
        if !js_truthy(&block) {
            bail!("Transaction order unavailable");
        }
        let block_signatures: Vec<&str> = block["signatures"]
            .as_array()
            .map(|list| list.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        for sig in same_slot {
            let index = block_signatures
                .iter()
                .position(|candidate| candidate == sig)
                .ok_or_else(|| anyhow!("Transaction order unavailable"))?;
            positions.insert(sig.clone(), index);
        }
    }
    ordered.sort_by_key(|(sig, tx)| (tx.slot, positions.get(sig).copied().unwrap_or(0)));

    let mut events: Vec<ProgramEvent> = Vec::new();
    let (mut started, mut finished) = (false, false);
    for (sig, tx) in &ordered {
        for event in decode_events(&tx.logs, &program)? {
            if event.game_key() != Some(&completed.game_key) {
                continue;
            }
            if matches!(event, ProgramEvent::GameInitialized(_)) {
                started = true;
            }
            if !started {
                continue;
            }
            if matches!(event, ProgramEvent::GameCompleted(_)) && sig == value {
                finished = true;
                break;
            }
            events.push(event);
        }
        if finished {
            break;
        }
    }
    if !started || !finished {
        bail!("Incomplete game history");
    }

    let (participants, last_slot) = replay_participants(&events, &completed.game_key)?;
    if participants.len() != completed.tickets_count as usize || participants.is_empty() {
        bail!("Ticket count mismatch");
    }
    let result = calculate_winner(&secret, last_slot, u64::from(completed.tickets_count))
        .map_err(|error| anyhow!("{}", error.0))?;
    if result.winner_index != submitted_winner
        || participants.get(result.winner_index as usize) != Some(&completed.winner)
    {
        bail!("Winner mismatch");
    }
    let token_mint = initialized.token_mint.to_base58();
    let metadata = get_game_token_metadata(rpc, std::slice::from_ref(&initialized.token_mint))
        .await?
        .remove(&token_mint)
        .ok_or_else(|| anyhow!("Token metadata unavailable"))?;
    let decimals = metadata.decimals;
    let value_index = ordered.iter().position(|(sig, _)| sig == value).expect("completion is ordered");
    let random_value = result.random_value.to_string();

    let game = json!({
        "gameKey": game_key,
        "signature": value,
        "timestamp": completed.timestamp,
        "gameType": initialized.game_type.name(),
        "creator": initialized.creator.to_base58(),
        "isPrivate": initialized.is_private,
        "ticketAmount": tokens_to_amount(initialized.ticket_amount, decimals),
        "totalAmount": tokens_to_amount(initialized.total_amount, decimals),
        "maxTickets": initialized.max_tickets,
        "createdAt": initialized.created_at,
        "participants": participants
            .iter()
            .enumerate()
            .map(|(index, address)| json!({ "address": address.to_base58(), "ticketCount": 1, "ticketIndices": [index] }))
            .collect::<Vec<_>>(),
        "totalTickets": completed.tickets_count,
        "winner": completed.winner.to_base58(),
        "winnerTicketIndex": result.winner_index,
        "prizeAmount": tokens_to_amount(completed.winner_amount, decimals),
        "feeAmount": tokens_to_amount(completed.fee_amount, decimals),
        "tokenMint": token_mint,
        "tokenSymbol": get_token_symbol(&token_mint),
        "tokenDecimals": decimals,
        "randomValue": random_value,
        "secretKey": hex::encode(secret),
        "randomHash": hex::encode(commitment),
        "lastSlot": last_slot.to_string(),
        "transactionSignatures": ordered[..=value_index].iter().map(|(sig, _)| sig.clone()).collect::<Vec<_>>(),
        "calculationBreakdown": {
            "randomValue": random_value,
            "totalTickets": completed.tickets_count,
            "winnerIndex": result.winner_index,
            "formula": format!(
                "u64_le_window(SHA-256(secret || {last_slot}_le)) % {} = {}",
                completed.tickets_count, result.winner_index
            ),
        },
        "explorerUrl": format!("https://solscan.io/tx/{value}"),
    });
    Ok(parse(&FINALIZED_VERIFIED_GAME, &game)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::solana::pool::testing::FakeTransport;
    use crate::solana::rpc::RpcError;
    use base64::Engine;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use timba_protocol::events::PlayerMembership;

    const GAME_KEY: &str = "11111111111111111111111111111111";
    const PLAYER: &str = "So11111111111111111111111111111111111111112";
    const OTHER: &str = "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump";

    fn address(value: &str) -> Address {
        Address::parse(value).unwrap()
    }

    fn membership() -> PlayerMembership {
        PlayerMembership {
            game_key: address(GAME_KEY),
            player: address(PLAYER),
            total_amount: 1,
            tickets_count: 1,
            ticket_index: 0,
            moved_participant: None,
            last_slot: 10,
            timestamp: 1,
        }
    }

    #[test]
    fn replays_tied_timestamps_and_swap_remove_unjoins_in_chain_order() {
        let events = [
            ProgramEvent::PlayerJoined(membership()),
            ProgramEvent::PlayerJoined(PlayerMembership {
                player: address(OTHER),
                ticket_index: 1,
                tickets_count: 2,
                ..membership()
            }),
            ProgramEvent::PlayerUnjoined(PlayerMembership {
                tickets_count: 1,
                moved_participant: Some(address(OTHER)),
                last_slot: 11,
                ..membership()
            }),
        ];
        assert_eq!(replay_participants(&events, &address(GAME_KEY)).unwrap(), (vec![address(OTHER)], 11));
        let error = replay_participants(
            &[ProgramEvent::PlayerJoined(PlayerMembership { ticket_index: 1, ..membership() })],
            &address(GAME_KEY),
        )
        .unwrap_err();
        assert!(error.to_string().contains("Incomplete"));
        let error = replay_participants(&[ProgramEvent::PlayerUnjoined(membership())], &address(GAME_KEY)).unwrap_err();
        assert_eq!(error.to_string(), "Incomplete unjoin history");
        let error = replay_participants(
            &[ProgramEvent::PlayerJoined(PlayerMembership { tickets_count: 2, ..membership() })],
            &address(GAME_KEY),
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "Incomplete ticket history");
        let other_game = PlayerMembership { game_key: address(PLAYER), ticket_index: 5, ..membership() };
        assert_eq!(
            replay_participants(&[ProgramEvent::PlayerJoined(other_game)], &address(GAME_KEY)).unwrap(),
            (vec![], 0)
        );
    }

    struct Fixture {
        rpc: RpcPool,
        transport: Arc<FakeTransport>,
        complete_sig: String,
        init_sig: String,
        transactions: Arc<Mutex<HashMap<String, Value>>>,
        game: Address,
    }

    fn sig(n: u8) -> String {
        let mut bytes = [n; 64];
        bytes[0] = 100;
        bs58::encode(bytes).into_string()
    }

    fn history_fixture() -> Fixture {
        let secret = [7u8; 32];
        let hash: [u8; 32] = Sha256::digest(secret).into();
        let game = find_game_pda(&hash, &PROGRAM_ID);
        let player = address(PLAYER);
        let (complete_sig, join_sig, init_sig) = (sig(3), sig(2), sig(1));

        let mut initialized = vec![0u8; 146];
        initialized[..8].copy_from_slice(&[82, 221, 11, 2, 244, 52, 240, 250]);
        initialized[8..40].copy_from_slice(&game.0);
        initialized[40..72].copy_from_slice(&player.0);
        initialized[72] = 1;
        initialized[73..81].copy_from_slice(&100u64.to_le_bytes());
        initialized[81..89].copy_from_slice(&100u64.to_le_bytes());
        initialized[89..93].copy_from_slice(&2u32.to_le_bytes());
        initialized[93..97].copy_from_slice(&1u32.to_le_bytes());
        initialized[97..129].copy_from_slice(&player.0);
        initialized[130..138].copy_from_slice(&1u64.to_le_bytes());
        initialized[138..146].copy_from_slice(&600u64.to_le_bytes());

        let mut joined = vec![0u8; 104];
        joined[..8].copy_from_slice(&[39, 144, 49, 106, 108, 210, 183, 38]);
        joined[8..40].copy_from_slice(&game.0);
        joined[40..72].copy_from_slice(&player.0);
        joined[72..80].copy_from_slice(&100u64.to_le_bytes());
        joined[80..84].copy_from_slice(&1u32.to_le_bytes());
        joined[84..88].copy_from_slice(&0u32.to_le_bytes());
        joined[88..96].copy_from_slice(&3u64.to_le_bytes());
        joined[96..104].copy_from_slice(&1u64.to_le_bytes());

        let mut completed = vec![0u8; 100];
        completed[..8].copy_from_slice(&[103, 26, 106, 108, 240, 191, 179, 120]);
        completed[8..40].copy_from_slice(&game.0);
        completed[40..72].copy_from_slice(&player.0);
        completed[72..76].copy_from_slice(&1u32.to_le_bytes());
        completed[76..84].copy_from_slice(&99u64.to_le_bytes());
        completed[84..92].copy_from_slice(&1u64.to_le_bytes());
        completed[92..100].copy_from_slice(&2u64.to_le_bytes());

        let mut data = COMPLETE_GAME.to_vec();
        data.extend_from_slice(&hash);
        data.extend_from_slice(&secret);
        data.extend_from_slice(&[0; 4]);

        let program = PROGRAM_ID.to_base58();
        let tx = |slot: u64, event: &[u8], complete: bool| {
            json!({
                "slot": slot,
                "blockTime": 2,
                "meta": {
                    "err": null,
                    "logMessages": [
                        format!("Program {program} invoke [1]"),
                        format!("Program data: {}", base64::engine::general_purpose::STANDARD.encode(event)),
                        format!("Program {program} success"),
                    ],
                },
                "transaction": {
                    "message": {
                        "accountKeys": [game.to_base58(), PLAYER, program],
                        "instructions": if complete {
                            json!([{ "programIdIndex": 2, "accounts": [0, 1], "data": bs58::encode(&data).into_string() }])
                        } else {
                            json!([])
                        },
                    },
                },
            })
        };
        let transactions = Arc::new(Mutex::new(HashMap::from([
            (init_sig.clone(), tx(1, &initialized, false)),
            (join_sig.clone(), tx(2, &joined, false)),
            (complete_sig.clone(), tx(2, &completed, true)),
        ])));

        let transport = FakeTransport::new();
        let pages = Arc::new(Mutex::new(0usize));
        let (store, page_count) = (transactions.clone(), pages.clone());
        let (c, j, i) = (complete_sig.clone(), join_sig.clone(), init_sig.clone());
        let mut mint = vec![0u8; 82];
        mint[44] = 9;
        mint[45] = 1;
        let mint = base64::engine::general_purpose::STANDARD.encode(mint);
        transport.on(move |_, method, params| -> Option<Result<Value, RpcError>> {
            Some(Ok(match method {
                "getTransaction" => {
                    assert_eq!(params[1]["commitment"], "finalized");
                    store.lock().unwrap().get(params[0].as_str().unwrap()).cloned().unwrap_or(Value::Null)
                }
                "getSignaturesForAddress" => {
                    assert_eq!(params[1]["commitment"], "finalized");
                    let mut pages = page_count.lock().unwrap();
                    *pages += 1;
                    match *pages {
                        1 => json!([{ "signature": c, "slot": 2, "err": null }, { "signature": j, "slot": 2, "err": null }]),
                        2 => json!([{ "signature": i, "slot": 1, "err": null }]),
                        _ => json!([]),
                    }
                }
                "getBlock" => json!({ "signatures": [j, c] }),
                "getMultipleAccounts" => json!({
                    "context": { "slot": 3 },
                    "value": [{
                        "data": [mint, "base64"],
                        "owner": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                        "lamports": 1, "executable": false, "space": 82
                    }],
                }),
                _ => return None,
            }))
        });
        let rpc = RpcPool::with_transport(&["https://rpc.test".into()], transport.clone()).unwrap();
        Fixture { rpc, transport, complete_sig, init_sig, transactions, game }
    }

    #[tokio::test]
    async fn reconstructs_finalized_history_across_pages_and_uses_block_order_for_tied_slots() {
        let fixture = history_fixture();
        let result = verify_game_transaction(&fixture.rpc, &PROGRAM_ID, &fixture.complete_sig).await.unwrap();
        assert_eq!(result["winner"], PLAYER);
        assert_eq!(result["winnerTicketIndex"], 0);
        assert_eq!(result["randomValue"], "7669647862329529978");
        assert_eq!(fixture.transport.calls_for("getSignaturesForAddress").len(), 2);
        let signatures = result["transactionSignatures"].as_array().unwrap();
        assert_eq!(signatures.last().unwrap(), &json!(fixture.complete_sig));
        assert_eq!(signatures.first().unwrap(), &json!(fixture.init_sig));
        assert_eq!(signatures.len(), 3);
        assert_eq!(
            fixture.transport.calls_for("getBlock")[0].1,
            json!([2, { "commitment": "finalized", "transactionDetails": "signatures", "rewards": false }])
        );

        let keys: Vec<&str> = result.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "gameKey",
                "signature",
                "timestamp",
                "gameType",
                "creator",
                "isPrivate",
                "ticketAmount",
                "totalAmount",
                "maxTickets",
                "createdAt",
                "participants",
                "totalTickets",
                "winner",
                "winnerTicketIndex",
                "prizeAmount",
                "feeAmount",
                "tokenMint",
                "tokenSymbol",
                "tokenDecimals",
                "randomValue",
                "secretKey",
                "randomHash",
                "transactionSignatures",
                "lastSlot",
                "calculationBreakdown",
                "explorerUrl"
            ]
        );
        assert_eq!(result["gameKey"], fixture.game.to_base58());
        assert_eq!(result["gameType"], "giveaway");
        assert_eq!(result["ticketAmount"], json!(0.0000001));
        assert_eq!(result["prizeAmount"], json!(0.000000099));
        assert_eq!(result["tokenSymbol"], "SOL");
        assert_eq!(result["tokenDecimals"], 9);
        assert_eq!(result["timestamp"], 2);
        assert_eq!(result["createdAt"], 1);
        assert_eq!(result["lastSlot"], "3");
        assert_eq!(result["secretKey"], "07".repeat(32));
        assert_eq!(result["participants"], json!([{ "address": PLAYER, "ticketCount": 1, "ticketIndices": [0] }]));
        assert_eq!(
            result["calculationBreakdown"],
            json!({
                "randomValue": "7669647862329529978", "totalTickets": 1, "winnerIndex": 0,
                "formula": "u64_le_window(SHA-256(secret || 3_le)) % 1 = 0"
            })
        );
        assert_eq!(result["explorerUrl"], format!("https://solscan.io/tx/{}", fixture.complete_sig));
    }

    #[tokio::test]
    async fn missing_initialization_and_failed_completion_never_produce_a_verification_record() {
        let missing = history_fixture();
        missing.transactions.lock().unwrap().remove(&missing.init_sig);
        let error = verify_game_transaction(&missing.rpc, &PROGRAM_ID, &missing.complete_sig).await.unwrap_err();
        assert!(error.to_string().contains("Incomplete"), "{error}");

        let failed = history_fixture();
        failed.transactions.lock().unwrap().get_mut(&failed.complete_sig).unwrap()["meta"]["err"] =
            json!("synthetic failure");
        let error = verify_game_transaction(&failed.rpc, &PROGRAM_ID, &failed.complete_sig).await.unwrap_err();
        assert!(error.to_string().contains("Finalized"), "{error}");
    }

    #[tokio::test]
    async fn rejects_invalid_signatures_and_tampered_reveals() {
        let fixture = history_fixture();
        let error = verify_game_transaction(&fixture.rpc, &PROGRAM_ID, "invalid").await.unwrap_err();
        assert_eq!(error.to_string(), "Invalid signature");
        assert!(fixture.transport.calls.lock().unwrap().is_empty());

        let tampered = history_fixture();
        {
            let mut store = tampered.transactions.lock().unwrap();
            let tx = store.get_mut(&tampered.complete_sig).unwrap();
            let encoded = tx["transaction"]["message"]["instructions"][0]["data"].as_str().unwrap().to_string();
            let mut data = bs58::decode(encoded).into_vec().unwrap();
            data[40] ^= 1;
            tx["transaction"]["message"]["instructions"][0]["data"] = json!(bs58::encode(data).into_string());
        }
        let error = verify_game_transaction(&tampered.rpc, &PROGRAM_ID, &tampered.complete_sig).await.unwrap_err();
        assert_eq!(error.to_string(), "Invalid revealed commitment");
    }

    #[tokio::test]
    async fn rejects_a_submitted_winner_that_does_not_match_the_replay() {
        let fixture = history_fixture();
        {
            let mut store = fixture.transactions.lock().unwrap();
            let tx = store.get_mut(&fixture.complete_sig).unwrap();
            let encoded = tx["transaction"]["message"]["instructions"][0]["data"].as_str().unwrap().to_string();
            let mut data = bs58::decode(encoded).into_vec().unwrap();
            data[72] = 1;
            tx["transaction"]["message"]["instructions"][0]["data"] = json!(bs58::encode(data).into_string());
        }
        let error = verify_game_transaction(&fixture.rpc, &PROGRAM_ID, &fixture.complete_sig).await.unwrap_err();
        assert_eq!(error.to_string(), "Winner mismatch");
    }
}
