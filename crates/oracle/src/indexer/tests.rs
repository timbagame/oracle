//! Indexer database and API tests (ports of `indexer-database.test.ts`,
//! `indexer-database.jobs.test.ts` and `indexer-api.test.ts`).

use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{HeaderMap, Request, StatusCode};
use axum::Router;
use futures::FutureExt;
use serde_json::{json, Value};
use timba_protocol::address::Address;
use tower::ServiceExt;

use super::api::router_with_clock;
use super::database::{IndexerDatabase, IndexerDatabaseOptions, LeaderboardPeriod};
use super::pricing::TokenUsdPrices;
use super::types::{
    GameClosedEvent, GameCompletedEvent, GameInitializedEvent, IndexedEvents, IndexerCursor, MembershipKind,
    PlayerMembershipEvent,
};
use crate::token::price::PriceFetcher;

fn key(seed: u8) -> String {
    Address::new([seed; 32]).to_base58()
}

fn signature(seed: u8) -> String {
    bs58::encode([seed; 64]).into_string()
}

fn cursor(signature: &str, slot: u64) -> IndexerCursor {
    IndexerCursor { signature: signature.into(), slot }
}

type ManualClock = Arc<AtomicI64>;

fn clock_of(clock: &ManualClock) -> super::database::Clock {
    let clock = clock.clone();
    Arc::new(move || clock.load(Ordering::SeqCst))
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

struct Fixture {
    db: Arc<IndexerDatabase>,
    events: IndexedEvents,
    game_key: String,
    player: String,
    mint: String,
    completed_signature: String,
}

fn initialized_event(game_key: &str, creator: &str, mint: &str, sig: &str, slot: u64) -> GameInitializedEvent {
    GameInitializedEvent {
        game_key: game_key.into(),
        creator: creator.into(),
        game_type: "coinflip".into(),
        ticket_amount: 100,
        total_amount: 100,
        max_tickets: 2,
        min_tickets: 2,
        token_mint: mint.into(),
        is_private: false,
        created_at: 1_000,
        timeout: 3_600,
        signature: sig.into(),
        slot,
    }
}

fn fixture(options: IndexerDatabaseOptions) -> Fixture {
    let db = Arc::new(IndexerDatabase::open_with_options(":memory:", options).unwrap());
    let (game_key, creator, player, mint) = (key(1), key(2), key(3), key(4));
    let initialized_signature = "1".repeat(64);
    let completed_signature = format!("{}2", "1".repeat(63));
    let events = IndexedEvents {
        initialized: vec![initialized_event(&game_key, &creator, &mint, &initialized_signature, 10)],
        membership: vec![PlayerMembershipEvent {
            kind: MembershipKind::Joined,
            game_key: game_key.clone(),
            player: player.clone(),
            tickets_count: 1,
            ticket_index: 0,
            moved_participant: None,
            timestamp: 1_001,
            signature: initialized_signature.clone(),
            slot: 11,
        }],
        completed: vec![GameCompletedEvent {
            game_key: game_key.clone(),
            winner: player.clone(),
            tickets_count: 2,
            winner_amount: 198,
            fee_amount: 2,
            timestamp: 1_002,
            signature: completed_signature.clone(),
            slot: 12,
        }],
        closed: vec![],
    };
    Fixture { db, events, game_key, player, mint, completed_signature }
}

fn initialized_only(events: &IndexedEvents) -> IndexedEvents {
    IndexedEvents { initialized: events.initialized.clone(), ..Default::default() }
}

#[test]
fn stores_lifecycle_data_and_serves_stats_without_duplicate_totals() {
    let f = fixture(Default::default());
    let next = cursor(&f.completed_signature, 12);
    f.db.apply(&f.events, &next).unwrap();
    f.db.apply(&f.events, &next).unwrap();

    assert_eq!(f.db.get_cursor().unwrap(), Some(next));
    let stats = f.db.get_stats(None).unwrap();
    assert_eq!(stats.total_games, json!(1));
    assert_eq!(stats.unique_players, json!(1));
    assert_eq!(
        serde_json::to_value(&stats.financials).unwrap(),
        json!([{
            "tokenMint": f.mint,
            "totalVolume": 200,
            "totalFees": 2,
            "biggestWin": { "amount": 198, "winner": f.player, "signature": f.completed_signature },
        }])
    );
    assert_eq!(f.db.get_game(&f.game_key).unwrap().unwrap()["status"], json!("completed"));
    assert!(f.db.get_active_games(None).unwrap().is_empty());
    let summary = f.db.get_player_profile(&f.player).unwrap().summary;
    assert_eq!(summary["related_games"], json!(1));
    assert_eq!(summary["played_games"], json!(1));
    assert_eq!(summary["wins"], json!(1));
    // Completed games queue a verification job.
    f.db.close();
}

#[test]
fn falls_back_to_the_newest_game_for_the_cursor() {
    let f = fixture(Default::default());
    assert_eq!(f.db.get_cursor().unwrap(), None);
    f.db.import_sql(&format!("INSERT INTO games VALUES ('{}', 'g', 'w', 1, 0, 2, 'm', 1, 44, 1)", signature(9)))
        .unwrap();
    assert_eq!(f.db.get_cursor().unwrap(), Some(cursor(&signature(9), 44)));
    // The stored cursor only moves forward.
    f.db.set_cursor(&cursor("a", 50)).unwrap();
    f.db.set_cursor(&cursor("b", 49)).unwrap();
    assert_eq!(f.db.get_cursor().unwrap(), Some(cursor("a", 50)));
}

#[test]
fn migrates_legacy_active_membership_columns_before_creating_indexes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("legacy.sqlite");
    let legacy = rusqlite::Connection::open(&path).unwrap();
    legacy
        .execute_batch(
            "CREATE TABLE active_game_players (
          game_key TEXT NOT NULL, player TEXT NOT NULL, ticket_index INTEGER NOT NULL,
          joined_at INTEGER NOT NULL, PRIMARY KEY (game_key, player)
        );
        CREATE INDEX idx_active_player ON active_game_players(player);
        INSERT INTO active_game_players VALUES ('game', 'player', 0, 1000);",
        )
        .unwrap();
    drop(legacy);

    let migrated = IndexerDatabase::open(&path).unwrap();
    migrated.close();

    let inspected = rusqlite::Connection::open(&path).unwrap();
    let row: (i64, i64) = inspected
        .query_row("SELECT is_joined, updated_slot FROM active_game_players", [], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap();
    assert_eq!(row, (1, 0));
    let sql: String = inspected
        .query_row("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_active_player'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(sql.contains("player, is_joined"));
}

#[test]
fn rejects_an_import_until_historical_player_data_is_complete() {
    let f = fixture(Default::default());
    f.db.apply(&f.events, &cursor(&f.completed_signature, 12)).unwrap();
    let error = f.db.assert_d1_import_ready().unwrap_err();
    assert!(error.to_string().contains("historical backfill is incomplete"));
    f.db.import_sql(
        "INSERT INTO historical_backfill
        (name, pages, transactions, initialized_events, closed_events, complete, updated_at)
      VALUES ('game-lifecycle-v3-player-history', 1, 1, 1, 0, 1, 1000)",
    )
    .unwrap();
    f.db.assert_d1_import_ready().unwrap();
}

#[test]
fn throttles_cache_rebuilds_and_flushes_them_once_the_window_passes() {
    let now: ManualClock = Arc::new(AtomicI64::new(1_000_000));
    let f = fixture(IndexerDatabaseOptions {
        cache_rebuild_interval_ms: Some(30_000),
        now: Some(clock_of(&now)),
        ..Default::default()
    });
    let initialized = initialized_only(&f.events);
    f.db.apply(&initialized, &cursor(&f.events.initialized[0].signature, 10)).unwrap();
    assert!(!f.db.has_pending_cache_rebuild());
    assert_eq!(f.db.ms_until_cache_flush(), None);
    assert_eq!(f.db.get_stats(None).unwrap().total_games, json!(1));

    now.fetch_add(1_000, Ordering::SeqCst);
    let other_key = key(30);
    let mut other = initialized.clone();
    other.initialized[0].game_key = other_key.clone();
    other.initialized[0].signature = "3".repeat(64);
    other.initialized[0].slot = 13;
    f.db.apply(&other, &cursor(&"3".repeat(64), 13)).unwrap();
    assert!(f.db.has_pending_cache_rebuild());
    assert_eq!(f.db.ms_until_cache_flush(), Some(29_000));
    assert_eq!(f.db.get_stats(None).unwrap().total_games, json!(1));
    assert!(!f.db.flush_caches(false).unwrap());

    now.fetch_add(29_000, Ordering::SeqCst);
    assert_eq!(f.db.ms_until_cache_flush(), Some(0));
    assert!(f.db.flush_caches(false).unwrap());
    assert!(!f.db.flush_caches(false).unwrap());
    assert_eq!(f.db.get_stats(None).unwrap().total_games, json!(2));
    assert!(!f.db.has_pending_cache_rebuild());

    now.fetch_add(1_000, Ordering::SeqCst);
    f.db.apply(&f.events, &cursor(&f.completed_signature, 12)).unwrap();
    assert!(f.db.has_pending_cache_rebuild());
    assert!(f.db.flush_caches(true).unwrap());
    assert_eq!(f.db.get_game(&f.game_key).unwrap().unwrap()["status"], json!("completed"));
    assert_eq!(f.db.get_stats(None).unwrap().financials.len(), 1);

    now.fetch_add(30_000, Ordering::SeqCst);
    other.initialized[0].slot = 14;
    f.db.apply(&other, &cursor(&"3".repeat(64), 14)).unwrap();
    assert!(!f.db.has_pending_cache_rebuild());
}

#[test]
fn rebuilds_after_every_batch_when_throttling_is_disabled() {
    let f = fixture(IndexerDatabaseOptions {
        cache_rebuild_interval_ms: Some(0),
        now: Some(Arc::new(|| 5)),
        ..Default::default()
    });
    let initialized = initialized_only(&f.events);
    f.db.apply(&initialized, &cursor(&f.events.initialized[0].signature, 10)).unwrap();
    let mut other = initialized.clone();
    other.initialized[0].game_key = key(31);
    other.initialized[0].signature = "4".repeat(64);
    f.db.apply(&other, &cursor(&"4".repeat(64), 11)).unwrap();
    assert!(!f.db.has_pending_cache_rebuild());
    assert_eq!(f.db.get_stats(None).unwrap().total_games, json!(2));
}

fn leaderboard_rows(rows: Vec<super::types::Row>) -> Value {
    Value::Array(rows.into_iter().map(Value::Object).collect())
}

#[test]
fn a_window_queried_before_a_rebuild_is_not_cached_after_it() {
    let now: ManualClock = Arc::new(AtomicI64::new(1_000_000));
    let f = fixture(IndexerDatabaseOptions {
        leaderboard_cache_ttl_ms: Some(30_000),
        now: Some(clock_of(&now)),
        ..Default::default()
    });
    let stale = vec![json!({ "player": "stale", "games_won": 9 }).as_object().unwrap().clone()];
    // A query read the generation, then a rebuild ran before it stored its rows.
    let before = f.db.cache_generation();
    f.db.rebuild_caches().unwrap();
    f.db.store_window("24h:*".into(), before, 1_000_000, &stale);
    assert!(f.db.get_leaderboard(10, None, LeaderboardPeriod::Day).unwrap().is_empty());
    // Without a rebuild in between, the rows are served from memory.
    let current = f.db.cache_generation();
    f.db.store_window("7d:*".into(), current, 1_000_000, &stale);
    assert_eq!(f.db.get_leaderboard(10, None, LeaderboardPeriod::Week).unwrap(), stale);
}

#[tokio::test]
async fn ranks_windowed_leaderboards_from_recent_games_and_caches_them_briefly() {
    let now_seconds: i64 = 20_000_000;
    let now: ManualClock = Arc::new(AtomicI64::new(now_seconds * 1000));
    let f = fixture(IndexerDatabaseOptions {
        cache_rebuild_interval_ms: Some(0),
        leaderboard_cache_ttl_ms: Some(30_000),
        now: Some(clock_of(&now)),
        ..Default::default()
    });
    let other = key(40);
    let game = |key_seed: u8, winner: &str, timestamp: i64, amount: u64, slot: u64| GameCompletedEvent {
        game_key: key(key_seed),
        winner: winner.into(),
        tickets_count: 2,
        winner_amount: amount,
        fee_amount: 1,
        timestamp: timestamp as u64,
        signature: format!("{slot:03}{}", "5".repeat(61)),
        slot,
    };
    let completed = vec![
        game(41, &f.player, now_seconds - 86_390, 50, 20),
        game(42, &other, now_seconds - 3 * 86_400, 500, 21),
        game(43, &other, now_seconds - 30 * 86_400, 900, 22),
        game(44, &other, now_seconds - 60 * 86_400, 900, 23),
    ];
    let initialized = completed
        .iter()
        .map(|item| {
            let mut event = f.events.initialized[0].clone();
            event.game_key = item.game_key.clone();
            event.signature = format!("{:03}{}", item.slot, "6".repeat(61));
            event
        })
        .collect();
    let last = completed[3].signature.clone();
    f.db.apply(&IndexedEvents { initialized, completed, ..Default::default() }, &cursor(&last, 23)).unwrap();

    assert_eq!(
        leaderboard_rows(f.db.get_leaderboard(10, None, LeaderboardPeriod::Day).unwrap()),
        json!([{ "player": f.player, "games_won": 1, "total_winnings": null, "avg_win": null }])
    );
    assert_eq!(
        leaderboard_rows(f.db.get_leaderboard(10, Some(&f.mint), LeaderboardPeriod::Week).unwrap()),
        json!([
            { "player": other, "games_won": 1, "total_winnings": 500, "avg_win": 500 },
            { "player": f.player, "games_won": 1, "total_winnings": 50, "avg_win": 50 },
        ])
    );
    assert_eq!(f.db.get_leaderboard(1, Some(&f.mint), LeaderboardPeriod::Week).unwrap().len(), 1);
    let all = f.db.get_leaderboard(10, None, LeaderboardPeriod::All).unwrap();
    assert_eq!(all[0]["player"], json!(other));
    assert_eq!(all[0]["games_won"], json!(3));

    // Served from memory until the TTL expires, even as time moves on.
    now.fetch_add(20_000, Ordering::SeqCst);
    assert_eq!(f.db.get_leaderboard(10, None, LeaderboardPeriod::Day).unwrap().len(), 1);
    now.fetch_add(10_000, Ordering::SeqCst);
    assert!(f.db.get_leaderboard(10, None, LeaderboardPeriod::Day).unwrap().is_empty());

    let api = Api::new(f.db.clone(), None, clock_of(&now));
    let (status, headers, body) = api.get(&format!("/api/leaderboard?period=7d&tokenMint={}", f.mint)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["cache-control"], "public, max-age=30");
    assert_eq!(body["count"], json!(2));
    let (status, _, _) = api.get("/api/leaderboard?period=1y").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (_, _, body) = api.get("/api/leaderboard").await;
    assert_eq!(body["count"], json!(2));
}

#[test]
fn does_not_cache_windowed_leaderboards_when_the_ttl_is_zero() {
    let now: ManualClock = Arc::new(AtomicI64::new(3_000_000_000));
    let f = fixture(IndexerDatabaseOptions {
        leaderboard_cache_ttl_ms: Some(0),
        now: Some(clock_of(&now)),
        ..Default::default()
    });
    assert!(f.db.get_leaderboard(5, None, LeaderboardPeriod::Day).unwrap().is_empty());
    now.fetch_add(1, Ordering::SeqCst);
    assert!(f.db.get_leaderboard(5, None, LeaderboardPeriod::Week).unwrap().is_empty());
}

#[tokio::test]
async fn returns_timeout_and_current_tickets_for_incomplete_player_games() {
    let f = fixture(IndexerDatabaseOptions { cache_rebuild_interval_ms: Some(0), ..Default::default() });
    let pending = IndexedEvents { completed: vec![], ..f.events.clone() };
    f.db.apply(&pending, &cursor(&f.events.initialized[0].signature, 11)).unwrap();
    let games = f.db.get_player_games(&f.player, 10, 0).unwrap();
    assert_eq!(games[0]["game_key"], json!(f.game_key));
    assert_eq!(games[0]["status"], json!("active"));
    assert_eq!(games[0]["timeout"], json!(3_600));
    assert_eq!(games[0]["tickets_count"], json!(1));

    // After reconciliation drops the live row, membership still yields a count.
    f.db.remove_stale_active_games(std::slice::from_ref(&f.game_key)).unwrap();
    let stale = f.db.get_player_games(&f.player, 10, 0).unwrap();
    assert_eq!(stale[0]["status"], json!("active"));
    assert_eq!(stale[0]["timeout"], json!(3_600));
    assert_eq!(stale[0]["tickets_count"], json!(1));

    let api = Api::new(f.db.clone(), None, Arc::new(timba_common::time::now_ms));
    let (_, _, body) = api.get(&format!("/api/player-games?player={}", f.player)).await;
    assert_eq!(body["games"][0]["timeout"], json!(3_600));
    assert_eq!(body["games"][0]["expiresAt"], json!(4_600));
    assert_eq!(body["games"][0]["ticketsCount"], json!(1));
}

#[test]
fn closures_cancel_games_and_unjoins_update_ticket_counts() {
    let f = fixture(IndexerDatabaseOptions { cache_rebuild_interval_ms: Some(0), ..Default::default() });
    let mut events = IndexedEvents { completed: vec![], ..f.events.clone() };
    f.db.apply(&events, &cursor("a", 11)).unwrap();
    assert_eq!(f.db.get_active_games(None).unwrap()[0]["current_tickets"], json!(1));
    events.initialized.clear();
    events.membership[0].kind = MembershipKind::Unjoined;
    events.membership[0].slot = 12;
    f.db.apply(&events, &cursor("b", 12)).unwrap();
    assert_eq!(f.db.get_active_games(None).unwrap()[0]["current_tickets"], json!(0));
    // An older membership event does not override the newer state.
    events.membership[0].kind = MembershipKind::Joined;
    events.membership[0].slot = 11;
    f.db.apply(&events, &cursor("c", 12)).unwrap();
    assert_eq!(f.db.get_active_games(None).unwrap()[0]["current_tickets"], json!(0));

    let closed = IndexedEvents {
        closed: vec![GameClosedEvent {
            game_key: f.game_key.clone(),
            timestamp: 2_000,
            operator: true,
            signature: "close".into(),
            slot: 13,
        }],
        ..Default::default()
    };
    assert_eq!(f.db.apply(&closed, &cursor("close", 13)).unwrap(), 1);
    assert!(f.db.get_active_games(None).unwrap().is_empty());
    let game = f.db.get_game(&f.game_key).unwrap().unwrap();
    assert_eq!(game["status"], json!("cancelled"));
    assert_eq!(game["signature"], json!("close"));
    assert_eq!(game["timestamp"], json!(2_000));
}

// -- verification jobs --------------------------------------------------------

fn jobs_db(now: &ManualClock) -> IndexerDatabase {
    IndexerDatabase::open_with_options(
        ":memory:",
        IndexerDatabaseOptions { wall_clock: Some(clock_of(now)), ..Default::default() },
    )
    .unwrap()
}

fn job(signature: &str, attempts: i64) -> Option<super::VerificationJob> {
    Some(super::VerificationJob { signature: signature.into(), attempts })
}

#[test]
fn delays_a_queued_verification_by_one_minute() {
    let now: ManualClock = Arc::new(AtomicI64::new(1_000_000));
    let db = jobs_db(&now);
    db.queue_verification("sig-a").unwrap();
    assert_eq!(db.next_verification_job().unwrap(), None);
    now.fetch_add(60_000, Ordering::SeqCst);
    assert_eq!(db.next_verification_job().unwrap(), job("sig-a", 0));
}

#[test]
fn does_not_queue_the_same_signature_twice() {
    let now: ManualClock = Arc::new(AtomicI64::new(1_000_000));
    let db = jobs_db(&now);
    db.queue_verification("sig-a").unwrap();
    now.fetch_add(30_000, Ordering::SeqCst);
    db.queue_verification("sig-a").unwrap();
    now.fetch_add(30_000, Ordering::SeqCst);
    assert_eq!(db.next_verification_job().unwrap(), job("sig-a", 0));
}

#[test]
fn backs_off_retries_exponentially_and_caps_them_at_one_day() {
    let now: ManualClock = Arc::new(AtomicI64::new(1_000_000));
    let db = jobs_db(&now);
    db.queue_verification("sig-a").unwrap();
    now.fetch_add(60_000, Ordering::SeqCst);

    db.retry_verification_job("sig-a", 2).unwrap();
    now.fetch_add(4 * 60_000 - 1, Ordering::SeqCst);
    assert_eq!(db.next_verification_job().unwrap(), None);
    now.fetch_add(1, Ordering::SeqCst);
    assert_eq!(db.next_verification_job().unwrap(), job("sig-a", 3));

    db.retry_verification_job("sig-a", 20).unwrap();
    now.fetch_add(86_400_000 - 1, Ordering::SeqCst);
    assert_eq!(db.next_verification_job().unwrap(), None);
    now.fetch_add(1, Ordering::SeqCst);
    assert_eq!(db.next_verification_job().unwrap(), job("sig-a", 21));
}

#[test]
fn removes_finished_jobs() {
    let now: ManualClock = Arc::new(AtomicI64::new(1_000_000));
    let db = jobs_db(&now);
    db.queue_verification("sig-a").unwrap();
    now.fetch_add(60_000, Ordering::SeqCst);
    db.finish_verification_job("sig-a").unwrap();
    assert_eq!(db.next_verification_job().unwrap(), None);
}

#[test]
fn completed_events_queue_verification_jobs() {
    let now: ManualClock = Arc::new(AtomicI64::new(1_000_000));
    let f = fixture(IndexerDatabaseOptions { wall_clock: Some(clock_of(&now)), ..Default::default() });
    f.db.apply(&f.events, &cursor(&f.completed_signature, 12)).unwrap();
    now.fetch_add(60_000, Ordering::SeqCst);
    assert_eq!(f.db.next_verification_job().unwrap(), job(&f.completed_signature, 0));
}

#[test]
fn caches_verified_game_payloads_by_key() {
    let db = IndexerDatabase::open(":memory:").unwrap();
    assert_eq!(db.get_verified_game("game:1").unwrap(), None);
    db.save_verified_game("game:1", r#"{"ok":true}"#).unwrap();
    db.save_verified_game("game:1", r#"{"ok":false}"#).unwrap();
    assert_eq!(db.get_verified_game("game:1").unwrap().as_deref(), Some(r#"{"ok":false}"#));
}

#[test]
fn reports_backfill_state() {
    let db = IndexerDatabase::open(":memory:").unwrap();
    let state = db.get_backfill_state().unwrap();
    assert_eq!(
        serde_json::to_value(&state).unwrap(),
        json!({
            "beforeSignature": null,
            "pages": 0,
            "transactions": 0,
            "initializedEvents": 0,
            "closedEvents": 0,
            "complete": false,
        })
    );
    db.import_sql(
        "INSERT INTO historical_backfill
      (name, before_signature, pages, transactions, initialized_events, closed_events, complete, updated_at)
      VALUES ('game-lifecycle-v3-player-history', 'sig-before', 3, 250, 40, 7, 1, 1)",
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(db.get_backfill_state().unwrap()).unwrap(),
        json!({
            "beforeSignature": "sig-before",
            "pages": 3,
            "transactions": 250,
            "initializedEvents": 40,
            "closedEvents": 7,
            "complete": true,
        })
    );
}

#[test]
fn closed_databases_fail_cleanly() {
    let db = IndexerDatabase::open(":memory:").unwrap();
    db.close();
    assert!(!db.is_open());
    assert!(db.get_tokens().is_err());
    db.close();
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

struct Api {
    router: Router,
    price_calls: Arc<AtomicUsize>,
}

impl Api {
    fn new(db: Arc<IndexerDatabase>, api_key: Option<&str>, now: super::database::Clock) -> Self {
        Self::with_prices(db, api_key, now, json!({}))
    }

    fn with_prices(
        db: Arc<IndexerDatabase>,
        api_key: Option<&str>,
        now: super::database::Clock,
        prices: Value,
    ) -> Self {
        let price_calls = Arc::new(AtomicUsize::new(0));
        let calls = price_calls.clone();
        let fetcher: PriceFetcher = Arc::new(move |_url: String, _key: String| {
            calls.fetch_add(1, Ordering::SeqCst);
            let body = prices.clone();
            async move { Ok((200, body)) }.boxed()
        });
        let prices = Arc::new(TokenUsdPrices::with_fetcher(fetcher, Arc::new(|| 0)));
        Self { router: router_with_clock(db, api_key.map(String::from), prices, now), price_calls }
    }

    async fn request(&self, method: &str, path: &str) -> (StatusCode, HeaderMap, Value) {
        let response = self
            .router
            .clone()
            .oneshot(Request::builder().method(method).uri(format!("/indexer{path}")).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, headers, body)
    }

    async fn get(&self, path: &str) -> (StatusCode, HeaderMap, Value) {
        self.request("GET", path).await
    }
}

struct Seeded {
    db: Arc<IndexerDatabase>,
    creator: String,
    player: String,
    mint: String,
    completed: String,
    cancelled: String,
    active: String,
}

/// One completed coinflip, one cancelled giveaway and one still-open private
/// game, all sharing a creator and a player so every player view has data.
fn seeded() -> Seeded {
    let db = Arc::new(
        IndexerDatabase::open_with_options(
            ":memory:",
            IndexerDatabaseOptions { cache_rebuild_interval_ms: Some(0), ..Default::default() },
        )
        .unwrap(),
    );
    let now = timba_common::time::now_secs() as u64;
    let (creator, player, mint) = (key(50), key(51), key(52));
    let (completed, cancelled, active) = (key(53), key(54), key(55));
    let initialized = |game: &str, seed: u8| {
        let mut event = initialized_event(game, &creator, &mint, &signature(seed), seed as u64);
        event.total_amount = 0;
        event.created_at = now - 100;
        event
    };
    let joined = |game: &str, seed: u8, who: &str, index: u32| PlayerMembershipEvent {
        kind: MembershipKind::Joined,
        game_key: game.into(),
        player: who.into(),
        tickets_count: index + 1,
        ticket_index: index,
        moved_participant: None,
        timestamp: now - 90 + seed as u64,
        signature: signature(seed),
        slot: seed as u64,
    };
    let mut giveaway = initialized(&cancelled, 2);
    giveaway.game_type = "giveaway".into();
    giveaway.total_amount = 500;
    giveaway.min_tickets = 1;
    let mut private = initialized(&active, 3);
    private.is_private = true;
    let events = IndexedEvents {
        initialized: vec![initialized(&completed, 1), giveaway, private],
        membership: vec![
            joined(&completed, 4, &creator, 0),
            joined(&completed, 5, &player, 1),
            joined(&active, 6, &player, 0),
        ],
        completed: vec![GameCompletedEvent {
            game_key: completed.clone(),
            winner: player.clone(),
            tickets_count: 2,
            winner_amount: 190,
            fee_amount: 10,
            timestamp: now - 50,
            signature: signature(7),
            slot: 7,
        }],
        closed: vec![GameClosedEvent {
            game_key: cancelled.clone(),
            timestamp: now - 40,
            operator: false,
            signature: signature(8),
            slot: 8,
        }],
    };
    db.apply(&events, &cursor(&signature(8), 8)).unwrap();
    db.flush_caches(true).unwrap();
    Seeded { db, creator, player, mint, completed, cancelled, active }
}

fn api(seeded: &Seeded) -> Api {
    Api::new(seeded.db.clone(), None, Arc::new(timba_common::time::now_ms))
}

#[tokio::test]
async fn reports_health() {
    let s = seeded();
    let (status, headers, body) = api(&s).get("/health").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-type"], "application/json");
    assert!(headers.get("cache-control").is_none());
    assert_eq!(body["status"], json!("ok"));
    assert!(body["timestamp"].as_i64().unwrap() > 0);
}

#[tokio::test]
async fn returns_stats_compatible_with_the_existing_api() {
    let s = seeded();
    let (status, headers, body) = api(&s).get("/api/stats").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["cache-control"], "public, max-age=10");
    assert_eq!(body["totalGames"], json!(3));
    assert_eq!(body["uniquePlayers"], json!(1));
    assert_eq!(
        body["financials"],
        json!([{
            "tokenMint": s.mint,
            "totalVolume": 200,
            "totalFees": 10,
            "priceUsd": null,
            "biggestWin": { "amount": 190, "winner": s.player, "signature": signature(7) },
        }])
    );
    let keys: Vec<&String> = body.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["totalGames", "uniquePlayers", "financials", "lastUpdated"]);
    let (_, _, scoped) = api(&s).get(&format!("/api/stats?tokenMint={}", key(99))).await;
    assert_eq!(scoped["totalGames"], json!(0));
    assert_eq!(scoped["financials"], json!([]));
}

#[tokio::test]
async fn lists_completed_games_with_paging_metadata() {
    let s = seeded();
    let (_, headers, body) = api(&s).get(&format!("/api/games?limit=10&offset=0&tokenMint={}", s.mint)).await;
    assert_eq!(headers["cache-control"], "public, max-age=5");
    assert_eq!(body["total"], json!(1));
    assert_eq!(body["page"], json!(1));
    assert_eq!(body["limit"], json!(10));
    assert_eq!(
        body["games"],
        json!([{
            "signature": signature(7),
            "gameKey": s.completed,
            "winner": s.player,
            "winnerAmount": 190,
            "feeAmount": 10,
            "ticketsCount": 2,
            "tokenMint": s.mint,
            "timestamp": body["games"][0]["timestamp"],
            "slot": 7,
            "priceUsd": null,
        }])
    );
}

#[tokio::test]
async fn uses_parsed_query_defaults_and_coerces_paging_numbers() {
    let s = seeded();
    let (status, _, defaults) = api(&s).get("/api/games").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!((&defaults["total"], &defaults["page"], &defaults["limit"]), (&json!(1), &json!(1), &json!(50)));
    let (status, _, empty) = api(&s).get("/api/games?limit=1&offset=1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(empty["page"], json!(2));
    assert_eq!(empty["games"], json!([]));
    // Last duplicate wins (`Object.fromEntries`) and whitespace is coerced.
    let (_, _, coerced) = api(&s).get("/api/games?limit=500&limit=%202%20").await;
    assert_eq!(coerced["limit"], json!(2));
}

#[tokio::test]
async fn lists_latest_completed_games_in_the_compact_format() {
    let s = seeded();
    let (_, _, body) = api(&s).get("/api/games/latest?limit=5").await;
    assert_eq!(body.as_array().unwrap().len(), 1);
    let game = &body[0];
    assert_eq!(game["gameKey"], json!(s.completed));
    assert_eq!(game["status"], json!("completed"));
    assert_eq!(game["creator"], Value::Null);
    assert_eq!(game["expiresAt"], Value::Null);
    let keys: Vec<&String> = game.as_object().unwrap().keys().collect();
    assert_eq!(
        keys,
        [
            "signature",
            "gameKey",
            "status",
            "creator",
            "gameType",
            "ticketAmount",
            "totalAmount",
            "maxTickets",
            "minTickets",
            "isPrivate",
            "createdAt",
            "timeout",
            "expiresAt",
            "winner",
            "winnerAmount",
            "feeAmount",
            "ticketsCount",
            "tokenMint",
            "timestamp",
            "slot",
            "priceUsd"
        ]
    );
}

#[tokio::test]
async fn lists_latest_lifecycle_entries_filtered_by_token_and_game_type() {
    let s = seeded();
    let (_, _, body) = api(&s)
        .get(&format!("/api/games/latest?limit=5&includeLifecycle=1&gameType=giveaway&tokenMint={}", s.mint))
        .await;
    assert_eq!(body.as_array().unwrap().len(), 1);
    assert_eq!(body[0]["gameKey"], json!(s.cancelled));
    assert_eq!(body[0]["status"], json!("cancelled"));
    assert_eq!(body[0]["gameType"], json!("giveaway"));
    assert_eq!(
        body[0]["expiresAt"].as_i64().unwrap(),
        body[0]["createdAt"].as_i64().unwrap() + body[0]["timeout"].as_i64().unwrap()
    );
    assert_eq!(body[0]["winner"], Value::Null);
    let (_, _, all) = api(&s).get("/api/games/latest?includeLifecycle=1").await;
    assert_eq!(all.as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn serves_one_game_by_key_and_404s_unknown_games() {
    let s = seeded();
    let (_, headers, found) = api(&s).get(&format!("/api/games/by-key?gameKey={}", s.completed)).await;
    assert_eq!(found["gameKey"], json!(s.completed));
    assert_eq!(found["status"], json!("completed"));
    assert_eq!(found["winner"], json!(s.player));
    assert_eq!(found["isPrivate"], json!(false));
    assert_eq!(headers["cache-control"], "public, max-age=2, stale-while-revalidate=2");
    let (status, headers, missing) = api(&s).get(&format!("/api/games/by-key?gameKey={}", key(98))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(missing, json!({ "error": "Game not found" }));
    assert!(headers.get("cache-control").is_none());
}

#[tokio::test]
async fn lists_tokens_with_the_number_of_games_created_in_each() {
    let s = seeded();
    let (_, headers, body) = api(&s).get("/api/tokens").await;
    assert_eq!(headers["cache-control"], "public, max-age=30");
    assert_eq!(body["tokens"].as_array().unwrap().len(), 1);
    assert_eq!(body["tokens"][0]["tokenMint"], json!(s.mint));
    assert_eq!(body["tokens"][0]["games"], json!(3));
    assert_eq!(body["tokens"][0]["priceUsd"], Value::Null);
}

#[tokio::test]
async fn lists_open_games_and_a_players_open_games() {
    let s = seeded();
    let (_, headers, all) = api(&s).get("/api/active-games").await;
    assert_eq!(headers["cache-control"], "public, max-age=5, stale-while-revalidate=10");
    assert_eq!(all["count"], json!(1));
    let game = &all["games"][0];
    assert_eq!(game["game_key"], json!(s.active));
    assert_eq!(game["creator"], json!(s.creator));
    assert_eq!(game["isPrivate"], json!(true));
    assert_eq!(game["is_private"], json!(1));
    assert_eq!(game["current_tickets"], json!(1));
    assert_eq!(game["game_type"], json!("coinflip"));
    assert!(game["timeLeft"].as_i64().unwrap() > 0);
    assert!(game.get("tokenMint").is_none());
    let (_, _, mine) = api(&s).get(&format!("/api/my-active-games?player={}", s.player)).await;
    assert_eq!(mine["games"][0]["game_key"], json!(s.active));
    let (_, _, stranger) = api(&s).get(&format!("/api/my-active-games?player={}", key(97))).await;
    assert_eq!(stranger, json!({ "games": [], "count": 0 }));
}

#[tokio::test]
async fn hides_expired_open_games() {
    let s = seeded();
    let later = Arc::new(|| (timba_common::time::now_secs() + 4_000) * 1000);
    let api = Api::new(s.db.clone(), None, later);
    let (_, _, body) = api.get("/api/active-games").await;
    assert_eq!(body, json!({ "games": [], "count": 0 }));
}

#[tokio::test]
async fn rejects_a_player_lookup_without_a_player() {
    let s = seeded();
    let (status, _, body) = api(&s).get("/api/my-active-games").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({ "error": "Invalid query parameters" }));
}

#[tokio::test]
async fn lists_a_players_games_with_their_role_in_each() {
    let s = seeded();
    let (_, _, body) = api(&s).get(&format!("/api/player-games?player={}&limit=10&offset=0", s.player)).await;
    assert_eq!(body["count"], json!(2));
    assert_eq!(body["limit"], json!(10));
    assert_eq!(body["offset"], json!(0));
    let games = body["games"].as_array().unwrap();
    let find = |key: &str| games.iter().find(|g| g["gameKey"] == json!(key)).unwrap().clone();
    let completed = find(&s.completed);
    assert_eq!(completed["isCreator"], json!(false));
    assert_eq!(completed["isPlayer"], json!(true));
    assert_eq!(completed["isJoined"], json!(true));
    let active = find(&s.active);
    assert_eq!(active["status"], json!("active"));
    assert_eq!(active["isPlayer"], json!(true));
    assert_eq!(active["isPrivate"], json!(true));
}

#[tokio::test]
async fn builds_a_player_profile_with_wins_tokens_and_frequent_opponents() {
    let s = seeded();
    let (_, headers, body) = api(&s).get(&format!("/api/player-profile?player={}", s.player)).await;
    assert_eq!(headers["cache-control"], "public, max-age=30, stale-while-revalidate=60");
    assert_eq!(body["wallet"], json!(s.player));
    let summary = &body["summary"];
    assert_eq!(summary["relatedGames"], json!(2));
    assert_eq!(summary["playedGames"], json!(2));
    assert_eq!(summary["completedGames"], json!(1));
    assert_eq!(summary["activeGames"], json!(1));
    assert_eq!(summary["wins"], json!(1));
    assert_eq!(summary["losses"], json!(0));
    assert!(summary["lastActivity"].is_i64());
    assert_eq!(body["tokens"][0]["tokenMint"], json!(s.mint));
    assert_eq!(body["tokens"][0]["gamesPlayed"], json!(2));
    assert_eq!(body["tokens"][0]["wonAmount"], json!(190));
    assert_eq!(body["frequentPlayers"], json!([{ "player": s.creator, "gamesTogether": 1 }]));
    assert_eq!(body["historyComplete"], json!(false));
}

#[tokio::test]
async fn returns_an_empty_profile_for_an_unknown_wallet() {
    let s = seeded();
    let (_, _, body) = api(&s).get(&format!("/api/player-profile?player={}", key(96))).await;
    assert_eq!(body["summary"]["relatedGames"], json!(0));
    assert_eq!(body["summary"]["wins"], json!(0));
    assert_eq!(body["summary"]["lastActivity"], Value::Null);
    assert_eq!(body["tokens"], json!([]));
}

#[tokio::test]
async fn attaches_live_usd_prices_when_a_jupiter_key_is_configured() {
    let s = seeded();
    let api = Api::with_prices(
        s.db.clone(),
        Some("jupiter-key"),
        Arc::new(timba_common::time::now_ms),
        json!({ s.mint.clone(): { "usdPrice": 2.5 } }),
    );
    let (_, _, body) = api.get("/api/stats").await;
    assert_eq!(body["financials"][0]["tokenMint"], json!(s.mint));
    assert_eq!(body["financials"][0]["priceUsd"], json!(2.5));
    assert_eq!(api.price_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn rejects_non_get_requests_bad_queries_and_unknown_endpoints() {
    let s = seeded();
    let api = api(&s);
    let (status, _, body) = api.request("POST", "/health").await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(body, json!({ "error": "Method not allowed" }));
    for path in [
        "/api/games?limit=abc",
        "/api/stats?tokenMint=%20",
        "/api/games/latest?limit=-1",
        "/api/games/by-key",
        "/api/leaderboard?period=year",
        "/api/player-games",
        "/api/player-profile",
        "/api/games?offset=1.5",
        "/api/games/latest?gameType=dice",
    ] {
        assert_eq!(api.get(path).await.0, StatusCode::BAD_REQUEST, "{path}");
    }
    let (status, _, body) = api.get("/api/nope").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, json!({ "error": "Endpoint not found" }));
    let (status, _, _) = api.get("").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, _) = api.get("/").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn hides_database_failures_behind_a_500() {
    let s = seeded();
    let api = api(&s);
    s.db.close();
    let (status, headers, body) = api.get("/api/tokens").await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(headers["content-type"], "application/json");
    assert_eq!(body, json!({ "error": "Internal server error" }));
}
