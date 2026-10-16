//! Route tests for the web game API (ports of `tests/web-api.test.ts` and
//! `tests/web-api.routes.test.ts`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode};
use base64::Engine;
use futures::future::{BoxFuture, FutureExt};
use serde_json::{json, Value};
use timba_protocol::address::TOKEN_PROGRAM_ID;
use timba_protocol::contracts::{find_game_pda, find_game_token_pda, GameAccount, GameType, PROGRAM_ID};
use timba_protocol::transaction::{LegacyMessage, Transaction};
use timba_protocol::{AccountMeta, Address, ContractVersion, Instruction};
use tower::ServiceExt;

use super::api::{verification_namespace, WebGameApi, JSON_CONTENT_TYPE};
use super::token_utils::{KNOWN_TOKENS, SOL_MINT, USDC_MINT};
use crate::config::OracleConfig;
use crate::indexer::database::Clock;
use crate::indexer::pricing::TokenUsdPrices;
use crate::indexer::IndexerDatabase;
use crate::solana::pool::testing::FakeTransport;
use crate::solana::rpc::RpcError;
use crate::solana::{Keypair, RpcPool};
use crate::token::policy::TokenPolicy;
use crate::types::{GameSecrets, WebGameOracle};

const CREATOR: &str = "HGBiGfyR9GF36J4SMPjxsRkFuwYNuNYuzdCjgR4aw4FC";
const OPERATOR: &str = "4oRdwjBqMGjhh5octi4BLvtNGCgWdJDMv3bBr9Jpi5V8";

/// `crates/protocol/tests/fixtures/generators/web-prepare.mjs`: the transactions the
/// TypeScript `/web/games/prepare` builds for the inputs used below.
const TS_PREPARED_V020: &str = "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgEIDvGe0IZ5lbzejq53Q3XIGNu+FxRQSLdJoMBFKO4Wju6DOHeilYRTMl+jwsnoQ058578aNGn4ZrZOSkRvEfqDg2cPbdPtrt/mhARJWZA11u1XHOL3jOXB6HpdPAI+WWJ3+x9BFiFXtgCLXNxeuaMkqnUkvASKhI4dfu68SDmJ0gLsljEVTTn9VixI2jrZOGzMVqAFzUB8XPXTiLS61vF1OUroYB5wKnJk5h7g/mEgDgHSJ+HRonq2y5+uRTcgyem+ZgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHg0iCz6jo3UH9WT2FI2e1g3U0Q2pnkk5POb7LpIKoKY8gPwT+zdT/1s9AWh863b5f15PVDHSOc02+O/tizt3PD+JMu2ktphMpyUGuNDBrVhFHPfs/ct3trUw8Sy1NvYPjJclj04kifG7PRApFI4NgwtaE5na/xCEBI572Nvp+FkGm4hX/quBhPtof2NGGMA12sQ53BrrO1WYoPAAAAAAAQan1RcZLFxRIYzJTD1K8X9Y2u4Im6H9ROPb2YoAAAAABt324ddloZPZy+FGzut5rBy0he1fWzeROoz1hX7/AKkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUKBgAEAAsGDQEBBwwDAAkBCwIIBQ0KBAZCLD5m937QgtcAQEIPAAAAAAACAAAAAgAAAFgCAAAAAAAAAAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBgIABAwCAAAAQEIPAAAAAAANAgQMAREHCwMABwsCCAUNCgQJCGtwEiY4rTyA";
const TS_PREPARED_V030: &str = "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgEHDPGe0IZ5lbzejq53Q3XIGNu+FxRQSLdJoMBFKO4Wju6DOHeilYRTMl+jwsnoQ058578aNGn4ZrZOSkRvEfqDg2cfQRYhV7YAi1zcXrmjJKp1JLwEioSOHX7uvEg5idIC7Mr6ZlQDhdvBIXzw9nA2oXbBSPL8DmSBkWsawnqkEGXQyT+/5ql39Kf9ltb156+jJWNJTxCz2n3q0MbcNKnx0LAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4NIgs+o6N1B/Vk9hSNntYN1NENqZ5JOTzm+y6SCqCmP4ky7aS2mEynJQa40MGtWEUc9+z9y3e2tTDxLLU29g+MiobsSnS/BQzgi2ZAV4l9yW9eaY5HUVX1b4a0WQ8eAoyXJY9OJInxuz0QKRSODYMLWhOZ2v8QhASOe9jb6fhZxvp6877brTo9ZfNqq8l0MbG75MLS9uDkfKYCA0UvXWEG3fbh12Whk9nL4UbO63msHLSF7V9bN5E6jPWFfv8AqQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwkGAAQACgULAQEJBgADCAoFCwEBBgsCAAcBCggDCwkEBUIsPmb3ftCC1wFAQg8AAAAAAAIAAAABAAAAWAIAAAAAAAAABwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

type PoliciesFn = Arc<dyn Fn() -> Result<Vec<TokenPolicy>> + Send + Sync>;
type SecretsFn = Arc<dyn Fn(Option<&str>) -> Result<GameSecrets> + Send + Sync>;
type SignFn = Arc<dyn Fn(&str) -> Result<String> + Send + Sync>;

