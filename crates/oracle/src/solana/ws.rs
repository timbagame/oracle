//! `logsSubscribe` over the Solana PubSub websocket.

use std::time::Duration;

use futures::{Sink, SinkExt, Stream, StreamExt};
use serde_json::{json, Value};
use timba_protocol::Address;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

const PING_INTERVAL: Duration = Duration::from_secs(5);
const SUBSCRIBE_TIMEOUT: Duration = Duration::from_secs(30);

/// Silence after which a socket counts as dead (three missed pings).
const PONG_TIMEOUT: Duration = Duration::from_secs(15);

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
    /// Next notification; an error means the stream ended.
    pub async fn next(&mut self) -> Result<LogsNotification, String> {
        match self.receiver.recv().await {
            Some(notification) => notification,
            None => Err("WebSocket subscription closed".into()),
        }
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

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn open_subscription(ws_url: &str, mentions: &Address) -> Result<Socket, String> {
    let (mut socket, _) =
        tokio_tungstenite::connect_async(ws_url).await.map_err(|e| format!("WebSocket connection failed: {e}"))?;
    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "logsSubscribe",
        "params": [{ "mentions": [mentions.to_base58()] }, { "commitment": "confirmed" }]
    });
    socket.send(Message::Text(request.to_string().into())).await.map_err(|e| e.to_string())?;
    while let Some(message) = socket.next().await {
        let message = message.map_err(|e| e.to_string())?;
        let Message::Text(text) = message else { continue };
        let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
        if value.get("id") == Some(&json!(1)) {
            if let Some(error) = value.get("error").filter(|e| !e.is_null()) {
                return Err(format!("logsSubscribe failed: {error}"));
            }
            return Ok(socket);
        }
    }
    Err("WebSocket closed before the subscription was acknowledged".to_string())
}

/// Opens the websocket and waits until the node acknowledges the
/// subscription, like kit's `subscribe()`.
pub async fn subscribe_logs(ws_url: &str, mentions: &Address) -> Result<LogsSubscription, String> {
    subscribe_logs_with(ws_url, mentions, SUBSCRIBE_TIMEOUT, PING_INTERVAL, PONG_TIMEOUT).await
}

async fn subscribe_logs_with(
    ws_url: &str,
    mentions: &Address,
    subscribe_timeout: Duration,
    ping_interval: Duration,
    pong_timeout: Duration,
) -> Result<LogsSubscription, String> {
    // Bound the connect and TLS handshake too: a stalled endpoint must not hang the
    // caller (and the subscription lock it holds) forever.
    let socket = tokio::time::timeout(subscribe_timeout, open_subscription(ws_url, mentions))
        .await
        .map_err(|_| "Timed out waiting for logsSubscribe acknowledgement".to_string())??;
    let (sender, receiver) = mpsc::channel(256);
    let task = tokio::spawn(pump(socket, sender, ping_interval, pong_timeout));
    Ok(LogsSubscription { receiver, task })
}

