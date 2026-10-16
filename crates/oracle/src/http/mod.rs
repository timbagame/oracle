//! The oracle HTTP API: route handlers, bearer authentication and rate
//! limiting, and delegation to the indexer and web routers (port of the
//! router and handlers in `index.ts`).

pub mod docs;
pub mod envelope;

use std::sync::{Arc, OnceLock};

use axum::body::{to_bytes, Body};
use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::Response;
use axum::Router;
use futures::future::{BoxFuture, FutureExt};
use serde_json::{json, Map, Value};
use timba_common::security::{has_valid_bearer_token, RouteRateLimiter, MAX_REQUEST_BODY_BYTES};
use timba_common::{error, warn};
use timba_protocol::transaction::Transaction;
use timba_protocol::validators::{is_base64_transaction, is_solana_address};
use tower::ServiceExt;

use crate::core::service::{GameTransactionError, OracleService, RequeueFailure, ServiceStats};
use crate::core::types::CompletionResult;
use crate::db::ToggleFailure;
use crate::token::policy::TokenPolicy;
use crate::types::GameSecrets;
use docs::{generate_documentation_html, HttpMethod, RouteDocumentation};
use envelope::{contract_payload, contract_response, error_response, html_response, json_response, service_payload};

pub const MAX_GAME_TYPE_LENGTH: usize = 128;

mod messages {
    pub const AUTO_COMPLETE_ALREADY_SET: &str = "Auto-complete is already set to the requested value";
    pub const AUTO_COMPLETE_BOOLEAN_REQUIRED: &str = "autoCompleteDisabled must be a boolean";
    pub const ENDPOINT_NOT_FOUND: &str = "Endpoint not found";
    pub const FAILED_TO_GENERATE_HASH: &str = "Failed to generate hash";
    pub const GAME_ALREADY_FINALIZED: &str = "Game is already finalized";
    pub const GAME_ALREADY_QUEUED: &str = "Game is already queued for completion";
    pub const GAME_ADDRESS_REQUIRED: &str = "gameAddress is required";
    pub const GAME_COMPLETION_CONFLICT: &str = "Game could not be completed";
    pub const GAME_MISSING_SECRET: &str = "Game is missing its secret key";
    pub const GAME_NOT_TRACKED: &str = "Game is not tracked";
    pub const INTERNAL_SERVER_ERROR: &str = "Internal server error";
    pub const INVALID_GAME_TRANSACTION: &str = "Invalid game transaction";
    pub const INVALID_GAME_TYPE: &str = "gameType is invalid";
    pub const INVALID_JSON: &str = "Invalid JSON payload";
    pub const REQUEST_BODY_TOO_LARGE: &str = "Request body too large";
    pub const TOKEN_POLICIES_UNAVAILABLE: &str = "Token policies are unavailable";
    pub const TOO_MANY_REQUESTS: &str = "Too many requests";
    pub const UNAUTHORIZED: &str = "Unauthorized";
}
use messages as msg;

/// The oracle operations the HTTP handlers use (the TS `OracleApi`).
pub trait OracleApi: Send + Sync {
    fn generate_game_secrets(&self, game_type: Option<&str>) -> anyhow::Result<GameSecrets>;
    fn sign_game_transaction<'a>(&'a self, tx_base64: &'a str) -> BoxFuture<'a, Result<String, GameTransactionError>>;
    fn token_policies(&self) -> BoxFuture<'_, anyhow::Result<Vec<TokenPolicy>>>;
    fn stats(&self) -> ServiceStats;
    fn requeue_game(&self, game_address: &str) -> Result<(), RequeueFailure>;
    /// Wakes completion without waiting for it; `None` means in flight.
    fn queue_game_completion<'a>(&'a self, game_address: &'a str) -> BoxFuture<'a, Option<CompletionResult>>;
    fn set_auto_complete_disabled(
        &self,
        game_address: &str,
        disabled: bool,
    ) -> anyhow::Result<Result<bool, ToggleFailure>>;
}

impl OracleApi for OracleService {
    fn generate_game_secrets(&self, game_type: Option<&str>) -> anyhow::Result<GameSecrets> {
        OracleService::generate_game_secrets(self, game_type)
    }

    fn sign_game_transaction<'a>(&'a self, tx_base64: &'a str) -> BoxFuture<'a, Result<String, GameTransactionError>> {
        OracleService::sign_game_transaction(self, tx_base64).boxed()
    }

