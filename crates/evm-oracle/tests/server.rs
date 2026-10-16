//! Port of `tests/evm-server.test.ts` and the router cases of `tests/evm.test.ts`.

mod common;

use alloy_primitives::B256;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::response::Response;
use axum::Router;
use common::*;
use serde_json::{json, Value};
use timba_evm_oracle::rpc::RpcError;
use timba_evm_oracle::server::create_evm_router;
use timba_evm_oracle::store::PendingTransaction;
use tower::ServiceExt;

const TOKEN_SECRET: &str = "router-token";

fn game_id() -> B256 {
    B256::repeat_byte(0x5a)
}

fn router(fake: &Fake) -> Router {
    create_evm_router(fake.service.clone(), TOKEN_SECRET.into())
}

async fn send(router: &Router, request: Request<Body>) -> Response {
    router.clone().oneshot(request).await.unwrap()
}

fn get(path: &str) -> Request<Body> {
    Request::get(path).header("authorization", format!("Bearer {TOKEN_SECRET}")).body(Body::empty()).unwrap()
}

fn post(path: &str, body: impl Into<Body>) -> Request<Body> {
    Request::post(path).header("authorization", format!("Bearer {TOKEN_SECRET}")).body(body.into()).unwrap()
}

async fn text(response: Response) -> String {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    String::from_utf8(bytes.to_vec()).unwrap()
}

async fn body(response: Response) -> Value {
    serde_json::from_str(&text(response).await).unwrap()
}

fn insert_created(fake: &Fake, block: i64, id: &str) {
    fake.service
        .store()
        .db
        .execute(
            "INSERT INTO events VALUES (?,?,?,?)",
            rusqlite::params![
                block,
                format!("0x{block:064x}"),
                0,
                json!({ "event": { "kind": "created", "reference": { "gameId": id }, "isPrivate": false } })
                    .to_string()
            ],
        )
        .unwrap();
}

#[tokio::test]
async fn all_routes_require_bearer_auth_and_body_limits_cannot_be_bypassed() {
    let fake = setup();
    let router = create_evm_router(fake.service.clone(), "test-token".into());
    let unauthorized = send(&router, Request::get("/evm/config").body(Body::empty()).unwrap()).await;
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(body(unauthorized).await, json!({ "error": "Unauthorized" }));
    let wrong = Request::get("/evm/health").header("authorization", "Bearer wrong-token").body(Body::empty()).unwrap();
    assert_eq!(send(&router, wrong).await.status(), StatusCode::UNAUTHORIZED);

    let large = Request::post("/evm/authorize")
        .header("authorization", "Bearer test-token")
        .body(Body::from("x".repeat(20_000)))
        .unwrap();
    let response = send(&router, large).await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body(response).await, json!({ "error": "Body too large" }));

    let chunks =
        futures::stream::iter((0..20).map(|_| Ok::<_, std::io::Error>(axum::body::Bytes::from(vec![b'x'; 1_000]))));
    let streamed = Request::post("/evm/private-join")
        .header("authorization", "Bearer test-token")
        .body(Body::from_stream(chunks))
        .unwrap();
    assert_eq!(send(&router, streamed).await.status(), StatusCode::PAYLOAD_TOO_LARGE);

    let invalid = Request::post("/evm/authorize")
        .header("authorization", "Bearer test-token")
        .body(Body::from("not json"))
        .unwrap();
    assert_eq!(send(&router, invalid).await.status(), StatusCode::BAD_REQUEST);

    let empty =
        Request::post("/evm/authorize").header("authorization", "Bearer test-token").body(Body::empty()).unwrap();
    let response = send(&router, empty).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body(response).await, json!({ "error": "Body required" }));
}

#[tokio::test]
async fn serves_public_deployment_config_with_the_live_settlement_buffer() {
    let fake = setup();
    let response = send(&router(&fake), get("/evm/config")).await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(response.headers()["content-type"], "application/json");
    assert_eq!(
        text(response).await,
        json!({
            "chainId": 31337,
            "address": "0x1111111111111111111111111111111111111111",
            "version": "0.1.0",
            "tokens": [{
                "address": TOKEN.to_checksum(None),
                "symbol": "TEST",
                "decimals": 18,
                "minimumAmount": "100"
            }],
            "confirmations": 2,
            "buffer": ORACLE_LIMITS[1],
        })
        .to_string()
    );
}

#[tokio::test]
async fn reports_health_as_degraded_until_a_cycle_has_run_recently() {
    let fake = setup();
    let router = router(&fake);
    assert_eq!(send(&router, get("/evm/health")).await.status(), StatusCode::SERVICE_UNAVAILABLE);

    fake.service.last_cycle_at.store(timba_common::time::now_ms(), std::sync::atomic::Ordering::SeqCst);
    let response = send(&router, get("/evm/health")).await;

    assert_eq!(response.status(), StatusCode::OK);
    let health = body(response).await;
    assert_eq!(health["status"], "healthy");
    assert_eq!(health["error"], Value::Null);
    assert_eq!(health["pendingTransaction"], Value::Null);
}