struct FakeOracle {
    rpc: Arc<RpcPool>,
    policies: PoliciesFn,
    secrets: SecretsFn,
    sign: SignFn,
}

impl WebGameOracle for FakeOracle {
    fn rpc(&self) -> Arc<RpcPool> {
        self.rpc.clone()
    }

    fn program_id(&self) -> Address {
        PROGRAM_ID
    }

    fn generate_game_secrets<'a>(&'a self, game_type: Option<&'a str>) -> BoxFuture<'a, Result<GameSecrets>> {
        let result = (self.secrets)(game_type);
        async move { result }.boxed()
    }

    fn sign_game_transaction<'a>(&'a self, tx_base64: &'a str) -> BoxFuture<'a, Result<String>> {
        let result = (self.sign)(tx_base64);
        async move { result }.boxed()
    }

    fn token_policies(&self) -> BoxFuture<'_, Result<Vec<TokenPolicy>>> {
        let result = (self.policies)();
        async move { result }.boxed()
    }
}

fn policy(mint: &str, minimum: &str, accepted: &str, revision: i64) -> TokenPolicy {
    TokenPolicy {
        mint: mint.into(),
        enabled: true,
        minimum_amount_raw: minimum.into(),
        accepted_minimum_amount_raw: accepted.into(),
        revision,
        effective_at: "2026-01-01T00:00:00.000Z".into(),
    }
}

fn default_policies() -> Vec<TokenPolicy> {
    KNOWN_TOKENS.iter().map(|token| policy(token.mint, "1000", "950", 1)).collect()
}

fn secrets(operator: Option<&str>) -> GameSecrets {
    GameSecrets {
        random_hash: "07".repeat(32),
        game_address: CREATOR.into(),
        oracle_operator: operator.map(String::from),
    }
}

type Accounts = Arc<Mutex<HashMap<String, Value>>>;

fn encoded_account(data: &[u8], owner: &Address) -> Value {
    json!({
        "data": [base64::engine::general_purpose::STANDARD.encode(data), "base64"],
        "owner": owner.to_base58(),
        "lamports": 1,
        "executable": false,
        "space": data.len(),
        "rentEpoch": 0,
    })
}

/// An initialized SPL mint (`getMintEncoder`) with no authorities.
fn mint_data(decimals: u8) -> Vec<u8> {
    let mut data = vec![0u8; 82];
    data[36..44].copy_from_slice(&1_000_000u64.to_le_bytes());
    data[44] = decimals;
    data[45] = 1;
    data
}

fn game_token_data(mint: &Address, min_amount: u64, enabled: bool) -> Vec<u8> {
    timba_protocol::contracts::GameTokenAccount {
        token_mint: *mint,
        vault_bump: 255,
        min_amount,
        fee_amount: 0,
        enabled,
    }
    .encode()
}

/// Mint accounts for every supported token plus their v0.2 configuration PDAs.
fn token_chain() -> Accounts {
    let mut accounts = HashMap::new();
    for token in KNOWN_TOKENS {
        let mint = Address::parse(token.mint).unwrap();
        accounts.insert(token.mint.to_string(), encoded_account(&mint_data(6), &TOKEN_PROGRAM_ID));
        accounts.insert(
            find_game_token_pda(&mint, &PROGRAM_ID).to_base58(),
            encoded_account(&game_token_data(&mint, 1_000, true), &PROGRAM_ID),
        );
    }
    Arc::new(Mutex::new(accounts))
}

fn empty_chain() -> Accounts {
    Arc::default()
}

/// An RPC double serving accounts from `accounts`; other methods fail unless
/// a handler is added to the returned transport.
fn rpc_for(accounts: &Accounts) -> (Arc<RpcPool>, Arc<FakeTransport>) {
    let transport = FakeTransport::new();
    let accounts = accounts.clone();
    transport.on(move |_, method, params| -> Option<Result<Value, RpcError>> {
        let accounts = accounts.lock().unwrap();
        let lookup = |key: &Value| accounts.get(key.as_str().unwrap_or_default()).cloned().unwrap_or(Value::Null);
        match method {
            "getMultipleAccounts" => {
                let values: Vec<Value> = params[0].as_array().unwrap().iter().map(lookup).collect();
                Some(Ok(json!({ "context": { "slot": 1 }, "value": values })))
            }
            "getAccountInfo" => Some(Ok(json!({ "context": { "slot": 1 }, "value": lookup(&params[0]) }))),
            _ => None,
        }
    });
    let rpc = RpcPool::with_transport(&["https://rpc.test".into()], transport.clone()).unwrap();
    (Arc::new(rpc), transport)
}

fn oracle(rpc: Arc<RpcPool>) -> FakeOracle {
    FakeOracle {
        rpc,
        policies: Arc::new(|| Ok(default_policies())),
        secrets: Arc::new(|_| Err(anyhow!("unexpected secret generation"))),
        sign: Arc::new(|_| Err(anyhow!("unexpected signing"))),
    }
}

struct Harness {
    api: Arc<WebGameApi>,
    db: Arc<IndexerDatabase>,
    now: Arc<AtomicI64>,
}