    fn token_policies(&self) -> BoxFuture<'_, anyhow::Result<Vec<TokenPolicy>>> {
        self.get_token_policies().boxed()
    }

    fn stats(&self) -> ServiceStats {
        self.get_stats()
    }

    fn requeue_game(&self, game_address: &str) -> Result<(), RequeueFailure> {
        OracleService::requeue_game(self, game_address)
    }

    fn queue_game_completion<'a>(&'a self, game_address: &'a str) -> BoxFuture<'a, Option<CompletionResult>> {
        futures::future::ready(self.queue_completion(game_address)).boxed()
    }

    fn set_auto_complete_disabled(
        &self,
        game_address: &str,
        disabled: bool,
    ) -> anyhow::Result<Result<bool, ToggleFailure>> {
        OracleService::set_auto_complete_disabled(self, game_address, disabled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Handler {
    Health,
    GenerateHash,
    SignGameTransaction,
    TokenPolicies,
    Stats,
    CompleteGameNow,
    RequeueGame,
    ToggleAutoComplete,
}

struct Route {
    doc: RouteDocumentation,
    handler: Handler,
}

const fn route(
    path: &'static str,
    method: HttpMethod,
    handler: Handler,
    summary: &'static str,
    request_example: Option<&'static str>,
) -> Route {
    Route { doc: RouteDocumentation { path, method, summary, request_example }, handler }
}

pub const PROTECTED_ROUTES: [&str; 5] =
    ["/generate-hash", "/sign-game-transaction", "/token-policies", "/stats", "/games/complete-now"];

const ROUTES: [Route; 6] = [
    route("/health", HttpMethod::Get, Handler::Health, "Simple health check - returns basic service status", None),
    route(
        "/generate-hash",
        HttpMethod::Post,
        Handler::GenerateHash,
        "Generate new game secrets (random hash and game address)",
        Some(r#"{ "gameType": "coinflip" | "giveaway" }"#),
    ),
    route(
        "/sign-game-transaction",
        HttpMethod::Post,
        Handler::SignGameTransaction,
        "Validate and oracle-sign a game initialization transaction",
        Some(r#"{ "txBase64": "..." }"#),
    ),
    route("/token-policies", HttpMethod::Get, Handler::TokenPolicies, "List the current token creation policies", None),
    route("/stats", HttpMethod::Get, Handler::Stats, "Detailed statistics and metrics about the oracle service", None),
    route(
        "/games/complete-now",
        HttpMethod::Post,
        Handler::CompleteGameNow,
        "Attempt immediate completion for one tracked game",
        Some(r#"{ "gameAddress": "Ht8Kup..." }"#),
    ),
];

const ADMIN_ROUTES: [Route; 2] = [
    route("/games/requeue", HttpMethod::Post, Handler::RequeueGame, "CLI-only requeue operation", None),
    route(
        "/games/auto-complete",
        HttpMethod::Post,
        Handler::ToggleAutoComplete,
        "CLI-only auto-complete operation",
        None,
    ),
];

fn api_documentation() -> &'static str {
    static HTML: OnceLock<String> = OnceLock::new();
    HTML.get_or_init(|| {
        let docs: Vec<RouteDocumentation> = ROUTES.iter().map(|r| r.doc).collect();
        generate_documentation_html(&docs)
    })
}

pub struct RouterOptions {
    /// `None` disables authentication and rate limiting (tests only).
    pub api_token: Option<String>,
    pub rate_limiter: Arc<RouteRateLimiter>,
    pub enable_admin_routes: bool,
    pub web: Option<Router>,
    pub indexer: Option<Router>,
}

impl RouterOptions {
    pub fn new(api_token: Option<String>) -> Self {
        Self {
            api_token,
            rate_limiter: Arc::new(RouteRateLimiter::default()),
            enable_admin_routes: false,
            web: None,
            indexer: None,
        }
    }
}

struct AppState {
    api: Arc<dyn OracleApi>,
    options: RouterOptions,
}

/// Builds the oracle router (`buildFetchRouter` + `buildHandlers`).
pub fn router(api: Arc<dyn OracleApi>, options: RouterOptions) -> Router {
    Router::new().fallback(dispatch).with_state(Arc::new(AppState { api, options }))
}

fn method_of(method: &Method) -> Option<HttpMethod> {
    match *method {
        Method::GET => Some(HttpMethod::Get),
        Method::POST => Some(HttpMethod::Post),
        _ => None,
    }
}

async fn dispatch(State(state): State<Arc<AppState>>, request: Request) -> Response {
    let path = request.uri().path().to_string();
    let method = method_of(request.method());

    if request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok())
        .is_some_and(|len| len > MAX_REQUEST_BODY_BYTES)
    {
        return Response::builder().status(StatusCode::PAYLOAD_TOO_LARGE).body(Body::empty()).unwrap();
    }

    if path == "/" && method == Some(HttpMethod::Get) {
        return html_response(api_documentation());
    }

    let is_indexer = path == "/indexer" || path.starts_with("/indexer/");
    let is_web = path.starts_with("/web/");
    // Admin routes exist only for tests and the CLI, but still require the token.
    let is_admin = state.options.enable_admin_routes && ADMIN_ROUTES.iter().any(|r| r.doc.path == path);
    if PROTECTED_ROUTES.contains(&path.as_str()) || is_indexer || is_web || is_admin {
        if let Some(token) = &state.options.api_token {
            let authorization = request.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok());
            if token.is_empty() || !has_valid_bearer_token(authorization, token) {
                return error_response(StatusCode::UNAUTHORIZED, msg::UNAUTHORIZED);
            }
            let limit = state.options.rate_limiter.check(&path);
            if !limit.allowed {
                let mut response = error_response(StatusCode::TOO_MANY_REQUESTS, msg::TOO_MANY_REQUESTS);
                let retry_after = limit.retry_after_seconds.unwrap_or(1).to_string();
                response.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from_str(&retry_after).unwrap());
                return response;
            }
        }
    }

    if is_web {
        if let Some(web) = &state.options.web {
            return delegate(web.clone(), request).await;
        }
    }
    if is_indexer {
        if let Some(indexer) = &state.options.indexer {
            return delegate(indexer.clone(), request).await;
        }
    }

    let admin: &[Route] = if state.options.enable_admin_routes { &ADMIN_ROUTES } else { &[] };
    let Some(route) = ROUTES.iter().chain(admin).find(|r| r.doc.path == path && Some(r.doc.method) == method) else {
        return error_response(StatusCode::NOT_FOUND, msg::ENDPOINT_NOT_FOUND);
    };
    let api = state.api.as_ref();
    match route.handler {
        Handler::Health => contract_response(json!({ "success": true, "status": "healthy" })),
        Handler::GenerateHash => handle_generate_hash(api, request).await,
        Handler::SignGameTransaction => handle_sign_game_transaction(api, request).await,
        Handler::TokenPolicies => handle_token_policies(api).await,
        Handler::Stats => contract_response(json!({ "success": true, "stats": api.stats() })),
        Handler::CompleteGameNow => handle_complete_game_now(api, request).await,
        Handler::RequeueGame => handle_requeue_game(api, request).await,
        Handler::ToggleAutoComplete => handle_toggle_auto_complete(api, request).await,
    }
}

async fn delegate(router: Router, request: Request) -> Response {
    match router.oneshot(request).await {
        Ok(response) => response,
        Err(never) => match never {},
    }
}

/// `readJsonBody`: `Ok(None)` for a missing, non-JSON or non-object body.
async fn read_json_body(request: Request) -> Result<Option<Map<String, Value>>, &'static str> {
    let content_type =
        request.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or_default().to_lowercase();
    if !content_type.is_empty() && !content_type.contains("application/json") {
        return Ok(None);
    }
    let bytes = to_bytes(request.into_body(), MAX_REQUEST_BODY_BYTES).await.map_err(|_| msg::REQUEST_BODY_TOO_LARGE)?;
    if bytes.is_empty() {
        return Ok(None);
    }
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(map)) => Ok(Some(map)),
        Ok(_) => Ok(None),
        Err(err) => {
            warn!("⚠️  Failed to parse /generate-hash payload: {err}");
            Err(msg::INVALID_JSON)
        }
    }
}

