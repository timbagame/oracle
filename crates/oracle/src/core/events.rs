//! Program event handling: per-game ordered mutations, debounced player
//! registry writes, auto-complete scheduling and registry reconciliation
//! (port of `oracle-event-processor.ts`).

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures::future::{BoxFuture, FutureExt};
use timba_common::{error, info, warn};
use timba_protocol::Address;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use super::registry::{analyze_registry_state, RegistryStats};
use crate::config::normalize_game_type;
use crate::db::{OracleDatabase, PlayerMutation};
use crate::indexed_events::{
    GameClosedEvent, GameCompletedEvent, GameInitializedEvent, MembershipKind, PlayerMembershipEvent,
};
use crate::program_client::{EventCallback, EventName, ProgramClient, ProgramDispatch};

pub const DEFAULT_REGISTRY_SYNC_RETRY_DELAY_MS: u64 = 2_000;
pub const DEFAULT_REGISTRY_SYNC_TIMEOUT_MS: u64 = 30_000;

pub const ALL_EVENTS: [EventName; 6] = [
    EventName::PlayerJoined,
    EventName::PlayerUnjoined,
    EventName::GameInitialized,
    EventName::GameCompleted,
    EventName::GameClosed,
    EventName::OperatorGameClosed,
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistrySyncRequest {
    pub game_address: String,
    pub expected_tickets: Option<i64>,
    pub trigger: String,
    pub game_key: Option<Address>,
}

/// Callbacks into the oracle service.
pub trait EventHooks: Send + Sync {
    fn try_auto_complete(
        &self,
        game_key: Option<Address>,
        game_address: String,
        trigger: String,
    ) -> BoxFuture<'static, ()>;
    fn sync_player_registry(&self, request: RegistrySyncRequest) -> BoxFuture<'static, bool>;
    fn on_game_finalized(&self, game_address: &str);
}

pub struct EventProcessorOptions {
    pub program: Arc<ProgramClient>,
    pub db: Arc<OracleDatabase>,
    pub hooks: Weak<dyn EventHooks>,
    pub events: Vec<EventName>,
    pub player_flush_debounce_ms: u64,
    pub player_flush_max_operations: usize,
    pub auto_complete_debounce_ms: u64,
    pub registry_sync_retry_delay_ms: u64,
    pub registry_sync_timeout_ms: u64,
}

#[derive(Default)]
struct PlayerBuffer {
    operations: Vec<PlayerMutation>,
    running: bool,
    timer: Option<JoinHandle<()>>,
    expected_tickets: Option<i64>,
    last_game_key: Option<Address>,
    last_trigger: Option<String>,
}

#[derive(Default)]
struct AutoCompleteState {
    pending: bool,
    running: bool,
    timer: Option<JoinHandle<()>>,
    game_key: Option<Address>,
    trigger: Option<String>,
}

#[derive(Default)]
struct RegistryEntry {
    /// Identifies this entry, so loops and timers left over from a cleared
    /// entry never act on a newer one for the same game.
    id: u64,
    queue: VecDeque<RegistrySyncRequest>,
    running: bool,
    timer: Option<JoinHandle<()>>,
    /// The request a scheduled retry will run; set exactly while its timer waits.
    retry_pending: Option<RegistrySyncRequest>,
    failures: u32,
}

/// Consecutive failed syncs before giving up on a game; completion-time
/// recovery still reconciles it. Each attempt can cost thousands of RPC calls.
const MAX_REGISTRY_SYNC_FAILURES: u32 = 10;

#[derive(Default)]
struct ListenState {
    listening: bool,
    listener_ids: Vec<u64>,
}

type Job = BoxFuture<'static, ()>;
pub type ProgramEventObserver = Arc<dyn Fn() + Send + Sync>;

/// Aborts a timer unless it is the task currently running (a fired timer
/// clearing itself must not cancel its own continuation).
fn cancel_timer(timer: Option<JoinHandle<()>>) {
    if let Some(timer) = timer {
        if tokio::task::try_id() != Some(timer.id()) {
            timer.abort();
        }
    }
}

fn merge_requests(current: RegistrySyncRequest, incoming: RegistrySyncRequest) -> RegistrySyncRequest {
    RegistrySyncRequest {
        game_address: incoming.game_address,
        expected_tickets: incoming.expected_tickets.or(current.expected_tickets),
        trigger: incoming.trigger,
        game_key: incoming.game_key.or(current.game_key),
    }
}

pub struct EventProcessor {
    program: Arc<ProgramClient>,
    db: Arc<OracleDatabase>,
    hooks: Weak<dyn EventHooks>,
    events: Vec<EventName>,
    player_flush_debounce_ms: u64,
    player_flush_max_operations: usize,
    auto_complete_debounce_ms: u64,
    registry_retry_delay_ms: u64,
    registry_timeout_ms: u64,
    listen: tokio::sync::Mutex<ListenState>,
    listening_flag: Mutex<(bool, usize)>,
    queues: Mutex<HashMap<String, mpsc::UnboundedSender<Job>>>,
    buffers: Mutex<HashMap<String, PlayerBuffer>>,
    auto_completes: Mutex<HashMap<String, AutoCompleteState>>,
    registry: Mutex<HashMap<String, RegistryEntry>>,
    next_registry_id: AtomicU64,
    observers: Mutex<Vec<(u64, ProgramEventObserver)>>,
    next_observer: Mutex<u64>,
}

impl EventProcessor {
    pub fn new(options: EventProcessorOptions) -> Arc<Self> {
        Arc::new(Self {
            program: options.program,
            db: options.db,
            hooks: options.hooks,
            events: options.events,
            player_flush_debounce_ms: options.player_flush_debounce_ms,
            player_flush_max_operations: options.player_flush_max_operations.max(1),
            auto_complete_debounce_ms: options.auto_complete_debounce_ms,
            registry_retry_delay_ms: options.registry_sync_retry_delay_ms,
            registry_timeout_ms: options.registry_sync_timeout_ms,
            listen: tokio::sync::Mutex::new(ListenState::default()),
            listening_flag: Mutex::new((false, 0)),
            queues: Mutex::new(HashMap::new()),
            buffers: Mutex::new(HashMap::new()),
            auto_completes: Mutex::new(HashMap::new()),
            registry: Mutex::new(HashMap::new()),
            next_registry_id: AtomicU64::new(1),
            observers: Mutex::new(Vec::new()),
            next_observer: Mutex::new(1),
        })
    }

    pub fn is_listening(&self) -> bool {
        self.listening_flag.lock().unwrap().0
    }

    pub fn active_listener_count(&self) -> usize {
        self.listening_flag.lock().unwrap().1
    }

    fn set_listening(&self, state: &ListenState) {
        *self.listening_flag.lock().unwrap() = (state.listening, state.listener_ids.len());
    }

    // -- observers ---------------------------------------------------------

    /// Registers a callback run on every program event; returns its id for
    /// [`Self::remove_program_event_observer`].
    pub fn add_program_event_observer(&self, observer: ProgramEventObserver) -> u64 {
        let mut next = self.next_observer.lock().unwrap();
        let id = *next;
        *next += 1;
        self.observers.lock().unwrap().push((id, observer));
        id
    }

    pub fn remove_program_event_observer(&self, id: u64) {
        self.observers.lock().unwrap().retain(|(existing, _)| *existing != id);
    }

    fn notify_observers(&self) {
        let observers: Vec<_> = self.observers.lock().unwrap().iter().map(|(_, o)| o.clone()).collect();
        for observer in observers {
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| observer())).is_err() {
                warn!("Program event observer failed");
            }
        }
    }

    // -- per-game ordering -------------------------------------------------

    /// Appends a job to the game's FIFO queue; jobs for one game never run
    /// concurrently and run in submission order.
    fn enqueue(self: &Arc<Self>, game_address: &str, job: Job) {
        let mut queues = self.queues.lock().unwrap();
        // Workers deregister under this lock before exiting, so a failed send
        // means the worker was dropped with its runtime: start a new one.
        let job = match queues.get(game_address) {
            Some(sender) => match sender.send(job) {
                Ok(()) => return,
                Err(unsent) => unsent.0,
            },
            None => job,
        };
        let (sender, receiver) = mpsc::unbounded_channel();
        let _ = sender.send(job);
        queues.insert(game_address.to_string(), sender);
        let processor = self.clone();
        let game = game_address.to_string();
        tokio::spawn(async move { processor.run_queue(game, receiver).await });
    }

    async fn run_queue(self: Arc<Self>, game: String, mut receiver: mpsc::UnboundedReceiver<Job>) {
        loop {
            // Checked under the queue lock, so `enqueue` never sends to a worker that is exiting.
            let job = {
                let mut queues = self.queues.lock().unwrap();
                match receiver.try_recv() {
                    Ok(job) => job,
                    Err(_) => {
                        queues.remove(&game);
                        return;
                    }
                }
            };
            if std::panic::AssertUnwindSafe(job).catch_unwind().await.is_err() {
                error!("Event handler panicked for {game}");
            }
        }
    }

    /// Runs `handler` in the game's queue, logging failures, and waits for it.
    async fn run_event_mutation<F>(self: &Arc<Self>, event_type: String, game_address: &str, handler: F)
    where
        F: Future<Output = anyhow::Result<()>> + Send + 'static,
    {
        let _ = self.enqueue_event_mutation(event_type, game_address, handler).await;
    }

    /// Queues `handler` behind earlier work for the same game; the receiver
    /// resolves once it ran. Dropping the receiver does not cancel it.
    fn enqueue_event_mutation<F>(
        self: &Arc<Self>,
        event_type: String,
        game_address: &str,
        handler: F,
    ) -> oneshot::Receiver<()>
    where
        F: Future<Output = anyhow::Result<()>> + Send + 'static,
    {
        let (done, wait) = oneshot::channel();
        let game = game_address.to_string();
        self.enqueue(
            game_address,
            async move {
                if let Err(error) = handler.await {
                    error!("Error in {event_type} event for {game}: {error:#}");
                }
                let _ = done.send(());
            }
            .boxed(),
        );
        wait
    }

    // -- listening -----------------------------------------------------------

    pub async fn start_listening(self: &Arc<Self>) -> anyhow::Result<()> {
        let mut state = self.listen.lock().await;
        if state.listening {
            return Ok(());
        }
        info!("🎧 Starting event listeners...");
        let listeners = self
            .events
            .iter()
            .map(|event| {
                let weak = Arc::downgrade(self);
                let callback: EventCallback = Arc::new(move |dispatch| {
                    let weak = weak.clone();
                    async move {
                        if let Some(processor) = weak.upgrade() {
                            processor.notify_observers();
                            processor.handle_dispatch(dispatch).await;
                        }
                    }
                    .boxed()
                });
                (*event, callback)
            })
            .collect();
        let ids = self.program.add_event_listeners(listeners).await?;
        state.listening = true;
        state.listener_ids = ids;
        self.set_listening(&state);
        Ok(())
    }

    pub async fn stop_listening(&self) {
        let mut state = self.listen.lock().await;
        if !state.listening {
            return;
        }
        for id in std::mem::take(&mut state.listener_ids) {
            self.program.remove_event_listener(id).await;
        }
        state.listening = false;
        self.set_listening(&state);
        self.clear_registry_syncs();
        for (_, buffer) in self.buffers.lock().unwrap().drain() {
            cancel_timer(buffer.timer);
        }
        for (_, entry) in self.auto_completes.lock().unwrap().drain() {
            cancel_timer(entry.timer);
        }
    }

    pub fn clear_registry_syncs(&self) {
        for (_, entry) in self.registry.lock().unwrap().drain() {
            cancel_timer(entry.timer);
        }
    }

    pub async fn handle_dispatch(self: &Arc<Self>, dispatch: ProgramDispatch) {
        match dispatch {
            ProgramDispatch::PlayerMembership(event) => self.handle_player_event(event).await,
            ProgramDispatch::GameInitialized(event) => self.handle_game_initialized(&event),
            // Like the TypeScript `void runEventMutation(...)`: queued in order, but
            // the subscription reader does not wait for the flush and DB writes.
            ProgramDispatch::GameCompleted(GameCompletedEvent { game_key, .. }) => {
                drop(self.start_game_status_change(GameStatus::Completed, &game_key))
            }
            ProgramDispatch::GameClosed(GameClosedEvent { game_key, .. }) => {
                drop(self.start_game_status_change(GameStatus::Closed, &game_key))
            }
        }
    }

    fn has_active_secret_key(&self, game_address: &str) -> bool {
        self.db.get_secret_key(game_address).is_some()
    }

    // -- handlers ------------------------------------------------------------

    pub async fn handle_player_event(self: &Arc<Self>, event: PlayerMembershipEvent) {
        let action = match event.kind {
            MembershipKind::Joined => "joined",
            MembershipKind::Unjoined => "unjoined",
        };
        let event_type = format!("player {action}");
        let Ok(game_key) = Address::parse(&event.game_key) else {
            warn!("⚠️  Invalid game address in {event_type} event for {}", event.game_key);
            return;
        };
        let game_address = event.game_key.clone();
        if !self.has_active_secret_key(&game_address) {
            // Ignore activity for games the oracle did not issue secrets for.
            return;
        }
        let mutation = match event.kind {
            MembershipKind::Joined => PlayerMutation::Joined {
                player_address: event.player.clone(),
                ticket_index: i64::from(event.ticket_index),
            },
            MembershipKind::Unjoined => PlayerMutation::Unjoined {
                ticket_index: i64::from(event.ticket_index),
                moved_participant: event.moved_participant.clone(),
            },
        };
        let expected = Some(i64::from(event.tickets_count));
        let processor = self.clone();
        let game = game_address.clone();
        self.run_event_mutation(event_type, &game_address, async move {
            processor.enqueue_player_mutation(&game, mutation, expected, Some(game_key), action).await;
            Ok(())
        })
        .await;
    }

    pub async fn handle_game_status_change(self: &Arc<Self>, status: GameStatus, game_key: &str) {
        if let Some(done) = self.start_game_status_change(status, game_key) {
            let _ = done.await;
        }
    }

    fn start_game_status_change(self: &Arc<Self>, status: GameStatus, game_key: &str) -> Option<oneshot::Receiver<()>> {
        let event_type = format!("game {}", status.as_str());
        let Ok(key) = Address::parse(game_key) else {
            warn!("⚠️  Invalid game address in {event_type} event for {game_key}");
            return None;
        };
        if !self.has_active_secret_key(game_key) {
            return None;
        }
        let processor = self.clone();
        let game = game_key.to_string();
        let trigger = event_type.clone();
        Some(self.enqueue_event_mutation(event_type, game_key, async move {
            processor.flush_player_buffer_serialized(&game, &trigger, Some(key)).await;
            processor.apply_status(status, &game)
        }))
    }

    fn apply_status(&self, status: GameStatus, game: &str) -> anyhow::Result<()> {
        match status {
            GameStatus::Completed => self.db.mark_game_completed(game)?,
            GameStatus::Closed => {
                self.db.mark_game_closed(game)?;
                self.db.clear_stale_players_for_game(game)?;
                info!("🚫 Game closed: {game}");
            }
        }
        self.cancel_auto_complete(game);
        if let Some(hooks) = self.hooks.upgrade() {
            hooks.on_game_finalized(game);
        }
        Ok(())
    }

    pub fn handle_game_initialized(&self, event: &GameInitializedEvent) {
        let game_address = &event.game_key;
        if Address::parse(game_address).is_err() {
            warn!("⚠️  Invalid game address in game initialized event for {game_address}");
            return;
        }
        if !self.has_active_secret_key(game_address) {
            // Never create tracking rows from on-chain events alone.
            return;
        }
        if let Err(error) = self.db.mark_secret_key_committed(game_address) {
            error!("Error in game initialized event for {game_address}: {error:#}");
            return;
        }
        let game_type = normalize_game_type(Some(&event.game_type), true).ok().flatten();
        info!("🎮 Game initialized: {game_address}, Type: {}", game_type.as_deref().unwrap_or("unknown"));
        if let Err(error) = self.db.track_game(game_address, game_type.as_deref(), true) {
            error!("Error in game initialized event for {game_address}: {error:#}");
        }
    }

    // -- player mutation buffering ------------------------------------------

    async fn enqueue_player_mutation(
        self: &Arc<Self>,
        game: &str,
        mutation: PlayerMutation,
        expected_tickets: Option<i64>,
        game_key: Option<Address>,
        trigger: &str,
    ) {
        let flush_now = {
            let mut buffers = self.buffers.lock().unwrap();
            let entry = buffers.entry(game.to_string()).or_default();
            entry.operations.push(mutation);
            entry.last_game_key = game_key.or(entry.last_game_key);
            entry.last_trigger = Some(trigger.to_string());
            if expected_tickets.is_some() {
                entry.expected_tickets = expected_tickets;
            }
            let flush_now =
                self.player_flush_debounce_ms == 0 || entry.operations.len() >= self.player_flush_max_operations;
            if !flush_now && entry.timer.is_none() {
                let processor = self.clone();
                let address = game.to_string();
                let delay = self.player_flush_debounce_ms;
                entry.timer = Some(tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                    let (key, trigger) = {
                        let mut buffers = processor.buffers.lock().unwrap();
                        let Some(entry) = buffers.get_mut(&address) else { return };
                        entry.timer = None;
                        (entry.last_game_key, entry.last_trigger.clone())
                    };
                    // The batch is named after its latest event, as an immediate flush is.
                    processor.flush_player_buffer(&address, trigger.as_deref().unwrap_or("debounce"), key);
                }));
            }
            flush_now.then_some(entry.last_game_key)
        };
        if let Some(key) = flush_now {
            self.flush_player_buffer_serialized(game, trigger, key).await;
        }
    }

    /// Queues a flush behind the game's pending mutations.
    fn flush_player_buffer(self: &Arc<Self>, game: &str, trigger: &str, game_key: Option<Address>) {
        {
            let mut buffers = self.buffers.lock().unwrap();
            match buffers.get(game) {
                None => return,
                Some(entry) if entry.operations.is_empty() && !entry.running && entry.timer.is_none() => {
                    buffers.remove(game);
                    return;
                }
                Some(_) => {}
            }
        }
        let processor = self.clone();
        let address = game.to_string();
        let trigger = trigger.to_string();
        self.enqueue(
            game,
            async move { processor.flush_player_buffer_serialized(&address, &trigger, game_key).await }.boxed(),
        );
    }

    fn flush_player_buffer_serialized<'a>(
        self: &'a Arc<Self>,
        game: &'a str,
        trigger: &'a str,
        game_key: Option<Address>,
    ) -> BoxFuture<'a, ()> {
        async move {
            let (operations, expected, key, trigger) = {
                let mut buffers = self.buffers.lock().unwrap();
                let Some(entry) = buffers.get_mut(game) else { return };
                cancel_timer(entry.timer.take());
                if entry.running {
                    return;
                }
                if entry.operations.is_empty() {
                    buffers.remove(game);
                    return;
                }
                entry.running = true;
                let operations = std::mem::take(&mut entry.operations);
                let expected = entry.expected_tickets.take();
                (operations, expected, game_key.or(entry.last_game_key), trigger.to_string())
            };

            match self.db.apply_player_mutations(game, &operations) {
                Ok(()) => {
                    let registry_trigger = if trigger == "joined" || trigger == "unjoined" {
                        format!("player {trigger}")
                    } else {
                        format!("player batch {trigger}")
                    };
                    self.evaluate_registry_consistency(game, expected, registry_trigger, key);
                    if let Some(flush) = self.schedule_auto_complete(game, key, Some(trigger.clone())) {
                        flush.await;
                    }
                }
                Err(error) => error!("Error in player batch flush event for {game}: {error:#}"),
            }

            let follow_up = {
                let mut buffers = self.buffers.lock().unwrap();
                let Some(entry) = buffers.get_mut(game) else { return };
                entry.running = false;
                if !entry.operations.is_empty() {
                    Some(entry.last_game_key)
                } else {
                    if entry.timer.is_none() {
                        buffers.remove(game);
                    }
                    None
                }
            };
            if let Some(key) = follow_up {
                self.flush_player_buffer_serialized(game, "followup", key).await;
            }
        }
        .boxed()
    }

    // -- auto-complete -------------------------------------------------------

    fn cancel_auto_complete(&self, game: &str) {
        if let Some(entry) = self.auto_completes.lock().unwrap().remove(game) {
            cancel_timer(entry.timer);
        }
    }

    /// Returns a future to await when the attempt should run immediately.
    fn schedule_auto_complete(
        self: &Arc<Self>,
        game: &str,
        game_key: Option<Address>,
        trigger: Option<String>,
    ) -> Option<BoxFuture<'static, ()>> {
        let mut states = self.auto_completes.lock().unwrap();
        let entry = states.entry(game.to_string()).or_default();
        entry.pending = true;
        entry.game_key = game_key.or(entry.game_key);
        entry.trigger = trigger.or(entry.trigger.take());
        if entry.running {
            return None;
        }
        let processor = self.clone();
        let address = game.to_string();
        if self.auto_complete_debounce_ms == 0 {
            return Some(async move { processor.flush_auto_complete(&address).await }.boxed());
        }
        if entry.timer.is_some() {
            return None;
        }
        let delay = self.auto_complete_debounce_ms;
        entry.timer = Some(tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            processor.flush_auto_complete(&address).await;
        }));
        None
    }

    async fn flush_auto_complete(self: &Arc<Self>, game: &str) {
        loop {
            let (game_key, trigger) = {
                let mut states = self.auto_completes.lock().unwrap();
                let Some(entry) = states.get_mut(game) else { return };
                cancel_timer(entry.timer.take());
                if !entry.pending || entry.running {
                    return;
                }
                entry.pending = false;
                entry.running = true;
                (entry.game_key, entry.trigger.clone().unwrap_or_else(|| "batch".into()))
            };
            if let Some(hooks) = self.hooks.upgrade() {
                // A panic must not leave `running` set, which would ignore every
                // later event for the game.
                let attempt = AssertUnwindSafe(hooks.try_auto_complete(game_key, game.to_string(), trigger));
                if attempt.catch_unwind().await.is_err() {
                    error!("Auto-complete for {game} panicked");
                }
            }
            let mut states = self.auto_completes.lock().unwrap();
            let Some(entry) = states.get_mut(game) else { return };
            entry.running = false;
            if !entry.pending {
                states.remove(game);
                return;
            }
        }
    }

    // -- registry reconciliation -------------------------------------------

    fn evaluate_registry_consistency(
        self: &Arc<Self>,
        game: &str,
        expected_tickets: Option<i64>,
        trigger: String,
        game_key: Option<Address>,
    ) {
        let stats = self.db.get_player_ticket_stats(game);
        let analysis = analyze_registry_state(
            RegistryStats { count: stats.count, max_index: stats.max_index, min_index: stats.min_index },
            expected_tickets,
        );
        if !analysis.needs_reconciliation {
            return;
        }
        self.schedule_registry_sync(RegistrySyncRequest {
            game_address: game.to_string(),
            expected_tickets: analysis.normalized_expected,
            trigger,
            game_key,
        });
    }

    pub fn schedule_registry_sync(self: &Arc<Self>, request: RegistrySyncRequest) {
        let game = request.game_address.clone();
        let mut entries = self.registry.lock().unwrap();
        let entry = entries.entry(game.clone()).or_insert_with(|| RegistryEntry {
            id: self.next_registry_id.fetch_add(1, Ordering::Relaxed),
            queue: VecDeque::new(),
            running: false,
            timer: None,
            retry_pending: None,
            failures: 0,
        });
        if let Some(pending) = entry.retry_pending.take() {
            entry.retry_pending = Some(merge_requests(pending, request));
            return;
        }
        match entry.queue.pop_back() {
            Some(last) => entry.queue.push_back(merge_requests(last, request)),
            None => entry.queue.push_back(request),
        }
        if entry.running {
            return;
        }
        entry.running = true;
        let (processor, id) = (self.clone(), entry.id);
        tokio::spawn(async move { processor.process_registry_queue(game, id).await });
    }

    pub fn has_pending_registry_sync(&self, game: &str) -> bool {
        self.registry.lock().unwrap().contains_key(game)
    }

    /// Drops queued and scheduled registry syncs for a finalized game.
    pub fn cancel_registry_sync(&self, game: &str) {
        if let Some(entry) = self.registry.lock().unwrap().remove(game) {
            cancel_timer(entry.timer);
        }
    }

    /// Drains the game's queue. The caller has already marked the entry as
    /// running; "queue empty" and "not running" flip under one lock so a request
    /// scheduled in between always finds a worker.
    fn process_registry_queue(self: Arc<Self>, game: String, id: u64) -> BoxFuture<'static, ()> {
        async move {
            loop {
                let next = {
                    let mut entries = self.registry.lock().unwrap();
                    let Some(entry) = entries.get_mut(&game).filter(|e| e.id == id) else { return };
                    match entry.queue.pop_front() {
                        Some(next) => next,
                        None => {
                            entry.running = false;
                            // A waiting retry always has its timer, so the request alone tells.
                            if entry.retry_pending.is_none() {
                                entries.remove(&game);
                            }
                            return;
                        }
                    }
                };
                let success = match self.hooks.upgrade() {
                    Some(hooks) => {
                        let sync = AssertUnwindSafe(hooks.sync_player_registry(next.clone())).catch_unwind();
                        let outcome = if self.registry_timeout_ms == 0 {
                            Ok(sync.await)
                        } else {
                            tokio::time::timeout(Duration::from_millis(self.registry_timeout_ms), sync).await
                        };
                        match outcome {
                            Ok(Ok(success)) => success,
                            Ok(Err(_)) => {
                                error!("Registry sync panicked for {game}");
                                false
                            }
                            Err(_) => {
                                warn!("Registry sync failed or timed out for {game}: Registry sync timeout");
                                false
                            }
                        }
                    }
                    None => false,
                };

                let mut entries = self.registry.lock().unwrap();
                let Some(entry) = entries.get_mut(&game).filter(|e| e.id == id) else { return };
                if success {
                    entry.failures = 0;
                    cancel_timer(entry.timer.take());
                    continue;
                }
                entry.failures += 1;
                if entry.failures >= MAX_REGISTRY_SYNC_FAILURES {
                    warn!(
                        "Giving up registry sync for {game} after {} failures; completion will reconcile it",
                        entry.failures
                    );
                    if let Some(entry) = entries.remove(&game) {
                        cancel_timer(entry.timer);
                    }
                    return;
                }
                entry.running = false;
                entry.retry_pending = Some(match entry.retry_pending.take() {
                    Some(pending) => merge_requests(pending, next),
                    None => next,
                });
                let processor = self.clone();
                let address = game.clone();
                let delay = self.registry_retry_delay_ms;
                entry.timer = Some(tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                    {
                        let mut entries = processor.registry.lock().unwrap();
                        let Some(current) = entries.get_mut(&address).filter(|e| e.id == id) else { return };
                        current.timer = None;
                        if let Some(pending) = current.retry_pending.take() {
                            current.queue.push_front(pending);
                        }
                        if current.running {
                            return;
                        }
                        current.running = true;
                    }
                    processor.process_registry_queue(address, id).await;
                }));
                return;
            }
        }
        .boxed()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GameStatus {
    Completed,
    Closed,
}

