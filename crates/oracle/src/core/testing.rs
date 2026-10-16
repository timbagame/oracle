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