fn bad_request(message: &str) -> Response {
    error_response(StatusCode::BAD_REQUEST, message)
}

fn internal_error() -> Response {
    error_response(StatusCode::INTERNAL_SERVER_ERROR, msg::INTERNAL_SERVER_ERROR)
}

/// `GenerateHashRequestSchema`: a strict object with an optional `gameType`
/// that is trimmed, lowercased and 1–128 characters long.
fn parse_game_type(body: Option<&Map<String, Value>>) -> Result<Option<String>, ()> {
    let Some(body) = body else { return Ok(None) };
    if body.keys().any(|key| key != "gameType") {
        return Err(());
    }
    match body.get("gameType") {
        None => Ok(None),
        Some(Value::String(value)) => {
            let normalized = value.trim().to_lowercase();
            let length = normalized.encode_utf16().count();
            if (1..=MAX_GAME_TYPE_LENGTH).contains(&length) {
                Ok(Some(normalized))
            } else {
                Err(())
            }
        }
        Some(_) => Err(()),
    }
}

/// Returns the single string field of a strict one-key object.
fn strict_string_field<'a>(body: Option<&'a Map<String, Value>>, key: &str) -> Option<&'a str> {
    let body = body?;
    if body.len() != 1 {
        return None;
    }
    body.get(key)?.as_str()
}

