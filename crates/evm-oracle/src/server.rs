//! Bearer-protected HTTP API (port of `evm/server.ts`).

use std::sync::{Arc, Mutex};

use axum::body::{Body, HttpBody};
use axum::extract::{Request, State};
use axum::http::{header, Method, StatusCode};
use axum::response::Response;
use axum::Router;
use futures::StreamExt;
use serde_json::{json, Value};
use timba_common::security::{has_valid_bearer_token, MAX_REQUEST_BODY_BYTES};

use crate::protocol::abi::configCall;
use crate::protocol::schema::{parse_address, parse_bytes32};
use crate::service::{game_json, EvmService};

/// Requests allowed per one-second window across all routes.
const REQUESTS_PER_SECOND: u32 = 30;
/// Games returned per discovery page.
const GAMES_PAGE_SIZE: usize = 20;

pub const CYCLE_FAILED_MESSAGE: &str = "EVM oracle cycle failed; durable work retained for retry";
const REJECTED_MESSAGE: &str = "Authorization rejected. Check wallet, nonce, invitation and game terms.";

struct RouterState {
    service: Arc<EvmService>,
    api_token: String,
    /// Current one-second window and the requests counted in it.
    window: Mutex<(i64, u32)>,
}

pub fn create_evm_router(service: Arc<EvmService>, api_token: String) -> Router {
    let state = Arc::new(RouterState { service, api_token, window: Mutex::new((0, 0)) });
    Router::new().fallback(handle).with_state(state)
}

fn reply(body: Value, status: StatusCode) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(body.to_string()))
        .expect("static response parts are valid")
}

fn error(message: &str, status: StatusCode) -> Response {
    reply(json!({ "error": message }), status)
}

async fn handle(State(state): State<Arc<RouterState>>, request: Request) -> Response {
    route(&state, request)
        .await
        .unwrap_or_else(|_| error("EVM service temporarily unavailable", StatusCode::SERVICE_UNAVAILABLE))
}

/// `/^(0|[1-9][0-9]{0,6})$/`
fn valid_offset(text: &str) -> bool {
    text == "0"
        || (!text.is_empty()
            && text.len() <= 7
            && !text.starts_with('0')
            && text.bytes().all(|byte| byte.is_ascii_digit()))
}

fn query_param(request: &Request, name: &str) -> Option<String> {
    let query = request.uri().query()?;
    url::form_urlencoded::parse(query.as_bytes()).find(|(key, _)| key == name).map(|(_, value)| value.into_owned())
}

