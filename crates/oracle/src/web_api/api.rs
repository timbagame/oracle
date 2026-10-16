//! The `/web/*` game API (port of `web-api/api.ts`): token configuration,
//! game preparation and submission, game lookup and finalized verification.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, bail, Result};
use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::Response;
use axum::routing::any;
use axum::Router;
use futures::future::{BoxFuture, FutureExt, Shared};
use futures::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use timba_protocol::contracts::{GameType, PROGRAM_ID};
use timba_protocol::plans::{
    build_create_game_plan, serialize_game, ContractAdapter, CreateGameInput, GameInstructionInput,
};
use timba_protocol::transaction::{LegacyMessage, Transaction};
use timba_protocol::validators::{is_base64_transaction, is_solana_signature};
use timba_protocol::{Address, ContractVersion};

use super::cache::{VerificationLoader, VerificationLoaderOptions};
use super::create_game_request::{parse_create_game_request, validate_create_game_request, CreateGameValidationError};
use super::game_token_config::{
    assert_game_token_amount, assert_game_token_policy, format_game_token_policies, get_game_token_configs,
    get_game_token_metadata, validate_token_policies,
};
use super::verification::{is_valid_signature, verify_game_transaction};
use crate::config::OracleConfig;
use crate::indexer::database::Clock;
use crate::indexer::pricing::TokenUsdPrices;
use crate::indexer::schema::{to_js_json, QueryParams, MAX_SAFE_INTEGER};
use crate::indexer::IndexerDatabase;
use crate::types::WebGameOracle;

/// `Response.json` content type.
pub const JSON_CONTENT_TYPE: &str = "application/json;charset=utf-8";
pub const CONTRACT_VERSION_HEADER: &str = "x-timba-contract-version";

const NO_STORE: &str = "no-store";
const CONFIG_CACHE: &str = "public, max-age=5, s-maxage=10";
const VERIFIED_CACHE: &str = "public, max-age=31536000, s-maxage=31536000, immutable";
const GAME_CACHE: &str = "public, max-age=2, s-maxage=2";
const UNAVAILABLE: &str = "Game service temporarily unavailable";

const PREPARE_BODY_LIMIT: usize = 4096;
const SUBMIT_BODY_LIMIT: usize = 8192;
const SUBMIT_TRANSACTION_MAX_LENGTH: usize = 4000;

const TOKEN_CACHE_FRESH_MS: i64 = 5000;
/// After the fresh window, keep serving the last value while one background
/// refresh runs, so page loads do not wait on Solana RPC and Jupiter.
const TOKEN_CACHE_STALE_MS: i64 = 5 * 60_000;

type TokenRefresh = Shared<BoxFuture<'static, Result<Value, String>>>;

fn validation(message: &str) -> anyhow::Error {
    CreateGameValidationError::new(message).into()
}

fn json_response(status: StatusCode, value: &Value, headers: &[(&'static str, &str)]) -> Response {
    let mut builder = Response::builder().status(status).header(header::CONTENT_TYPE, JSON_CONTENT_TYPE);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(Body::from(to_js_json(value))).expect("valid response")
}

/// `json(value, cache)`: 200 with a cache policy.
fn ok(value: &Value, cache: &str) -> Response {
    json_response(StatusCode::OK, value, &[("cache-control", cache)])
}

fn error_body(message: &str) -> Value {
    json!({ "error": message })
}

/// `readBody`: a bounded JSON request body.
async fn read_body(headers: &HeaderMap, body: Body, max_bytes: usize) -> Result<Value> {
    let is_json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("application/json"));
    if !is_json {
        return Err(validation("Expected JSON"));
    }
    let mut stream = body.into_data_stream();
    let mut bytes: Vec<u8> = Vec::new();
    let mut received_any = false;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| anyhow!("Failed to read request body: {error}"))?;
        received_any = true;
        if bytes.len() + chunk.len() > max_bytes {
            return Err(validation("Request is too large"));
        }
        bytes.extend_from_slice(&chunk);
    }
    if !received_any && bytes.is_empty() {
        return Err(validation("Missing body"));
    }
    serde_json::from_slice(&bytes).map_err(|_| validation("Invalid JSON"))
}

/// `SubmitGameRequestSchema`: `{ txBase64 }` only, at most 4000 characters.
fn parse_submit_request(value: &Value) -> Option<String> {
    let object = value.as_object()?;
    if object.keys().any(|key| key != "txBase64") {
        return None;
    }
    let tx = object.get("txBase64")?.as_str()?;
    (is_base64_transaction(tx) && tx.len() <= SUBMIT_TRANSACTION_MAX_LENGTH).then(|| tx.to_string())
}

