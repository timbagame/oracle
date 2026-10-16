//! Timba program account reads and log-subscription event dispatch (port of
//! `timba-program-client.ts`).

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use std::panic::AssertUnwindSafe;

use futures::future::BoxFuture;
use futures::FutureExt;
use timba_common::warn;
use timba_protocol::contracts::{GameAccount, PROGRAM_ID};
use timba_protocol::{Address, ContractVersion};
use tokio::task::JoinHandle;

use crate::indexed_events::{
    parse_transaction_events, GameClosedEvent, GameCompletedEvent, GameInitializedEvent, MembershipKind,
    PlayerMembershipEvent,
};
use crate::solana::ws::{subscribe_logs, websocket_url, LogsSubscription};
use crate::solana::RpcPool;

const RECONNECT_DELAY: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EventName {
    GameInitialized,
    GameCompleted,
    GameClosed,
    OperatorGameClosed,
    PlayerJoined,
    PlayerUnjoined,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProgramDispatch {
    GameInitialized(GameInitializedEvent),
    GameCompleted(GameCompletedEvent),
    GameClosed(GameClosedEvent),
    PlayerMembership(PlayerMembershipEvent),
}

impl ProgramDispatch {
    pub fn name(&self) -> EventName {
        match self {
            Self::GameInitialized(_) => EventName::GameInitialized,
            Self::GameCompleted(_) => EventName::GameCompleted,
            Self::GameClosed(event) if event.operator => EventName::OperatorGameClosed,
            Self::GameClosed(_) => EventName::GameClosed,
            Self::PlayerMembership(event) if event.kind == MembershipKind::Joined => EventName::PlayerJoined,
            Self::PlayerMembership(_) => EventName::PlayerUnjoined,
        }
    }
}

pub type EventCallback = Arc<dyn Fn(ProgramDispatch) -> BoxFuture<'static, ()> + Send + Sync>;

#[derive(Default)]
struct SubscriptionState {
    task: Option<JoinHandle<()>>,
    reconnect: Option<JoinHandle<()>>,
    /// Incremented on every stop so stale tasks never reschedule.
    generation: u64,
}

pub struct ProgramClient {
    pub rpc: Arc<RpcPool>,
    pub contract_version: ContractVersion,
    pub program_id: Address,
    ws_endpoint: Option<String>,
    listeners: Mutex<BTreeMap<u64, (EventName, EventCallback)>>,
    next_listener_id: AtomicU64,
    state: tokio::sync::Mutex<SubscriptionState>,
}

/// Error message kit raises for a missing account; the completion manager
/// matches on it.
pub fn account_not_found_message(address: &Address) -> String {
    format!("Account not found at address: {address}")
}

pub fn is_account_missing_error(message: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?i)Account (?:does not exist|not found(?: at address)?)").unwrap())
        .is_match(message)
}

impl ProgramClient {
    pub fn new(rpc: Arc<RpcPool>, contract_version: ContractVersion, ws_endpoint: Option<String>) -> Arc<Self> {
        Arc::new(Self {
            rpc,
            contract_version,
            program_id: PROGRAM_ID,
            ws_endpoint: ws_endpoint.filter(|e| !e.is_empty()),
            listeners: Mutex::new(BTreeMap::new()),
            next_listener_id: AtomicU64::new(1),
            state: tokio::sync::Mutex::new(SubscriptionState::default()),
        })
    }

    pub async fn fetch_game(&self, game: &Address) -> anyhow::Result<GameAccount> {
        let account =
            self.rpc.get_account_info(game).await?.ok_or_else(|| anyhow::anyhow!(account_not_found_message(game)))?;
        GameAccount::decode(&account.data).map_err(|error| anyhow::anyhow!("{error}"))
    }

    pub fn listener_count(&self) -> usize {
        self.listeners.lock().unwrap().len()
    }

