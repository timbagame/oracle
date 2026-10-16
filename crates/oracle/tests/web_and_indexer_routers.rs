//! Wires the public indexer and web game routers the way the service does,
//! over a file-backed indexer database and an in-memory Solana RPC.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use base64::Engine;
use futures::future::{BoxFuture, FutureExt};
use serde_json::{json, Value};
use timba_oracle::config::OracleConfig;
use timba_oracle::indexer::{self, IndexerDatabase, IndexerDatabaseOptions};
use timba_oracle::solana::{RpcError, RpcPool, RpcTransport};
use timba_oracle::token::policy::TokenPolicy;
use timba_oracle::types::{GameSecrets, WebGameOracle};
use timba_oracle::web_api::token_utils::KNOWN_TOKENS;
use timba_oracle::web_api::WebGameApi;
use timba_protocol::contracts::{find_game_token_pda, GameTokenAccount, PROGRAM_ID};
use timba_protocol::Address;
use tower::ServiceExt;

/// Serves the v0.2 game token configuration accounts of every known token.
struct Chain {
    accounts: HashMap<String, Value>,
    calls: Mutex<Vec<String>>,
}

impl Chain {
    fn new() -> Self {
        let mut accounts = HashMap::new();
        for token in KNOWN_TOKENS {
            let mint = Address::parse(token.mint).unwrap();
            let data =
                GameTokenAccount { token_mint: mint, vault_bump: 254, min_amount: 2_500, fee_amount: 0, enabled: true }
                    .encode();
            accounts.insert(
                find_game_token_pda(&mint, &PROGRAM_ID).to_base58(),
                json!({
                    "data": [base64::engine::general_purpose::STANDARD.encode(&data), "base64"],
                    "owner": PROGRAM_ID.to_base58(),
                    "lamports": 1,
                    "executable": false,
                }),
            );
        }
        Self { accounts, calls: Mutex::new(Vec::new()) }
    }
}

impl RpcTransport for Chain {
    fn send<'a>(
        &'a self,
        _endpoint: &'a str,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<Value, RpcError>> {
        self.calls.lock().unwrap().push(method.to_string());
        let result = match method {
            "getMultipleAccounts" => {
                let values: Vec<Value> = params[0]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|key| self.accounts.get(key.as_str().unwrap()).cloned().unwrap_or(Value::Null))
                    .collect();
                Ok(json!({ "context": { "slot": 1 }, "value": values }))
            }
            "getTransaction" => Ok(Value::Null),
            other => Err(RpcError::decode(format!("unexpected RPC call {other}"))),
        };
        async move { result }.boxed()
    }
}

struct Oracle {
    rpc: Arc<RpcPool>,
}

impl WebGameOracle for Oracle {
    fn rpc(&self) -> Arc<RpcPool> {
        self.rpc.clone()
    }

    fn program_id(&self) -> Address {
        PROGRAM_ID
    }

    fn generate_game_secrets<'a>(&'a self, _: Option<&'a str>) -> BoxFuture<'a, anyhow::Result<GameSecrets>> {
        async { Err(anyhow::anyhow!("unexpected secret generation")) }.boxed()
    }

    fn sign_game_transaction<'a>(&'a self, _: &'a str) -> BoxFuture<'a, anyhow::Result<String>> {
        async { Err(anyhow::anyhow!("unexpected signing")) }.boxed()
    }

    fn token_policies(&self) -> BoxFuture<'_, anyhow::Result<Vec<TokenPolicy>>> {
        async { Ok(Vec::new()) }.boxed()
    }
}

async fn get(router: &axum::Router, uri: &str) -> (StatusCode, Value) {
    let response = router.clone().oneshot(Request::get(uri).body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn serves_the_indexer_and_web_routers_side_by_side() {
    let dir = tempfile::tempdir().unwrap();
    let wall_clock = Arc::new(AtomicI64::new(1_800_000_000_000));
    let clock = wall_clock.clone();
    let options = IndexerDatabaseOptions {
        wall_clock: Some(Arc::new(move || clock.load(Ordering::SeqCst))),
        ..IndexerDatabaseOptions::default()
    };
    let db = Arc::new(IndexerDatabase::open_with_options(dir.path().join("indexer.sqlite"), options).unwrap());
    let chain = Arc::new(Chain::new());
    let rpc = Arc::new(RpcPool::with_transport(&["https://rpc.test".into()], chain.clone()).unwrap());
    let config = OracleConfig::for_tests();
    let web = Arc::new(WebGameApi::new(Arc::new(Oracle { rpc }), db.clone(), &config));
    let router = indexer::api::router(db.clone(), None).merge(web.clone().router());

    let (status, health) = get(&router, "/indexer/health").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(health["status"], "ok");

    let (status, config) = get(&router, "/web/config").await;
    assert_eq!(status, StatusCode::OK);
    let tokens = config["tokens"].as_array().unwrap();
    assert_eq!(tokens.len(), KNOWN_TOKENS.len());
    assert!(tokens.iter().all(|token| token["minimumAmountRaw"] == "2500" && token["priceUsd"].is_null()));
    assert_eq!(tokens[0]["symbol"], "TIMBA");
    assert_eq!(tokens[0]["minimumAmount"], "0.0025");

    let (status, body) = get(&router, "/web/elsewhere").await;
    assert_eq!((status, body), (StatusCode::NOT_FOUND, json!({ "error": "Not found" })));
    assert!(!chain.calls.lock().unwrap().iter().any(|method| method == "getTransaction"));

    // The verification worker retries games whose history is not finalized yet.
    let signature = bs58::encode([5u8; 64]).into_string();
    db.queue_verification(&signature).unwrap();
    assert!(db.next_verification_job().unwrap().is_none());
    wall_clock.fetch_add(60_000, Ordering::SeqCst);
    let job = db.next_verification_job().unwrap().expect("queued job");
    assert_eq!(job.signature, signature);
    assert!(web.verify(&job.signature).await.is_err());
    db.retry_verification_job(&job.signature, job.attempts).unwrap();
    assert!(db.next_verification_job().unwrap().is_none());
    assert!(chain.calls.lock().unwrap().iter().any(|method| method == "getTransaction"));
    db.close();
}
