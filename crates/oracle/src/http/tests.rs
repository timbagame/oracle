use super::*;
use crate::core::signer::CreationPolicyError;
use crate::db::DatabaseStats;
use crate::token::policy::RejectionCode;
use std::sync::Mutex;

const GAME: &str = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const TOKEN: &str = "secret-token";

#[derive(Default)]
struct FakeOracle {
    game_types: Mutex<Vec<Option<String>>>,
    sign_error: Mutex<Option<GameTransactionError>>,
    completion: Mutex<Option<CompletionResult>>,
    requeue: Mutex<Option<RequeueFailure>>,
    fail_generate: Mutex<bool>,
    policies: Mutex<Option<Vec<TokenPolicy>>>,
    toggle: Mutex<Option<anyhow::Result<Result<bool, ToggleFailure>>>>,
}

impl OracleApi for FakeOracle {
    fn generate_game_secrets(&self, game_type: Option<&str>) -> anyhow::Result<GameSecrets> {
        self.game_types.lock().unwrap().push(game_type.map(str::to_string));
        if *self.fail_generate.lock().unwrap() {
            anyhow::bail!("database is closed");
        }
        Ok(GameSecrets { random_hash: "ab".repeat(32), game_address: GAME.into(), oracle_operator: Some(GAME.into()) })
    }
    fn sign_game_transaction<'a>(&'a self, tx: &'a str) -> BoxFuture<'a, Result<String, GameTransactionError>> {
        let result = match self.sign_error.lock().unwrap().take() {
            Some(err) => Err(err),
            None => Ok(format!("signed:{tx}")),
        };
        futures::future::ready(result).boxed()
    }
    fn token_policies(&self) -> BoxFuture<'_, anyhow::Result<Vec<TokenPolicy>>> {
        let result = self.policies.lock().unwrap().clone().ok_or_else(|| anyhow::anyhow!("no prices"));
        futures::future::ready(result).boxed()
    }
    fn stats(&self) -> ServiceStats {
        ServiceStats {
            db: DatabaseStats { total_secrets: 3, ..Default::default() },
            event_listening: true,
            active_listeners: 6,
        }
    }
    fn requeue_game(&self, _game: &str) -> Result<(), RequeueFailure> {
        match *self.requeue.lock().unwrap() {
            Some(reason) => Err(reason),
            None => Ok(()),
        }
    }
    fn queue_game_completion<'a>(&'a self, _game: &'a str) -> BoxFuture<'a, Option<CompletionResult>> {
        futures::future::ready(self.completion.lock().unwrap().clone()).boxed()
    }
    fn set_auto_complete_disabled(&self, _game: &str, disabled: bool) -> anyhow::Result<Result<bool, ToggleFailure>> {
        if let Some(result) = self.toggle.lock().unwrap().take() {
            return result;
        }
        Ok(if disabled { Ok(true) } else { Err(ToggleFailure::Unchanged) })
    }
}

fn app(oracle: Arc<FakeOracle>, admin: bool) -> Router {
    let mut options = RouterOptions::new(Some(TOKEN.into()));
    options.enable_admin_routes = admin;
    options.web = Some(Router::new().route("/web/config", axum::routing::get(|| async { "web" })));
    router(oracle, options)
}

async fn call(app: &Router, method: &str, path: &str, body: Option<&str>, auth: bool) -> (StatusCode, Value, Response) {
    let mut builder = axum::http::Request::builder().method(method).uri(path);
    if auth {
        builder = builder.header("authorization", format!("Bearer {TOKEN}"));
    }
    if body.is_some() {
        builder = builder.header("content-type", "application/json");
    }
    let request = builder.body(Body::from(body.unwrap_or_default().to_string())).unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let (parts, body) = response.into_parts();
    let bytes = to_bytes(body, usize::MAX).await.unwrap();
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::String(String::from_utf8_lossy(&bytes).into()));
    (status, json, Response::from_parts(parts, Body::empty()))
}