impl Harness {
    fn new(oracle: FakeOracle, version: ContractVersion) -> Self {
        let db = Arc::new(IndexerDatabase::open(":memory:").unwrap());
        let config = OracleConfig { contract_version: version, jupiter_api_key: None, ..OracleConfig::for_tests() };
        let now = Arc::new(AtomicI64::new(1_800_000_000_000));
        let clock = now.clone();
        let clock: Clock = Arc::new(move || clock.load(Ordering::SeqCst));
        // Jupiter stays disabled: no price lookup may leave the process.
        let prices = TokenUsdPrices::with_fetcher(
            Arc::new(|url, _| async move { Err(format!("unexpected network request to {url}")) }.boxed()),
            clock.clone(),
        );
        let api =
            WebGameApi::new(Arc::new(oracle), db.clone(), &config).with_prices(Arc::new(prices)).with_clock(clock);
        Self { api: Arc::new(api), db, now }
    }

    fn advance(&self, ms: i64) {
        self.now.fetch_add(ms, Ordering::SeqCst);
    }

    async fn send(&self, request: Request<Body>) -> Reply {
        let response = self.api.clone().router().oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        let body = serde_json::from_str(&text).unwrap_or(Value::Null);
        Reply { status, headers, body, text }
    }

    async fn get(&self, uri: &str) -> Reply {
        self.send(Request::get(format!("http://oracle{uri}")).body(Body::empty()).unwrap()).await
    }
}

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: Value,
    text: String,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }
}

fn post(uri: &str, content_type: &str, body: impl Into<Body>, headers: &[(&str, &str)]) -> Request<Body> {
    let mut builder = Request::post(format!("http://oracle{uri}")).header("content-type", content_type);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(body.into()).unwrap()
}

fn method_calls(transport: &FakeTransport, method: &str) -> usize {
    transport.calls_for(method).len()
}

/// Yields until `done` holds (bounded), letting background refreshes finish.
async fn settle(done: impl Fn() -> bool) {
    for _ in 0..5_000 {
        if done() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
}

// ---------------------------------------------------------------------------
// Token config
// ---------------------------------------------------------------------------

#[tokio::test]
async fn token_config_lists_every_supported_token_with_its_creation_minimum() {
    let (rpc, _) = rpc_for(&token_chain());
    let harness = Harness::new(oracle(rpc), ContractVersion::V0_2_0);

    let reply = harness.get("/web/config").await;

    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.header("cache-control"), Some("public, max-age=5, s-maxage=10"));
    assert_eq!(reply.header("content-type"), Some(JSON_CONTENT_TYPE));
    let tokens = reply.body["tokens"].as_array().unwrap();
    let mut mints: Vec<&str> = tokens.iter().map(|token| token["mint"].as_str().unwrap()).collect();
    mints.sort();
    let mut expected: Vec<&str> = KNOWN_TOKENS.iter().map(|token| token.mint).collect();
    expected.sort();
    assert_eq!(mints, expected);
    let usdc = tokens.iter().find(|token| token["mint"] == USDC_MINT).unwrap();
    assert_eq!(
        usdc,
        &json!({
            "mint": USDC_MINT, "symbol": "USDC", "decimals": 6, "minimumAmount": "0.001",
            "minimumAmountRaw": "1000", "enabled": true, "priceUsd": null
        })
    );
}

#[tokio::test]
async fn token_config_serves_fresh_then_stale_while_revalidating_then_refreshes() {
    let (rpc, transport) = rpc_for(&token_chain());
    let harness = Harness::new(oracle(rpc), ContractVersion::V0_2_0);
    let reads = || method_calls(&transport, "getMultipleAccounts");

    harness.get("/web/config").await;
    let after_first = reads();
    assert!(after_first > 0);
    harness.get("/web/config").await;
    assert_eq!(reads(), after_first);

    harness.advance(6_000);
    let stale = harness.get("/web/config").await;
    assert_eq!(stale.status, StatusCode::OK);
    settle(|| reads() >= after_first * 2).await;
    assert_eq!(reads(), after_first * 2);

    harness.advance(10 * 60_000);
    harness.get("/web/config").await;
    assert_eq!(reads(), after_first * 3);
}

#[tokio::test]
async fn token_config_shares_one_in_flight_refresh_between_concurrent_requests() {
    let (rpc, transport) = rpc_for(&token_chain());
    let harness = Harness::new(oracle(rpc), ContractVersion::V0_2_0);

    let (first, second) = tokio::join!(harness.get("/web/config"), harness.get("/web/config"));

    assert_eq!((first.status, second.status), (StatusCode::OK, StatusCode::OK));
    let (single_rpc, single_transport) = rpc_for(&token_chain());
    Harness::new(oracle(single_rpc), ContractVersion::V0_2_0).get("/web/config").await;
    assert_eq!(method_calls(&transport, "getMultipleAccounts"), method_calls(&single_transport, "getMultipleAccounts"));
}