async fn handle_generate_hash(api: &dyn OracleApi, request: Request) -> Response {
    let body = match read_json_body(request).await {
        Ok(body) => body,
        Err(message) => return bad_request(message),
    };
    let Ok(game_type) = parse_game_type(body.as_ref()) else { return bad_request(msg::INVALID_GAME_TYPE) };
    match api.generate_game_secrets(game_type.as_deref()) {
        Ok(secrets) => contract_response(json!({
            "success": true,
            "randomHash": secrets.random_hash,
            "gameAddress": secrets.game_address,
            "oracleOperator": secrets.oracle_operator,
        })),
        Err(err) => {
            error!("Error generating hash: {err:#}");
            error_response(StatusCode::INTERNAL_SERVER_ERROR, msg::FAILED_TO_GENERATE_HASH)
        }
    }
}

async fn handle_sign_game_transaction(api: &dyn OracleApi, request: Request) -> Response {
    let body = match read_json_body(request).await {
        Ok(body) => body,
        Err(message) => return bad_request(message),
    };
    let Some(tx_base64) = strict_string_field(body.as_ref(), "txBase64").filter(|tx| is_base64_transaction(tx)) else {
        return bad_request(msg::INVALID_GAME_TRANSACTION);
    };
    match api.sign_game_transaction(tx_base64).await {
        Ok(signed) => contract_response(json!({ "success": true, "txBase64": signed })),
        Err(err) => {
            error!(
                "Game transaction signing rejected: {}",
                json!({ "error": err.to_string(), "transaction": summarize_game_transaction(tx_base64) })
            );
            match err {
                GameTransactionError::CreationPolicy(rejection) => {
                    let mut fields = json!({
                        "success": false,
                        "error": rejection.message,
                        "code": rejection.code.as_str(),
                    });
                    let map = fields.as_object_mut().unwrap();
                    if let Some(mint) = rejection.mint {
                        map.insert("mint".into(), mint.into());
                    }
                    if let Some(minimum) = rejection.minimum_amount_raw {
                        map.insert("minimumAmountRaw".into(), minimum.into());
                    }
                    if let Some(accepted) = rejection.accepted_minimum_amount_raw {
                        map.insert("acceptedMinimumAmountRaw".into(), accepted.into());
                    }
                    if let Some(revision) = rejection.revision {
                        map.insert("revision".into(), revision.into());
                    }
                    json_response(StatusCode::UNPROCESSABLE_ENTITY, &contract_payload(fields))
                }
                GameTransactionError::Validation(_) => bad_request(msg::INVALID_GAME_TRANSACTION),
            }
        }
    }
}

async fn handle_token_policies(api: &dyn OracleApi) -> Response {
    match api.token_policies().await {
        Ok(policies) => contract_response(json!({ "success": true, "policies": policies })),
        Err(err) => {
            error!("Error loading token policies: {err:#}");
            error_response(StatusCode::SERVICE_UNAVAILABLE, msg::TOKEN_POLICIES_UNAVAILABLE)
        }
    }
}

async fn handle_complete_game_now(api: &dyn OracleApi, request: Request) -> Response {
    let body = match read_json_body(request).await {
        Ok(body) => body,
        Err(message) => return bad_request(message),
    };
    let Some(address) = strict_string_field(body.as_ref(), "gameAddress").filter(|a| is_solana_address(a)) else {
        return bad_request(msg::GAME_ADDRESS_REQUIRED);
    };
    let address = address.to_string();
    let result = api.queue_game_completion(&address).await;
    let Some(result) = result else {
        return contract_response(json!({ "success": true, "gameAddress": address, "status": "in-flight" }));
    };
    if result.success {
        let (Some(tx_hash), Some(winner), Some(total_pot)) = (result.tx_hash, result.winner_address, result.total_pot)
        else {
            error!("Error completing game now: completed result is missing fields");
            return internal_error();
        };
        return contract_response(json!({
            "success": true,
            "gameAddress": address,
            "status": "completed",
            "txHash": tx_hash,
            "winnerAddress": winner,
            "totalPot": total_pot,
        }));
    }
    if result.not_ready {
        return contract_response(json!({ "success": true, "gameAddress": address, "status": "not-ready" }));
    }
    warn!("Immediate game completion was rejected: {}", json!({ "gameAddress": address, "error": result.error }));
    error_response(StatusCode::CONFLICT, msg::GAME_COMPLETION_CONFLICT)
}

