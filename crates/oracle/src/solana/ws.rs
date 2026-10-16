//! `logsSubscribe` over the Solana PubSub websocket.

use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use timba_protocol::Address;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

const PING_INTERVAL: Duration = Duration::from_secs(5);
const SUBSCRIBE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq)]
pub struct LogsNotification {
    pub slot: u64,
    pub signature: String,
    pub err: Option<Value>,
    pub logs: Vec<String>,
}

/// Converts an RPC URL to its PubSub URL (`https` → `wss`, otherwise `ws`).
pub fn websocket_url(endpoint: &str) -> Result<String, String> {
    let mut url = url::Url::parse(endpoint).map_err(|e| format!("Invalid websocket endpoint {endpoint}: {e}"))?;
    let scheme = if matches!(url.scheme(), "https" | "wss") { "wss" } else { "ws" };
    url.set_scheme(scheme).map_err(|_| format!("Invalid websocket endpoint {endpoint}"))?;
    Ok(url.to_string())
}

pub struct LogsSubscription {
    receiver: mpsc::Receiver<Result<LogsNotification, String>>,
    task: JoinHandle<()>,
}

impl Drop for LogsSubscription {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl LogsSubscription {
    /// Next notification; `None` or `Some(Err)` means the stream ended.
    pub async fn next(&mut self) -> Option<Result<LogsNotification, String>> {
        self.receiver.recv().await
    }
}

fn parse_notification(value: &Value) -> Option<LogsNotification> {
    let result = &value["params"]["result"];
    Some(LogsNotification {
        slot: result["context"]["slot"].as_u64()?,
        signature: result["value"]["signature"].as_str()?.to_string(),
        err: result["value"].get("err").filter(|e| !e.is_null()).cloned(),
        logs: result["value"]["logs"]
            .as_array()
            .map(|l| l.iter().filter_map(|s| s.as_str().map(String::from)).collect())
            .unwrap_or_default(),
    })
}

/// Opens the websocket and waits until the node acknowledges the
/// subscription, like kit's `subscribe()`.
pub async fn subscribe_logs(ws_url: &str, mentions: &Address) -> Result<LogsSubscription, String> {
    let (mut socket, _) =
        tokio_tungstenite::connect_async(ws_url).await.map_err(|e| format!("WebSocket connection failed: {e}"))?;
    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "logsSubscribe",
        "params": [{ "mentions": [mentions.to_base58()] }, { "commitment": "confirmed" }]
    });
    socket.send(Message::Text(request.to_string().into())).await.map_err(|e| e.to_string())?;

    let ack = tokio::time::timeout(SUBSCRIBE_TIMEOUT, async {
        while let Some(message) = socket.next().await {
            let message = message.map_err(|e| e.to_string())?;
            let Message::Text(text) = message else { continue };
            let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
            if value.get("id") == Some(&json!(1)) {
                if let Some(error) = value.get("error") {
                    return Err(format!("logsSubscribe failed: {error}"));
                }
                return Ok(());
            }
        }
        Err("WebSocket closed before the subscription was acknowledged".to_string())
    })
    .await
    .map_err(|_| "Timed out waiting for logsSubscribe acknowledgement".to_string())?;
    ack?;

    let (sender, receiver) = mpsc::channel(256);
    let task = tokio::spawn(async move {
        let mut ping = tokio::time::interval(PING_INTERVAL);
        ping.tick().await;
        loop {
            tokio::select! {
                _ = ping.tick() => {
                    if let Err(e) = socket.send(Message::Ping(Vec::new().into())).await {
                        let _ = sender.send(Err(e.to_string())).await;
                        return;
                    }
                }
                message = socket.next() => {
                    match message {
                        None => {
                            let _ = sender.send(Err("WebSocket closed".into())).await;
                            return;
                        }
                        Some(Err(e)) => {
                            let _ = sender.send(Err(e.to_string())).await;
                            return;
                        }
                        Some(Ok(Message::Text(text))) => {
                            let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
                            if value["method"] != "logsNotification" {
                                continue;
                            }
                            if let Some(notification) = parse_notification(&value) {
                                if sender.send(Ok(notification)).await.is_err() {
                                    return;
                                }
                            }
                        }
                        Some(Ok(Message::Close(_))) => {
                            let _ = sender.send(Err("WebSocket closed".into())).await;
                            return;
                        }
                        Some(Ok(_)) => {}
                    }
                }
            }
        }
    });
    Ok(LogsSubscription { receiver, task })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_urls() {
        assert_eq!(websocket_url("https://api.mainnet-beta.solana.com").unwrap(), "wss://api.mainnet-beta.solana.com/");
        assert_eq!(websocket_url("http://localhost:8899").unwrap(), "ws://localhost:8899/");
        assert_eq!(websocket_url("wss://x/?k=1").unwrap(), "wss://x/?k=1");
    }

    #[test]
    fn parses_notifications() {
        let value = json!({"method": "logsNotification", "params": {"result": {
            "context": {"slot": 5},
            "value": {"signature": "abc", "err": null, "logs": ["a", "b"]}
        }}});
        let parsed = parse_notification(&value).unwrap();
        assert_eq!(parsed, LogsNotification { slot: 5, signature: "abc".into(), err: None, logs: vec!["a".into(), "b".into()] });
    }

    #[tokio::test]
    async fn subscribes_against_a_local_server() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            let request = ws.next().await.unwrap().unwrap();
            let request: Value = serde_json::from_str(request.to_text().unwrap()).unwrap();
            assert_eq!(request["method"], "logsSubscribe");
            ws.send(Message::Text(json!({"jsonrpc": "2.0", "id": 1, "result": 9}).to_string().into())).await.unwrap();
            let note = json!({"jsonrpc": "2.0", "method": "logsNotification", "params": {"subscription": 9, "result": {
                "context": {"slot": 7}, "value": {"signature": "s", "err": null, "logs": ["x"]}
            }}});
            ws.send(Message::Text(note.to_string().into())).await.unwrap();
            ws.close(None).await.unwrap();
        });
        let mut sub = subscribe_logs(&format!("ws://{addr}"), &Address([1; 32])).await.unwrap();
        let first = sub.next().await.unwrap().unwrap();
        assert_eq!(first.slot, 7);
        assert!(sub.next().await.unwrap().is_err());
    }
}
