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
use timba_evm_oracle::rpc::{is_contract_revert, FallbackTransport, PublicClient, RpcError, Transport};
use timba_evm_oracle::server::CYCLE_FAILED_MESSAGE;
use timba_protocol::evm::abi::ownerCall;

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

/// Starts the oracle, retrying on a fresh port if another test grabbed the free one
/// between `free_port` and the oracle's bind.
async fn start(
    rpc_urls: Vec<String>,
) -> (Deployment, Shutdown, tokio::task::JoinHandle<anyhow::Result<()>>, reqwest::Response) {
    let client = timba_common::http_client::client_builder().build().unwrap();
    for _ in 0..5 {
        let deployment = deployment(rpc_urls.clone(), &operator_key());
        let shutdown = Shutdown::new();
        let running = tokio::spawn(app::run(Some(deployment.config_file.clone()), shutdown.clone()));
        let health = format!("http://127.0.0.1:{}/evm/health", deployment.port);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while tokio::time::Instant::now() < deadline && !running.is_finished() {
            if let Ok(response) = client.get(&health).send().await {
                return (deployment, shutdown, running, response);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let error = running.await.unwrap().expect_err("the oracle stopped without an error");
        assert!(error.to_string().contains("in use"), "oracle exited early: {error}");
    }
    panic!("no free port after 5 attempts");
}

#[tokio::test]
async fn serves_the_api_and_ticks_until_shutdown() {
    let chain = FakeChain::new();
    let url = rpc_endpoint(chain.clone()).await;
    // The first endpoint refuses connections; the fallback moves on to the second.
    let (deployment, shutdown, running, unauthorized) = start(vec!["http://127.0.0.1:1".into(), url]).await;

    let client = timba_common::http_client::client_builder().build().unwrap();
    let base = format!("http://127.0.0.1:{}", deployment.port);
    assert_eq!(unauthorized.status(), 401);
    // Oversized bodies are refused before the bearer check, as Bun's maxRequestBodySize does.
    let oversized = client.post(format!("{base}/evm/authorize")).body(vec![b'x'; 16 * 1024 + 1]).send().await.unwrap();
    assert_eq!(oversized.status(), 413);
    let healthy = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let response = client.get(format!("{base}/evm/health")).bearer_auth("evm-token").send().await.unwrap();
            if response.status() == 200 {
                break response.json::<Value>().await.unwrap();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the oracle becomes healthy");
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

/// Runs the real `timba-evm-oracle` binary with `config_file`.
fn binary(config_file: Option<&str>) -> std::process::Command {
    let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_timba-evm-oracle"));
    match config_file {
        Some(file) => command.env("EVM_CONFIG_FILE", file),
        None => command.env_remove("EVM_CONFIG_FILE"),
    };
    command.env("LOG_SILENT", "1").stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped());
    command
}

#[tokio::test]
async fn the_binary_reports_failed_cycles_and_stops_cleanly_on_sigterm() {
    let chain = FakeChain::new();
    let url = rpc_endpoint(chain.clone()).await;
    let client = timba_common::http_client::client_builder().build().unwrap();
    for _ in 0..5 {
        let deployment = deployment(vec![url.clone()], &operator_key());
        let mut child = binary(Some(&deployment.config_file)).spawn().unwrap();
        let health = format!("http://127.0.0.1:{}/evm/health", deployment.port);
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let mut answered = false;
        while !answered && std::time::Instant::now() < deadline && child.try_wait().unwrap().is_none() {
            answered = client.get(&health).send().await.is_ok();
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        if !answered {
            // Another test took the free port first; try a fresh one.
            let output = tokio::task::spawn_blocking(move || child.wait_with_output().unwrap()).await.unwrap();
            assert!(String::from_utf8_lossy(&output.stderr).contains("in use"), "{output:?}");
            continue;
        }
        // Once running, the RPC goes away: the next cycle fails and is reported on stderr.
        chain.on("eth_chainId", |_| Err(RpcError::Http("unavailable".into())));
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let response = client.get(&health).bearer_auth("evm-token").send().await.unwrap();
                let body = response.json::<Value>().await.unwrap();
                if body["error"] == CYCLE_FAILED_MESSAGE {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the failed cycle shows in the health check");
        let pid = child.id().to_string();
        assert!(std::process::Command::new("kill").args(["-TERM", &pid]).status().unwrap().success());
        let output = tokio::task::spawn_blocking(move || child.wait_with_output().unwrap()).await.unwrap();
        assert_eq!(output.status.code(), Some(0), "{output:?}");
        assert!(String::from_utf8_lossy(&output.stderr).contains(CYCLE_FAILED_MESSAGE), "{output:?}");
        return;
    }
    panic!("no free port after 5 attempts");
}

#[tokio::test]
async fn the_binary_reports_configuration_errors() {
    let output = tokio::task::spawn_blocking(|| binary(None).output().unwrap()).await.unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(String::from_utf8_lossy(&output.stderr).trim(), "error: EVM_CONFIG_FILE is required");
}