#[tokio::test]
async fn reports_a_failed_cycle_as_degraded_with_retained_work() {
    let fake = setup();
    fake.service.last_cycle_at.store(timba_common::time::now_ms(), std::sync::atomic::Ordering::SeqCst);
    fake.service.last_cycle_failed.store(true, std::sync::atomic::Ordering::SeqCst);

    let response = send(&router(&fake), get("/evm/health")).await;

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let health = body(response).await;
    assert_eq!(health["status"], "degraded");
    assert_eq!(health["error"], "EVM oracle cycle failed; durable work retained for retry");
}

#[tokio::test]
async fn reports_the_journaled_settlement_transaction_in_health() {
    let fake = setup();
    fake.service.last_cycle_at.store(timba_common::time::now_ms(), std::sync::atomic::Ordering::SeqCst);
    fake.service
        .store()
        .submit(&PendingTransaction { game: game_id().to_string(), raw: "0xab".into(), hash: game_id().to_string() })
        .unwrap();

    let health = body(send(&router(&fake), get("/evm/health")).await).await;
    assert_eq!(health["status"], "healthy");
    assert_eq!(health["pendingTransaction"], game_id().to_string());
}

#[tokio::test]
async fn lists_indexed_events() {
    let fake = setup();
    insert_created(&fake, 1, &game_id().to_string());

    let events = body(send(&router(&fake), get("/evm/events")).await).await;

    assert_eq!(
        events,
        json!({ "events": [
            { "event": { "kind": "created", "reference": { "gameId": game_id().to_string() }, "isPrivate": false } }
        ] })
    );
}

#[tokio::test]
async fn pages_public_games_with_their_on_chain_state() {
    let fake = setup();
    let ids: Vec<B256> = (1..=21u8).map(B256::with_last_byte).collect();
    for (index, id) in ids.iter().enumerate() {
        insert_created(&fake, index as i64 + 1, &id.to_string());
        fake.chain
            .state()
            .games
            .insert(*id, timba_evm_oracle::protocol::abi::Game { minPlayers: index as u32 + 1, ..fake_game() });
    }
    let router = router(&fake);

    let first = body(send(&router, get("/evm/games")).await).await;
    let second = body(send(&router, get("/evm/games?offset=20")).await).await;

    let games = first["games"].as_array().unwrap();
    assert_eq!(games.len(), 20);
    assert_eq!(games[0]["id"], ids[20].to_string());
    assert_eq!(games[0]["game"]["minPlayers"], 21);
    assert_eq!(games[0]["events"].as_array().unwrap().len(), 1);
    assert_eq!(first["nextOffset"], 20);
    let second_ids: Vec<&Value> = second["games"].as_array().unwrap().iter().map(|game| &game["id"]).collect();
    assert_eq!(second_ids, [&json!(ids[0].to_string())]);
    assert_eq!(second["nextOffset"], Value::Null);
}

#[tokio::test]
async fn filters_games_by_player_including_private_games() {
    let fake = setup();
    let id = game_id().to_string();
    let creator = creator().to_checksum(None);
    fake.service
        .store()
        .db
        .execute(
            "INSERT INTO events VALUES (1, '0x01', 0, ?)",
            [json!({ "event": { "kind": "created", "reference": { "gameId": id }, "creator": creator, "isPrivate": true } })
                .to_string()],
        )
        .unwrap();
    fake.chain.state().games.insert(game_id(), fake_game());
    let router = router(&fake);

    let public = body(send(&router, get("/evm/games")).await).await;
    assert!(public["games"].as_array().unwrap().is_empty());
    let path = format!("/evm/games?player={}", creator.to_lowercase());
    let mine = body(send(&router, get(&path)).await).await;
    assert_eq!(mine["games"][0]["id"], id);
}

#[tokio::test]
async fn rejects_malformed_game_list_queries() {
    let fake = setup();
    let router = router(&fake);
    for path in ["/evm/games?offset=-1", "/evm/games?offset=01", "/evm/games?player=alice"] {
        let response = send(&router, get(path)).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{path}");
        assert_eq!(body(response).await, json!({ "error": "Invalid query" }));
    }
}

#[tokio::test]
async fn serves_a_single_game_with_its_events() {
    let fake = setup();
    insert_created(&fake, 1, &game_id().to_string());
    fake.chain.state().games.insert(game_id(), timba_evm_oracle::protocol::abi::Game { maxPlayers: 4, ..fake_game() });

    let path = format!("/evm/games/{}", game_id().to_string().to_uppercase().replacen("0X", "0x", 1));
    let game = body(send(&router(&fake), get(&path)).await).await;

    assert_eq!(game["game"]["maxPlayers"], 4);
    assert_eq!(game["events"].as_array().unwrap().len(), 1);
    assert_eq!(
        game["game"].to_string(),
        json!({
            "creator": creator().to_checksum(None),
            "token": TOKEN.to_checksum(None),
            "gameType": 0,
            "status": 1,
            "isPrivate": false,
            "minPlayers": 2,
            "maxPlayers": 4,
            "expiresAt": "10000",
            "ticketAmount": "100",
            "totalAmount": "200",
            "commitment": B256::ZERO.to_string(),
            "lastEntryBlock": "5",
            "participants": [creator().to_checksum(None), player().to_checksum(None)],
        })
        .to_string()
    );
}

