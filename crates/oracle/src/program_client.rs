//! Timba program account reads and log-subscription event dispatch (port of
//! `timba-program-client.ts`).

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::BoxFuture;
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
            if let Err(error) = client.consume_notifications(subscription).await {
                warn!("Timba program log subscription failed: {error}");
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
            let parsed = parse_transaction_events(
                &notification.signature,
                notification.slot,
                &notification.logs,
                &self.program_id.to_base58(),
            )?;
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
}
