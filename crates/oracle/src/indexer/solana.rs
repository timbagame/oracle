//! Program history reads for the public indexer (port of `indexer/solana.ts`).

use anyhow::{anyhow, Result};
use futures::stream::{self, StreamExt, TryStreamExt};
use timba_protocol::address::Address;
use timba_protocol::contracts::discriminators::GAME_ACCOUNT;

pub use crate::indexed_events::parse_transaction_events;
use crate::solana::pool::RpcPool;
use crate::solana::rpc::{SignatureInfo, SignaturesForAddressOptions};

use super::types::{IndexedEvents, IndexerCursor};

pub use timba_protocol::events::get_trusted_program_data;

const SIGNATURE_PAGE_SIZE: u32 = 1_000;
const TRANSACTION_CONCURRENCY: usize = 4;
const ACCOUNT_BATCH_SIZE: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventsSince {
    pub events: IndexedEvents,
    pub cursor: Option<IndexerCursor>,
    pub transactions: usize,
}

/// The newest confirmed program signature.
pub async fn get_program_head(rpc: &RpcPool, program_id: &Address) -> Result<Option<IndexerCursor>> {
    let page = rpc
        .get_signatures_for_address(program_id, &SignaturesForAddressOptions { limit: Some(1), ..Default::default() })
        .await?;
    Ok(page.into_iter().next().map(|head| IndexerCursor { signature: head.signature, slot: head.slot }))
}

async fn get_signatures_since(
    rpc: &RpcPool,
    program_id: &Address,
    cursor: &IndexerCursor,
) -> Result<Vec<SignatureInfo>> {
    let mut signatures = Vec::new();
    let mut before: Option<String> = None;
    loop {
        let page = rpc
            .get_signatures_for_address(
                program_id,
                &SignaturesForAddressOptions {
                    before: before.clone(),
                    until: Some(cursor.signature.clone()),
                    limit: Some(SIGNATURE_PAGE_SIZE),
                },
            )
            .await?;
        let full = page.len() >= SIGNATURE_PAGE_SIZE as usize;
        before = page.last().map(|info| info.signature.clone());
        signatures.extend(page);
        if !full || before.is_none() {
            break;
        }
    }
    Ok(signatures)
}

/// Program events after `cursor`, oldest first, with the newest signature as
/// the next cursor.
pub async fn get_events_since(rpc: &RpcPool, program_id: &Address, cursor: &IndexerCursor) -> Result<EventsSince> {
    let newest_first = get_signatures_since(rpc, program_id, cursor).await?;
    let Some(newest) = newest_first.first() else {
        return Ok(EventsSince { events: IndexedEvents::default(), cursor: None, transactions: 0 });
    };
    let program = program_id.to_base58();
    let program = program.as_str();
    // Owned items keep the per-transaction futures free of higher-ranked
    // lifetimes, so the indexer loop stays `Send` for `tokio::spawn`.
    let parsed: Vec<IndexedEvents> = stream::iter(newest_first.iter().rev().cloned())
        .map(|item| async move {
            if item.err.as_ref().is_some_and(|err| !err.is_null()) {
                return Ok(IndexedEvents::default());
            }
            let transaction = rpc
                .get_transaction(&item.signature)
                .await?
                .ok_or_else(|| anyhow!("Transaction {} is unavailable", item.signature))?;
            if transaction.err.is_some() {
                return Ok(IndexedEvents::default());
            }
            parse_transaction_events(&item.signature, item.slot, &transaction.log_messages, program)
                .map_err(|message| anyhow!(message))
        })
        .buffered(TRANSACTION_CONCURRENCY)
        .try_collect()
        .await?;
    let mut events = IndexedEvents::default();
    for item in parsed {
        events.extend(item);
    }
    Ok(EventsSince {
        events,
        cursor: Some(IndexerCursor { signature: newest.signature.clone(), slot: newest.slot }),
        transactions: newest_first.len(),
    })
}