/// Forwards notifications from `socket` to `sender` until the socket fails,
/// closes or stops answering pings, reporting why through `sender`.
async fn pump<S>(
    mut socket: S,
    sender: mpsc::Sender<Result<LogsNotification, String>>,
    ping_interval: Duration,
    pong_timeout: Duration,
) where
    S: Stream<Item = Result<Message, WsError>> + Sink<Message, Error = WsError> + Unpin,
{
    let mut ping = tokio::time::interval(ping_interval);
    ping.tick().await;
    // Any frame (pongs included) proves the socket is alive; a half-open TCP
    // connection otherwise goes unnoticed until the OS gives up retransmitting.
    let mut last_seen = tokio::time::Instant::now();
    loop {
        tokio::select! {
            _ = ping.tick() => {
                if last_seen.elapsed() > pong_timeout {
                    let _ = sender.send(Err("WebSocket stopped answering pings".into())).await;
                    return;
                }
                if let Err(e) = socket.send(Message::Ping(Vec::new().into())).await {
                    let _ = sender.send(Err(e.to_string())).await;
                    return;
                }
            }
            message = socket.next() => {
                last_seen = tokio::time::Instant::now();
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
        assert_eq!(
            parsed,
            LogsNotification { slot: 5, signature: "abc".into(), err: None, logs: vec!["a".into(), "b".into()] }
        );
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
            // Some proxies send an explicit null error on success.
            let ack = json!({"jsonrpc": "2.0", "id": 1, "result": 9, "error": null});
            ws.send(Message::Text(ack.to_string().into())).await.unwrap();
            let note = json!({"jsonrpc": "2.0", "method": "logsNotification", "params": {"subscription": 9, "result": {
                "context": {"slot": 7}, "value": {"signature": "s", "err": null, "logs": ["x"]}
            }}});
            ws.send(Message::Text(note.to_string().into())).await.unwrap();
            ws.close(None).await.unwrap();
        });
        let mut sub = subscribe_logs(&format!("ws://{addr}"), &Address([1; 32])).await.unwrap();
        let first = sub.next().await.unwrap();
        assert_eq!(first.slot, 7);
        assert!(sub.next().await.is_err());
    }

    /// Serves one websocket client with `script`, returning the URL to connect to.
    async fn ws_server<F, Fut>(script: F) -> String
    where
        F: FnOnce(tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send,
    {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            script(ws).await;
        });
        format!("ws://{addr}")
    }

    #[tokio::test]
    async fn reports_subscription_errors() {
        let url = ws_server(|mut ws| async move {
            ws.next().await;
            let ack = json!({"jsonrpc": "2.0", "id": 1, "error": {"code": -32602, "message": "bad mentions"}});
            ws.send(Message::Text(ack.to_string().into())).await.unwrap();
        })
        .await;
        let err = subscribe_logs(&url, &Address([1; 32])).await.err().unwrap();
        assert!(err.starts_with("logsSubscribe failed:") && err.contains("bad mentions"), "{err}");

        let url = ws_server(|mut ws| async move {
            ws.next().await;
            ws.send(Message::Text("not json".into())).await.unwrap();
            ws.send(Message::Binary(vec![1].into())).await.unwrap();
            // Traffic for other requests is not the acknowledgement.
            ws.send(Message::Text(json!({"jsonrpc": "2.0", "id": 2, "result": 0}).to_string().into())).await.unwrap();
            ws.close(None).await.unwrap();
        })
        .await;
        let err = subscribe_logs(&url, &Address([1; 32])).await.err().unwrap();
        assert_eq!(err, "WebSocket closed before the subscription was acknowledged");

        let err = subscribe_logs("ws://127.0.0.1:1", &Address([1; 32])).await.err().unwrap();
        assert!(err.starts_with("WebSocket connection failed:"), "{err}");
    }

    #[tokio::test]
    async fn times_out_when_the_handshake_stalls() {
        // Accept the TCP connection but never answer the websocket upgrade.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (hung_up, hung_up_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            // Read the upgrade request, then wait for the client to give up.
            let mut buffer = [0u8; 1024];
            while tokio::io::AsyncReadExt::read(&mut stream, &mut buffer).await.is_ok_and(|read| read > 0) {}
            let _ = hung_up.send(());
        });
        let (ping, pong) = (Duration::from_secs(5), Duration::from_secs(15));
        let url = format!("ws://{addr}");
        let error =
            subscribe_logs_with(&url, &Address([1; 32]), Duration::from_millis(500), ping, pong).await.err().unwrap();
        assert_eq!(error, "Timed out waiting for logsSubscribe acknowledgement");
        tokio::time::timeout(Duration::from_secs(10), hung_up_rx).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn ends_the_stream_when_pings_go_unanswered() {
        let url = ws_server(|mut ws| async move {
            ws.next().await;
            ws.send(Message::Text(json!({"jsonrpc": "2.0", "id": 1, "result": 9}).to_string().into())).await.unwrap();
            // Keep the socket open but stop reading, so pings are never answered.
            let _keep_open = ws;
            std::future::pending::<()>().await;
        })
        .await;
        // Real time with short intervals: paused time would also fire the subscribe
        // timeout while the handshake is still in flight on a loaded machine.
        let mut sub = subscribe_logs_with(
            &url,
            &Address([1; 32]),
            SUBSCRIBE_TIMEOUT,
            Duration::from_millis(20),
            Duration::from_millis(100),
        )
        .await
        .unwrap();
        assert_eq!(sub.next().await.unwrap_err(), "WebSocket stopped answering pings");
    }

    #[tokio::test]
    async fn skips_frames_that_are_not_notifications() {
        let url = ws_server(|mut ws| async move {
            ws.next().await;
            ws.send(Message::Text(json!({"jsonrpc": "2.0", "id": 1, "result": 9}).to_string().into())).await.unwrap();
            ws.send(Message::Text("garbage".into())).await.unwrap();
            ws.send(Message::Text(json!({"method": "slotNotification"}).to_string().into())).await.unwrap();
            ws.send(Message::Text(json!({"method": "logsNotification", "params": {}}).to_string().into()))
                .await
                .unwrap();
            ws.send(Message::Pong(Vec::new().into())).await.unwrap();
            let note = json!({"method": "logsNotification", "params": {"result": {
                "context": {"slot": 8}, "value": {"signature": "t", "err": {"InstructionError": [0, "Custom"]}}
            }}});
            ws.send(Message::Text(note.to_string().into())).await.unwrap();
            drop(ws);
        })
        .await;
        let mut sub = subscribe_logs(&url, &Address([1; 32])).await.unwrap();
        let note = sub.next().await.unwrap();
        assert_eq!((note.slot, note.signature.as_str(), note.logs.len()), (8, "t", 0));
        assert!(note.err.is_some());
        assert!(sub.next().await.is_err(), "a dropped connection ends the stream");
    }

    /// A socket replaying `frames`, then either ending or staying silent.
    struct ScriptedSocket {
        frames: std::vec::IntoIter<Result<Message, WsError>>,
        silent_afterwards: bool,
        fail_sends: bool,
    }

    impl Stream for ScriptedSocket {
        type Item = Result<Message, WsError>;

        fn poll_next(
            mut self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Self::Item>> {
            match self.frames.next() {
                Some(frame) => std::task::Poll::Ready(Some(frame)),
                None if self.silent_afterwards => std::task::Poll::Pending,
                None => std::task::Poll::Ready(None),
            }
        }
    }

    impl Sink<Message> for ScriptedSocket {
        type Error = WsError;

        fn poll_ready(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), WsError>> {
            std::task::Poll::Ready(Ok(()))
        }

        fn start_send(self: std::pin::Pin<&mut Self>, _: Message) -> Result<(), WsError> {
            if self.fail_sends {
                Err(WsError::ConnectionClosed)
            } else {
                Ok(())
            }
        }

        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), WsError>> {
            std::task::Poll::Ready(Ok(()))
        }

        fn poll_close(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), WsError>> {
            std::task::Poll::Ready(Ok(()))
        }
    }

    fn scripted(frames: Vec<Result<Message, WsError>>, silent_afterwards: bool, fail_sends: bool) -> ScriptedSocket {
        ScriptedSocket { frames: frames.into_iter(), silent_afterwards, fail_sends }
    }

    #[tokio::test(start_paused = true)]
    async fn ends_the_stream_when_a_ping_cannot_be_sent() {
        let (sender, mut receiver) = mpsc::channel(4);
        let socket = scripted(Vec::new(), true, true);
        tokio::spawn(pump(socket, sender, Duration::from_secs(5), Duration::from_secs(3600)));
        assert_eq!(receiver.recv().await.unwrap().unwrap_err(), WsError::ConnectionClosed.to_string());
        assert!(receiver.recv().await.is_none(), "the pump stops after reporting");
    }

    #[tokio::test(start_paused = true)]
    async fn ends_the_stream_when_the_socket_is_exhausted() {
        let (sender, mut receiver) = mpsc::channel(4);
        let socket = scripted(Vec::new(), false, false);
        tokio::spawn(pump(socket, sender, Duration::from_secs(5), Duration::from_secs(15)));
        assert_eq!(receiver.recv().await.unwrap().unwrap_err(), "WebSocket closed");
    }

    #[tokio::test(start_paused = true)]
    async fn stops_pumping_when_the_subscriber_is_gone() {
        let note = json!({"method": "logsNotification", "params": {"result": {
            "context": {"slot": 1}, "value": {"signature": "s"}
        }}});
        let (sender, receiver) = mpsc::channel(4);
        drop(receiver);
        let socket = scripted(vec![Ok(Message::Text(note.to_string().into()))], true, false);
        // Returns instead of waiting for more frames.
        pump(socket, sender, Duration::from_secs(5), Duration::from_secs(15)).await;
    }

    #[tokio::test]
    async fn closed_subscriptions_report_an_error() {
        let (sender, receiver) = mpsc::channel(1);
        drop(sender);
        let mut subscription = LogsSubscription { receiver, task: tokio::spawn(async {}) };
        assert_eq!(subscription.next().await.unwrap_err(), "WebSocket subscription closed");
    }
}