#[tokio::test]
async fn token_config_keeps_serving_a_stale_value_when_the_background_refresh_fails() {
    let accounts = token_chain();
    let (rpc, transport) = rpc_for(&accounts);
    let fail = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let failing = fail.clone();
    let harness = Harness::new(
        FakeOracle {
            policies: Arc::new(move || {
                if failing.load(Ordering::SeqCst) {
                    Err(anyhow!("policy store offline"))
                } else {
                    Ok(default_policies())
                }
            }),
            ..oracle(rpc)
        },
        ContractVersion::V0_2_0,
    );
    let first = harness.get("/web/config").await;

    fail.store(true, Ordering::SeqCst);
    accounts.lock().unwrap().clear();
    harness.advance(6_000);
    let calls = method_calls(&transport, "getMultipleAccounts");
    let stale = harness.get("/web/config").await;
    settle(|| method_calls(&transport, "getMultipleAccounts") > calls).await;
    tokio::task::yield_now().await;

    assert_eq!(stale.status, StatusCode::OK);
    assert_eq!(stale.text, first.text);
    // The failed refresh is not cached: once the stale window passes, the error surfaces.
    harness.advance(10 * 60_000);
    let expired = harness.get("/web/config").await;
    assert_eq!(expired.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(expired.body, json!({ "error": "Game service temporarily unavailable" }));
}

#[tokio::test]
async fn token_config_lists_tokens_with_the_minimums_from_the_oracle_token_policy() {
    let (rpc, transport) = rpc_for(&token_chain());
    let policy_reads = Arc::new(AtomicUsize::new(0));
    let counter = policy_reads.clone();
    let harness = Harness::new(
        FakeOracle {
            policies: Arc::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(vec![policy(USDC_MINT, "2500", "2400", 3)])
            }),
            ..oracle(rpc)
        },
        ContractVersion::V0_3_0,
    );

    let reply = harness.get("/web/config").await;

    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(
        reply.body,
        json!({ "tokens": [{
            "mint": USDC_MINT, "symbol": "USDC", "decimals": 6, "minimumAmount": "0.0025",
            "minimumAmountRaw": "2500", "enabled": true, "priceUsd": null
        }] })
    );
    assert_eq!(policy_reads.load(Ordering::SeqCst), 1);
    assert_eq!(method_calls(&transport, "getProgramAccounts"), 0);
}

#[tokio::test]
async fn token_config_rejects_invalid_oracle_policies() {
    let (rpc, _) = rpc_for(&token_chain());
    let harness = Harness::new(
        FakeOracle { policies: Arc::new(|| Ok(vec![policy(USDC_MINT, "2400", "2500", 3)])), ..oracle(rpc) },
        ContractVersion::V0_3_0,
    );
    let reply = harness.get("/web/config").await;
    assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(reply.header("cache-control"), Some("no-store"));
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

fn signature_of(byte: u8) -> String {
    bs58::encode([byte; 64]).into_string()
}

#[tokio::test]
// The current-thread test runtime has no other task contending for the lock.
#[allow(clippy::await_holding_lock)]
async fn verification_serves_a_previously_verified_game_with_an_immutable_cache_policy() {
    let _env = crate::env_test_lock();
    let (rpc, transport) = rpc_for(&empty_chain());
    let harness = Harness::new(oracle(rpc), ContractVersion::V0_2_0);
    let signature = signature_of(9);
    let key = format!("{}:verification-v2:{signature}", verification_namespace(&PROGRAM_ID));
    harness.db.save_verified_game(&key, &json!({ "signature": signature, "winner": "cached" }).to_string()).unwrap();

    let reply = harness.get(&format!("/web/verification/{signature}")).await;

    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body, json!({ "signature": signature, "winner": "cached" }));
    assert_eq!(reply.header("cache-control"), Some("public, max-age=31536000, s-maxage=31536000, immutable"));
    assert!(transport.calls.lock().unwrap().is_empty());
    harness.api.verify(&signature).await.unwrap();
    assert_eq!(harness.api.verified_game(&signature).await.unwrap()["winner"], "cached");
}

#[tokio::test]
// The current-thread test runtime has no other task contending for the lock.
#[allow(clippy::await_holding_lock)]
async fn verification_reports_an_unavailable_service_when_the_chain_lookup_fails() {
    let _env = crate::env_test_lock();
    let (rpc, _) = rpc_for(&empty_chain());
    let harness = Harness::new(oracle(rpc), ContractVersion::V0_2_0);
    let signature = signature_of(9);

    let reply = harness.get(&format!("/web/verification/{signature}")).await;

    assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(reply.header("retry-after"), Some("5"));
    assert_eq!(reply.header("cache-control"), Some("no-store"));
    assert_eq!(reply.body, json!({ "error": "Game service temporarily unavailable" }));
    assert!(harness.api.verify(&signature).await.is_err());
    assert_eq!(
        harness
            .db
            .get_verified_game(&format!("{}:verification-v2:{signature}", verification_namespace(&PROGRAM_ID)))
            .unwrap(),
        None
    );
}