fn body_game_address(body: Option<&Map<String, Value>>) -> String {
    body.and_then(|b| b.get("gameAddress")).and_then(Value::as_str).map(|s| s.trim().to_string()).unwrap_or_default()
}

async fn handle_requeue_game(api: &dyn OracleApi, request: Request) -> Response {
    let body = match read_json_body(request).await {
        Ok(body) => body,
        Err(message) => return bad_request(message),
    };
    let address = body_game_address(body.as_ref());
    if address.is_empty() {
        return bad_request(msg::GAME_ADDRESS_REQUIRED);
    }
    match api.requeue_game(&address) {
        Ok(()) => json_response(
            StatusCode::OK,
            &service_payload(json!({ "success": true, "gameAddress": address, "status": "queued" })),
        ),
        Err(reason) => {
            let (status, message) = match reason {
                RequeueFailure::InvalidAddress => (StatusCode::BAD_REQUEST, msg::GAME_ADDRESS_REQUIRED),
                RequeueFailure::NotFound => (StatusCode::NOT_FOUND, msg::GAME_NOT_TRACKED),
                RequeueFailure::Finalized => (StatusCode::CONFLICT, msg::GAME_ALREADY_FINALIZED),
                RequeueFailure::MissingSecret => (StatusCode::CONFLICT, msg::GAME_MISSING_SECRET),
                RequeueFailure::Unchanged => (StatusCode::CONFLICT, msg::GAME_ALREADY_QUEUED),
            };
            error_response(status, message)
        }
    }
}

async fn handle_toggle_auto_complete(api: &dyn OracleApi, request: Request) -> Response {
    let body = match read_json_body(request).await {
        Ok(body) => body,
        Err(message) => return bad_request(message),
    };
    let address = body_game_address(body.as_ref());
    if address.is_empty() {
        return bad_request(msg::GAME_ADDRESS_REQUIRED);
    }
    let Some(disabled) = body.as_ref().and_then(|b| b.get("autoCompleteDisabled")).and_then(Value::as_bool) else {
        return bad_request(msg::AUTO_COMPLETE_BOOLEAN_REQUIRED);
    };
    match api.set_auto_complete_disabled(&address, disabled) {
        Ok(Ok(value)) => json_response(
            StatusCode::OK,
            &service_payload(json!({ "success": true, "gameAddress": address, "autoCompleteDisabled": value })),
        ),
        Ok(Err(reason)) => {
            let (status, message) = match reason {
                ToggleFailure::InvalidAddress => (StatusCode::BAD_REQUEST, msg::GAME_ADDRESS_REQUIRED),
                ToggleFailure::NotFound => (StatusCode::NOT_FOUND, msg::GAME_NOT_TRACKED),
                ToggleFailure::Finalized => (StatusCode::CONFLICT, msg::GAME_ALREADY_FINALIZED),
                ToggleFailure::Unchanged => (StatusCode::CONFLICT, msg::AUTO_COMPLETE_ALREADY_SET),
            };
            error_response(status, message)
        }
        Err(err) => {
            error!("Error toggling auto-complete: {err:#}");
            internal_error()
        }
    }
}

/// Diagnostic summary of a rejected transaction (`summarizeGameTransaction`).
pub fn summarize_game_transaction(tx_base64: &str) -> Value {
    let decoded = Transaction::from_base64(tx_base64).map_err(|e| e.to_string()).and_then(|tx| {
        let message =
            timba_protocol::transaction::LegacyMessage::deserialize(&tx.message_bytes).map_err(|e| e.to_string())?;
        let instructions = message.decompile().map_err(|e| e.to_string())?;
        Ok((tx.signatures.len(), instructions))
    });
    match decoded {
        Ok((signature_slots, instructions)) => json!({
            "instructionCount": instructions.len(),
            "signatureSlots": signature_slots,
            "instructions": instructions.iter().enumerate().map(|(index, ix)| json!({
                "index": index,
                "programId": ix.program_id.to_base58(),
                "accountCount": ix.accounts.len(),
                "signerCount": ix.accounts.iter().filter(|a| a.signer).count(),
                "writableCount": ix.accounts.iter().filter(|a| a.writable).count(),
                "accountFlags": ix.accounts.iter().map(|a| json!({"signer": a.signer, "writable": a.writable})).collect::<Vec<_>>(),
                "dataLength": ix.data.len(),
                "discriminator": hex::encode(&ix.data[..ix.data.len().min(8)]),
            })).collect::<Vec<_>>(),
        }),
        Err(message) => json!({ "parseError": message }),
    }
}

#[cfg(test)]
mod tests;
