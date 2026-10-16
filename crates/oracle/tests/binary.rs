//! Runs the `timba-oracle` binary the way the container does: real process,
//! real signals, a fake Solana JSON-RPC endpoint and websocket.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::routing::post;
use axum::{Json, Router};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

const TOKEN: &str = "test-api-token";

/// In-memory Solana node: an empty chain over JSON-RPC plus a `logsSubscribe` websocket.
struct FakeSolana {
    http: String,
    ws: String,
    calls: Arc<Mutex<Vec<String>>>,
}

fn rpc_result(method: &str, params: &Value) -> Result<Value, Value> {
    let context = json!({ "slot": 100 });
    Ok(match method {
        "getSignaturesForAddress" | "getProgramAccounts" => json!([]),
        "getSlot" | "getBlockHeight" => json!(100),
        "getHealth" => json!("ok"),
        "getAccountInfo" => json!({ "context": context, "value": null }),
        "getMultipleAccounts" => {
            let count = params[0].as_array().map_or(0, Vec::len);
            json!({ "context": context, "value": vec![Value::Null; count] })
        }
        "getBalance" => json!({ "context": context, "value": 0 }),
        "getLatestBlockhash" => json!({
            "context": context,
            "value": { "blockhash": "11111111111111111111111111111111", "lastValidBlockHeight": 200 },
        }),
        _ => return Err(json!({ "code": -32601, "message": "Method not found" })),
    })
}

impl FakeSolana {
    async fn start() -> Self {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let log = calls.clone();
        let app = Router::new().route(
            "/",
            post(move |Json(body): Json<Value>| {
                let log = log.clone();
                async move {
                    let method = body["method"].as_str().unwrap_or_default().to_string();
                    log.lock().unwrap().push(method.clone());
                    Json(match rpc_result(&method, &body["params"]) {
                        Ok(result) => json!({ "jsonrpc": "2.0", "id": body["id"], "result": result }),
                        Err(error) => json!({ "jsonrpc": "2.0", "id": body["id"], "error": error }),
                    })
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let http = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws = format!("ws://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else { return };
                    while let Some(Ok(message)) = socket.next().await {
                        if let Message::Text(text) = message {
                            let request: Value = serde_json::from_str(&text).unwrap_or_default();
                            let ack = json!({ "jsonrpc": "2.0", "id": request["id"], "result": 1 });
                            let _ = socket.send(Message::Text(ack.to_string().into())).await;
                        }
                    }
                });
            }
        });
        Self { http, ws, calls }
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

struct Oracle {
    dir: tempfile::TempDir,
    port: u16,
    env: Vec<(String, String)>,
}

impl Oracle {
    fn new(solana: &FakeSolana) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let port = free_port();
        let env = [
            ("SOLANA_NETWORK", solana.http.clone()),
            ("SOLANA_WS_ENDPOINT", solana.ws.clone()),
            ("ORACLE_PORT", port.to_string()),
            ("ORACLE_API_TOKEN", TOKEN.into()),
            ("DATABASE_FILE", dir.path().join("oracle.sqlite").to_str().unwrap().into()),
            ("INDEXER_DATABASE_FILE", dir.path().join("indexer.sqlite").to_str().unwrap().into()),
            ("USE_FAKE_KEYPAIR", "true".into()),
            ("BOT_INTERNAL_URL", "http://127.0.0.1:9".into()),
            ("JUPITER_PRICE_URL", "http://127.0.0.1:9".into()),
        ];
        Self { dir, port, env: env.into_iter().map(|(k, v)| (k.to_string(), v)).collect() }
    }

    fn set(mut self, key: &str, value: &str) -> Self {
        self.env.retain(|(k, _)| k != key);
        self.env.push((key.into(), value.into()));
        self
    }

    fn unset(mut self, key: &str) -> Self {
        self.env.retain(|(k, _)| k != key);
        self
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_timba-oracle"));
        command.args(args).current_dir(self.dir.path()).envs(self.env.iter().map(|(k, v)| (k, v)));
        for key in ["SOLANA_NETWORK", "ORACLE_API_TOKEN_FILE", "LOG_SILENT", "LOG_LEVEL", "NODE_ENV", "BUN_ENV"] {
            if !self.env.iter().any(|(k, _)| k == key) {
                command.env_remove(key);
            }
        }
        command
    }

    /// Runs a one-shot command to completion off the async runtime.
    async fn run(&self, args: &[&str]) -> (i32, String, String) {
        let mut command = self.command(args);
        let output = tokio::task::spawn_blocking(move || command.output().unwrap()).await.unwrap();
        let text = |bytes: Vec<u8>| String::from_utf8(bytes).unwrap();
        (output.status.code().unwrap(), text(output.stdout), text(output.stderr))
    }

    fn spawn(&self) -> Server {
        let mut child = self.command(&["serve"]).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let output = Arc::new(Mutex::new(String::new()));
        let readers =
            [Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>, Box::new(child.stderr.take().unwrap())]
                .map(|stream| {
                    let output = output.clone();
                    std::thread::spawn(move || {
                        for line in BufReader::new(stream).lines() {
                            output.lock().unwrap().push_str(&format!("{}\n", line.unwrap()));
                        }
                    })
                });
        Server { child, output, port: self.port, readers: Some(readers) }
    }
}

struct Server {
    child: Child,
    output: Arc<Mutex<String>>,
    port: u16,
    readers: Option<[std::thread::JoinHandle<()>; 2]>,
}

impl Server {
    fn output(&self) -> String {
        self.output.lock().unwrap().clone()
    }