#[test]
fn the_verification_namespace_hashes_the_configured_network() {
    let _env = crate::env_test_lock();
    let namespace = verification_namespace(&PROGRAM_ID);
    let (hash, program) = namespace.split_once(':').unwrap();
    assert_eq!(program, PROGRAM_ID.to_base58());
    match std::env::var("SOLANA_NETWORK") {
        // sha256("configured")
        Err(_) => assert_eq!(hash, "20158224750041d653cd8c737d64c2fdce258d4280c9bf2a49fa1db0a7f9f3ac"),
        Ok(network) => {
            use sha2::Digest;
            assert_eq!(hash, hex::encode(sha2::Sha256::digest(network.as_bytes())));
        }
    }
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

/// A legacy transaction signed by its fee payer and, with `signers == 2`, the
/// second required signer.
fn signed_transaction(payer: &Keypair, other: &Keypair, signers: usize) -> String {
    let message = LegacyMessage::compile(
        &payer.address(),
        &Address::parse("11111111111111111111111111111111").unwrap(),
        &[Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![AccountMeta::readonly_signer(other.address())],
            data: vec![1],
        }],
    )
    .unwrap();
    let mut transaction = Transaction::from_message(&message);
    transaction.set_signature(&payer.address(), payer.sign(&transaction.message_bytes)).unwrap();
    if signers == 2 {
        transaction.set_signature(&other.address(), other.sign(&transaction.message_bytes)).unwrap();
    }
    transaction.to_base64()
}

fn submit(body: impl Into<Body>, content_type: &str) -> Request<Body> {
    post("/web/games/submit", content_type, body, &[])
}

#[tokio::test]
async fn submission_broadcasts_the_oracle_co_signed_transaction() {
    let (payer, other) = (Keypair::generate(), Keypair::generate());
    let signed = signed_transaction(&payer, &other, 2);
    let creator_signed = signed_transaction(&payer, &other, 1);
    let broadcast = signature_of(3);
    let (rpc, transport) = rpc_for(&empty_chain());
    let reply_signature = broadcast.clone();
    transport.on(move |_, method, _| (method == "sendTransaction").then(|| Ok(json!(reply_signature))));
    let payloads = Arc::new(Mutex::new(Vec::<String>::new()));
    let recorded = payloads.clone();
    let cosigned = signed.clone();
    let harness = Harness::new(
        FakeOracle {
            sign: Arc::new(move |payload| {
                recorded.lock().unwrap().push(payload.to_string());
                Ok(cosigned.clone())
            }),
            ..oracle(rpc)
        },
        ContractVersion::V0_2_0,
    );

    let reply = harness.send(submit(json!({ "txBase64": creator_signed }).to_string(), "application/json")).await;

    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body, json!({ "signature": broadcast }));
    assert_eq!(reply.header("cache-control"), Some("no-store"));
    assert_eq!(*payloads.lock().unwrap(), vec![creator_signed]);
    let sent = transport.calls_for("sendTransaction");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].1, json!([signed, { "encoding": "base64", "preflightCommitment": "confirmed" }]));
}

#[tokio::test]
async fn submission_fails_closed_when_the_node_returns_a_malformed_signature() {
    let (payer, other) = (Keypair::generate(), Keypair::generate());
    let signed = signed_transaction(&payer, &other, 2);
    let (rpc, transport) = rpc_for(&empty_chain());
    transport.on(|_, method, _| (method == "sendTransaction").then(|| Ok(json!("not-a-signature"))));
    let cosigned = signed.clone();
    let harness = Harness::new(
        FakeOracle { sign: Arc::new(move |_| Ok(cosigned.clone())), ..oracle(rpc) },
        ContractVersion::V0_2_0,
    );

    let reply = harness.send(submit(json!({ "txBase64": signed }).to_string(), "application/json")).await;

    assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(reply.body, json!({ "error": "Game service temporarily unavailable" }));
    assert_eq!(method_calls(&transport, "sendTransaction"), 1, "the transaction was broadcast");
}

#[tokio::test]
async fn submission_refuses_to_broadcast_a_transaction_that_is_still_missing_signatures() {
    let (payer, other) = (Keypair::generate(), Keypair::generate());
    let partial = signed_transaction(&payer, &other, 1);
    let (rpc, transport) = rpc_for(&empty_chain());
    let returned = partial.clone();
    let harness = Harness::new(
        FakeOracle { sign: Arc::new(move |_| Ok(returned.clone())), ..oracle(rpc) },
        ContractVersion::V0_2_0,
    );

    let reply = harness.send(submit(json!({ "txBase64": partial }).to_string(), "application/json")).await;

    assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(method_calls(&transport, "sendTransaction"), 0);
    assert!(Transaction::from_base64(&partial).unwrap().signatures.iter().any(|(_, signature)| signature.is_none()));
}

#[tokio::test]
async fn submission_rejects_malformed_bodies() {
    let (rpc, transport) = rpc_for(&empty_chain());
    let harness = Harness::new(oracle(rpc), ContractVersion::V0_2_0);

    let cases = [
        (submit(json!({ "nope": true }).to_string(), "application/json"), "Invalid transaction"),
        (submit("{", "application/json"), "Invalid JSON"),
        (submit(json!({ "txBase64": "x" }).to_string(), "text/plain"), "Expected JSON"),
        (submit(json!({ "txBase64": "AQID", "extra": 1 }).to_string(), "application/json"), "Invalid transaction"),
        (submit(json!({ "txBase64": "A".repeat(4004) }).to_string(), "application/json"), "Invalid transaction"),
        (submit(Body::empty(), "application/json"), "Missing body"),
        (submit(" ".repeat(8193), "application/json; charset=utf-8"), "Request is too large"),
    ];
    for (request, message) in cases {
        let reply = harness.send(request).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{message}");
        assert_eq!(reply.body, json!({ "error": message }));
        assert_eq!(reply.header("cache-control"), Some("no-store"));
        assert_eq!(reply.header("retry-after"), Some("5"));
    }
    assert!(transport.calls.lock().unwrap().is_empty());
}

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