#[tokio::test]
async fn serves_docs_and_health_without_auth() {
    let app = app(Arc::default(), false);
    let (status, body, response) = call(&app, "GET", "/", None, false).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "text/html");
    assert!(body.as_str().unwrap().contains("<code>/sign-game-transaction</code>"));
    let (status, body, _) = call(&app, "GET", "/health", None, false).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "healthy");
    assert_eq!(body["service"]["name"], "oracle-api");
    let (status, body, _) = call(&app, "POST", "/health", None, false).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"], "Endpoint not found");
}

#[tokio::test]
async fn requires_bearer_token_on_protected_routes() {
    let app = app(Arc::default(), false);
    for path in ["/stats", "/web/config", "/indexer/games"] {
        let (status, body, _) = call(&app, "GET", path, None, false).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{path}");
        assert_eq!(body["error"], "Unauthorized");
    }
    let (status, body, _) = call(&app, "GET", "/web/config", None, true).await;
    assert_eq!((status, body), (StatusCode::OK, Value::String("web".into())));
    let (status, body, _) = call(&app, "GET", "/stats", None, true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["stats"],
        json!({"totalSecrets": 3, "usedSecrets": 0, "pendingGames": 0, "completedGames": 0, "cancelledGames": 0, "eventListening": true, "activeListeners": 6})
    );
}

#[tokio::test]
async fn rate_limits_routes() {
    let app = app(Arc::default(), false);
    for _ in 0..10 {
        assert_eq!(call(&app, "GET", "/stats", None, true).await.0, StatusCode::OK);
    }
    let (status, body, response) = call(&app, "GET", "/stats", None, true).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["error"], "Too many requests");
    assert_eq!(response.headers()["retry-after"], "1");
}