    async fn wait_for_output(&self, needle: &str) {
        let deadline = Instant::now() + Duration::from_secs(30);
        while !self.output().contains(needle) {
            assert!(Instant::now() < deadline, "timed out waiting for {needle:?}:\n{}", self.output());
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    fn signal(&self, name: &str) {
        let status = Command::new("kill").args([&format!("-{name}"), &self.child.id().to_string()]).status().unwrap();
        assert!(status.success());
    }

    /// Waits for the process to exit and returns its status and full output.
    async fn wait(mut self) -> (ExitStatus, String) {
        let deadline = Instant::now() + Duration::from_secs(30);
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < deadline, "process did not exit:\n{}", self.output());
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        for reader in self.readers.take().unwrap() {
            reader.join().unwrap();
        }
        (status, self.output())
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

#[tokio::test]
async fn serves_the_api_until_sigterm() {
    let solana = FakeSolana::start().await;
    let oracle = Oracle::new(&solana);
    // A verification job that is already due runs as soon as the workers start.
    let indexer = oracle.dir.path().join("indexer.sqlite");
    timba_oracle::indexer::IndexerDatabase::open(&indexer)
        .unwrap()
        .queue_verification(&bs58::encode([7; 64]).into_string())
        .unwrap();
    rusqlite::Connection::open(&indexer).unwrap().execute("UPDATE verification_jobs SET next_attempt=0", []).unwrap();
    let server = oracle.spawn();
    server.wait_for_output("Oracle services initialized").await;

    let http = reqwest::Client::new();
    let health = http.get(server.url("/health")).send().await.unwrap();
    assert_eq!(health.status(), 200);
    let anonymous = http.get(server.url("/stats")).send().await.unwrap();
    assert_eq!(anonymous.status(), 401);
    let stats = http.get(server.url("/stats")).bearer_auth(TOKEN).send().await.unwrap();
    assert_eq!(stats.status(), 200);
    let (code, _, _) = oracle.run(&["healthcheck"]).await;
    assert_eq!(code, 0, "the container probe sees the running API");
    let calls = solana.calls.lock().unwrap().clone();
    assert!(calls.iter().any(|m| m == "getSignaturesForAddress"), "the indexer polled: {calls:?}");
    assert!(calls.iter().any(|m| m == "getTransaction"), "the verification job ran: {calls:?}");

    server.signal("TERM");
    let (status, output) = server.wait().await;
    assert_eq!(status.code(), Some(0), "{output}");
    assert!(output.contains("Shutting down (SIGTERM)"), "{output}");
    assert!(output.contains("Shutdown complete"), "{output}");
}

#[tokio::test]
async fn a_second_signal_exits_without_waiting() {
    let solana = FakeSolana::start().await;
    let oracle = Oracle::new(&solana);
    let server = oracle.spawn();
    server.wait_for_output("Oracle services initialized").await;

    // A request whose body never arrives keeps the HTTP server draining.
    let mut stalled = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
    stalled.write_all(b"POST /generate-hash HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\n\r\n").unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;

    server.signal("INT");
    server.wait_for_output("Shutting down (SIGINT)").await;
    server.signal("INT");
    let (status, output) = server.wait().await;
    assert_eq!(status.code(), Some(130), "{output}");
    assert!(output.contains("SIGINT received again"), "{output}");
    assert!(!output.contains("Shutdown complete"), "{output}");
}

#[tokio::test]
async fn losing_the_websocket_at_startup_stops_the_oracle() {
    let solana = FakeSolana::start().await;
    let refused = format!("ws://127.0.0.1:{}", free_port());
    let oracle = Oracle::new(&solana).set("SOLANA_WS_ENDPOINT", &refused);
    let server = oracle.spawn();
    let (status, output) = server.wait().await;
    assert_eq!(status.code(), Some(1), "{output}");
    assert!(output.contains("Oracle initialization failed"), "{output}");
}

#[tokio::test]
async fn refuses_to_start_without_its_requirements() {
    let solana = FakeSolana::start().await;
    let quiet = || Oracle::new(&solana).set("LOG_SILENT", "1");
    let oracle = quiet();

    let (code, _, stderr) = quiet().unset("ORACLE_API_TOKEN").run(&[]).await;
    assert_eq!((code, stderr.trim()), (1, "ORACLE_API_TOKEN is required to start the oracle API"));

    let (code, _, stderr) = quiet().unset("SOLANA_NETWORK").run(&["serve"]).await;
    assert_eq!(code, 1);
    assert!(stderr.contains("SOLANA_NETWORK"), "{stderr}");

    let missing = oracle.dir.path().join("missing/indexer.sqlite");
    let (code, _, stderr) = quiet().set("INDEXER_DATABASE_FILE", missing.to_str().unwrap()).run(&["serve"]).await;
    assert_eq!(code, 1);
    assert!(stderr.starts_with("Failed to open indexer database"), "{stderr}");
    assert_eq!(stderr.matches("Failed to open indexer database").count(), 1, "{stderr}");

    let (code, _, stderr) =
        quiet().set("USE_FAKE_KEYPAIR", "false").set("OPERATOR_KEYPAIR_PATH", "none.json").run(&[]).await;
    assert_eq!(code, 1);
    assert!(stderr.contains("none.json"), "{stderr}");

    let taken = std::net::TcpListener::bind("0.0.0.0:0").unwrap();
    let port = taken.local_addr().unwrap().port().to_string();
    let (code, _, stderr) = quiet().set("ORACLE_PORT", &port).run(&["serve"]).await;
    assert_eq!(code, 1);
    assert!(stderr.starts_with(&format!("Failed to bind port {port}")), "{stderr}");
}

#[tokio::test]
async fn runs_the_operator_commands() {
    let solana = FakeSolana::start().await;
    // Logs go to stdout too; silence them so the command output parses.
    let oracle = Oracle::new(&solana).set("LOG_SILENT", "1");
    let unknown = "11111111111111111111111111111111";

    let (code, _, stderr) = oracle.run(&["admin"]).await;
    assert_eq!(code, 2);
    assert!(stderr.starts_with("Usage:"), "{stderr}");
    let (code, stdout, _) = oracle.run(&["admin", "token-policy", "list"]).await;
    assert_eq!((code, stdout.trim()), (0, "[]"));
    let (code, _, stderr) = oracle.run(&["admin", "requeue", unknown]).await;
    assert_eq!((code, stderr.trim()), (1, "Unable to requeue game: not-found"));

    let (code, stdout, _) = oracle.run(&["attempt-completion", unknown]).await;
    assert_eq!(code, 0);
    assert_eq!(serde_json::from_str::<Value>(&stdout).unwrap(), json!({ "result": null }), "untracked game");

    let (code, stdout, _) = oracle.run(&["inspect-game", unknown]).await;
    assert_eq!(code, 0);
    assert_eq!(serde_json::from_str::<Value>(&stdout).unwrap(), json!({ "address": unknown, "exists": false }));
    let (code, _, stderr) = oracle.run(&["inspect-game", "not-an-address"]).await;
    assert_eq!(code, 1);
    assert!(stderr.starts_with("Invalid game address not-an-address"), "{stderr}");

    let (code, _, stderr) = oracle.run(&["inspect-oracle"]).await;
    assert_eq!(code, 1);
    assert!(stderr.contains("Account not found at address"), "{stderr}");

    // Without an address it prompts; stdin is closed here.
    let (code, stdout, stderr) = oracle.run(&["audit-random"]).await;
    assert_eq!((code, stdout.as_str(), stderr.trim()), (1, "Game address (base58): ", "No game address provided"));
    let (code, _, stderr) = oracle.run(&["audit-random", "--slots", "0"]).await;
    assert_eq!((code, stderr.trim()), (1, "--slots must be a number between 1 and 500"));

    let (code, stdout, _) = oracle.run(&["manual-shutdown"]).await;
    assert_eq!(code, 0);
    assert!(stdout.contains("Manual shutdown scan complete"), "{stdout}");

    let (code, _, stderr) = oracle.run(&["import-indexer", "missing.sql"]).await;
    assert_eq!(code, 1);
    assert!(stderr.contains("missing.sql"), "{stderr}");

    let (code, _, _) = oracle.run(&["healthcheck"]).await;
    assert_eq!(code, 1, "nothing listens on the configured port");
}