async fn route(state: &RouterState, request: Request) -> anyhow::Result<Response> {
    let authorization = request.headers().get(header::AUTHORIZATION).and_then(|value| value.to_str().ok());
    if !has_valid_bearer_token(authorization, &state.api_token) {
        return Ok(error("Unauthorized", StatusCode::UNAUTHORIZED));
    }
    let service = &state.service;
    {
        let now = service.now_ms().div_euclid(1000);
        let mut window = state.window.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if window.0 != now {
            *window = (now, 0);
        }
        window.1 += 1;
        if window.1 > REQUESTS_PER_SECOND {
            return Ok(error("Too many requests", StatusCode::TOO_MANY_REQUESTS));
        }
    }
    let path = request.uri().path().to_string();
    let get = request.method() == Method::GET;
    if get && path == "/evm/config" {
        let config = &service.config;
        let limits = service.public_client.read_contract(config.address, &configCall {}).await?;
        return Ok(reply(
            json!({
                "chainId": config.chain_id,
                "address": config.address.to_checksum(None),
                "version": config.version,
                "tokens": config.tokens,
                "confirmations": config.confirmations,
                "buffer": limits.buffer,
            }),
            StatusCode::OK,
        ));
    }
    if get && path == "/evm/health" {
        let last_cycle_at = service.last_cycle_at.load(std::sync::atomic::Ordering::SeqCst);
        let failed = service.last_cycle_failed.load(std::sync::atomic::Ordering::SeqCst);
        let freshness = 30_000.max(service.config.poll_ms as i64 * 3);
        let healthy = !failed && service.now_ms() - last_cycle_at < freshness;
        let pending = service.store().pending()?;
        return Ok(reply(
            json!({
                "status": if healthy { "healthy" } else { "degraded" },
                "lastCycleAt": last_cycle_at,
                "error": if failed { Some(CYCLE_FAILED_MESSAGE) } else { None },
                "pendingTransaction": pending.map(|pending| pending.hash),
            }),
            if healthy { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE },
        ));
    }
    if get && path == "/evm/events" {
        let events = service.store().events(None)?;
        return Ok(reply(json!({ "events": events }), StatusCode::OK));
    }
    if get && path == "/evm/games" {
        let offset_text = query_param(&request, "offset").unwrap_or_else(|| "0".into());
        let player = query_param(&request, "player");
        let invalid_player =
            player.as_deref().is_some_and(|player| !player.is_empty() && parse_address(player).is_none());
        if !valid_offset(&offset_text) || invalid_player {
            return Ok(error("Invalid query", StatusCode::BAD_REQUEST));
        }
        let offset: i64 = offset_text.parse()?;
        let ids = service.store().listed_game_ids(offset, player.as_deref())?;
        let games = futures::future::try_join_all(ids.iter().take(GAMES_PAGE_SIZE).map(|id| async move {
            let game_id = parse_bytes32(id).ok_or_else(|| anyhow::anyhow!("Invalid indexed game id"))?;
            let game = service.game(game_id).await?;
            let events = service.store().events(Some(id))?;
            anyhow::Ok(json!({ "id": id, "game": game_json(&game), "events": events }))
        }))
        .await?;
        let next_offset = (ids.len() > GAMES_PAGE_SIZE).then_some(offset + GAMES_PAGE_SIZE as i64);
        return Ok(reply(json!({ "games": games, "nextOffset": next_offset }), StatusCode::OK));
    }
    if get {
        if let Some(game_id) = path.strip_prefix("/evm/games/").and_then(parse_bytes32) {
            let game = service.game(game_id).await?;
            let events = service.store().events(path.strip_prefix("/evm/games/"))?;
            return Ok(reply(json!({ "game": game_json(&game), "events": events }), StatusCode::OK));
        }
    }
    let authorize = path == "/evm/authorize";
    if request.method() != Method::POST || !(authorize || path == "/evm/private-join") {
        return Ok(error("Not found", StatusCode::NOT_FOUND));
    }
    let body = request.into_body();
    if body.size_hint().exact() == Some(0) {
        return Ok(error("Body required", StatusCode::BAD_REQUEST));
    }
    let mut stream = body.into_data_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else {
            return Ok(error(REJECTED_MESSAGE, StatusCode::BAD_REQUEST));
        };
        if bytes.len() + chunk.len() > MAX_REQUEST_BODY_BYTES {
            return Ok(error("Body too large", StatusCode::PAYLOAD_TOO_LARGE));
        }
        bytes.extend_from_slice(&chunk);
    }
    let result = match serde_json::from_slice::<Value>(&bytes) {
        Ok(input) if authorize => service.authorize(&input).await.map(|auth| auth.to_json()),
        Ok(input) => service.private_join(&input).await.map(|join| join.to_json()),
        Err(parse) => Err(parse.into()),
    };
    // Never serialize RPC errors, signed transaction payloads, credentials, or secrets.
    Ok(match result {
        Ok(body) => reply(body, StatusCode::OK),
        Err(_) => error(REJECTED_MESSAGE, StatusCode::BAD_REQUEST),
    })
}

#[cfg(test)]
mod tests {
    use super::valid_offset;

    #[test]
    fn offsets_are_canonical_and_bounded() {
        for valid in ["0", "20", "9999999"] {
            assert!(valid_offset(valid), "{valid}");
        }
        for invalid in ["", "-1", "01", "10000000", "1e3", " 1"] {
            assert!(!valid_offset(invalid), "{invalid}");
        }
    }
}