/// `serializeGame(adapter.decodeGame(...))` in the TypeScript key order
/// (including the empty `creationSignature`).
fn serialized_game_value(adapter: &ContractAdapter, address: &str, data: &[u8]) -> Result<Value> {
    let game = adapter.decode_game(address, data).map_err(|error| anyhow!("{error}"))?;
    let serialized = serde_json::to_value(serialize_game(&game))?;
    let Value::Object(fields) = serialized else {
        bail!("Serialized game is not an object");
    };
    let mut output = serde_json::Map::new();
    for (key, value) in fields {
        let after_expiry = key == "expiresAt";
        output.insert(key, value);
        if after_expiry {
            output.insert("creationSignature".into(), Value::String(game.creation_signature.clone()));
        }
    }
    Ok(Value::Object(output))
}

/// The cache namespace for verification records:
/// `sha256(SOLANA_NETWORK ?? "configured"):programId`.
pub fn verification_namespace(program_id: &Address) -> String {
    let network = std::env::var("SOLANA_NETWORK").unwrap_or_else(|_| "configured".into());
    format!("{}:{}", hex::encode(Sha256::digest(network.as_bytes())), program_id.to_base58())
}

/// `createWebGameApi`.
pub struct WebGameApi {
    oracle: Arc<dyn WebGameOracle>,
    contract_version: ContractVersion,
    adapter: ContractAdapter,
    jupiter_api_key: Option<String>,
    prices: Arc<TokenUsdPrices>,
    now: Clock,
    verifier: VerificationLoader,
    token_cache: Mutex<Option<(Value, i64)>>,
    token_pending: Mutex<Option<(u64, TokenRefresh)>>,
    token_generation: AtomicU64,
}

impl WebGameApi {
    pub fn new(oracle: Arc<dyn WebGameOracle>, db: Arc<IndexerDatabase>, config: &OracleConfig) -> Self {
        let (reader, writer) = (db.clone(), db);
        let loader_oracle = oracle.clone();
        let verifier = VerificationLoader::new(VerificationLoaderOptions {
            read: Arc::new(move |key| reader.get_verified_game(key)),
            write: Arc::new(move |key, value| writer.save_verified_game(key, value)),
            load: Arc::new(move |signature| {
                let oracle = loader_oracle.clone();
                async move {
                    let rpc = oracle.rpc();
                    verify_game_transaction(&rpc, &oracle.program_id(), &signature).await
                }
                .boxed()
            }),
            namespace: verification_namespace(&oracle.program_id()),
            concurrency: None,
        });
        Self {
            contract_version: config.contract_version,
            adapter: ContractAdapter::new(config.contract_version, PROGRAM_ID),
            jupiter_api_key: config.jupiter_api_key.clone(),
            prices: TokenUsdPrices::global(),
            now: Arc::new(timba_common::time::now_ms),
            verifier,
            oracle,
            token_cache: Mutex::new(None),
            token_pending: Mutex::new(None),
            token_generation: AtomicU64::new(0),
        }
    }

    /// Replaces the process-wide USD price cache.
    pub fn with_prices(mut self, prices: Arc<TokenUsdPrices>) -> Self {
        self.prices = prices;
        self
    }

    /// Replaces `Date.now` for the token configuration cache.
    pub fn with_clock(mut self, now: Clock) -> Self {
        self.now = now;
        self
    }

    /// Serves `/web/*`. Authentication and rate limiting belong to the outer router.
    pub fn router(self: Arc<Self>) -> Router {
        let handler = move |request: Request| {
            let api = self.clone();
            async move { api.handle(request).await }
        };
        Router::new().route("/web/", any(handler.clone())).route("/web/{*rest}", any(handler))
    }

    /// Verifies (or loads the stored verification of) a completed game.
    pub async fn verify(&self, signature: &str) -> Result<()> {
        self.verifier.get(signature).await.map(|_| ())
    }

    /// The finalized verification record of a completed game.
    pub async fn verified_game(&self, signature: &str) -> Result<Value> {
        self.verifier.get(signature).await
    }

    pub async fn handle(self: Arc<Self>, request: Request) -> Response {
        match self.route(request).await {
            Ok(response) => response,
            Err(error) => {
                let (status, message) = match error.downcast_ref::<CreateGameValidationError>() {
                    Some(validation) => (StatusCode::BAD_REQUEST, validation.public_message.as_str()),
                    None => (StatusCode::SERVICE_UNAVAILABLE, UNAVAILABLE),
                };
                json_response(status, &error_body(message), &[("cache-control", NO_STORE), ("retry-after", "5")])
            }
        }
    }