    pub async fn add_event_listener(
        self: &Arc<Self>,
        event: EventName,
        callback: EventCallback,
    ) -> anyhow::Result<u64> {
        let id = self.next_listener_id.fetch_add(1, Ordering::SeqCst);
        self.listeners.lock().unwrap().insert(id, (event, callback));
        if let Err(error) = self.ensure_subscription().await {
            self.listeners.lock().unwrap().remove(&id);
            if self.listener_count() == 0 {
                if let Some(timer) = self.state.lock().await.reconnect.take() {
                    timer.abort();
                }
            }
            return Err(error);
        }
        Ok(id)
    }

    pub async fn remove_event_listener(&self, id: u64) {
        self.listeners.lock().unwrap().remove(&id);
        if self.listener_count() == 0 {
            self.stop_subscription().await;
        }
    }

    pub async fn close(&self) {
        self.listeners.lock().unwrap().clear();
        self.stop_subscription().await;
    }

    fn ws_url(&self) -> anyhow::Result<String> {
        let endpoint = self.ws_endpoint.clone().unwrap_or_else(|| self.rpc.active_endpoint().to_string());
        websocket_url(&endpoint).map_err(anyhow::Error::msg)
    }

    async fn ensure_subscription(self: &Arc<Self>) -> anyhow::Result<()> {
        let mut state = self.state.lock().await;
        if state.task.as_ref().is_some_and(|task| !task.is_finished()) {
            return Ok(());
        }
        let subscription = subscribe_logs(&self.ws_url()?, &self.program_id).await.map_err(anyhow::Error::msg)?;
        let generation = state.generation;
        let client = self.clone();
        state.task = Some(tokio::spawn(async move {
            // A panicking listener must not leave the program without a subscription:
            // always fall through to the reconnect logic.
            match AssertUnwindSafe(client.consume_notifications(subscription)).catch_unwind().await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => warn!("Timba program log subscription failed: {error}"),
                Err(_) => warn!("Timba program log subscription stopped after a listener panicked"),
            }
            client.on_subscription_ended(generation).await;
        }));
        Ok(())
    }

    async fn on_subscription_ended(self: &Arc<Self>, generation: u64) {
        let mut state = self.state.lock().await;
        if state.generation != generation {
            return;
        }
        state.task = None;
        if self.listener_count() > 0 {
            self.schedule_reconnect(&mut state);
        }
    }

    fn schedule_reconnect(self: &Arc<Self>, state: &mut SubscriptionState) {
        if state.reconnect.as_ref().is_some_and(|timer| !timer.is_finished()) || self.listener_count() == 0 {
            return;
        }
        let client = self.clone();
        let generation = state.generation;
        state.reconnect = Some(tokio::spawn(async move {
            tokio::time::sleep(RECONNECT_DELAY).await;
            if client.listener_count() == 0 {
                return;
            }
            if let Err(error) = client.ensure_subscription().await {
                warn!("Failed to restore Timba program log subscription: {error:#}");
                let mut state = client.state.lock().await;
                if state.generation == generation {
                    state.reconnect = None;
                    client.schedule_reconnect(&mut state);
                }
            }
        }));
    }

    async fn stop_subscription(&self) {
        let mut state = self.state.lock().await;
        state.generation += 1;
        if let Some(timer) = state.reconnect.take() {
            timer.abort();
        }
        if let Some(task) = state.task.take() {
            task.abort();
            let _ = task.await;
        }
    }

    async fn consume_notifications(&self, mut subscription: LogsSubscription) -> Result<(), String> {
        while let Some(notification) = subscription.next().await {
            let notification = notification?;
            if notification.err.is_some() || notification.slot > (1 << 53) - 1 {
                continue;
            }
            // One undecodable event (say an amount above 2^53) must not drop the
            // subscription and every event behind it; the fallback scan covers it.
            let parsed = match parse_transaction_events(
                &notification.signature,
                notification.slot,
                &notification.logs,
                &self.program_id.to_base58(),
            ) {
                Ok(parsed) => parsed,
                Err(error) => {
                    warn!("Skipping undecodable program events in {}: {error}", notification.signature);
                    continue;
                }
            };
            let dispatches = parsed
                .initialized
                .into_iter()
                .map(ProgramDispatch::GameInitialized)
                .chain(parsed.completed.into_iter().map(ProgramDispatch::GameCompleted))
                .chain(parsed.closed.into_iter().map(ProgramDispatch::GameClosed))
                .chain(parsed.membership.into_iter().map(ProgramDispatch::PlayerMembership));
            for dispatch in dispatches {
                self.dispatch(dispatch).await;
            }
        }
        Ok(())
    }

    /// Invokes every listener registered for the event concurrently.
    pub async fn dispatch(&self, dispatch: ProgramDispatch) {
        let name = dispatch.name();
        let callbacks: Vec<EventCallback> = self
            .listeners
            .lock()
            .unwrap()
            .values()
            .filter(|(event, _)| *event == name)
            .map(|(_, callback)| callback.clone())
            .collect();
        futures::future::join_all(callbacks.into_iter().map(|callback| callback(dispatch.clone()))).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::FutureExt;

    fn closed(operator: bool) -> ProgramDispatch {
        ProgramDispatch::GameClosed(GameClosedEvent {
            game_key: "g".into(),
            timestamp: 1,
            operator,
            signature: "s".into(),
            slot: 2,
        })
    }

    #[tokio::test]
    async fn dispatches_by_event_name() {
        let rpc = Arc::new(RpcPool::new(&["http://127.0.0.1:1".into()]).unwrap());
        let client = ProgramClient::new(rpc, ContractVersion::V0_3_0, None);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        client.listeners.lock().unwrap().insert(
            1,
            (
                EventName::OperatorGameClosed,
                Arc::new(move |event| {
                    sink.lock().unwrap().push(event);
                    async {}.boxed()
                }),
            ),
        );
        client.dispatch(closed(false)).await;
        client.dispatch(closed(true)).await;
        assert_eq!(*seen.lock().unwrap(), vec![closed(true)]);
        assert!(is_account_missing_error(&account_not_found_message(&PROGRAM_ID)));
        assert!(is_account_missing_error("Account does not exist"));
    }

    #[tokio::test]
    async fn failed_subscription_removes_listener() {
        let rpc = Arc::new(RpcPool::new(&["http://127.0.0.1:1".into()]).unwrap());
        let client = ProgramClient::new(rpc, ContractVersion::V0_3_0, None);
        let result = client.add_event_listener(EventName::GameCompleted, Arc::new(|_| async {}.boxed())).await;
        assert!(result.is_err());
        assert_eq!(client.listener_count(), 0);
    }

    use base64::Engine;
    use futures::{SinkExt, StreamExt};
    use serde_json::{json, Value};
    use tokio_tungstenite::tungstenite::Message;

    fn joined_logs(ticket_index: u32) -> Vec<String> {
        let mut data = timba_protocol::events::discriminators::PLAYER_JOINED.to_vec();
        data.extend_from_slice(&[1; 32]);
        data.extend_from_slice(&[2; 32]);
        data.extend_from_slice(&10u64.to_le_bytes());
        data.extend_from_slice(&(ticket_index + 1).to_le_bytes());
        data.extend_from_slice(&ticket_index.to_le_bytes());
        data.extend_from_slice(&5u64.to_le_bytes());
        data.extend_from_slice(&6u64.to_le_bytes());
        let program = PROGRAM_ID.to_base58();
        vec![
            format!("Program {program} invoke [1]"),
            format!("Program data: {}", base64::engine::general_purpose::STANDARD.encode(data)),
            format!("Program {program} success"),
        ]
    }

    fn notification(slot: u64, err: Value, logs: Vec<String>) -> Message {
        let note = json!({"jsonrpc": "2.0", "method": "logsNotification", "params": {"subscription": 1, "result": {
            "context": {"slot": slot}, "value": {"signature": format!("sig-{slot}"), "err": err, "logs": logs}
        }}});
        Message::Text(note.to_string().into())
    }

    /// Serves logs subscriptions. The first connection delivers a join, three
    /// notifications the client must skip (failed, out of range, malformed), a
    /// second join and then hangs up; later connections deliver one join and
    /// stay open.
    async fn scripted_server() -> (String, Arc<AtomicU64>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let connections = Arc::new(AtomicU64::new(0));
        let counter = connections.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let connection = counter.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else { return };
                    let Some(Ok(request)) = ws.next().await else { return };
                    let request: Value = serde_json::from_str(request.to_text().unwrap()).unwrap();
                    let reply = json!({"jsonrpc": "2.0", "id": request["id"], "result": 1});
                    ws.send(Message::Text(reply.to_string().into())).await.unwrap();
                    if connection == 0 {
                        ws.send(notification(10, Value::Null, joined_logs(0))).await.unwrap();
                        ws.send(notification(11, json!({"InstructionError": [0, "Custom"]}), joined_logs(1)))
                            .await
                            .unwrap();
                        ws.send(notification(1 << 53, Value::Null, joined_logs(2))).await.unwrap();
                        let mut broken = joined_logs(3);
                        broken[1] = format!(
                            "Program data: {}",
                            base64::engine::general_purpose::STANDARD
                                .encode([39u8, 144, 49, 106, 108, 210, 183, 38, 1])
                        );
                        ws.send(notification(12, Value::Null, broken)).await.unwrap();
                        ws.send(notification(13, Value::Null, joined_logs(5))).await.unwrap();
                        return;
                    } else {
                        ws.send(notification(20 + connection, Value::Null, joined_logs(4))).await.unwrap();
                    }
                    while let Some(Ok(_)) = ws.next().await {}
                });
            }
        });
        (format!("ws://{addr}"), connections)
    }

    #[tokio::test]
    async fn dispatches_notifications_and_reconnects() {
        let (url, connections) = scripted_server().await;
        let rpc = Arc::new(RpcPool::new(&["http://127.0.0.1:1".into()]).unwrap());
        let client = ProgramClient::new(rpc, ContractVersion::V0_3_0, Some(url));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let id = client
            .add_event_listener(
                EventName::PlayerJoined,
                Arc::new(move |event| {
                    tx.send(event).unwrap();
                    async {}.boxed()
                }),
            )
            .await
            .unwrap();
        let ignored =
            client.add_event_listener(EventName::GameCompleted, Arc::new(|_| async {}.boxed())).await.unwrap();
        assert_eq!(client.listener_count(), 2);

        async fn next(rx: &mut tokio::sync::mpsc::UnboundedReceiver<ProgramDispatch>) -> ProgramDispatch {
            tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap().unwrap()
        }
        let ProgramDispatch::PlayerMembership(first) = next(&mut rx).await else { panic!("membership expected") };
        assert_eq!((first.slot, first.ticket_index, first.signature.as_str()), (10, 0, "sig-10"));
        // Failed, out-of-range and malformed notifications are skipped without
        // dropping the subscription.
        let ProgramDispatch::PlayerMembership(second) = next(&mut rx).await else { panic!("membership expected") };
        assert_eq!((second.slot, second.ticket_index), (13, 5));
        assert_eq!(connections.load(Ordering::SeqCst), 1);
        // The server then hangs up; the subscription is restored after the reconnect delay.
        let ProgramDispatch::PlayerMembership(third) = next(&mut rx).await else { panic!("membership expected") };
        assert_eq!((third.slot, third.ticket_index), (21, 4));
        assert_eq!(connections.load(Ordering::SeqCst), 2);

        client.remove_event_listener(ignored).await;
        assert_eq!(client.listener_count(), 1);
        client.remove_event_listener(id).await;
        assert_eq!(client.listener_count(), 0);
        assert!(client.state.lock().await.task.is_none());
        client.close().await;
    }

    #[tokio::test]
    async fn reconnects_after_a_listener_panics() {
        let (url, connections) = scripted_server().await;
        let rpc = Arc::new(RpcPool::new(&["http://127.0.0.1:1".into()]).unwrap());
        let client = ProgramClient::new(rpc, ContractVersion::V0_3_0, Some(url));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        client
            .add_event_listener(
                EventName::PlayerJoined,
                Arc::new(move |event| {
                    let ProgramDispatch::PlayerMembership(ref membership) = event else { unreachable!() };
                    assert_ne!(membership.slot, 10, "listener bug");
                    tx.send(event).unwrap();
                    async {}.boxed()
                }),
            )
            .await
            .unwrap();
        let event = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap().unwrap();
        let ProgramDispatch::PlayerMembership(membership) = event else { panic!("membership expected") };
        assert_eq!(membership.slot, 21, "delivered over the restored subscription");
        assert_eq!(connections.load(Ordering::SeqCst), 2);
        client.close().await;
    }

    #[tokio::test]
    async fn names_dispatches() {
        let initialized = ProgramDispatch::GameInitialized(GameInitializedEvent {
            game_key: "g".into(),
            creator: "c".into(),
            game_type: "coinflip".into(),
            ticket_amount: 1,
            total_amount: 1,
            max_tickets: 2,
            min_tickets: 1,
            token_mint: "m".into(),
            is_private: false,
            created_at: 0,
            timeout: 0,
            signature: "s".into(),
            slot: 1,
        });
        let completed = ProgramDispatch::GameCompleted(GameCompletedEvent {
            game_key: "g".into(),
            winner: "w".into(),
            tickets_count: 1,
            winner_amount: 1,
            fee_amount: 0,
            timestamp: 0,
            signature: "s".into(),
            slot: 1,
        });
        let membership = |kind| {
            ProgramDispatch::PlayerMembership(PlayerMembershipEvent {
                kind,
                game_key: "g".into(),
                player: "p".into(),
                tickets_count: 1,
                ticket_index: 0,
                moved_participant: None,
                timestamp: 0,
                signature: "s".into(),
                slot: 1,
            })
        };
        assert_eq!(initialized.name(), EventName::GameInitialized);
        assert_eq!(completed.name(), EventName::GameCompleted);
        assert_eq!(closed(false).name(), EventName::GameClosed);
        assert_eq!(closed(true).name(), EventName::OperatorGameClosed);
        assert_eq!(membership(MembershipKind::Joined).name(), EventName::PlayerJoined);
        assert_eq!(membership(MembershipKind::Unjoined).name(), EventName::PlayerUnjoined);
    }

    #[tokio::test]
    async fn fetches_and_decodes_game_accounts() {
        use crate::solana::pool::testing::FakeTransport;
        use timba_protocol::contracts::GameType;
        let transport = FakeTransport::new();
        let rpc = Arc::new(RpcPool::with_transport(&["https://a".into()], transport.clone()).unwrap());
        let client = ProgramClient::new(rpc, ContractVersion::V0_3_0, None);
        let game = GameAccount {
            creator: Address([1; 32]),
            game_type: GameType::Coinflip,
            ticket_amount: 10,
            max_tickets: 2,
            min_tickets: 2,
            tickets_count: 1,
            token_mint: Address([2; 32]),
            created_at: 5,
            timeout: 60,
            last_slot: 9,
            is_private: false,
            total_amount: 10,
            participants: vec![Address([3; 32])],
        };
        let encoded = base64::engine::general_purpose::STANDARD.encode(game.encode());
        transport.push(
            "getAccountInfo",
            Ok(json!({"value": {"data": [encoded, "base64"], "owner": PROGRAM_ID.to_base58(), "lamports": 1, "executable": false}})),
        );
        transport.push("getAccountInfo", Ok(json!({"value": null})));
        transport.push(
            "getAccountInfo",
            Ok(json!({"value": {"data": ["AAAA", "base64"], "owner": PROGRAM_ID.to_base58(), "lamports": 1, "executable": false}})),
        );
        let key = Address([4; 32]);
        assert_eq!(client.fetch_game(&key).await.unwrap(), game);
        let missing = client.fetch_game(&key).await.unwrap_err().to_string();
        assert_eq!(missing, account_not_found_message(&key));
        assert!(is_account_missing_error(&missing));
        assert!(client.fetch_game(&key).await.is_err());
    }
}