#[tokio::test]
async fn returns_404_for_unknown_routes_and_methods() {
    let fake = setup();
    let router = router(&fake);
    for request in [get("/evm/unknown"), get("/evm/authorize"), post("/evm/health", "{}")] {
        let response = send(&router, request).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(body(response).await, json!({ "error": "Not found" }));
    }
}

#[tokio::test]
async fn forwards_authorization_and_invitation_bodies_to_the_service() {
    let fake = setup();
    let router = router(&fake);
    let input = creation_intent(&fake, json!({}));

    let authorized = send(&router, post("/evm/authorize", input.to_string())).await;

    assert_eq!(authorized.status(), StatusCode::OK);
    let authorization = body(authorized).await;
    let keys: Vec<&str> = authorization.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, ["gameId", "request", "signature"]);
    assert_eq!(authorization["request"]["amount"], "100");

    let private = B256::repeat_byte(0x44);
    fake.chain.state().games.insert(private, timba_evm_oracle::protocol::abi::Game { isPrivate: true, ..fake_game() });
    let deadline = fake.chain.state().now + 60;
    let digest = timba_evm_oracle::protocol::client::private_join_digest(
        &fake.service.deployment,
        private,
        player(),
        alloy_primitives::U256::from(deadline),
    )
    .unwrap();
    let invitation = json!({
        "gameId": private.to_string(),
        "player": player().to_checksum(None),
        "deadline": deadline.to_string(),
        "proof": account(CREATOR_KEY).sign_hash(digest).unwrap().to_string(),
    });
    let joined = body(send(&router, post("/evm/private-join", invitation.to_string())).await).await;
    assert_eq!(joined["deadline"], deadline.to_string());
    assert_eq!(joined["signature"].as_str().unwrap().len(), 132);
}

#[tokio::test]
async fn hides_service_errors_behind_a_generic_rejection() {
    let fake = setup();
    fake.chain.on("eth_getBlockByNumber", |_| Err(RpcError::Http("secret detail".into())));
    let input = creation_intent(&fake, json!({}));

    let response = send(&router(&fake), post("/evm/authorize", input.to_string())).await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let text = text(response).await;
    assert!(!text.contains("secret detail"));
    assert_eq!(
        text,
        json!({ "error": "Authorization rejected. Check wallet, nonce, invitation and game terms." }).to_string()
    );
}

#[tokio::test]
async fn returns_503_when_a_read_route_fails() {
    let fake = setup();
    let response = send(&router(&fake), get(&format!("/evm/games/{}", game_id()))).await;

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body(response).await, json!({ "error": "EVM service temporarily unavailable" }));
}

#[tokio::test]
async fn rate_limits_bursts_above_thirty_requests_per_second() {
    let fake = setup();
    fake.set_now_ms(1_700_000_000_000);
    let router = router(&fake);

    let mut statuses = Vec::new();
    for _ in 0..31 {
        statuses.push(send(&router, get("/evm/events")).await.status());
    }

    assert!(statuses[..30].iter().all(|status| *status == StatusCode::OK));
    assert_eq!(statuses[30], StatusCode::TOO_MANY_REQUESTS);
    fake.set_now_ms(1_700_000_001_000);
    assert_eq!(send(&router, get("/evm/events")).await.status(), StatusCode::OK);
}

#[tokio::test]
async fn failed_settlement_rebroadcast_degrades_health_without_discarding_pending_bytes() {
    let fake = setup();
    let pending = PendingTransaction {
        game: B256::repeat_byte(0x11).to_string(),
        raw: "0xab".into(),
        hash: B256::repeat_byte(0x11).to_string(),
    };
    fake.service.store().submit(&pending).unwrap();
    fake.chain.on("eth_sendRawTransaction", |_| Err(RpcError::Http("secret RPC URL".into())));
    let router = router(&fake);

    for _ in 0..2 {
        assert!(fake.service.tick().await.is_err());
        assert_eq!(fake.service.store().pending().unwrap(), Some(pending.clone()));
        let response = send(&router, get("/evm/health")).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let text = text(response).await;
        assert!(text.contains("durable work retained"));
        assert!(!text.contains("secret RPC URL"));
    }

    let hash = pending.hash.clone();
    fake.chain.on("eth_sendRawTransaction", move |_| Ok(json!(hash)));
    fake.service.tick().await.unwrap();
    assert_eq!(fake.service.store().pending().unwrap(), Some(pending.clone()));
    assert_eq!(send(&router, get("/evm/health")).await.status(), StatusCode::OK);
    let sends = fake.chain.calls("eth_sendRawTransaction");
    assert_eq!(sends.last().unwrap(), &json!([pending.raw]));
}
