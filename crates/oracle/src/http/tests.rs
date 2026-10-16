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
}

impl OracleApi for FakeOracle {
    fn generate_game_secrets(&self, game_type: Option<&str>) -> anyhow::Result<GameSecrets> {
        self.game_types.lock().unwrap().push(game_type.map(str::to_string));
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
        futures::future::ready(Err(anyhow::anyhow!("no prices"))).boxed()
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
async fn admin_routes_are_disabled_by_default() {
    let body = format!(r#"{{"gameAddress":"{GAME}"}}"#);
    let (status, _, _) = call(&app(Arc::default(), false), "POST", "/games/requeue", Some(&body), false).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let oracle = Arc::new(FakeOracle::default());
    let app = app(oracle.clone(), true);
    let (status, json, _) = call(&app, "POST", "/games/requeue", Some(&body), false).await;
    assert_eq!((status, json["status"].clone()), (StatusCode::OK, json!("queued")));
    *oracle.requeue.lock().unwrap() = Some(RequeueFailure::MissingSecret);
    let (status, json, _) = call(&app, "POST", "/games/requeue", Some(&body), false).await;
    assert_eq!((status, json["error"].clone()), (StatusCode::CONFLICT, json!("Game is missing its secret key")));
    let toggle = format!(r#"{{"gameAddress":"{GAME}","autoCompleteDisabled":false}}"#);
    let (status, json, _) = call(&app, "POST", "/games/auto-complete", Some(&toggle), false).await;
    assert_eq!(
        (status, json["error"].clone()),
        (StatusCode::CONFLICT, json!("Auto-complete is already set to the requested value"))
    );
}

#[test]
fn summarizes_unparseable_transactions() {
    assert!(summarize_game_transaction("AAAA")["parseError"].is_string());
}