impl GameStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Closed => "closed",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::solana::pool::testing::FakeTransport;
    use crate::solana::pool::RpcPool;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use timba_protocol::ContractVersion;

    #[derive(Default)]
    struct RecordingHooks {
        auto_completes: Mutex<Vec<(String, String)>>,
        syncs: Mutex<Vec<RegistrySyncRequest>>,
        finalized: Mutex<Vec<String>>,
        fail_syncs: AtomicUsize,
        panic_syncs: AtomicUsize,
        hold_syncs: std::sync::atomic::AtomicBool,
        release: Arc<tokio::sync::Notify>,
        panic_auto_completes: AtomicUsize,
        hold_auto_completes: std::sync::atomic::AtomicBool,
        auto_release: Arc<tokio::sync::Notify>,
    }

    impl EventHooks for RecordingHooks {
        fn try_auto_complete(&self, _key: Option<Address>, game: String, trigger: String) -> BoxFuture<'static, ()> {
            self.auto_completes.lock().unwrap().push((game, trigger));
            if self.panic_auto_completes.try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1)).is_ok() {
                return async { panic!("simulated auto-complete bug") }.boxed();
            }
            let hold = self.hold_auto_completes.load(Ordering::SeqCst).then(|| self.auto_release.clone());
            async move {
                if let Some(release) = hold {
                    release.notified().await;
                }
            }
            .boxed()
        }
        fn sync_player_registry(&self, request: RegistrySyncRequest) -> BoxFuture<'static, bool> {
            self.syncs.lock().unwrap().push(request);
            if self.panic_syncs.try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1)).is_ok() {
                return async { panic!("simulated registry sync bug") }.boxed();
            }
            let fail = self.fail_syncs.try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1)).is_ok();
            let hold = self.hold_syncs.load(Ordering::SeqCst).then(|| self.release.clone());
            async move {
                if let Some(release) = hold {
                    release.notified().await;
                }
                !fail
            }
            .boxed()
        }
        fn on_game_finalized(&self, game: &str) {
            self.finalized.lock().unwrap().push(game.to_string());
        }
    }

    struct Harness {
        _dir: tempfile::TempDir,
        db: Arc<OracleDatabase>,
        hooks: Arc<RecordingHooks>,
        processor: Arc<EventProcessor>,
    }

    fn harness(player_flush_debounce_ms: u64) -> Harness {
        harness_with(Settings { player_flush_debounce_ms, ..Settings::default() })
    }

    struct Settings {
        player_flush_debounce_ms: u64,
        auto_complete_debounce_ms: u64,
        registry_sync_timeout_ms: u64,
        ws_endpoint: Option<String>,
    }

    impl Default for Settings {
        fn default() -> Self {
            Self {
                player_flush_debounce_ms: 0,
                auto_complete_debounce_ms: 0,
                registry_sync_timeout_ms: 1_000,
                ws_endpoint: None,
            }
        }
    }

    fn harness_with(settings: Settings) -> Harness {
        let Settings { player_flush_debounce_ms, auto_complete_debounce_ms, registry_sync_timeout_ms, ws_endpoint } =
            settings;
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(OracleDatabase::open(dir.path().join("o.sqlite").to_str().unwrap()).unwrap());
        let rpc = Arc::new(RpcPool::with_transport(&["https://a".into()], FakeTransport::new()).unwrap());
        let program = ProgramClient::new(rpc, ContractVersion::V0_2_0, ws_endpoint);
        let hooks = Arc::new(RecordingHooks::default());
        let weak: Weak<dyn EventHooks> = Arc::downgrade(&(hooks.clone() as Arc<dyn EventHooks>));
        let processor = EventProcessor::new(EventProcessorOptions {
            program,
            db: db.clone(),
            hooks: weak,
            events: ALL_EVENTS.to_vec(),
            player_flush_debounce_ms,
            player_flush_max_operations: 50,
            auto_complete_debounce_ms,
            registry_sync_retry_delay_ms: 10,
            registry_sync_timeout_ms,
        });
        Harness { _dir: dir, db, hooks, processor }
    }

    fn game() -> String {
        Address([7; 32]).to_base58()
    }

    fn join(game: &str, player: &str, ticket_index: u32, tickets_count: u32) -> PlayerMembershipEvent {
        PlayerMembershipEvent {
            kind: MembershipKind::Joined,
            game_key: game.into(),
            player: player.into(),
            tickets_count,
            ticket_index,
            moved_participant: None,
            timestamp: 0,
            signature: "sig".into(),
            slot: 1,
        }
    }

    async fn settle() {
        for _ in 0..20 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    #[tokio::test]
    async fn ignores_games_without_secrets() {
        let h = harness(0);
        h.processor.handle_player_event(join(&game(), "p1", 0, 1)).await;
        h.processor.handle_game_status_change(GameStatus::Completed, &game()).await;
        assert!(h.db.get_game_players(&game()).is_empty());
        assert!(h.hooks.auto_completes.lock().unwrap().is_empty());
        assert!(h.hooks.finalized.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn applies_joins_and_schedules_auto_complete() {
        let h = harness(0);
        h.db.save_secret_key(&game(), "secret", "hash").unwrap();
        h.db.track_game(&game(), None, true).unwrap();
        h.processor.handle_player_event(join(&game(), "p1", 0, 1)).await;
        h.processor.handle_player_event(join(&game(), "p2", 1, 2)).await;
        assert_eq!(h.db.get_game_players(&game()), vec!["p1".to_string(), "p2".to_string()]);
        let calls = h.hooks.auto_completes.lock().unwrap().clone();
        assert_eq!(calls, vec![(game(), "joined".to_string()), (game(), "joined".to_string())]);
        settle().await;
        assert!(h.hooks.syncs.lock().unwrap().is_empty());
        assert!(!h.processor.has_pending_registry_sync(&game()));
    }

    #[tokio::test]
    async fn status_events_do_not_hold_up_the_subscription() {
        let h = harness(0);
        h.db.save_secret_key(&game(), "secret", "hash").unwrap();
        h.db.track_game(&game(), None, true).unwrap();
        // Earlier work for the same game is still running.
        let release = Arc::new(tokio::sync::Notify::new());
        let gate = release.clone();
        let busy = h.processor.enqueue_event_mutation("busy".into(), &game(), async move {
            gate.notified().await;
            Ok(())
        });
        let completed = GameCompletedEvent {
            game_key: game(),
            winner: "w".into(),
            tickets_count: 2,
            winner_amount: 1,
            fee_amount: 0,
            timestamp: 0,
            signature: "sig".into(),
            slot: 1,
        };
        tokio::time::timeout(
            Duration::from_secs(1),
            h.processor.handle_dispatch(ProgramDispatch::GameCompleted(completed)),
        )
        .await
        .expect("the reader moves on while the status change is queued");
        assert_eq!(h.db.get_game_status(&game()).as_deref(), Some("pending"), "still queued behind the busy job");
        release.notify_one();
        busy.await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while h.db.get_game_status(&game()).as_deref() != Some("completed") {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the status change runs after the earlier job");
    }

    #[tokio::test]
    async fn debounced_joins_flush_before_status_change() {
        let h = harness(60_000);
        h.db.save_secret_key(&game(), "secret", "hash").unwrap();
        h.db.track_game(&game(), None, true).unwrap();
        h.processor.handle_player_event(join(&game(), "p1", 0, 1)).await;
        assert!(h.db.get_game_players(&game()).is_empty());
        h.processor.handle_game_status_change(GameStatus::Completed, &game()).await;
        assert_eq!(h.db.get_game_players(&game()), vec!["p1".to_string()]);
        assert_eq!(h.db.get_game_status(&game()).as_deref(), Some("completed"));
        assert_eq!(h.hooks.finalized.lock().unwrap().clone(), vec![game()]);
        let calls = h.hooks.auto_completes.lock().unwrap().clone();
        assert_eq!(calls, vec![(game(), "game completed".to_string())]);
    }

    #[tokio::test]
    async fn retries_failed_registry_syncs() {
        let h = harness(0);
        h.db.save_secret_key(&game(), "secret", "hash").unwrap();
        h.db.track_game(&game(), None, true).unwrap();
        h.hooks.fail_syncs.store(1, Ordering::SeqCst);
        // Ticket count 3 with one known player needs reconciliation.
        h.processor.handle_player_event(join(&game(), "p1", 0, 3)).await;
        settle().await;
        let syncs = h.hooks.syncs.lock().unwrap().clone();
        assert_eq!(syncs.len(), 2);
        assert_eq!(syncs[0].expected_tickets, Some(3));
        assert_eq!(syncs[0].trigger, "player joined");
        assert_eq!(syncs[1], syncs[0]);
        assert!(!h.processor.has_pending_registry_sync(&game()));
    }

    #[tokio::test]
    async fn game_initialized_tracks_type() {
        let h = harness(0);
        h.db.save_secret_key(&game(), "secret", "hash").unwrap();
        h.processor.handle_game_initialized(&GameInitializedEvent {
            game_key: game(),
            creator: "c".into(),
            game_type: "Bet".into(),
            ticket_amount: 1,
            total_amount: 1,
            max_tickets: 2,
            min_tickets: 2,
            token_mint: "m".into(),
            is_private: false,
            created_at: 0,
            timeout: 0,
            signature: "s".into(),
            slot: 1,
        });
        assert_eq!(h.db.get_game_status(&game()).as_deref(), Some("pending"));
        assert!(h.db.get_game_type(&game()).is_some());
    }

    fn sync_request(game: &str, trigger: &str) -> RegistrySyncRequest {
        RegistrySyncRequest {
            game_address: game.into(),
            expected_tickets: Some(3),
            trigger: trigger.into(),
            game_key: None,
        }
    }

    async fn wait_until(mut done: impl FnMut() -> bool) {
        for _ in 0..400 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("condition not reached");
    }

    #[tokio::test]
    async fn gives_up_after_repeated_registry_sync_failures() {
        let h = harness(0);
        h.hooks.fail_syncs.store(usize::MAX, Ordering::SeqCst);
        h.processor.schedule_registry_sync(sync_request(&game(), "player joined"));
        wait_until(|| !h.processor.has_pending_registry_sync(&game())).await;
        settle().await;
        assert_eq!(h.hooks.syncs.lock().unwrap().len(), MAX_REGISTRY_SYNC_FAILURES as usize);
    }

    #[tokio::test]
    async fn a_panicking_registry_sync_is_retried() {
        let h = harness(0);
        h.hooks.panic_syncs.store(1, Ordering::SeqCst);
        h.processor.schedule_registry_sync(sync_request(&game(), "player joined"));
        wait_until(|| !h.processor.has_pending_registry_sync(&game())).await;
        assert_eq!(h.hooks.syncs.lock().unwrap().len(), 2, "the panic counts as a failure and is retried");
    }

    #[tokio::test]
    async fn cancelling_drops_scheduled_retries() {
        let h = harness(0);
        h.hooks.fail_syncs.store(usize::MAX, Ordering::SeqCst);
        h.processor.schedule_registry_sync(sync_request(&game(), "player joined"));
        wait_until(|| !h.hooks.syncs.lock().unwrap().is_empty()).await;
        h.processor.cancel_registry_sync(&game());
        assert!(!h.processor.has_pending_registry_sync(&game()));
        let calls = h.hooks.syncs.lock().unwrap().len();
        settle().await;
        assert_eq!(h.hooks.syncs.lock().unwrap().len(), calls, "no retry after cancel");
        h.processor.cancel_registry_sync(&game());
    }

    #[tokio::test]
    async fn requests_during_a_running_sync_are_merged_and_run_next() {
        let h = harness(0);
        h.hooks.hold_syncs.store(true, Ordering::SeqCst);
        h.processor.schedule_registry_sync(sync_request(&game(), "first"));
        wait_until(|| h.hooks.syncs.lock().unwrap().len() == 1).await;
        h.processor.schedule_registry_sync(sync_request(&game(), "second"));
        h.processor.schedule_registry_sync(sync_request(&game(), "third"));
        h.hooks.hold_syncs.store(false, Ordering::SeqCst);
        h.hooks.release.notify_one();
        wait_until(|| !h.processor.has_pending_registry_sync(&game())).await;
        let triggers: Vec<String> = h.hooks.syncs.lock().unwrap().iter().map(|r| r.trigger.clone()).collect();
        assert_eq!(triggers, vec!["first".to_string(), "third".to_string()]);
    }

    #[tokio::test]
    async fn a_loop_from_a_cleared_entry_leaves_the_new_entry_alone() {
        let h = harness(0);
        h.hooks.hold_syncs.store(true, Ordering::SeqCst);
        h.processor.schedule_registry_sync(sync_request(&game(), "old"));
        wait_until(|| h.hooks.syncs.lock().unwrap().len() == 1).await;
        // RPC failover clears every sync while the old one is still in flight.
        h.processor.clear_registry_syncs();
        h.processor.schedule_registry_sync(sync_request(&game(), "new"));
        wait_until(|| h.hooks.syncs.lock().unwrap().len() == 2).await;
        h.hooks.hold_syncs.store(false, Ordering::SeqCst);
        h.hooks.release.notify_waiters();
        wait_until(|| !h.processor.has_pending_registry_sync(&game())).await;
        settle().await;
        let triggers: Vec<String> = h.hooks.syncs.lock().unwrap().iter().map(|r| r.trigger.clone()).collect();
        assert_eq!(triggers, vec!["old".to_string(), "new".to_string()], "each request ran exactly once");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_requests_are_never_stranded() {
        for round in 0..50 {
            let h = harness(0);
            let game = Address([round as u8; 32]).to_base58();
            let threads: Vec<_> = (0..4)
                .map(|i| {
                    let (processor, game) = (h.processor.clone(), game.clone());
                    let runtime = tokio::runtime::Handle::current();
                    std::thread::spawn(move || {
                        let _enter = runtime.enter();
                        for j in 0..10 {
                            processor.schedule_registry_sync(sync_request(&game, &format!("{i}-{j}")));
                        }
                    })
                })
                .collect();
            threads.into_iter().for_each(|t| t.join().unwrap());
            wait_until(|| !h.processor.has_pending_registry_sync(&game)).await;
        }
    }

    fn tracked(h: &Harness) -> String {
        h.db.save_secret_key(&game(), "secret", "hash").unwrap();
        h.db.track_game(&game(), None, true).unwrap();
        game()
    }

    /// Makes every `operation` (INSERT/UPDATE) on `table` fail from now on.
    fn break_writes(h: &Harness, table: &str, operation: &str) {
        let conn = rusqlite::Connection::open(h._dir.path().join("o.sqlite")).unwrap();
        conn.execute_batch(&format!(
            "CREATE TRIGGER fail_{operation}_{table} BEFORE {operation} ON {table} BEGIN SELECT RAISE(ABORT, 'disk full'); END;"
        ))
        .unwrap();
    }

    fn unjoin(game: &str, ticket_index: u32, moved: Option<&str>) -> PlayerMembershipEvent {
        PlayerMembershipEvent {
            kind: MembershipKind::Unjoined,
            moved_participant: moved.map(str::to_string),
            ..join(game, "gone", ticket_index, 1)
        }
    }

    fn initialized(game: &str) -> GameInitializedEvent {
        GameInitializedEvent {
            game_key: game.into(),
            creator: "c".into(),
            game_type: "Bet".into(),
            ticket_amount: 1,
            total_amount: 1,
            max_tickets: 2,
            min_tickets: 2,
            token_mint: "m".into(),
            is_private: false,
            created_at: 0,
            timeout: 0,
            signature: "s".into(),
            slot: 1,
        }
    }

    #[tokio::test]
    async fn listens_through_the_program_client_and_notifies_observers() {
        let h =
            harness_with(Settings { ws_endpoint: Some(crate::core::testing::ws_node().await), ..Settings::default() });
        let game = tracked(&h);
        let seen = Arc::new(AtomicUsize::new(0));
        let counter = seen.clone();
        h.processor.add_program_event_observer(Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        }));
        let broken = h.processor.add_program_event_observer(Arc::new(|| panic!("observer bug")));

        h.processor.start_listening().await.unwrap();
        h.processor.start_listening().await.unwrap();
        assert_eq!(h.processor.program.listener_count(), ALL_EVENTS.len(), "registered once");

        let program = h.processor.program.clone();
        program.dispatch(ProgramDispatch::PlayerMembership(join(&game, "p1", 0, 2))).await;
        program.dispatch(ProgramDispatch::PlayerMembership(join(&game, "p2", 1, 2))).await;
        assert_eq!(h.db.get_game_players(&game), vec!["p1".to_string(), "p2".to_string()]);
        program.dispatch(ProgramDispatch::PlayerMembership(unjoin(&game, 0, Some("p2")))).await;
        assert_eq!(h.db.get_game_players(&game), vec!["p2".to_string()], "the last player moved into the gap");
        program.dispatch(ProgramDispatch::GameInitialized(initialized(&game))).await;
        assert_eq!(seen.load(Ordering::SeqCst), 4, "a panicking observer does not stop the others");

        h.processor.remove_program_event_observer(broken);
        let closed =
            GameClosedEvent { game_key: game.clone(), timestamp: 1, operator: false, signature: "c".into(), slot: 2 };
        program.dispatch(ProgramDispatch::GameClosed(closed)).await;
        wait_until(|| h.db.get_game_status(&game).as_deref() == Some("cancelled")).await;
        assert!(h.db.get_game_players(&game).is_empty(), "closing clears the stale players");
        assert_eq!(h.hooks.finalized.lock().unwrap().clone(), vec![game.clone()]);
        assert_eq!(seen.load(Ordering::SeqCst), 5);

        h.processor.stop_listening().await;
        h.processor.stop_listening().await;
        assert_eq!(program.listener_count(), 0);
    }

    #[tokio::test]
    async fn stopping_cancels_buffered_joins_and_debounced_auto_completes() {
        let h = harness_with(Settings {
            player_flush_debounce_ms: 60_000,
            auto_complete_debounce_ms: 60_000,
            ws_endpoint: Some(crate::core::testing::ws_node().await),
            ..Settings::default()
        });
        let game = tracked(&h);
        h.processor.start_listening().await.unwrap();
        h.processor.handle_player_event(join(&game, "p1", 0, 2)).await;
        let other = Address([8; 32]).to_base58();
        assert!(h.processor.schedule_auto_complete(&other, None, Some("joined".into())).is_none());
        assert!(h.processor.buffers.lock().unwrap().contains_key(&game));
        assert!(h.processor.auto_completes.lock().unwrap().contains_key(&other));

        h.processor.stop_listening().await;
        assert!(h.processor.buffers.lock().unwrap().is_empty());
        assert!(h.processor.auto_completes.lock().unwrap().is_empty());
        assert!(h.db.get_game_players(&game).is_empty(), "the buffered join was dropped, not flushed");
        assert!(h.hooks.auto_completes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn events_after_the_processor_is_dropped_are_ignored() {
        let h =
            harness_with(Settings { ws_endpoint: Some(crate::core::testing::ws_node().await), ..Settings::default() });
        let game = tracked(&h);
        h.processor.start_listening().await.unwrap();
        let Harness { processor, db, hooks, _dir } = h;
        let program = processor.program.clone();
        drop(processor);
        program.dispatch(ProgramDispatch::PlayerMembership(join(&game, "p1", 0, 2))).await;
        assert!(db.get_game_players(&game).is_empty());
        assert!(hooks.auto_completes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn auto_completes_after_the_service_is_gone_only_clear_their_state() {
        let Harness { processor, hooks, _dir, db: _db } = harness(0);
        drop(hooks);
        let attempt = processor.schedule_auto_complete(&game(), None, Some("joined".into())).unwrap();
        attempt.await;
        assert!(!processor.auto_completes.lock().unwrap().contains_key(&game()));
    }

    #[tokio::test]
    async fn a_failed_subscription_registers_no_listeners() {
        let refused = format!("ws://{}", std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap());
        let h = harness_with(Settings { ws_endpoint: Some(refused), ..Settings::default() });
        assert!(h.processor.start_listening().await.is_err());
        assert_eq!(h.processor.program.listener_count(), 0);
        assert!(!h.processor.is_listening());
    }

    #[tokio::test]
    async fn ignores_invalid_addresses_and_unknown_games() {
        let h = harness(0);
        h.processor.handle_player_event(join("not-an-address", "p1", 0, 1)).await;
        h.processor.handle_game_status_change(GameStatus::Completed, "not-an-address").await;
        h.processor.handle_game_initialized(&initialized("not-an-address"));
        h.processor.handle_game_initialized(&initialized(&game()));
        assert_eq!(h.db.get_game_status(&game()), None, "no tracking row without a secret");
        assert!(h.hooks.auto_completes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn database_failures_are_logged_without_stopping_later_events() {
        let h = harness(0);
        h.db.save_secret_key(&game(), "secret", "hash").unwrap();
        break_writes(&h, "secret_keys", "UPDATE");
        h.processor.handle_game_initialized(&initialized(&game()));
        assert_eq!(h.db.get_game_status(&game()), None, "stops before tracking");

        let h = harness(0);
        h.db.save_secret_key(&game(), "secret", "hash").unwrap();
        break_writes(&h, "game_tracking", "INSERT");
        h.processor.handle_game_initialized(&initialized(&game()));
        assert_eq!(h.db.get_game_status(&game()), None);

        let h = harness(0);
        let game = tracked(&h);
        break_writes(&h, "game_players", "INSERT");
        h.processor.handle_player_event(join(&game, "p1", 0, 1)).await;
        assert!(h.db.get_game_players(&game).is_empty());
        assert!(h.hooks.auto_completes.lock().unwrap().is_empty(), "nothing to complete after a failed write");
        break_writes(&h, "game_tracking", "UPDATE");
        h.processor.handle_game_status_change(GameStatus::Completed, &game).await;
        assert_eq!(h.db.get_game_status(&game).as_deref(), Some("pending"));
        assert!(h.hooks.finalized.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn debounced_joins_flush_on_their_timer() {
        let h = harness(20);
        let game = tracked(&h);
        h.processor.handle_player_event(join(&game, "p1", 0, 2)).await;
        h.processor.handle_player_event(join(&game, "p2", 1, 2)).await;
        assert!(h.db.get_game_players(&game).is_empty(), "buffered");
        wait_until(|| h.db.get_game_players(&game).len() == 2).await;
        let calls = h.hooks.auto_completes.lock().unwrap().clone();
        assert_eq!(calls, vec![(game.clone(), "joined".to_string())], "one attempt for the batch");
        wait_until(|| !h.processor.buffers.lock().unwrap().contains_key(&game)).await;
    }

    #[tokio::test]
    async fn player_buffer_guards() {
        let h = harness(0);
        let game = tracked(&h);
        // Nothing buffered: nothing to queue.
        h.processor.flush_player_buffer(&game, "debounce", None);
        h.processor.buffers.lock().unwrap().insert(game.clone(), PlayerBuffer::default());
        h.processor.flush_player_buffer(&game, "debounce", None);
        assert!(!h.processor.buffers.lock().unwrap().contains_key(&game), "an idle empty buffer is dropped");

        h.processor.buffers.lock().unwrap().insert(game.clone(), PlayerBuffer { running: true, ..Default::default() });
        h.processor.flush_player_buffer_serialized(&game, "status", None).await;
        assert!(h.processor.buffers.lock().unwrap().contains_key(&game), "a running flush is left alone");
        h.processor.buffers.lock().unwrap().insert(game.clone(), PlayerBuffer::default());
        h.processor.flush_player_buffer_serialized(&game, "status", None).await;
        assert!(!h.processor.buffers.lock().unwrap().contains_key(&game));

        h.processor.buffers.lock().unwrap().insert(
            game.clone(),
            PlayerBuffer { timer: Some(tokio::spawn(std::future::pending())), ..Default::default() },
        );
        h.processor.flush_player_buffer(&game, "debounce", None);
        wait_until(|| !h.processor.buffers.lock().unwrap().contains_key(&game)).await;
    }

    #[tokio::test]
    async fn joins_buffered_during_a_flush_are_flushed_next() {
        let h = harness(0);
        let game = tracked(&h);
        h.hooks.hold_auto_completes.store(true, Ordering::SeqCst);
        let processor = h.processor.clone();
        let first = tokio::spawn({
            let game = game.clone();
            async move { processor.handle_player_event(join(&game, "p1", 0, 2)).await }
        });
        wait_until(|| h.hooks.auto_completes.lock().unwrap().len() == 1).await;
        // The flush is waiting on auto-complete; a join lands in its buffer meanwhile.
        h.processor
            .buffers
            .lock()
            .unwrap()
            .get_mut(&game)
            .unwrap()
            .operations
            .push(PlayerMutation::Joined { player_address: "p2".into(), ticket_index: 1 });
        h.hooks.hold_auto_completes.store(false, Ordering::SeqCst);
        h.hooks.auto_release.notify_one();
        first.await.unwrap();
        assert_eq!(h.db.get_game_players(&game), vec!["p1".to_string(), "p2".to_string()]);
        assert!(!h.processor.buffers.lock().unwrap().contains_key(&game));
    }

    #[tokio::test]
    async fn debounced_auto_completes_coalesce_and_finalizing_cancels_them() {
        let h = harness_with(Settings { auto_complete_debounce_ms: 20, ..Settings::default() });
        let game = tracked(&h);
        h.processor.handle_player_event(join(&game, "p1", 0, 2)).await;
        h.processor.handle_player_event(join(&game, "p2", 1, 2)).await;
        assert!(h.hooks.auto_completes.lock().unwrap().is_empty(), "waiting for the debounce");
        wait_until(|| !h.hooks.auto_completes.lock().unwrap().is_empty()).await;
        settle().await;
        assert_eq!(h.hooks.auto_completes.lock().unwrap().len(), 1);

        let h = harness_with(Settings { auto_complete_debounce_ms: 60_000, ..Settings::default() });
        let game = tracked(&h);
        h.processor.handle_player_event(join(&game, "p1", 0, 2)).await;
        assert!(h.processor.auto_completes.lock().unwrap().contains_key(&game));
        h.processor.handle_game_status_change(GameStatus::Completed, &game).await;
        assert!(!h.processor.auto_completes.lock().unwrap().contains_key(&game), "the timer is cancelled");
        assert!(h.hooks.auto_completes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn auto_complete_reruns_when_asked_again_and_survives_a_panic() {
        let h = harness(0);
        let game = tracked(&h);
        h.hooks.panic_auto_completes.store(1, Ordering::SeqCst);
        h.processor.handle_player_event(join(&game, "p1", 0, 2)).await;
        assert!(!h.processor.auto_completes.lock().unwrap().contains_key(&game), "a panic clears the running flag");

        h.hooks.hold_auto_completes.store(true, Ordering::SeqCst);
        let processor = h.processor.clone();
        let running = tokio::spawn({
            let game = game.clone();
            async move { processor.handle_player_event(join(&game, "p2", 1, 2)).await }
        });
        wait_until(|| h.hooks.auto_completes.lock().unwrap().len() == 2).await;
        // Another trigger while the attempt runs only marks it pending.
        assert!(h.processor.schedule_auto_complete(&game, None, Some("again".into())).is_none());
        h.hooks.hold_auto_completes.store(false, Ordering::SeqCst);
        h.hooks.auto_release.notify_one();
        running.await.unwrap();
        let triggers: Vec<String> = h.hooks.auto_completes.lock().unwrap().iter().map(|(_, t)| t.clone()).collect();
        assert_eq!(triggers, vec!["joined", "joined", "again"]);

        // A flush with nothing pending does nothing.
        h.processor.auto_completes.lock().unwrap().insert(game.clone(), AutoCompleteState::default());
        h.processor.flush_auto_complete(&game).await;
        assert_eq!(h.hooks.auto_completes.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn requests_during_a_retry_wait_join_the_retry() {
        let h = harness(0);
        h.hooks.fail_syncs.store(1, Ordering::SeqCst);
        h.processor.schedule_registry_sync(sync_request(&game(), "first"));
        wait_until(|| h.processor.registry.lock().unwrap().get(&game()).is_some_and(|e| e.retry_pending.is_some()))
            .await;
        h.processor.schedule_registry_sync(sync_request(&game(), "second"));
        wait_until(|| !h.processor.has_pending_registry_sync(&game())).await;
        let triggers: Vec<String> = h.hooks.syncs.lock().unwrap().iter().map(|r| r.trigger.clone()).collect();
        assert_eq!(triggers, vec!["first".to_string(), "second".to_string()], "merged into one retry");
    }

    #[tokio::test]
    async fn registry_syncs_time_out_or_run_unbounded() {
        let h = harness_with(Settings { registry_sync_timeout_ms: 20, ..Settings::default() });
        h.hooks.hold_syncs.store(true, Ordering::SeqCst);
        h.processor.schedule_registry_sync(sync_request(&game(), "slow"));
        wait_until(|| h.hooks.syncs.lock().unwrap().len() >= 2).await;
        h.processor.cancel_registry_sync(&game());

        let h = harness_with(Settings { registry_sync_timeout_ms: 0, ..Settings::default() });
        h.processor.schedule_registry_sync(sync_request(&game(), "unbounded"));
        wait_until(|| !h.processor.has_pending_registry_sync(&game())).await;
        assert_eq!(h.hooks.syncs.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn registry_syncs_fail_once_the_service_is_gone() {
        let h = harness(0);
        let Harness { processor, hooks, _dir, db: _db } = h;
        drop(hooks);
        processor.schedule_registry_sync(sync_request(&game(), "orphan"));
        wait_until(|| processor.registry.lock().unwrap().get(&game()).is_some_and(|e| e.failures > 0)).await;
        processor.cancel_registry_sync(&game());
    }

    #[tokio::test]
    async fn registry_guards_keep_one_worker_per_game() {
        let h = harness(0);
        h.hooks.fail_syncs.store(1, Ordering::SeqCst);
        h.hooks.hold_syncs.store(true, Ordering::SeqCst);
        h.processor.schedule_registry_sync(sync_request(&game(), "first"));
        wait_until(|| h.hooks.syncs.lock().unwrap().len() == 1).await;
        // A retry is already waiting when this attempt fails: both are merged.
        h.processor.registry.lock().unwrap().get_mut(&game()).unwrap().retry_pending =
            Some(sync_request(&game(), "waiting"));
        h.hooks.hold_syncs.store(false, Ordering::SeqCst);
        h.hooks.release.notify_one();
        wait_until(|| h.processor.registry.lock().unwrap().get(&game()).is_some_and(|e| e.timer.is_some())).await;
        let retry = h.processor.registry.lock().unwrap().get(&game()).unwrap().retry_pending.clone().unwrap();
        assert_eq!(retry.trigger, "first", "the newer request wins the merge");
        // A worker started meanwhile: the timer hands it the retry instead of starting another.
        h.processor.registry.lock().unwrap().get_mut(&game()).unwrap().running = true;
        wait_until(|| h.processor.registry.lock().unwrap().get(&game()).is_some_and(|e| e.retry_pending.is_none()))
            .await;
        let entry_queue = h.processor.registry.lock().unwrap().get(&game()).unwrap().queue.len();
        assert_eq!(entry_queue, 1, "queued for the running worker");
        assert_eq!(h.hooks.syncs.lock().unwrap().len(), 1, "no second worker ran it");
        h.processor.cancel_registry_sync(&game());
    }

    #[test]
    fn a_queue_outlives_a_dropped_runtime() {
        let h = {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            let h = runtime.block_on(async { harness(0) });
            runtime.block_on(async {
                h.processor.enqueue(&game(), std::future::pending().boxed());
                tokio::task::yield_now().await;
            });
            h
        };
        // The worker went down with its runtime but is still registered.
        assert!(h.processor.queues.lock().unwrap().contains_key(&game()));
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            let (done, ran) = oneshot::channel();
            h.processor.enqueue(
                &game(),
                async move {
                    let _ = done.send(());
                }
                .boxed(),
            );
            tokio::time::timeout(Duration::from_secs(1), ran).await.unwrap().unwrap();
            h.processor.enqueue(&game(), async { panic!("handler bug") }.boxed());
            wait_until(|| !h.processor.queues.lock().unwrap().contains_key(&game())).await;
        });
    }
}