    async fn route(self: &Arc<Self>, request: Request) -> Result<Response> {
        let (parts, body) = request.into_parts();
        let path = parts.uri.path().to_string();
        let get = parts.method == Method::GET;
        let post = parts.method == Method::POST;

        if path == "/web/config" && get {
            return Ok(ok(&self.token_config().await?, CONFIG_CACHE));
        }
        if let Some(signature) = single_segment(&path, "/web/verification/") {
            if get {
                if !is_valid_signature(signature) {
                    return Ok(json_response(StatusCode::BAD_REQUEST, &error_body("Invalid signature"), &[]));
                }
                return Ok(ok(&self.verifier.get(signature).await?, VERIFIED_CACHE));
            }
        }
        if path == "/web/games/prepare" && post {
            let version = parts.headers.get(CONTRACT_VERSION_HEADER).cloned();
            let body = read_body(&parts.headers, body, PREPARE_BODY_LIMIT).await?;
            return Ok(ok(&self.prepare(body, version).await?, NO_STORE));
        }
        if path == "/web/games/submit" && post {
            let body = read_body(&parts.headers, body, SUBMIT_BODY_LIMIT).await?;
            return Ok(ok(&self.submit(body).await?, NO_STORE));
        }
        if let Some(game) = single_segment(&path, "/web/games/") {
            if get {
                let fresh = QueryParams::parse(parts.uri.query()).first("fresh") == Some("1");
                return self.game(game, fresh).await;
            }
        }
        Ok(json_response(StatusCode::NOT_FOUND, &error_body("Not found"), &[]))
    }

    async fn prepare(&self, body: Value, version: Option<HeaderValue>) -> Result<Value> {
        let parsed = parse_create_game_request(&body).ok_or_else(|| validation("Invalid game request"))?;
        // Prevent a web build targeting a different contract generation from receiving incompatible bytes.
        if version.as_ref().and_then(|v| v.to_str().ok()) != Some(self.contract_version.as_str()) {
            return Err(validation("Game contract configuration mismatch"));
        }
        let input = validate_create_game_request(&parsed)?;
        let rpc = self.oracle.rpc();
        if self.contract_version.capabilities().game_token_account {
            assert_game_token_amount(&rpc, &input.token_mint, input.amount).await?;
        } else {
            let policies = self.oracle.token_policies().await?;
            validate_token_policies(&policies)?;
            let metadata = get_game_token_metadata(&rpc, std::slice::from_ref(&input.token_mint)).await?;
            assert_game_token_policy(&policies, &input.token_mint.to_base58(), input.amount, &metadata)?;
        }
        let commitment = self.oracle.generate_game_secrets(Some(input.game_type.name())).await?;
        let random_hash = hex::decode(&commitment.random_hash)?;
        let operator = commitment.oracle_operator.as_deref().ok_or_else(|| anyhow!("Missing oracle operator"))?;
        let oracle_operator = Address::parse(operator).map_err(|error| anyhow!("Invalid oracle operator: {error}"))?;
        let plan = build_create_game_plan(
            &CreateGameInput {
                creator: input.creator,
                token_mint: input.token_mint,
                game_type: input.game_type,
                amount: input.amount,
                min_players: input.min_players,
                max_players: input.max_players,
                timeout_seconds: input.timeout_seconds,
                random_hash,
                oracle_operator,
            },
            self.contract_version,
            &PROGRAM_ID,
        )
        .map_err(|error| anyhow!("{error}"))?;
        let mut instructions = plan.instructions;
        if input.game_type == GameType::Coinflip {
            let join = self
                .adapter
                .build_join_plan(&GameInstructionInput {
                    game: plan.game,
                    player: input.creator,
                    token_mint: input.token_mint,
                    token_amount: Some(input.amount),
                    authority: None,
                })
                .map_err(|error| anyhow!("{error}"))?;
            instructions.extend(join.instructions.into_iter().skip(1));
        }
        let latest = rpc.get_latest_blockhash().await?;
        let message = LegacyMessage::compile(&input.creator, &latest.blockhash, &instructions)
            .map_err(|error| anyhow!("{error}"))?;
        let tx_base64 = Transaction::from_message(&message).to_base64();
        // PrepareGameResponseSchema
        if !is_base64_transaction(&tx_base64) || latest.last_valid_block_height as f64 > MAX_SAFE_INTEGER {
            bail!("Invalid prepared game response");
        }
        Ok(json!({
            "txBase64": tx_base64,
            "gameAddress": plan.game.to_base58(),
            "lastValidBlockHeight": latest.last_valid_block_height,
        }))
    }