/// Active game keys whose accounts no longer exist or are not game accounts.
pub async fn find_stale_active_games(rpc: &RpcPool, program_id: &Address, game_keys: &[String]) -> Result<Vec<String>> {
    let mut stale = Vec::new();
    for batch in game_keys.chunks(ACCOUNT_BATCH_SIZE) {
        let mut valid: Vec<(&String, Address)> = Vec::new();
        for key in batch {
            match Address::parse(key) {
                Ok(address) => valid.push((key, address)),
                Err(_) => stale.push(key.clone()),
            }
        }
        let addresses: Vec<Address> = valid.iter().map(|(_, address)| *address).collect();
        let accounts = rpc.get_multiple_accounts(&addresses).await?;
        for (index, (key, _)) in valid.iter().enumerate() {
            let live = accounts.get(index).and_then(Option::as_ref).is_some_and(|account| {
                account.owner == *program_id && account.data.len() >= 8 && account.data[..8] == GAME_ACCOUNT
            });
            if !live {
                stale.push((*key).clone());
            }
        }
    }
    Ok(stale)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::solana::pool::testing::FakeTransport;
    use base64::Engine;
    use serde_json::{json, Value};
    use std::sync::Arc;
    use timba_protocol::events::discriminators;

    fn address(n: u8) -> Address {
        Address::new([n; 32])
    }

    fn pool(transport: Arc<FakeTransport>) -> RpcPool {
        RpcPool::with_transport(&["https://rpc".into()], transport).unwrap()
    }

    fn closed_event(game: &Address, timestamp: u64) -> Vec<u8> {
        let mut data = discriminators::GAME_CLOSED.to_vec();
        data.extend(game.as_bytes());
        data.extend(timestamp.to_le_bytes());
        data
    }

    fn program_logs(program: &Address, events: &[Vec<u8>]) -> Vec<String> {
        let id = program.to_base58();
        let mut logs = vec![format!("Program {id} invoke [1]")];
        for event in events {
            logs.push(format!("Program data: {}", base64::engine::general_purpose::STANDARD.encode(event)));
        }
        logs.push(format!("Program {id} success"));
        logs
    }

    fn account(owner: &Address, data: &[u8]) -> Value {
        json!({
            "lamports": 1,
            "owner": owner.to_base58(),
            "data": [base64::engine::general_purpose::STANDARD.encode(data), "base64"],
            "executable": false
        })
    }

    fn game_data() -> Vec<u8> {
        let mut data = GAME_ACCOUNT.to_vec();
        data.extend([0u8; 8]);
        data
    }

    #[tokio::test]
    async fn program_head_returns_the_newest_confirmed_signature() {
        let transport = FakeTransport::new();
        transport.push("getSignaturesForAddress", Ok(json!([{ "signature": "newest", "slot": 99 }])));
        let program = address(1);
        let head = get_program_head(&pool(transport.clone()), &program).await.unwrap();
        assert_eq!(head, Some(IndexerCursor { signature: "newest".into(), slot: 99 }));
        let calls = transport.calls_for("getSignaturesForAddress");
        assert_eq!(calls[0].1, json!([program.to_base58(), { "commitment": "confirmed", "limit": 1 }]));

        transport.push("getSignaturesForAddress", Ok(json!([])));
        assert_eq!(get_program_head(&pool(transport), &program).await.unwrap(), None);
    }

    #[tokio::test]
    async fn returns_an_empty_batch_when_nothing_happened() {
        let transport = FakeTransport::new();
        transport.push("getSignaturesForAddress", Ok(json!([])));
        let cursor = IndexerCursor { signature: "1".repeat(64), slot: 1 };
        let result = get_events_since(&pool(transport), &address(1), &cursor).await.unwrap();
        assert_eq!(result, EventsSince { events: IndexedEvents::default(), cursor: None, transactions: 0 });
    }

    #[tokio::test]
    async fn pages_signatures_skips_failures_and_parses_oldest_first() {
        let program = address(1);
        let (first_game, second_game) = (address(2), address(3));
        let full_page: Vec<Value> = (0..1_000)
            .map(|index| {
                json!({
                    "signature": format!("page1-{index}"),
                    "slot": 3_000 - index,
                    "err": if index == 0 { Value::Null } else { json!({ "InstructionError": [0, "Custom"] }) }
                })
            })
            .collect();
        let second_page = json!([
            { "signature": "page2-0", "slot": 1_500, "err": null },
            { "signature": "page2-1", "slot": 1_400, "err": null }
        ]);
        let logs_first = program_logs(&program, &[closed_event(&first_game, 3_000)]);
        let logs_second = program_logs(&program, &[closed_event(&second_game, 1)]);
        let transport = FakeTransport::new();
        transport.on(move |_, method, params| match method {
            "getSignaturesForAddress" => Some(Ok(if params[1].get("before").is_some() {
                second_page.clone()
            } else {
                Value::Array(full_page.clone())
            })),
            "getTransaction" => Some(Ok(match params[0].as_str().unwrap() {
                "page1-0" => json!({ "slot": 3_000, "meta": { "err": null, "logMessages": logs_first } }),
                "page2-0" => json!({ "slot": 1_500, "meta": { "err": { "InstructionError": [0, "Custom"] }, "logMessages": [] } }),
                "page2-1" => json!({ "slot": 1_400, "meta": { "err": null, "logMessages": logs_second } }),
                _ => Value::Null,
            })),
            _ => None,
        });
        let cursor = IndexerCursor { signature: "1".repeat(64), slot: 1 };
        let result = get_events_since(&pool(transport.clone()), &program, &cursor).await.unwrap();

        let pages = transport.calls_for("getSignaturesForAddress");
        let befores: Vec<Option<&str>> =
            pages.iter().map(|(_, params)| params[1].get("before").and_then(Value::as_str)).collect();
        assert_eq!(befores, vec![None, Some("page1-999")]);
        assert_eq!(pages[0].1[1]["until"], json!("1".repeat(64)));
        assert_eq!(pages[0].1[1]["limit"], json!(1_000));
        assert_eq!(transport.calls_for("getTransaction").len(), 3);
        assert_eq!(result.transactions, 1_002);
        assert_eq!(result.cursor, Some(IndexerCursor { signature: "page1-0".into(), slot: 3_000 }));
        let closed: Vec<(String, String)> =
            result.events.closed.iter().map(|event| (event.game_key.clone(), event.signature.clone())).collect();
        assert_eq!(
            closed,
            vec![(second_game.to_base58(), "page2-1".to_string()), (first_game.to_base58(), "page1-0".to_string())]
        );
    }

    #[tokio::test]
    async fn fails_when_a_confirmed_transaction_cannot_be_loaded() {
        let transport = FakeTransport::new();
        transport.push("getSignaturesForAddress", Ok(json!([{ "signature": "missing", "slot": 5, "err": null }])));
        transport.push("getTransaction", Ok(Value::Null));
        let cursor = IndexerCursor { signature: "1".repeat(64), slot: 1 };
        let error = get_events_since(&pool(transport), &address(1), &cursor).await.unwrap_err();
        assert_eq!(error.to_string(), "Transaction missing is unavailable");
    }

    #[tokio::test]
    async fn treats_a_transaction_without_log_messages_as_empty() {
        let transport = FakeTransport::new();
        transport.push("getSignaturesForAddress", Ok(json!([{ "signature": "quiet", "slot": 5, "err": null }])));
        transport.push("getTransaction", Ok(json!({ "meta": null })));
        let cursor = IndexerCursor { signature: "1".repeat(64), slot: 1 };
        let result = get_events_since(&pool(transport), &address(1), &cursor).await.unwrap();
        assert_eq!(result.transactions, 1);
        assert!(result.events.closed.is_empty());
    }

    #[tokio::test]
    async fn flags_invalid_keys_closed_accounts_and_non_games() {
        let program = address(1);
        let (live, closed, foreign, short, wrong) = (address(2), address(3), address(4), address(5), address(6));
        let mut accounts = std::collections::HashMap::new();
        accounts.insert(live.to_base58(), account(&program, &game_data()));
        accounts.insert(closed.to_base58(), Value::Null);
        accounts.insert(foreign.to_base58(), account(&address(9), &game_data()));
        accounts.insert(short.to_base58(), account(&program, &[0u8; 4]));
        accounts.insert(wrong.to_base58(), account(&program, &[1u8; 16]));
        let transport = FakeTransport::new();
        transport.on(move |_, method, params| {
            (method == "getMultipleAccounts").then(|| {
                let value: Vec<Value> =
                    params[0].as_array().unwrap().iter().map(|key| accounts[key.as_str().unwrap()].clone()).collect();
                Ok(json!({ "value": value }))
            })
        });
        let keys: Vec<String> = vec![
            live.to_base58(),
            "not-an-address".into(),
            closed.to_base58(),
            foreign.to_base58(),
            short.to_base58(),
            wrong.to_base58(),
        ];
        let mut stale = find_stale_active_games(&pool(transport.clone()), &program, &keys).await.unwrap();
        stale.sort();
        let mut expected = vec![
            "not-an-address".to_string(),
            closed.to_base58(),
            foreign.to_base58(),
            short.to_base58(),
            wrong.to_base58(),
        ];
        expected.sort();
        assert_eq!(stale, expected);
        assert_eq!(
            transport.calls_for("getMultipleAccounts")[0].1[1],
            json!({ "commitment": "confirmed", "encoding": "base64" })
        );
    }

    #[tokio::test]
    async fn queries_accounts_in_batches_of_one_hundred() {
        let program = address(1);
        let keys: Vec<String> = (0..150u32)
            .map(|n| {
                let mut bytes = [7u8; 32];
                bytes[..4].copy_from_slice(&n.to_le_bytes());
                Address::new(bytes).to_base58()
            })
            .collect();
        let live = account(&program, &game_data());
        let transport = FakeTransport::new();
        transport.on(move |_, method, params| {
            (method == "getMultipleAccounts").then(|| {
                let count = params[0].as_array().unwrap().len();
                Ok(json!({ "value": vec![live.clone(); count] }))
            })
        });
        let stale = find_stale_active_games(&pool(transport.clone()), &program, &keys).await.unwrap();
        assert!(stale.is_empty());
        let sizes: Vec<usize> = transport
            .calls_for("getMultipleAccounts")
            .iter()
            .map(|(_, params)| params[0].as_array().unwrap().len())
            .collect();
        assert_eq!(sizes, vec![100, 50]);
    }

    #[test]
    fn accepts_only_events_from_the_timba_invocation_frame() {
        let program = address(1).to_base58();
        let attacker = address(2).to_base58();
        let encoded = base64::engine::general_purpose::STANDARD.encode(closed_event(&address(3), 10));
        let logs = vec![
            format!("Program {program} invoke [1]"),
            format!("Program data: {encoded}"),
            format!("Program {attacker} invoke [2]"),
            format!("Program data: {encoded}"),
            format!("Program {attacker} success"),
            format!("Program {program} success"),
        ];
        assert_eq!(get_trusted_program_data(&logs, &program).len(), 1);
        assert_eq!(parse_transaction_events(&"1".repeat(64), 10, &logs, &program).unwrap().closed.len(), 1);
    }
}