#[tokio::test]
async fn generate_hash_validates_game_type() {
    let oracle = Arc::new(FakeOracle::default());
    let app = app(oracle.clone(), false);
    let (status, body, _) = call(&app, "POST", "/generate-hash", Some(r#"{"gameType":"  CoinFlip "}"#), true).await;
    assert_eq!(status, StatusCode::OK);
    let keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys, ["timestamp", "service", "success", "randomHash", "gameAddress", "oracleOperator"]);
    assert_eq!(call(&app, "POST", "/generate-hash", None, true).await.0, StatusCode::OK);
    assert_eq!(oracle.game_types.lock().unwrap().clone(), vec![Some("coinflip".to_string()), None]);
    for bad in [r#"{"gameType":"  "}"#, r#"{"gameType":1}"#, r#"{"other":1}"#] {
        let (status, body, _) = call(&app, "POST", "/generate-hash", Some(bad), true).await;
        assert_eq!((status, body["error"].clone()), (StatusCode::BAD_REQUEST, json!("gameType is invalid")), "{bad}");
    }
    let (status, body, _) = call(&app, "POST", "/generate-hash", Some("{"), true).await;
    assert_eq!((status, body["error"].clone()), (StatusCode::BAD_REQUEST, json!("Invalid JSON payload")));
    let big = format!(r#"{{"gameType":"{}"}}"#, "a".repeat(MAX_REQUEST_BODY_BYTES));
    // Streamed bodies are cut off while reading; declared lengths are refused up front.
    let (status, body, _) = call(&app, "POST", "/generate-hash", Some(&big), true).await;
    assert_eq!((status, body["error"].clone()), (StatusCode::BAD_REQUEST, json!("Request body too large")));
    let request = axum::http::Request::builder()
        .method("POST")
        .uri("/generate-hash")
        .header("content-length", big.len())
        .body(Body::from(big))
        .unwrap();
    assert_eq!(app.clone().oneshot(request).await.unwrap().status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn sign_maps_errors() {
    let oracle = Arc::new(FakeOracle::default());
    let app = app(oracle.clone(), false);
    let (status, body, _) = call(&app, "POST", "/sign-game-transaction", Some(r#"{"txBase64":"AAAA"}"#), true).await;
    assert_eq!((status, body["txBase64"].clone()), (StatusCode::OK, json!("signed:AAAA")));
    let (status, _, _) = call(&app, "POST", "/sign-game-transaction", Some(r#"{"txBase64":"A"}"#), true).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    *oracle.sign_error.lock().unwrap() = Some(GameTransactionError::Validation("nope".into()));
    let (status, body, _) = call(&app, "POST", "/sign-game-transaction", Some(r#"{"txBase64":"AAAA"}"#), true).await;
    assert_eq!((status, body["error"].clone()), (StatusCode::BAD_REQUEST, json!("Invalid game transaction")));

    *oracle.sign_error.lock().unwrap() = Some(GameTransactionError::CreationPolicy(
        CreationPolicyError::new(RejectionCode::TokenDisabled, "Token mint is disabled", GAME).revision(4),
    ));
    let (status, body, _) = call(&app, "POST", "/sign-game-transaction", Some(r#"{"txBase64":"AAAA"}"#), true).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys, ["timestamp", "service", "success", "error", "code", "mint", "revision"]);
    assert_eq!(body["code"], "token_disabled");
}

#[tokio::test]
async fn token_policies_unavailable() {
    let app = app(Arc::default(), false);
    let (status, body, _) = call(&app, "GET", "/token-policies", None, true).await;
    assert_eq!(
        (status, body["error"].clone()),
        (StatusCode::SERVICE_UNAVAILABLE, json!("Token policies are unavailable"))
    );
}

#[tokio::test]
async fn complete_now_statuses() {
    let oracle = Arc::new(FakeOracle::default());
    let app = app(oracle.clone(), false);
    let body = format!(r#"{{"gameAddress":"{GAME}"}}"#);
    let (status, json, _) = call(&app, "POST", "/games/complete-now", Some(&body), true).await;
    assert_eq!((status, json["status"].clone()), (StatusCode::OK, json!("in-flight")));
    *oracle.completion.lock().unwrap() = Some(CompletionResult::not_ready());
    assert_eq!(call(&app, "POST", "/games/complete-now", Some(&body), true).await.1["status"], "not-ready");
    *oracle.completion.lock().unwrap() = Some(CompletionResult::failure("boom"));
    let (status, json, _) = call(&app, "POST", "/games/complete-now", Some(&body), true).await;
    assert_eq!((status, json["error"].clone()), (StatusCode::CONFLICT, json!("Game could not be completed")));
    let (status, _, _) = call(&app, "POST", "/games/complete-now", Some(r#"{"gameAddress":"bad"}"#), true).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn admin_routes_require_the_token() {
    let app = app(Arc::default(), true);
    let body = format!(r#"{{"gameAddress":"{GAME}"}}"#);
    for path in ["/games/requeue", "/games/auto-complete"] {
        let (status, _, _) = call(&app, "POST", path, Some(&body), false).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{path}");
    }
    // Enabling them leaves the public routes public.
    let (status, _, _) = call(&app, "GET", "/health", None, false).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn admin_routes_are_disabled_by_default() {
    let body = format!(r#"{{"gameAddress":"{GAME}"}}"#);
    let (status, _, _) = call(&app(Arc::default(), false), "POST", "/games/requeue", Some(&body), false).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let oracle = Arc::new(FakeOracle::default());
    let app = app(oracle.clone(), true);
    let (status, json, _) = call(&app, "POST", "/games/requeue", Some(&body), true).await;
    assert_eq!((status, json["status"].clone()), (StatusCode::OK, json!("queued")));
    *oracle.requeue.lock().unwrap() = Some(RequeueFailure::MissingSecret);
    let (status, json, _) = call(&app, "POST", "/games/requeue", Some(&body), true).await;
    assert_eq!((status, json["error"].clone()), (StatusCode::CONFLICT, json!("Game is missing its secret key")));
    let toggle = format!(r#"{{"gameAddress":"{GAME}","autoCompleteDisabled":false}}"#);
    let (status, json, _) = call(&app, "POST", "/games/auto-complete", Some(&toggle), true).await;
    assert_eq!(
        (status, json["error"].clone()),
        (StatusCode::CONFLICT, json!("Auto-complete is already set to the requested value"))
    );
}

#[test]
fn summarizes_unparseable_transactions() {
    assert!(summarize_game_transaction("AAAA")["parseError"].is_string());
}

#[tokio::test]
async fn generate_hash_failures_and_lenient_bodies() {
    let oracle = Arc::new(FakeOracle::default());
    let app = app(oracle.clone(), false);
    // Non-JSON content types and non-object JSON bodies count as empty.
    let request = axum::http::Request::builder()
        .method("POST")
        .uri("/generate-hash")
        .header("authorization", format!("Bearer {TOKEN}"))
        .header("content-type", "text/plain")
        .body(Body::from("gameType=coinflip"))
        .unwrap();
    assert_eq!(app.clone().oneshot(request).await.unwrap().status(), StatusCode::OK);
    assert_eq!(call(&app, "POST", "/generate-hash", Some("[1, 2]"), true).await.0, StatusCode::OK);
    assert_eq!(oracle.game_types.lock().unwrap().clone(), vec![None, None]);

    *oracle.fail_generate.lock().unwrap() = true;
    let (status, body, _) = call(&app, "POST", "/generate-hash", None, true).await;
    assert_eq!((status, body["error"].clone()), (StatusCode::INTERNAL_SERVER_ERROR, json!("Failed to generate hash")));
}

#[tokio::test]
async fn lists_token_policies() {
    let oracle = Arc::new(FakeOracle::default());
    let policy = TokenPolicy {
        mint: GAME.into(),
        enabled: true,
        minimum_amount_raw: "100".into(),
        accepted_minimum_amount_raw: "95".into(),
        revision: 2,
        effective_at: "2024-01-01T00:00:00.000Z".into(),
    };
    *oracle.policies.lock().unwrap() = Some(vec![policy]);
    let (status, body, _) = call(&app(oracle, false), "GET", "/token-policies", None, true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["success"], true);
    assert_eq!(body["policies"][0]["mint"], GAME);
    assert_eq!(body["policies"][0]["acceptedMinimumAmountRaw"], "95");
}

#[tokio::test]
async fn sign_reports_policy_minimums() {
    let oracle = Arc::new(FakeOracle::default());
    let app = app(oracle.clone(), false);
    *oracle.sign_error.lock().unwrap() = Some(GameTransactionError::CreationPolicy(CreationPolicyError {
        minimum_amount_raw: Some("100".into()),
        accepted_minimum_amount_raw: Some("95".into()),
        ..CreationPolicyError::new(RejectionCode::AmountBelowMinimum, "Game amount is below the token minimum", GAME)
            .revision(3)
    }));
    let (status, body, _) = call(&app, "POST", "/sign-game-transaction", Some(r#"{"txBase64":"AAAA"}"#), true).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "timestamp",
            "service",
            "success",
            "error",
            "code",
            "mint",
            "minimumAmountRaw",
            "acceptedMinimumAmountRaw",
            "revision"
        ]
    );
    assert_eq!(body["minimumAmountRaw"], "100");
    assert_eq!(body["acceptedMinimumAmountRaw"], "95");
    assert_eq!(body["revision"], 3);
    // Extra keys make the request invalid.
    let (status, _, _) =
        call(&app, "POST", "/sign-game-transaction", Some(r#"{"txBase64":"AAAA","extra":1}"#), true).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn complete_now_reports_completed_games() {
    let oracle = Arc::new(FakeOracle::default());
    let app = app(oracle.clone(), false);
    let body = format!(r#"{{"gameAddress":"{GAME}"}}"#);
    *oracle.completion.lock().unwrap() = Some(CompletionResult {
        success: true,
        tx_hash: Some("sig".into()),
        winner_address: Some("winner".into()),
        total_pot: Some(500),
        ..Default::default()
    });
    let (status, json, _) = call(&app, "POST", "/games/complete-now", Some(&body), true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["status"], "completed");
    assert_eq!(json["txHash"], "sig");
    assert_eq!(json["winnerAddress"], "winner");
    assert_eq!(json["totalPot"], 500);
    assert_eq!(json["gameAddress"], GAME);

    *oracle.completion.lock().unwrap() = Some(CompletionResult { success: true, ..Default::default() });
    let (status, json, _) = call(&app, "POST", "/games/complete-now", Some(&body), true).await;
    assert_eq!((status, json["error"].clone()), (StatusCode::INTERNAL_SERVER_ERROR, json!("Internal server error")));

    let (status, json, _) = call(&app, "POST", "/games/complete-now", Some("{"), true).await;
    assert_eq!((status, json["error"].clone()), (StatusCode::BAD_REQUEST, json!("Invalid JSON payload")));
}

#[tokio::test]
async fn requeue_maps_every_failure() {
    let oracle = Arc::new(FakeOracle::default());
    let app = app(oracle.clone(), true);
    let body = format!(r#"{{"gameAddress":" {GAME} "}}"#);
    let (status, json, _) = call(&app, "POST", "/games/requeue", Some(&body), true).await;
    assert_eq!((status, json["gameAddress"].clone()), (StatusCode::OK, json!(GAME)), "addresses are trimmed");
    for (reason, status, message) in [
        (RequeueFailure::InvalidAddress, StatusCode::BAD_REQUEST, "gameAddress is required"),
        (RequeueFailure::NotFound, StatusCode::NOT_FOUND, "Game is not tracked"),
        (RequeueFailure::Finalized, StatusCode::CONFLICT, "Game is already finalized"),
        (RequeueFailure::Unchanged, StatusCode::CONFLICT, "Game is already queued for completion"),
    ] {
        *oracle.requeue.lock().unwrap() = Some(reason);
        let (actual, json, _) = call(&app, "POST", "/games/requeue", Some(&body), true).await;
        assert_eq!(actual, status, "{reason:?}");
        assert_eq!(json["error"], message, "{reason:?}");
    }
    for bad in [r#"{}"#, r#"{"gameAddress":"  "}"#, r#"{"gameAddress":1}"#] {
        let (status, json, _) = call(&app, "POST", "/games/requeue", Some(bad), true).await;
        assert_eq!((status, json["error"].clone()), (StatusCode::BAD_REQUEST, json!("gameAddress is required")));
    }
    let (status, _, _) = call(&app, "POST", "/games/requeue", Some("{"), true).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn toggle_auto_complete_maps_every_outcome() {
    let oracle = Arc::new(FakeOracle::default());
    let app = app(oracle.clone(), true);
    let toggle = format!(r#"{{"gameAddress":"{GAME}","autoCompleteDisabled":true}}"#);
    let (status, json, _) = call(&app, "POST", "/games/auto-complete", Some(&toggle), true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["autoCompleteDisabled"], true);
    assert_eq!(json["gameAddress"], GAME);

    for (reason, status, message) in [
        (ToggleFailure::InvalidAddress, StatusCode::BAD_REQUEST, "gameAddress is required"),
        (ToggleFailure::NotFound, StatusCode::NOT_FOUND, "Game is not tracked"),
        (ToggleFailure::Finalized, StatusCode::CONFLICT, "Game is already finalized"),
    ] {
        *oracle.toggle.lock().unwrap() = Some(Ok(Err(reason)));
        let (actual, json, _) = call(&app, "POST", "/games/auto-complete", Some(&toggle), true).await;
        assert_eq!((actual, json["error"].clone()), (status, json!(message)), "{reason:?}");
    }
    *oracle.toggle.lock().unwrap() = Some(Err(anyhow::anyhow!("database is closed")));
    let (status, json, _) = call(&app, "POST", "/games/auto-complete", Some(&toggle), true).await;
    assert_eq!((status, json["error"].clone()), (StatusCode::INTERNAL_SERVER_ERROR, json!("Internal server error")));

    let missing_flag = format!(r#"{{"gameAddress":"{GAME}","autoCompleteDisabled":"yes"}}"#);
    let (status, json, _) = call(&app, "POST", "/games/auto-complete", Some(&missing_flag), true).await;
    assert_eq!(
        (status, json["error"].clone()),
        (StatusCode::BAD_REQUEST, json!("autoCompleteDisabled must be a boolean"))
    );
    let (status, json, _) =
        call(&app, "POST", "/games/auto-complete", Some(r#"{"autoCompleteDisabled":true}"#), true).await;
    assert_eq!((status, json["error"].clone()), (StatusCode::BAD_REQUEST, json!("gameAddress is required")));
    let (status, _, _) = call(&app, "POST", "/games/auto-complete", Some("{"), true).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn delegates_to_the_indexer_router() {
    let mut options = RouterOptions::new(Some(TOKEN.into()));
    options.indexer = Some(Router::new().route("/indexer/games", axum::routing::get(|| async { "games" })));
    let app = router(Arc::new(FakeOracle::default()), options);
    let (status, body, _) = call(&app, "GET", "/indexer/games", None, true).await;
    assert_eq!((status, body), (StatusCode::OK, Value::String("games".into())));
    // Without a web router the path falls through to the oracle routes.
    let (status, _, _) = call(&app, "GET", "/web/config", None, true).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // Unsupported methods and an empty configured token are rejected.
    assert_eq!(call(&app, "DELETE", "/health", None, false).await.0, StatusCode::NOT_FOUND);
    let locked = router(Arc::new(FakeOracle::default()), RouterOptions::new(Some(String::new())));
    assert_eq!(call(&locked, "GET", "/stats", None, true).await.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn missing_sub_routers_and_tokens_fall_through() {
    // No indexer router configured: the path is just unknown.
    let app = app(Arc::default(), false);
    let (status, body, _) = call(&app, "GET", "/indexer/games", None, true).await;
    assert_eq!((status, body["error"].clone()), (StatusCode::NOT_FOUND, json!("Endpoint not found")));

    // Without a configured token nothing is protected or rate limited.
    let open = router(Arc::new(FakeOracle::default()), RouterOptions::new(None));
    for _ in 0..12 {
        assert_eq!(call(&open, "GET", "/stats", None, false).await.0, StatusCode::OK);
    }
}

#[tokio::test]
async fn game_type_is_optional_and_malformed_bodies_are_rejected() {
    let oracle = Arc::new(FakeOracle::default());
    let app = app(oracle.clone(), false);
    assert_eq!(call(&app, "POST", "/generate-hash", Some("{}"), true).await.0, StatusCode::OK);
    assert_eq!(oracle.game_types.lock().unwrap().clone(), vec![None]);
    let (status, body, _) = call(&app, "POST", "/sign-game-transaction", Some("{"), true).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].is_string(), "{body}");
}

#[test]
fn routes_keep_their_documentation() {
    let route = route("/x", HttpMethod::Post, Handler::Stats, "Does x", Some("{}"));
    assert_eq!(route.handler, Handler::Stats);
    assert_eq!(
        (route.doc.path, route.doc.method, route.doc.summary, route.doc.request_example),
        ("/x", HttpMethod::Post, "Does x", Some("{}"))
    );
}

#[test]
fn summarizes_parseable_transactions() {
    use crate::solana::Keypair;
    use timba_protocol::{AccountMeta, Address, Instruction};
    let payer = Keypair::generate();
    let instruction = Instruction {
        program_id: Address([7; 32]),
        accounts: vec![AccountMeta::writable_signer(payer.address()), AccountMeta::readonly(Address([8; 32]))],
        data: vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    };
    let (_, wire) = crate::solana::tx::sign_legacy_transaction(&payer, &[], &Address([9; 32]), &[instruction]).unwrap();
    let summary = summarize_game_transaction(&wire);
    assert_eq!(summary["instructionCount"], 1);
    assert_eq!(summary["signatureSlots"], 1);
    assert_eq!(
        summary["instructions"][0],
        json!({
            "index": 0,
            "programId": Address([7; 32]).to_base58(),
            "accountCount": 2,
            "signerCount": 1,
            "writableCount": 1,
            "accountFlags": [{"signer": true, "writable": true}, {"signer": false, "writable": false}],
            "dataLength": 10,
            "discriminator": "0102030405060708",
        })
    );
}

/// The production [`OracleApi`] implementation wired to a real service.
mod service_api {
    use super::*;
    use crate::config::OracleConfig;
    use crate::db::OracleDatabase;
    use crate::metrics::OracleMetrics;
    use crate::solana::pool::testing::FakeTransport;
    use crate::solana::{Keypair, RpcPool};
    use crate::token::price::TokenPriceResolver;
    use std::collections::HashMap;

    struct NoPrices;

    impl TokenPriceResolver for NoPrices {
        fn get_token_usd_prices<'a>(
            &'a self,
            _mints: &'a [String],
            _allow_partial: bool,
        ) -> BoxFuture<'a, anyhow::Result<HashMap<String, f64>>> {
            futures::future::ready(Ok(HashMap::new())).boxed()
        }
    }

    #[tokio::test]
    async fn serves_requests_from_the_oracle_service() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(OracleDatabase::open(dir.path().join("o.sqlite").to_str().unwrap()).unwrap());
        let transport = FakeTransport::new();
        let rpc = Arc::new(RpcPool::with_transport(&["https://a".into()], transport).unwrap());
        let service = OracleService::new(crate::core::service::OracleServiceOptions {
            config: OracleConfig::for_tests(),
            db,
            metrics: Arc::new(OracleMetrics::new(10)),
            rpc,
            operator: Keypair::generate(),
            price_resolver: Arc::new(NoPrices),
        });
        let mut options = RouterOptions::new(Some(TOKEN.into()));
        options.enable_admin_routes = true;
        let app = router(service.clone(), options);

        let (status, body, _) = call(&app, "POST", "/generate-hash", Some(r#"{"gameType":"giveaway"}"#), true).await;
        assert_eq!(status, StatusCode::OK);
        let game = body["gameAddress"].as_str().unwrap().to_string();
        assert_eq!(service.db().get_game_type(&game).as_deref(), Some("giveaway"));
        assert_eq!(body["oracleOperator"], service.operator_address().to_base58());

        let (status, body, _) = call(&app, "GET", "/stats", None, true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["stats"]["totalSecrets"], 1);
        assert_eq!(body["stats"]["eventListening"], false);

        let (status, body, _) = call(&app, "GET", "/token-policies", None, true).await;
        assert_eq!((status, body["policies"].clone()), (StatusCode::OK, json!([])));

        let (status, body, _) =
            call(&app, "POST", "/sign-game-transaction", Some(r#"{"txBase64":"AAAA"}"#), true).await;
        assert_eq!((status, body["error"].clone()), (StatusCode::BAD_REQUEST, json!("Invalid game transaction")));

        let requeue = format!(r#"{{"gameAddress":"{GAME}"}}"#);
        let (status, _, _) = call(&app, "POST", "/games/requeue", Some(&requeue), true).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let toggle = format!(r#"{{"gameAddress":"{game}","autoCompleteDisabled":true}}"#);
        let (status, body, _) = call(&app, "POST", "/games/auto-complete", Some(&toggle), true).await;
        assert_eq!((status, body["autoCompleteDisabled"].clone()), (StatusCode::OK, json!(true)));

        // Disabled games are skipped by the background wake-up.
        let complete = format!(r#"{{"gameAddress":"{game}"}}"#);
        let (status, body, _) = call(&app, "POST", "/games/complete-now", Some(&complete), true).await;
        assert_eq!((status, body["status"].clone()), (StatusCode::OK, json!("in-flight")));
        service.close().await;
    }
}
