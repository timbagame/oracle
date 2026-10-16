//! Port of `tests/evm-main.test.ts`: the process wiring over real HTTP, with the in-memory
//! chain served as a JSON-RPC endpoint.

mod common;

use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use common::*;
use serde_json::{json, Value};
use timba_common::Shutdown;
use timba_evm_oracle::app;
use timba_evm_oracle::protocol::abi::ownerCall;
use timba_evm_oracle::rpc::{is_contract_revert, FallbackTransport, PublicClient, RpcError, Transport};

/// Serves `chain` as a JSON-RPC endpoint and returns its URL.
async fn rpc_endpoint(chain: Arc<FakeChain>) -> String {
    let app = Router::new().route(
        "/",
        post(move |Json(body): Json<Value>| {
            let transport = FakeTransport(chain.clone());
            async move {
                let id = body["id"].clone();
                let method = body["method"].as_str().unwrap_or_default().to_string();
                match transport.request(&method, body["params"].clone()).await {
                    Ok(result) => (
                        StatusCode::OK,
                        Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })),
                    ),
                    Err(RpcError::Node {
                        code,
                        message,
                        data,
                    }) => (
                        StatusCode::OK,
                        Json(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message, "data": data } })),
                    ),
                    Err(_) => (StatusCode::BAD_GATEWAY, Json(json!({}))),
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

struct Deployment {
    _directory: tempfile::TempDir,
    config_file: String,
    database: String,
    port: u16,
}

fn write_secret(directory: &tempfile::TempDir, name: &str, value: &str) -> String {
    use std::os::unix::fs::PermissionsExt;
    let path = directory.path().join(name);
    std::fs::write(&path, format!("{value}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    path.to_str().unwrap().to_string()
}

fn deployment(rpc_urls: Vec<String>, operator_key: &str) -> Deployment {
    let directory = tempfile::tempdir().unwrap();
    let port = free_port();
    let database = directory.path().join("evm.sqlite").to_str().unwrap().to_string();
    let config = json!({
        "chainId": 31337,
        "address": PROXY.to_checksum(None),
        "version": "0.1.0",
        "rpcUrls": rpc_urls,
        "startBlock": "0",
        "pollMs": 250,
        "database": database,
        "operatorKeyFile": write_secret(&directory, "operator.key", operator_key),
        "apiTokenFile": write_secret(&directory, "api.token", "evm-token"),
        "port": port,
        "tokens": [{ "address": TOKEN.to_checksum(None), "symbol": "TEST", "decimals": 18, "minimumAmount": "100" }],
    });
    let config_file = directory.path().join("evm.json");
    std::fs::write(&config_file, config.to_string()).unwrap();
    Deployment { config_file: config_file.to_str().unwrap().to_string(), database, port, _directory: directory }
}

fn operator_key() -> String {
    OPERATOR_KEY.to_string()
}

#[tokio::test]
async fn serves_the_api_and_ticks_until_shutdown() {
    let chain = FakeChain::new();
    let url = rpc_endpoint(chain.clone()).await;
    // The first endpoint refuses connections; the fallback moves on to the second.
    let deployment = deployment(vec!["http://127.0.0.1:1".into(), url], &operator_key());
    let shutdown = Shutdown::new();
    let running = tokio::spawn(app::run(Some(deployment.config_file.clone()), shutdown.clone()));

    let client = reqwest::Client::new();
    let health = format!("http://127.0.0.1:{}/evm/health", deployment.port);
    let unauthorized = loop {
        if let Ok(response) = client.get(&health).send().await {
            break response;
        }
        assert!(!running.is_finished(), "oracle exited early");
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(unauthorized.status(), 401);
    let healthy = loop {
        let response = client.get(&health).bearer_auth("evm-token").send().await.unwrap();
        if response.status() == 200 {
            break response.json::<Value>().await.unwrap();
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(healthy["status"], "healthy");
    assert!(chain.calls("eth_chainId").len() >= 2, "validated at start and every cycle");

    shutdown.trigger();
    tokio::time::timeout(Duration::from_secs(5), running).await.expect("oracle stops after shutdown").unwrap().unwrap();

    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(&deployment.database).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
    let identity = format!("31337:{}:0.1.0", PROXY.to_string().to_lowercase());
    timba_evm_oracle::store::EvmStore::open(&deployment.database, &identity).unwrap();
}

#[tokio::test]
async fn refuses_to_start_without_a_valid_configuration() {
    let error = app::run(None, Shutdown::new()).await.unwrap_err();
    assert_eq!(error.to_string(), "EVM_CONFIG_FILE is required");

    let bad_key = deployment(vec!["http://127.0.0.1:1".into()], "0x1234");
    let error = app::run(Some(bad_key.config_file.clone()), Shutdown::new()).await.unwrap_err();
    assert_eq!(error.to_string(), "Invalid EVM operator key file");
}

#[tokio::test]
async fn refuses_to_start_when_the_operator_does_not_own_the_proxy() {
    let chain = FakeChain::new();
    chain.state().owner = creator();
    let url = rpc_endpoint(chain).await;
    let deployment = deployment(vec![url], &operator_key());
    let error = app::run(Some(deployment.config_file.clone()), Shutdown::new()).await.unwrap_err();
    assert_eq!(error.to_string(), "EVM operator does not own configured proxy");
}

#[tokio::test]
async fn fallback_moves_on_after_http_failures_but_not_after_reverts() {
    let failing = FakeChain::new();
    failing.on("eth_chainId", |_| Err(RpcError::Http("unavailable".into())));
    failing.on("eth_call", |_| {
        Err(RpcError::Node { code: 3, message: "execution reverted".into(), data: Some(json!("0x")) })
    });
    let healthy = FakeChain::new();
    let urls = vec![rpc_endpoint(failing.clone()).await, rpc_endpoint(healthy.clone()).await];
    let client = PublicClient::new(Arc::new(FallbackTransport::http(&urls)));

    assert_eq!(client.get_chain_id().await.unwrap(), 31337);
    assert_eq!(healthy.calls("eth_chainId").len(), 1);

    let error = client.read_contract(PROXY, &ownerCall {}).await.unwrap_err();
    assert!(is_contract_revert(&error), "{error}");
    assert!(healthy.calls("eth_call").is_empty());
}