    async fn submit(&self, body: Value) -> Result<Value> {
        let tx_base64 = parse_submit_request(&body).ok_or_else(|| validation("Invalid transaction"))?;
        // Existing oracle validation checks instructions, creator signature, commitment and token policy.
        let signed = self.oracle.sign_game_transaction(&tx_base64).await?;
        let transaction = Transaction::from_base64(&signed).map_err(|error| anyhow!("{error}"))?;
        if !transaction.is_fully_signed() {
            bail!("Transaction is not fully signed");
        }
        let signature = self
            .oracle
            .rpc()
            .request(
                "sendTransaction",
                json!([transaction.to_base64(), { "encoding": "base64", "preflightCommitment": "confirmed" }]),
            )
            .await?;
        // SubmitGameResponseSchema
        if !signature.as_str().is_some_and(is_solana_signature) {
            bail!("Invalid transaction signature");
        }
        Ok(json!({ "signature": signature }))
    }

    async fn game(&self, game: &str, fresh: bool) -> Result<Response> {
        let address = Address::parse(game).map_err(|_| validation("Invalid game address"))?;
        let Some(account) = self.oracle.rpc().get_account_info(&address).await? else {
            return Ok(json_response(StatusCode::NOT_FOUND, &error_body("Game not found"), &[]));
        };
        if account.owner != self.oracle.program_id() {
            return Err(validation("Invalid game account"));
        }
        let cache = if fresh { NO_STORE } else { GAME_CACHE };
        Ok(ok(&serialized_game_value(&self.adapter, &address.to_base58(), &account.data)?, cache))
    }

    async fn token_config(self: &Arc<Self>) -> Result<Value> {
        let now = (self.now)();
        let cached = self.token_cache.lock().unwrap().clone();
        if let Some((value, expires)) = cached {
            if expires > now {
                return Ok(value);
            }
            if expires + TOKEN_CACHE_STALE_MS > now {
                // Keep serving the stale value; a failed refresh is retried by the next request.
                drop(self.start_token_refresh());
                return Ok(value);
            }
        }
        self.start_token_refresh().await.map_err(|message| anyhow!(message))
    }

    /// Starts (or joins) the single in-flight token configuration refresh.
    fn start_token_refresh(self: &Arc<Self>) -> TokenRefresh {
        let mut pending = self.token_pending.lock().unwrap();
        if let Some((_, running)) = pending.as_ref() {
            return running.clone();
        }
        let id = self.token_generation.fetch_add(1, Ordering::Relaxed);
        let api = self.clone();
        let handle = tokio::spawn(async move {
            let result = api.load_token_config().await.map_err(|error| format!("{error:#}"));
            if let Ok(value) = &result {
                *api.token_cache.lock().unwrap() = Some((value.clone(), (api.now)() + TOKEN_CACHE_FRESH_MS));
            }
            let mut pending = api.token_pending.lock().unwrap();
            if pending.as_ref().is_some_and(|(owner, _)| *owner == id) {
                *pending = None;
            }
            result
        });
        let refresh: TokenRefresh = async move { handle.await.map_err(|error| error.to_string())? }.boxed().shared();
        *pending = Some((id, refresh.clone()));
        refresh
    }

    async fn load_token_config(&self) -> Result<Value> {
        let rpc = self.oracle.rpc();
        let configs = if self.contract_version.capabilities().game_token_account {
            get_game_token_configs(&rpc).await?
        } else {
            let policies = self.oracle.token_policies().await?;
            validate_token_policies(&policies)?;
            let mints = policies
                .iter()
                .map(|policy| Address::parse(&policy.mint))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| anyhow!("{error}"))?;
            let metadata = get_game_token_metadata(&rpc, &mints).await?;
            format_game_token_policies(&policies, &HashMap::new(), &metadata)?
        };
        let mints: Vec<String> = configs.iter().map(|config| config.mint.clone()).collect();
        let prices = self.prices.get(&mints, self.jupiter_api_key.as_deref()).await;
        let tokens = configs
            .into_iter()
            .map(|mut config| {
                config.price_usd = prices.get(&config.mint).copied();
                serde_json::to_value(config)
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(json!({ "tokens": tokens }))
    }
}

/// Matches `^{prefix}([^/]+)$`.
fn single_segment<'a>(path: &'a str, prefix: &str) -> Option<&'a str> {
    path.strip_prefix(prefix).filter(|rest| !rest.is_empty() && !rest.contains('/'))
}
