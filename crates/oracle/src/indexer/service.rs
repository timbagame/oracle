//! Public indexer loop (port of `indexer/service.ts`): polls program history
//! into the indexer database, wakes early on live events, reconciles active
//! games against chain state and flushes throttled cache rebuilds.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use timba_common::shutdown::Shutdown;
use timba_common::{error, info, warn};
use timba_protocol::address::Address;
use tokio::sync::Notify;

use super::database::{Clock, IndexerDatabase};
use super::schema::js_string;
use super::solana::{find_stale_active_games, get_events_since, get_program_head};
use crate::solana::pool::RpcPool;

pub const DEFAULT_EVENT_DEBOUNCE_MS: u64 = 1_000;

/// Waits until the next reconciliation, or sooner when a cache flush is pending.
pub fn next_wait_ms(until_reconcile_ms: i64, cache_flush_in_ms: Option<i64>) -> i64 {
    let reconcile = until_reconcile_ms.max(0);
    match cache_flush_in_ms {
        None => reconcile,
        Some(flush) => reconcile.min(flush.max(0)),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RunOnceResult {
    pub indexed: usize,
    pub transactions: usize,
    pub cache_flush_in_ms: Option<i64>,
}

pub struct PublicIndexer {
    database: Arc<IndexerDatabase>,
    rpc: Arc<RpcPool>,
    program_id: Address,
    poll_interval_ms: u64,
    event_debounce_ms: u64,
    now: Clock,
    running: AtomicBool,
    wake_requested: AtomicBool,
    wake: Notify,
}

impl PublicIndexer {
    pub fn new(db: Arc<IndexerDatabase>, rpc: Arc<RpcPool>, program_id: Address, poll_interval_ms: u64) -> Self {
        Self {
            database: db,
            rpc,
            program_id,
            poll_interval_ms,
            event_debounce_ms: DEFAULT_EVENT_DEBOUNCE_MS,
            now: Arc::new(timba_common::time::now_ms),
            running: AtomicBool::new(false),
            wake_requested: AtomicBool::new(false),
            wake: Notify::new(),
        }
    }

    pub fn with_event_debounce_ms(mut self, ms: u64) -> Self {
        self.event_debounce_ms = ms;
        self
    }

    pub fn with_clock(mut self, now: Clock) -> Self {
        self.now = now;
        self
    }

    pub fn database(&self) -> &Arc<IndexerDatabase> {
        &self.database
    }

    pub async fn run_once(&self, reconcile_active_games: bool) -> Result<RunOnceResult> {
        let Some(cursor) = self.database.get_cursor()? else {
            if let Some(head) = get_program_head(&self.rpc, &self.program_id).await? {
                self.database.set_cursor(&head)?;
            }
            warn!("Indexer cursor initialized at the current program head; import the D1 export before cutover to retain history.");
            if reconcile_active_games {
                self.safely_reconcile_active_games().await;
            }
            return Ok(RunOnceResult::default());
        };

        let result = get_events_since(&self.rpc, &self.program_id, &cursor).await?;
        let indexed = match &result.cursor {
            Some(next) => self.database.apply(&result.events, next)?,
            None => 0,
        };
        if reconcile_active_games {
            self.safely_reconcile_active_games().await;
        }
        // Cache rebuilds are throttled; flush any rebuild that became due while
        // idle so stats never lag the indexed data by more than the throttle window.
        self.database.flush_caches(false)?;
        Ok(RunOnceResult {
            indexed,
            transactions: result.transactions,
            cache_flush_in_ms: self.database.ms_until_cache_flush(),
        })
    }

    pub async fn run(&self, shutdown: Shutdown) -> Result<()> {
        self.run_loop(&shutdown, |reconcile| self.run_once(reconcile)).await;
        Ok(())
    }

    /// The scheduling loop with the cycle injected (tests replace `run_once`).
    pub(crate) async fn run_loop<F, Fut>(&self, shutdown: &Shutdown, mut cycle: F)
    where
        F: FnMut(bool) -> Fut,
        Fut: Future<Output = Result<RunOnceResult>>,
    {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut next_reconciliation_at = 0i64;
        while !shutdown.is_triggered() {
            let should_reconcile = (self.now)() >= next_reconciliation_at;
            let mut completed = false;
            let mut cache_flush_in_ms = None;
            match cycle(should_reconcile).await {
                Ok(result) => {
                    completed = true;
                    cache_flush_in_ms = result.cache_flush_in_ms;
                    if should_reconcile {
                        next_reconciliation_at = (self.now)() + self.poll_interval_ms as i64;
                    }
                    if result.transactions > 0 {
                        info!(
                            "Public indexer processed {} transactions and {} game changes.",
                            result.transactions, result.indexed
                        );
                    }
                }
                Err(e) => error!("Public indexer cycle failed; cursor was not advanced: {e:#}"),
            }
            let wait_ms = if completed {
                next_wait_ms(next_reconciliation_at - (self.now)(), cache_flush_in_ms) as u64
            } else {
                self.poll_interval_ms
            };
            self.wait_for_next_cycle(shutdown, wait_ms).await;
        }
        self.running.store(false, Ordering::SeqCst);
    }

    /// Wakes the loop for a catch-up cycle (coalesced over the debounce window).
    pub fn request_catch_up(&self) {
        self.wake_requested.store(true, Ordering::SeqCst);
        self.wake.notify_one();
    }

    async fn wait_for_next_cycle(&self, shutdown: &Shutdown, interval_ms: u64) {
        if shutdown.is_triggered() {
            return;
        }
        let event = async {
            while !self.wake_requested.load(Ordering::SeqCst) {
                self.wake.notified().await;
            }
            if self.event_debounce_ms > 0 {
                tokio::time::sleep(Duration::from_millis(self.event_debounce_ms)).await;
            }
        };
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(interval_ms)) => {}
            _ = event => {}
            _ = shutdown.wait() => {}
        }
        self.wake_requested.store(false, Ordering::SeqCst);
    }

    async fn reconcile_active_games(&self) -> Result<()> {
        let games = self.database.get_active_games(None)?;
        if games.is_empty() {
            return Ok(());
        }
        // `String(game.game_key)`: the column is always selected, and a key that is not an
        // address is reported as stale like any other.
        let keys: Vec<String> = games
            .iter()
            .map(|game| {
                js_string(game.get("game_key").unwrap_or(&serde_json::Value::Null))
                    .as_str()
                    .unwrap_or_default()
                    .to_string()
            })
            .collect();
        let stale = find_stale_active_games(&self.rpc, &self.program_id, &keys).await?;
        self.database.remove_stale_active_games(&stale)
    }

    async fn safely_reconcile_active_games(&self) {
        if let Err(e) = self.reconcile_active_games().await {
            warn!("Public indexer active-game reconciliation failed: {e:#}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::indexer::database::IndexerDatabaseOptions;
    use crate::indexer::types::{GameInitializedEvent, IndexedEvents, IndexerCursor};
    use crate::solana::pool::testing::FakeTransport;
    use base64::Engine;
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicI64, AtomicUsize};
    use std::sync::Mutex;
    use std::time::Instant;
    use timba_protocol::contracts::discriminators::GAME_ACCOUNT;

    fn indexer(poll_interval_ms: u64, debounce_ms: u64) -> Arc<PublicIndexer> {
        let transport = FakeTransport::new();
        let rpc = Arc::new(RpcPool::with_transport(&["https://rpc".into()], transport).unwrap());
        let db = Arc::new(IndexerDatabase::open(":memory:").unwrap());
        Arc::new(
            PublicIndexer::new(db, rpc, Address::new([1; 32]), poll_interval_ms).with_event_debounce_ms(debounce_ms),
        )
    }

    async fn wait_until(condition: impl Fn() -> bool) {
        for _ in 0..500 {
            if condition() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        panic!("condition not reached");
    }

    #[test]
    fn waits_for_the_sooner_of_reconciliation_and_cache_flush() {
        assert_eq!(next_wait_ms(60_000, None), 60_000);
        assert_eq!(next_wait_ms(60_000, Some(5_000)), 5_000);
        assert_eq!(next_wait_ms(1_000, Some(5_000)), 1_000);
        assert_eq!(next_wait_ms(-10, None), 0);
        assert_eq!(next_wait_ms(1_000, Some(-5)), 0);
    }

    #[tokio::test]
    async fn runs_one_coalesced_catch_up_when_live_events_wake_it() {
        let indexer = indexer(60_000, 0);
        let shutdown = Shutdown::new();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let running = {
            let (indexer, shutdown, calls) = (indexer.clone(), shutdown.clone(), calls.clone());
            tokio::spawn(async move {
                indexer
                    .run_loop(&shutdown, |reconcile| {
                        let mut calls = calls.lock().unwrap();
                        calls.push(reconcile);
                        if calls.len() == 2 {
                            shutdown.trigger();
                        }
                        async { Ok(RunOnceResult::default()) }
                    })
                    .await
            })
        };
        wait_until(|| calls.lock().unwrap().len() == 1).await;
        indexer.request_catch_up();
        indexer.request_catch_up();
        tokio::time::timeout(Duration::from_secs(5), running).await.unwrap().unwrap();
        assert_eq!(*calls.lock().unwrap(), vec![true, false]);
    }

    #[tokio::test]
    async fn retains_periodic_catch_up_as_a_recovery_path() {
        let indexer = indexer(5, 0);
        let shutdown = Shutdown::new();
        let calls = Arc::new(Mutex::new(Vec::new()));
        tokio::time::timeout(
            Duration::from_secs(5),
            indexer.run_loop(&shutdown, |reconcile| {
                let mut calls = calls.lock().unwrap();
                calls.push(reconcile);
                if calls.len() == 2 {
                    shutdown.trigger();
                }
                async { Ok(RunOnceResult::default()) }
            }),
        )
        .await
        .unwrap();
        assert_eq!(*calls.lock().unwrap(), vec![true, true]);
    }

    #[tokio::test]
    async fn reconciles_on_schedule_while_events_keep_waking_it() {
        let now = Arc::new(AtomicI64::new(0));
        let clock = now.clone();
        let indexer = {
            let base = indexer(30, 0);
            let base = Arc::try_unwrap(base).ok().unwrap();
            Arc::new(base.with_clock(Arc::new(move || clock.load(Ordering::SeqCst))))
        };
        let shutdown = Shutdown::new();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let running = {
            let (indexer, shutdown, calls, now) = (indexer.clone(), shutdown.clone(), calls.clone(), now.clone());
            tokio::spawn(async move {
                let inner = indexer.clone();
                indexer
                    .run_loop(&shutdown, |reconcile| {
                        let mut calls = calls.lock().unwrap();
                        calls.push(reconcile);
                        if calls.len() == 2 {
                            now.store(30, Ordering::SeqCst);
                            inner.request_catch_up();
                        }
                        if calls.len() == 3 {
                            shutdown.trigger();
                        }
                        async { Ok(RunOnceResult::default()) }
                    })
                    .await
            })
        };
        wait_until(|| calls.lock().unwrap().len() == 1).await;
        now.store(5, Ordering::SeqCst);
        indexer.request_catch_up();
        tokio::time::timeout(Duration::from_secs(5), running).await.unwrap().unwrap();
        assert_eq!(*calls.lock().unwrap(), vec![true, false, true]);
    }

    #[tokio::test]
    async fn wakes_early_to_flush_pending_caches() {
        let indexer = indexer(60_000, 0);
        let shutdown = Shutdown::new();
        let cycles = AtomicUsize::new(0);
        let started = Instant::now();
        tokio::time::timeout(
            Duration::from_secs(5),
            indexer.run_loop(&shutdown, |_| {
                let cycle = cycles.fetch_add(1, Ordering::SeqCst) + 1;
                if cycle == 2 {
                    shutdown.trigger();
                }
                async move {
                    Ok(RunOnceResult { indexed: 1, transactions: 1, cache_flush_in_ms: (cycle == 1).then_some(5) })
                }
            }),
        )
        .await
        .unwrap();
        assert_eq!(cycles.load(Ordering::SeqCst), 2);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn coalesces_live_events_for_the_debounce_window() {
        let indexer = indexer(60_000, 50);
        let shutdown = Shutdown::new();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let running = {
            let (indexer, shutdown, calls) = (indexer.clone(), shutdown.clone(), calls.clone());
            tokio::spawn(async move {
                indexer
                    .run_loop(&shutdown, |reconcile| {
                        let mut calls = calls.lock().unwrap();
                        calls.push(reconcile);
                        if calls.len() == 2 {
                            shutdown.trigger();
                        }
                        async { Ok(RunOnceResult::default()) }
                    })
                    .await
            })
        };
        wait_until(|| calls.lock().unwrap().len() == 1).await;
        let woke = Instant::now();
        indexer.request_catch_up();
        indexer.request_catch_up();
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(calls.lock().unwrap().len(), 1);
        tokio::time::timeout(Duration::from_secs(5), running).await.unwrap().unwrap();
        assert!(woke.elapsed() >= Duration::from_millis(50));
        assert_eq!(*calls.lock().unwrap(), vec![true, false]);
    }

    #[tokio::test]
    async fn retries_after_a_failed_cycle_with_the_poll_interval() {
        let indexer = indexer(5, 0);
        let shutdown = Shutdown::new();
        let calls = Arc::new(Mutex::new(Vec::new()));
        tokio::time::timeout(
            Duration::from_secs(5),
            indexer.run_loop(&shutdown, |reconcile| {
                let mut calls = calls.lock().unwrap();
                calls.push(reconcile);
                let fail = calls.len() == 1;
                if calls.len() == 2 {
                    shutdown.trigger();
                }
                async move {
                    if fail {
                        anyhow::bail!("rpc offline");
                    }
                    Ok(RunOnceResult::default())
                }
            }),
        )
        .await
        .unwrap();
        // The failed cycle never scheduled the next reconciliation.
        assert_eq!(*calls.lock().unwrap(), vec![true, true]);
    }

    // -- run_once against a real database and a scripted RPC ------------------

    fn address(n: u8) -> Address {
        Address::new([n; 32])
    }

    fn setup(options: IndexerDatabaseOptions) -> (Arc<FakeTransport>, Arc<IndexerDatabase>, PublicIndexer) {
        let transport = FakeTransport::new();
        let rpc = Arc::new(RpcPool::with_transport(&["https://rpc".into()], transport.clone()).unwrap());
        let db = Arc::new(IndexerDatabase::open_with_options(":memory:", options).unwrap());
        let indexer = PublicIndexer::new(db.clone(), rpc, address(1), 60_000);
        (transport, db, indexer)
    }

    fn initialized(game: &Address, signature: &str, slot: u64) -> GameInitializedEvent {
        GameInitializedEvent {
            game_key: game.to_base58(),
            creator: address(20).to_base58(),
            game_type: "coinflip".into(),
            ticket_amount: 100,
            total_amount: 100,
            max_tickets: 2,
            min_tickets: 2,
            token_mint: address(21).to_base58(),
            is_private: false,
            created_at: 1_000,
            timeout: 3_600,
            signature: signature.into(),
            slot,
        }
    }

    fn seed_active(db: &IndexerDatabase, games: &[Address]) {
        let events = IndexedEvents {
            initialized: games
                .iter()
                .enumerate()
                .map(|(i, game)| initialized(game, &format!("{}", i + 1).repeat(64), 10))
                .collect(),
            ..Default::default()
        };
        db.apply(&events, &IndexerCursor { signature: "cursor".into(), slot: 1 }).unwrap();
    }

    fn game_account(owner: &Address) -> Value {
        let mut data = GAME_ACCOUNT.to_vec();
        data.extend([0u8; 8]);
        json!({
            "lamports": 1,
            "owner": owner.to_base58(),
            "data": [base64::engine::general_purpose::STANDARD.encode(data), "base64"],
            "executable": false
        })
    }

    #[tokio::test]
    async fn initializes_the_cursor_at_the_program_head() {
        let (transport, db, indexer) = setup(IndexerDatabaseOptions::default());
        transport.push("getSignaturesForAddress", Ok(json!([{ "signature": "head", "slot": 77 }])));
        let result = indexer.run_once(true).await.unwrap();
        assert_eq!(result, RunOnceResult::default());
        assert_eq!(db.get_cursor().unwrap(), Some(IndexerCursor { signature: "head".into(), slot: 77 }));
        // No active games: reconciliation skips the chain lookup.
        assert!(transport.calls_for("getMultipleAccounts").is_empty());
    }

    #[tokio::test]
    async fn applies_new_events_and_reports_the_next_flush() {
        let now = Arc::new(AtomicI64::new(1_000_000));
        let clock = now.clone();
        let (transport, db, indexer) = setup(IndexerDatabaseOptions {
            cache_rebuild_interval_ms: Some(30_000),
            now: Some(Arc::new(move || clock.load(Ordering::SeqCst))),
            ..Default::default()
        });
        // A first rebuild starts the throttle window.
        seed_active(&db, &[address(2)]);
        now.fetch_add(1_000, Ordering::SeqCst);

        let program = address(1);
        let mut closed = timba_protocol::events::discriminators::GAME_CLOSED.to_vec();
        closed.extend(address(2).as_bytes());
        closed.extend(5_000u64.to_le_bytes());
        let logs = vec![
            format!("Program {} invoke [1]", program.to_base58()),
            format!("Program data: {}", base64::engine::general_purpose::STANDARD.encode(&closed)),
            format!("Program {} success", program.to_base58()),
        ];
        transport.push("getSignaturesForAddress", Ok(json!([{ "signature": "next", "slot": 2, "err": null }])));
        transport.push("getTransaction", Ok(json!({ "slot": 2, "meta": { "err": null, "logMessages": logs } })));
        let result = indexer.run_once(false).await.unwrap();
        assert_eq!(result, RunOnceResult { indexed: 1, transactions: 1, cache_flush_in_ms: Some(29_000) });
        assert_eq!(db.get_cursor().unwrap().unwrap().signature, "next");
        assert_eq!(db.get_game(&address(2).to_base58()).unwrap().unwrap()["status"], json!("cancelled"));
    }

    #[tokio::test]
    async fn drops_active_games_whose_accounts_no_longer_exist() {
        let (transport, db, indexer) = setup(IndexerDatabaseOptions::default());
        let (live, gone) = (address(2), address(3));
        seed_active(&db, &[live, gone]);
        transport.push("getSignaturesForAddress", Ok(json!([])));
        let owner = address(1);
        let live_key = live.to_base58();
        transport.on(move |_, method, params| {
            (method == "getMultipleAccounts").then(|| {
                let value: Vec<Value> = params[0]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|key| if key.as_str() == Some(live_key.as_str()) { game_account(&owner) } else { Value::Null })
                    .collect();
                Ok(json!({ "value": value }))
            })
        });
        indexer.run_once(true).await.unwrap();
        let keys: Vec<Value> = db.get_active_games(None).unwrap().iter().map(|game| game["game_key"].clone()).collect();
        assert_eq!(keys, vec![json!(live.to_base58())]);
        let requested = &transport.calls_for("getMultipleAccounts")[0].1[0];
        assert_eq!(requested.as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn keeps_indexing_when_reconciliation_fails() {
        let (transport, db, indexer) = setup(IndexerDatabaseOptions::default());
        seed_active(&db, &[address(2)]);
        transport.push(
            "getSignaturesForAddress",
            Ok(json!([
                { "signature": "a", "slot": 3, "err": { "x": 1 } },
                { "signature": "b", "slot": 2, "err": { "x": 1 } }
            ])),
        );
        transport.push("getMultipleAccounts", Err(crate::solana::rpc::RpcError::json_rpc(-32000, "rpc offline")));
        let result = indexer.run_once(true).await.unwrap();
        assert_eq!(result.transactions, 2);
        assert_eq!(db.get_active_games(None).unwrap().len(), 1);
    }

    #[tokio::test]
    async fn exposes_the_database_it_indexes_into() {
        let (_transport, db, indexer) = setup(IndexerDatabaseOptions::default());
        assert!(Arc::ptr_eq(indexer.database(), &db));
    }

    #[tokio::test]
    async fn initializes_the_cursor_without_reconciling_when_not_asked_to() {
        let (transport, db, indexer) = setup(IndexerDatabaseOptions::default());
        // An imported active game that a reconciliation would look up on chain.
        db.import_sql(
            "INSERT INTO active_games (game_key, creator, ticket_amount, total_amount, max_tickets, min_tickets,
               token_mint, created_at, timeout, signature, slot, indexed_at)
             VALUES ('imported', 'c', 1, 2, 2, 2, 'm', 1, 1, 's', 1, 1)",
        )
        .unwrap();
        transport.push("getSignaturesForAddress", Ok(json!([{ "signature": "head", "slot": 77 }])));
        let result = indexer.run_once(false).await.unwrap();
        assert_eq!(result, RunOnceResult::default());
        assert_eq!(db.get_cursor().unwrap(), Some(IndexerCursor { signature: "head".into(), slot: 77 }));
        assert!(transport.calls_for("getMultipleAccounts").is_empty());
        assert_eq!(db.get_active_games(None).unwrap().len(), 1);
    }

    #[tokio::test]
    async fn leaves_the_cursor_unset_when_the_program_has_no_history() {
        let (transport, db, indexer) = setup(IndexerDatabaseOptions::default());
        transport.push("getSignaturesForAddress", Ok(json!([])));
        assert_eq!(indexer.run_once(false).await.unwrap(), RunOnceResult::default());
        assert_eq!(db.get_cursor().unwrap(), None);
    }

    #[tokio::test]
    async fn refuses_to_start_a_second_loop_and_leaves_the_first_running() {
        let indexer = indexer(60_000, 0);
        let shutdown = Shutdown::new();
        indexer.running.store(true, Ordering::SeqCst);
        let cycles = AtomicUsize::new(0);
        tokio::time::timeout(
            Duration::from_secs(5),
            indexer.run_loop(&shutdown, |_| {
                cycles.fetch_add(1, Ordering::SeqCst);
                async { Ok(RunOnceResult::default()) }
            }),
        )
        .await
        .unwrap();
        assert_eq!(cycles.load(Ordering::SeqCst), 0);
        assert!(indexer.running.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn reconciles_games_whose_stored_key_is_not_text() {
        let (transport, db, indexer) = setup(IndexerDatabaseOptions::default());
        let (live, gone) = (address(2), address(3));
        seed_active(&db, &[live, gone]);
        // A corrupt row whose key is a blob must not stop the other games from being checked.
        db.import_sql(
            "INSERT INTO active_games (game_key, creator, ticket_amount, total_amount, max_tickets, min_tickets,
               token_mint, created_at, timeout, signature, slot, indexed_at)
             VALUES (x'0102', 'c', 1, 2, 2, 2, 'm', 1, 1, 's', 1, 1)",
        )
        .unwrap();
        transport.push("getSignaturesForAddress", Ok(json!([])));
        let owner = address(1);
        let live_key = live.to_base58();
        transport.on(move |_, method, params| {
            (method == "getMultipleAccounts").then(|| {
                let value: Vec<Value> = params[0]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|key| if key.as_str() == Some(live_key.as_str()) { game_account(&owner) } else { Value::Null })
                    .collect();
                Ok(json!({ "value": value }))
            })
        });
        indexer.run_once(true).await.unwrap();
        let keys: Vec<Value> = db.get_active_games(None).unwrap().iter().map(|game| game["game_key"].clone()).collect();
        assert_eq!(keys.len(), 2);
        assert!(keys.contains(&json!(live.to_base58())));
        assert!(!keys.contains(&json!(gone.to_base58())));
        // Only the two real addresses were looked up.
        assert_eq!(transport.calls_for("getMultipleAccounts")[0].1[0].as_array().unwrap().len(), 2);
    }
}