fn prepare_body(token_mint: &str, game_type: &str, amount: &str, min_players: u32) -> String {
    json!({
        "creator": CREATOR,
        "tokenMint": token_mint,
        "type": game_type,
        "amount": amount,
        "minPlayers": min_players,
        "maxPlayers": 2,
        "timeoutSeconds": 600,
    })
    .to_string()
}

fn prepare(body: String, version: Option<&str>) -> Request<Body> {
    let headers: Vec<(&str, &str)> = version.map(|v| vec![("x-timba-contract-version", v)]).unwrap_or_default();
    post("/web/games/prepare", "application/json", body, &headers)
}

fn with_blockhash(transport: &FakeTransport) {
    transport.on(|_, method, _| {
        (method == "getLatestBlockhash").then(|| {
            Ok(json!({
                "context": { "slot": 1 },
                "value": { "blockhash": "11111111111111111111111111111111", "lastValidBlockHeight": 100 }
            }))
        })
    });
}

#[tokio::test]
async fn preparation_rejects_invalid_and_oversized_requests_before_rpc_or_signing() {
    let (rpc, transport) = rpc_for(&empty_chain());
    let harness = Harness::new(oracle(rpc), ContractVersion::V0_2_0);

    let reply = harness.send(post("/web/games/prepare", "application/json", "{}", &[])).await;
    assert_eq!((reply.status, reply.body), (StatusCode::BAD_REQUEST, json!({ "error": "Invalid game request" })));
    let reply = harness.send(post("/web/games/prepare", "application/json", " ".repeat(4097), &[])).await;
    assert_eq!((reply.status, reply.body), (StatusCode::BAD_REQUEST, json!({ "error": "Request is too large" })));
    let reply = harness.get("/web/verification/invalid").await;
    assert_eq!((reply.status, reply.body.clone()), (StatusCode::BAD_REQUEST, json!({ "error": "Invalid signature" })));
    assert_eq!(reply.header("cache-control"), None);
    let reply = harness.get("/web/games/invalid").await;
    assert_eq!((reply.status, reply.body), (StatusCode::BAD_REQUEST, json!({ "error": "Invalid game address" })));
    let reply = harness.get("/web/unknown/11111111111111111111111111111111").await;
    assert_eq!((reply.status, reply.body.clone()), (StatusCode::NOT_FOUND, json!({ "error": "Not found" })));
    assert_eq!(reply.header("cache-control"), None);
    assert!(transport.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn preparation_rejects_a_web_build_compiled_for_another_contract_version() {
    let (rpc, transport) = rpc_for(&empty_chain());
    let harness = Harness::new(oracle(rpc), ContractVersion::V0_2_0);

    for version in [Some("9.9.9"), None, Some("0.3.0")] {
        let reply = harness.send(prepare(prepare_body(USDC_MINT, "giveaway", "1000000", 1), version)).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
        assert_eq!(reply.body, json!({ "error": "Game contract configuration mismatch" }));
    }
    assert!(transport.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn preparation_fails_closed_when_the_oracle_does_not_report_its_operator() {
    let (rpc, _) = rpc_for(&token_chain());
    let harness =
        Harness::new(FakeOracle { secrets: Arc::new(|_| Ok(secrets(None))), ..oracle(rpc) }, ContractVersion::V0_2_0);

    let reply = harness.send(prepare(prepare_body(USDC_MINT, "giveaway", "1000000", 1), Some("0.2.0"))).await;

    assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn preparation_applies_the_v0_2_token_account_minimum() {
    let accounts = token_chain();
    let usdc = Address::parse(USDC_MINT).unwrap();
    accounts.lock().unwrap().insert(
        find_game_token_pda(&usdc, &PROGRAM_ID).to_base58(),
        encoded_account(&game_token_data(&usdc, 5_000_000, true), &PROGRAM_ID),
    );
    let (rpc, _) = rpc_for(&accounts);
    let harness = Harness::new(oracle(rpc), ContractVersion::V0_2_0);

    let reply = harness.send(prepare(prepare_body(USDC_MINT, "giveaway", "4999999", 1), Some("0.2.0"))).await;

    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(reply.body, json!({ "error": "Minimum amount is 5 USDC" }));
}

#[tokio::test]
async fn preparation_rejects_amounts_below_the_oracle_policy_minimum_before_generating_secrets() {
    let (rpc, _) = rpc_for(&token_chain());
    let secrets_calls = Arc::new(AtomicUsize::new(0));
    let counter = secrets_calls.clone();
    let harness = Harness::new(
        FakeOracle {
            secrets: Arc::new(move |_| {
                counter.fetch_add(1, Ordering::SeqCst);
                Err(anyhow!("unexpected secret generation"))
            }),
            ..oracle(rpc)
        },
        ContractVersion::V0_3_0,
    );

    let reply = harness.send(prepare(prepare_body(USDC_MINT, "giveaway", "10", 1), Some("0.3.0"))).await;

    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(reply.body, json!({ "error": "Minimum amount is 0.001 USDC" }));
    assert_eq!(secrets_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn preparation_checks_the_policy_minimum_and_then_requests_game_secrets() {
    let (rpc, _) = rpc_for(&token_chain());
    let secrets_calls = Arc::new(AtomicUsize::new(0));
    let counter = secrets_calls.clone();
    let harness = Harness::new(
        FakeOracle {
            secrets: Arc::new(move |game_type| {
                assert_eq!(game_type, Some("giveaway"));
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(secrets(None))
            }),
            ..oracle(rpc)
        },
        ContractVersion::V0_3_0,
    );

    let reply = harness.send(prepare(prepare_body(USDC_MINT, "giveaway", "1000000", 1), Some("0.3.0"))).await;

    assert_eq!(secrets_calls.load(Ordering::SeqCst), 1);
    assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn preparation_builds_a_creator_funded_coinflip_transaction() {
    let accounts = empty_chain();
    let sol = Address::parse(SOL_MINT).unwrap();
    accounts.lock().unwrap().insert(
        find_game_token_pda(&sol, &PROGRAM_ID).to_base58(),
        encoded_account(&game_token_data(&sol, 1, true), &PROGRAM_ID),
    );
    let (rpc, transport) = rpc_for(&accounts);
    with_blockhash(&transport);
    let harness = Harness::new(
        FakeOracle {
            secrets: Arc::new(|_| Ok(secrets(Some(OPERATOR)))),
            sign: Arc::new(|_| Err(anyhow!("Must not sign before the creator"))),
            ..oracle(rpc)
        },
        ContractVersion::V0_2_0,
    );

    let reply = harness.send(prepare(prepare_body(SOL_MINT, "coinflip", "1000000", 2), Some("0.2.0"))).await;

    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
    assert_eq!(reply.header("cache-control"), Some("no-store"));
    let game = find_game_pda(&[7; 32], &PROGRAM_ID);
    assert_eq!(reply.body["gameAddress"], game.to_base58());
    assert_eq!(reply.body["lastValidBlockHeight"], 100);
    let keys: Vec<&str> = reply.body.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, ["txBase64", "gameAddress", "lastValidBlockHeight"]);
    let tx_base64 = reply.body["txBase64"].as_str().unwrap();
    let transaction = Transaction::from_base64(tx_base64).unwrap();
    let message = LegacyMessage::deserialize(&transaction.message_bytes).unwrap();
    assert_eq!(message.account_keys[0].to_base58(), CREATOR);
    assert!(transaction.signatures.iter().any(|(address, _)| address.to_base58() == OPERATOR));
    assert!(transaction.signatures.iter().all(|(_, signature)| signature.is_none()));
    assert_eq!(tx_base64, TS_PREPARED_V020);
}

#[tokio::test]
async fn preparation_fails_closed_when_the_blockhash_expiry_is_not_a_safe_integer() {
    let accounts = empty_chain();
    let sol = Address::parse(SOL_MINT).unwrap();
    accounts.lock().unwrap().insert(
        find_game_token_pda(&sol, &PROGRAM_ID).to_base58(),
        encoded_account(&game_token_data(&sol, 1, true), &PROGRAM_ID),
    );
    let (rpc, transport) = rpc_for(&accounts);
    transport.push(
        "getLatestBlockhash",
        Ok(json!({
            "context": { "slot": 1 },
            "value": { "blockhash": "11111111111111111111111111111111", "lastValidBlockHeight": 9_007_199_254_740_993u64 }
        })),
    );
    let harness = Harness::new(
        FakeOracle { secrets: Arc::new(|_| Ok(secrets(Some(OPERATOR)))), ..oracle(rpc) },
        ContractVersion::V0_2_0,
    );

    let reply = harness.send(prepare(prepare_body(SOL_MINT, "coinflip", "1000000", 2), Some("0.2.0"))).await;

    assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE, "{}", reply.text);
    assert_eq!(reply.body, json!({ "error": "Game service temporarily unavailable" }));
    assert_eq!(method_calls(&transport, "getLatestBlockhash"), 1, "refused after building the transaction");
}

#[tokio::test]
async fn preparation_with_oracle_token_policies_matches_the_typescript_transaction() {
    let (rpc, transport) = rpc_for(&token_chain());
    with_blockhash(&transport);
    let harness = Harness::new(
        FakeOracle { secrets: Arc::new(|_| Ok(secrets(Some(OPERATOR)))), ..oracle(rpc) },
        ContractVersion::V0_3_0,
    );

    let reply = harness.send(prepare(prepare_body(USDC_MINT, "giveaway", "1000000", 1), Some("0.3.0"))).await;

    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
    assert_eq!(reply.body["txBase64"], TS_PREPARED_V030);
    assert_eq!(reply.body["gameAddress"], find_game_pda(&[7; 32], &PROGRAM_ID).to_base58());
}

// ---------------------------------------------------------------------------
// Game lookup
// ---------------------------------------------------------------------------

fn game_account_data() -> Vec<u8> {
    let creator = Keypair::generate().address();
    GameAccount {
        creator,
        game_type: GameType::Coinflip,
        ticket_amount: 250,
        max_tickets: 2,
        min_tickets: 2,
        tickets_count: 1,
        token_mint: Address::parse(USDC_MINT).unwrap(),
        created_at: 1_000,
        timeout: 600,
        last_slot: 42,
        is_private: false,
        total_amount: 250,
        participants: vec![creator],
    }
    .encode()
}

#[tokio::test]
async fn game_lookup_decodes_an_on_chain_game_and_honours_the_fresh_flag() {
    let game = Keypair::generate().address().to_base58();
    let data = game_account_data();
    let accounts = empty_chain();
    accounts.lock().unwrap().insert(game.clone(), encoded_account(&data, &PROGRAM_ID));
    let (rpc, transport) = rpc_for(&accounts);
    let harness = Harness::new(oracle(rpc), ContractVersion::V0_2_0);

    let cached = harness.get(&format!("/web/games/{game}")).await;
    let fresh = harness.get(&format!("/web/games/{game}?fresh=1")).await;
    let other = harness.get(&format!("/web/games/{game}?fresh=0&fresh=1")).await;

    assert_eq!(cached.header("cache-control"), Some("public, max-age=2, s-maxage=2"));
    assert_eq!(fresh.header("cache-control"), Some("no-store"));
    assert_eq!(other.header("cache-control"), Some("public, max-age=2, s-maxage=2"));
    let creator = Address::from_slice(&data[8..40]).unwrap().to_base58();
    assert_eq!(
        cached.text,
        json!({
            "address": game, "creator": creator, "type": "coinflip", "tokenMint": USDC_MINT,
            "stakeAmount": "250", "prizeAmount": "250", "currentPlayers": 1, "minPlayers": 2, "maxPlayers": 2,
            "isPrivate": false, "createdAt": 1000, "expiresAt": 1600, "creationSignature": "", "lastSlot": "42",
            "participantAddresses": [creator]
        })
        .to_string()
    );
    assert_eq!(
        transport.calls_for("getAccountInfo")[0].1,
        json!([game, { "commitment": "confirmed", "encoding": "base64" }])
    );
}

#[tokio::test]
async fn game_lookup_returns_404_for_a_missing_game_account() {
    let (rpc, _) = rpc_for(&empty_chain());
    let harness = Harness::new(oracle(rpc), ContractVersion::V0_2_0);
    let game = Keypair::generate().address().to_base58();

    let reply = harness.get(&format!("/web/games/{game}")).await;

    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert_eq!(reply.body, json!({ "error": "Game not found" }));
    assert_eq!(reply.header("cache-control"), None);
}

#[tokio::test]
async fn game_lookup_rejects_accounts_owned_by_another_program_or_not_holding_a_game() {
    let game = Keypair::generate().address().to_base58();
    let garbage = Keypair::generate().address().to_base58();
    let accounts = empty_chain();
    accounts.lock().unwrap().insert(game.clone(), encoded_account(&game_account_data(), &TOKEN_PROGRAM_ID));
    accounts.lock().unwrap().insert(garbage.clone(), encoded_account(&[1, 2, 3], &PROGRAM_ID));
    let (rpc, _) = rpc_for(&accounts);
    let harness = Harness::new(oracle(rpc), ContractVersion::V0_2_0);

    let reply = harness.get(&format!("/web/games/{game}")).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(reply.body, json!({ "error": "Invalid game account" }));

    let reply = harness.get(&format!("/web/games/{garbage}")).await;
    assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

#[tokio::test]
async fn routes_only_match_their_methods() {
    let (rpc, transport) = rpc_for(&empty_chain());
    let harness = Harness::new(oracle(rpc), ContractVersion::V0_2_0);

    let post_config = harness.send(post("/web/config", "application/json", "{}", &[])).await;
    assert_eq!((post_config.status, post_config.body), (StatusCode::NOT_FOUND, json!({ "error": "Not found" })));
    let get_submit = harness.get("/web/games/submit").await;
    assert_eq!(
        (get_submit.status, get_submit.body),
        (StatusCode::BAD_REQUEST, json!({ "error": "Invalid game address" }))
    );
    let nested = harness.get("/web/games/a/b").await;
    assert_eq!(nested.status, StatusCode::NOT_FOUND);
    // Known paths with the wrong method are not routed either.
    let signature = signature_of(9);
    let post_verification =
        harness.send(post(&format!("/web/verification/{signature}"), "application/json", "{}", &[])).await;
    assert_eq!(post_verification.status, StatusCode::NOT_FOUND);
    let post_game = harness.send(post(&format!("/web/games/{CREATOR}"), "application/json", "{}", &[])).await;
    assert_eq!(post_game.status, StatusCode::NOT_FOUND);
    let root = harness.get("/web/").await;
    assert_eq!(root.status, StatusCode::NOT_FOUND);
    assert_eq!(root.header("content-type"), Some(JSON_CONTENT_TYPE));
    assert!(transport.calls.lock().unwrap().is_empty());
}

#[test]
fn mint_fixtures_match_the_spl_mint_layout() {
    assert_eq!(mint_data(6).len(), super::game_token_config::MINT_SIZE);
}
