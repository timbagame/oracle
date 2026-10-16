//! Test harness: an `OracleService` over a scriptable RPC transport, a
//! temporary database and fixed token prices.

use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine;
use futures::future::{BoxFuture, FutureExt};
use serde_json::{json, Value};
use timba_protocol::contracts::{GameAccount, GameType, PROGRAM_ID};
use timba_protocol::Address;

use super::service::{OracleService, OracleServiceOptions};
use crate::config::OracleConfig;
use crate::db::OracleDatabase;
use crate::metrics::OracleMetrics;
use crate::solana::pool::testing::FakeTransport;
use crate::solana::{Keypair, RpcPool};
use crate::token::price::TokenPriceResolver;

pub struct FixedPrices(pub HashMap<String, f64>);

impl TokenPriceResolver for FixedPrices {
    fn get_token_usd_prices<'a>(
        &'a self,
        mints: &'a [String],
        allow_partial: bool,
    ) -> BoxFuture<'a, anyhow::Result<HashMap<String, f64>>> {
        let found: HashMap<_, _> = mints.iter().filter_map(|m| self.0.get(m).map(|p| (m.clone(), *p))).collect();
        let result = if !allow_partial && found.len() != mints.len() {
            Err(anyhow::anyhow!("missing price"))
        } else {
            Ok(found)
        };
        futures::future::ready(result).boxed()
    }
}

pub struct Harness {
    pub _dir: tempfile::TempDir,
    pub transport: Arc<FakeTransport>,
    pub service: Arc<OracleService>,
}

pub const MINT_A: &str = "So11111111111111111111111111111111111111112";
pub const MINT_B: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

pub fn harness() -> Harness {
    harness_with(OracleConfig::for_tests(), Keypair::generate(), &["https://a"])
}

pub fn harness_with(config: OracleConfig, operator: Keypair, endpoints: &[&str]) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(OracleDatabase::open(dir.path().join("o.sqlite").to_str().unwrap()).unwrap());
    let transport = FakeTransport::new();
    let endpoints: Vec<String> = endpoints.iter().map(|e| e.to_string()).collect();
    let rpc = Arc::new(
        RpcPool::with_transport(&endpoints, transport.clone())
            .unwrap()
            .with_delay(|_| futures::future::ready(()).boxed()),
    );
    let service = OracleService::new(OracleServiceOptions {
        config,
        db,
        metrics: Arc::new(OracleMetrics::new(10)),
        rpc,
        operator,
        price_resolver: Arc::new(FixedPrices(HashMap::from([(MINT_A.to_string(), 150.0)]))),
    });
    Harness { _dir: dir, transport, service }
}

/// A coinflip game with `tickets` distinct participants.
pub fn game_account(tickets: u32, max: u32, min: u32, created_at: u64, timeout: u64) -> GameAccount {
    GameAccount {
        creator: Keypair::generate().address(),
        game_type: GameType::Coinflip,
        ticket_amount: 10,
        max_tickets: max,
        min_tickets: min,
        tickets_count: tickets,
        token_mint: Address([2; 32]),
        created_at,
        timeout,
        last_slot: 99,
        is_private: false,
        total_amount: 12_345,
        participants: (0..tickets).map(|i| Address([i as u8 + 10; 32])).collect(),
    }
}

/// `getAccountInfo` result for a program-owned game account.
pub fn account_value(game: &GameAccount) -> Value {
    json!({"value": {
        "data": [base64::engine::general_purpose::STANDARD.encode(game.encode()), "base64"],
        "owner": PROGRAM_ID.to_base58(),
        "lamports": 1,
        "executable": false
    }})
}

/// A websocket node that acknowledges every `logsSubscribe` and keeps the socket open.
pub async fn ws_node() -> String {
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else { return };
                while let Some(Ok(message)) = socket.next().await {
                    if let Message::Text(text) = message {
                        let request: Value = serde_json::from_str(&text).unwrap();
                        let ack = json!({ "jsonrpc": "2.0", "id": request["id"], "result": 1 });
                        let _ = socket.send(Message::Text(ack.to_string().into())).await;
                    }
                }
            });
        }
    });
    url
}

/// Makes updates of `table` matching the SQL condition `when` fail in the
/// database stored in `dir` (a harness directory), whatever connection
/// issues them.
pub fn fail_updates(dir: &std::path::Path, trigger: &str, table: &str, when: &str) {
    let conn = rusqlite::Connection::open(dir.join("o.sqlite")).unwrap();
    conn.execute_batch(&format!(
        "CREATE TRIGGER {trigger} BEFORE UPDATE ON {table} WHEN {when} BEGIN SELECT RAISE(ABORT, 'disk full'); END;"
    ))
    .unwrap();
}

/// Condition for [`fail_updates`] matching updates that leave a game's
/// status and completion failure bookkeeping alone (pure `last_checked` touches).
pub const TOUCH_ONLY: &str = "NEW.status = OLD.status AND NEW.completion_attempts = OLD.completion_attempts \
     AND NEW.completion_failure_kind IS OLD.completion_failure_kind";

/// Runs raw SQL against the database stored in `dir`, for states the service
/// API cannot produce (odd statuses, failure triggers).
pub fn exec_sql(dir: &std::path::Path, sql: &str) {
    rusqlite::Connection::open(dir.join("o.sqlite")).unwrap().execute_batch(sql).unwrap();
}

/// Number of rows stored in `table` of the database in `dir`.
pub fn count_rows(dir: &std::path::Path, table: &str) -> i64 {
    let conn = rusqlite::Connection::open(dir.join("o.sqlite")).unwrap();
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0)).unwrap()
}
