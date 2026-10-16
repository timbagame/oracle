//! Public indexer SQLite store (port of `indexer/database.ts`). The schema,
//! migrations and queries are unchanged so existing indexer databases and
//! Cloudflare D1 exports open as-is.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Params};
use serde::Serialize;
use serde_json::Value;
use timba_common::warn;

use super::schema::{js_number, js_string, normalize_number};
use super::types::{
    GameClosedEvent, GameCompletedEvent, GameInitializedEvent, HistoricalBackfillState, IndexedEvents, IndexerCursor,
    MembershipKind, PlayerMembershipEvent, Row,
};

const PROGRAM_CURSOR: &str = "program-transactions";
pub const BACKFILL_NAME: &str = "game-lifecycle-v3-player-history";
pub const DEFAULT_TOKEN_MINT: &str = "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump";

// Games a player created or took part in. Equivalent to
// "l.creator=? OR p.player IS NOT NULL" but resolved through the creator and
// player indexes instead of scanning every lifecycle row.
const PLAYER_GAME_KEYS_SQL: &str = "SELECT game_key FROM game_lifecycle WHERE creator=?
  UNION SELECT game_key FROM game_players WHERE player=?";

/// The schema from `indexer/database.ts`, verbatim.
const SCHEMA: &str = include_str!("schema.sql");

const LEADERBOARD_MAX_ROWS: i64 = 100;
const LEADERBOARD_CACHE_MAX_ENTRIES: usize = 256;

pub const DEFAULT_CACHE_REBUILD_INTERVAL_MS: i64 = 30_000;
pub const DEFAULT_LEADERBOARD_CACHE_TTL_MS: i64 = 30_000;

/// Millisecond clock.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LeaderboardPeriod {
    Day,
    Week,
    #[default]
    All,
}

impl LeaderboardPeriod {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "24h" => Some(Self::Day),
            "7d" => Some(Self::Week),
            "all" => Some(Self::All),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Day => "24h",
            Self::Week => "7d",
            Self::All => "all",
        }
    }

    /// The length of the rolling window, or `None` for the all-time leaderboard.
    fn window_seconds(self) -> Option<i64> {
        match self {
            Self::Day => Some(86_400),
            Self::Week => Some(7 * 86_400),
            Self::All => None,
        }
    }
}

#[derive(Clone, Default)]
pub struct IndexerDatabaseOptions {
    /// Minimum time between materialized cache rebuilds triggered by `apply()`.
    /// Changes inside the window mark the caches dirty; `flush_caches()` (called
    /// by the indexer loop) or the next `apply()` after the window rebuilds them.
    /// Use 0 to rebuild after every batch.
    pub cache_rebuild_interval_ms: Option<i64>,
    /// How long windowed (24h / 7d) leaderboards are served from memory.
    pub leaderboard_cache_ttl_ms: Option<i64>,
    /// Millisecond clock for cache throttling, injectable for deterministic tests.
    pub now: Option<Clock>,
    /// Wall clock used for `indexed_at` / `updated_at` columns and verification
    /// job scheduling (`Date.now()` in the TypeScript implementation).
    pub wall_clock: Option<Clock>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerificationJob {
    pub signature: String,
    pub attempts: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BiggestWin {
    pub amount: Value,
    pub winner: Value,
    pub signature: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenFinancials {
    pub token_mint: Value,
    pub total_volume: Value,
    pub total_fees: Value,
    pub biggest_win: Option<BiggestWin>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexerStats {
    pub total_games: Value,
    pub unique_players: Value,
    pub financials: Vec<TokenFinancials>,
    pub last_updated: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GamesPage {
    pub games: Vec<Row>,
    pub total: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlayerProfile {
    pub summary: Row,
    pub tokens: Vec<Row>,
    pub frequent_players: Vec<Row>,
    pub history_complete: bool,
}

#[derive(Default)]
struct CacheState {
    dirty: bool,
    last_rebuild_at: Option<i64>,
    leaderboard_windows: HashMap<String, (i64, Vec<Row>)>,
    /// Bumped by every rebuild, so a windowed query that raced one is not cached.
    generation: u64,
}

pub struct IndexerDatabase {
    conn: Mutex<Option<Connection>>,
    cache: Mutex<CacheState>,
    cache_rebuild_interval_ms: i64,
    leaderboard_cache_ttl_ms: i64,
    clock: Clock,
    wall_clock: Clock,
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

fn sql_to_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => normalize_number(f),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::Array(b.iter().map(|&x| Value::from(x)).collect()),
    }
}

fn query_all(conn: &Connection, sql: &str, params: impl Params) -> rusqlite::Result<Vec<Row>> {
    let mut statement = conn.prepare_cached(sql)?;
    let names: Vec<String> = statement.column_names().into_iter().map(String::from).collect();
    let mut rows = statement.query(params)?;
    let mut output = Vec::new();
    while let Some(row) = rows.next()? {
        let mut map = Row::new();
        for (index, name) in names.iter().enumerate() {
            map.insert(name.clone(), sql_to_json(row.get_ref(index)?));
        }
        output.push(map);
    }
    Ok(output)
}

fn query_one(conn: &Connection, sql: &str, params: impl Params) -> rusqlite::Result<Option<Row>> {
    Ok(query_all(conn, sql, params)?.into_iter().next())
}

fn run(conn: &Connection, sql: &str, params: impl Params) -> rusqlite::Result<usize> {
    conn.prepare_cached(sql)?.execute(params)
}

fn field(row: &Row, key: &str) -> Value {
    row.get(key).cloned().unwrap_or(Value::Null)
}

/// `value ?? fallback`
fn or(value: Option<Value>, fallback: Value) -> Value {
    match value {
        Some(v) if !v.is_null() => v,
        _ => fallback,
    }
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.is_empty())
}

fn boolean_integer(value: &Value) -> Value {
    Value::from(i64::from(js_number(value) == 1))
}

fn i64_of(value: u64) -> Result<i64> {
    i64::try_from(value).map_err(|_| anyhow!("Value {value} exceeds the SQLite integer range"))
}

impl IndexerDatabase {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_with_options(path, IndexerDatabaseOptions::default())
    }

    pub fn open_with_options(path: impl AsRef<Path>, options: IndexerDatabaseOptions) -> Result<Self> {
        let path = path.as_ref();
        let conn =
            Connection::open(path).with_context(|| format!("Failed to open indexer database {}", path.display()))?;
        conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
        conn.execute_batch("PRAGMA foreign_keys = ON")?;
        conn.query_row("PRAGMA busy_timeout = 5000", [], |_| Ok(()))?;
        migrate_legacy_schema(&conn)?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(Some(conn)),
            cache: Mutex::new(CacheState::default()),
            cache_rebuild_interval_ms: options
                .cache_rebuild_interval_ms
                .unwrap_or(DEFAULT_CACHE_REBUILD_INTERVAL_MS)
                .max(0),
            leaderboard_cache_ttl_ms: options
                .leaderboard_cache_ttl_ms
                .unwrap_or(DEFAULT_LEADERBOARD_CACHE_TTL_MS)
                .max(0),
            clock: options.now.unwrap_or_else(|| Arc::new(timba_common::time::now_ms)),
            wall_clock: options.wall_clock.unwrap_or_else(|| Arc::new(timba_common::time::now_ms)),
        })
    }

    /// Queries block the calling worker (see `timba_common::blocking`).
    fn with_conn<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
        timba_common::blocking::blocking(|| {
            let mut guard = self.conn.lock().unwrap();
            let conn = guard.as_mut().ok_or_else(|| anyhow!("Indexer database is closed"))?;
            f(conn)
        })
    }

    fn transaction<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        self.with_conn(|conn| {
            let tx = conn.transaction()?;
            let value = f(&tx)?;
            tx.commit()?;
            Ok(value)
        })
    }

    fn now_ms(&self) -> i64 {
        (self.wall_clock)()
    }

    fn now_seconds(&self) -> i64 {
        self.now_ms().div_euclid(1000)
    }

    pub fn is_open(&self) -> bool {
        self.conn.lock().unwrap().is_some()
    }

    pub fn close(&self) {
        let Some(conn) = self.conn.lock().unwrap().take() else {
            return;
        };
        if let Err(e) = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())) {
            warn!("Failed to checkpoint the indexer WAL during close: {e}");
        }
        if let Err((_, e)) = conn.close() {
            warn!("Failed to close the indexer database: {e}");
        }
    }

    // -- verification jobs ---------------------------------------------------

    fn queue_verification_in(&self, conn: &Connection, signature: &str) -> Result<()> {
        run(
            conn,
            "INSERT OR IGNORE INTO verification_jobs(signature,next_attempt) VALUES (?,?)",
            params![signature, self.now_ms() + 60_000],
        )?;
        Ok(())
    }

    pub fn queue_verification(&self, signature: &str) -> Result<()> {
        self.with_conn(|conn| self.queue_verification_in(conn, signature))
    }

    pub fn next_verification_job(&self) -> Result<Option<VerificationJob>> {
        self.with_conn(|conn| {
            Ok(conn
                .prepare_cached(
                    "SELECT signature,attempts FROM verification_jobs WHERE next_attempt<=? ORDER BY next_attempt LIMIT 1",
                )?
                .query_row(params![self.now_ms()], |row| {
                    Ok(VerificationJob {
                        signature: row.get(0)?,
                        attempts: row.get(1)?,
                    })
                })
                .optional()?)
        })
    }

    pub fn finish_verification_job(&self, signature: &str) -> Result<()> {
        self.with_conn(|conn| {
            run(conn, "DELETE FROM verification_jobs WHERE signature=?", params![signature])?;
            Ok(())
        })
    }

    pub fn retry_verification_job(&self, signature: &str, attempts: i64) -> Result<()> {
        let exponent = attempts.min(11);
        let backoff = if exponent < 0 {
            // 2 ** negative is a fraction in JavaScript.
            (60_000.0 * 2f64.powi(exponent.max(-64) as i32)) as i64
        } else {
            60_000i64 * (1i64 << exponent)
        };
        let next = self.now_ms() + backoff.min(86_400_000);
        self.with_conn(|conn| {
            run(
                conn,
                "UPDATE verification_jobs SET next_attempt=?,attempts=? WHERE signature=?",
                params![next, attempts + 1, signature],
            )?;
            Ok(())
        })
    }

    pub fn get_verified_game(&self, key: &str) -> Result<Option<String>> {
        self.with_conn(|conn| {
            Ok(conn
                .prepare_cached("SELECT payload FROM verified_games WHERE cache_key = ?")?
                .query_row(params![key], |row| row.get::<_, Option<String>>(0))
                .optional()?
                .flatten())
        })
    }

    pub fn save_verified_game(&self, key: &str, payload: &str) -> Result<()> {
        self.with_conn(|conn| {
            run(
                conn,
                "INSERT OR REPLACE INTO verified_games (cache_key, payload) VALUES (?, ?)",
                params![key, payload],
            )?;
            Ok(())
        })
    }

    // -- import --------------------------------------------------------------

    pub fn import_sql(&self, sql: &str) -> Result<()> {
        self.transaction(|conn| Ok(conn.execute_batch(sql)?))?;
        self.rebuild_caches()
    }

    pub fn assert_d1_import_ready(&self) -> Result<()> {
        self.with_conn(|conn| {
            let games = query_one(
                conn,
                "SELECT COUNT(DISTINCT game_key) count FROM (
             SELECT game_key FROM games UNION ALL
             SELECT game_key FROM gameplay_events UNION ALL
             SELECT game_key FROM active_games
           )",
                [],
            )?
            .map(|row| field(&row, "count"));
            if or(games, Value::from(0)) == 0 {
                return Ok(());
            }
            let backfill =
                query_one(conn, "SELECT complete FROM historical_backfill WHERE name=?", params![BACKFILL_NAME])?;
            if backfill.map(|row| field(&row, "complete")) != Some(Value::from(1)) {
                bail!("D1 historical backfill is incomplete; finish it in the existing Worker before exporting");
            }
            Ok(())
        })
    }

    // -- cursor --------------------------------------------------------------

    pub fn get_cursor(&self) -> Result<Option<IndexerCursor>> {
        self.with_conn(|conn| {
            let read = |row: &rusqlite::Row<'_>| -> rusqlite::Result<IndexerCursor> {
                Ok(IndexerCursor { signature: row.get(0)?, slot: row.get::<_, i64>(1)?.max(0) as u64 })
            };
            let cursor = conn
                .prepare_cached("SELECT signature, slot FROM indexer_state WHERE name = ?")?
                .query_row(params![PROGRAM_CURSOR], read)
                .optional()?;
            if cursor.is_some() {
                return Ok(cursor);
            }
            Ok(conn
                .prepare_cached("SELECT signature, slot FROM games ORDER BY slot DESC LIMIT 1")?
                .query_row([], read)
                .optional()?)
        })
    }

    fn set_cursor_in(&self, conn: &Connection, cursor: &IndexerCursor) -> Result<()> {
        run(
            conn,
            "INSERT INTO indexer_state (name, signature, slot, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET signature = excluded.signature,
           slot = excluded.slot, updated_at = excluded.updated_at
         WHERE excluded.slot >= indexer_state.slot",
            params![PROGRAM_CURSOR, cursor.signature, i64_of(cursor.slot)?, self.now_seconds()],
        )?;
        Ok(())
    }

    pub fn set_cursor(&self, cursor: &IndexerCursor) -> Result<()> {
        self.with_conn(|conn| self.set_cursor_in(conn, cursor))
    }

    // -- event application ---------------------------------------------------

    /// Applies one batch of events and advances the cursor atomically. Returns
    /// the number of game changes.
    pub fn apply(&self, events: &IndexedEvents, cursor: &IndexerCursor) -> Result<usize> {
        self.transaction(|conn| {
            let mut changed = 0;
            for event in &events.initialized {
                self.apply_initialized(conn, event)?;
                changed += 1;
            }
            for event in &events.membership {
                self.apply_membership(conn, event)?;
            }
            for event in &events.completed {
                if self.apply_completed(conn, event)? {
                    changed += 1;
                }
                self.queue_verification_in(conn, &event.signature)?;
            }
            for event in &events.closed {
                self.apply_closed(conn, event)?;
                changed += 1;
            }
            self.set_cursor_in(conn, cursor)?;
            if changed > 0 {
                let mut cache = self.cache.lock().unwrap();
                cache.dirty = true;
                if self.cache_rebuild_due(&cache) {
                    self.rebuild_caches_in(conn, &mut cache)?;
                }
            }
            Ok(changed)
        })
    }

    fn cache_rebuild_due(&self, cache: &CacheState) -> bool {
        match cache.last_rebuild_at {
            None => true,
            Some(at) => (self.clock)() - at >= self.cache_rebuild_interval_ms,
        }
    }

    /// True when indexed changes are not yet reflected in the materialized caches.
    pub fn has_pending_cache_rebuild(&self) -> bool {
        self.cache.lock().unwrap().dirty
    }

    /// Milliseconds until a pending cache rebuild becomes due, or `None` when
    /// the caches are current. The indexer loop uses this to wake up and flush.
    pub fn ms_until_cache_flush(&self) -> Option<i64> {
        let cache = self.cache.lock().unwrap();
        if !cache.dirty {
            return None;
        }
        let Some(at) = cache.last_rebuild_at else {
            return Some(0);
        };
        Some((at + self.cache_rebuild_interval_ms - (self.clock)()).max(0))
    }

    /// Rebuilds dirty caches once the throttle window has passed (or
    /// immediately with `force`). Returns true when a rebuild ran.
    pub fn flush_caches(&self, force: bool) -> Result<bool> {
        {
            let cache = self.cache.lock().unwrap();
            if !cache.dirty {
                return Ok(false);
            }
            if !force && !self.cache_rebuild_due(&cache) {
                return Ok(false);
            }
        }
        self.rebuild_caches()?;
        Ok(true)
    }

    fn apply_initialized(&self, conn: &Connection, game: &GameInitializedEvent) -> Result<()> {
        let now = self.now_seconds();
        let is_private = i64::from(game.is_private);
        run(
            conn,
            "INSERT INTO game_initializations
           (game_key, signature, creator, game_type, ticket_amount, total_amount,
            max_tickets, min_tickets, token_mint, is_private, created_at, timeout, slot, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(game_key) DO UPDATE SET signature=excluded.signature,
           creator=excluded.creator, game_type=excluded.game_type,
           ticket_amount=excluded.ticket_amount, total_amount=excluded.total_amount,
           max_tickets=excluded.max_tickets, min_tickets=excluded.min_tickets,
           token_mint=excluded.token_mint, is_private=excluded.is_private,
           created_at=excluded.created_at, timeout=excluded.timeout,
           slot=excluded.slot, indexed_at=excluded.indexed_at",
            params![
                game.game_key,
                game.signature,
                game.creator,
                game.game_type,
                i64_of(game.ticket_amount)?,
                i64_of(game.total_amount)?,
                game.max_tickets,
                game.min_tickets,
                game.token_mint,
                is_private,
                i64_of(game.created_at)?,
                i64_of(game.timeout)?,
                i64_of(game.slot)?,
                now
            ],
        )?;
        run(
            conn,
            "INSERT OR IGNORE INTO gameplay_events
          (signature, game_key, token_mint, timestamp, slot, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?)",
            params![game.signature, game.game_key, game.token_mint, i64_of(game.created_at)?, i64_of(game.slot)?, now],
        )?;
        run(conn, "UPDATE games SET token_mint = ? WHERE game_key = ?", params![game.token_mint, game.game_key])?;

        let finalized = query_one(
            conn,
            "SELECT 1 AS found FROM games WHERE game_key = ? UNION SELECT 1 FROM game_closures WHERE game_key = ? LIMIT 1",
            params![game.game_key, game.game_key],
        )?;
        if finalized.is_none() {
            run(
                conn,
                "INSERT INTO active_games
             (game_key, creator, ticket_amount, total_amount, max_tickets, min_tickets,
              current_tickets, token_mint, is_private, created_at, timeout, signature, slot, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(game_key) DO UPDATE SET creator=excluded.creator,
             ticket_amount=excluded.ticket_amount, total_amount=excluded.total_amount,
             max_tickets=excluded.max_tickets, min_tickets=excluded.min_tickets,
             token_mint=excluded.token_mint, is_private=excluded.is_private,
             created_at=excluded.created_at, timeout=excluded.timeout,
             signature=excluded.signature, slot=excluded.slot, indexed_at=excluded.indexed_at",
                params![
                    game.game_key,
                    game.creator,
                    i64_of(game.ticket_amount)?,
                    i64_of(game.total_amount)?,
                    game.max_tickets,
                    game.min_tickets,
                    game.token_mint,
                    is_private,
                    i64_of(game.created_at)?,
                    i64_of(game.timeout)?,
                    game.signature,
                    i64_of(game.slot)?,
                    now
                ],
            )?;
        }
        self.refresh_lifecycle(conn, &game.game_key)
    }

    fn apply_membership(&self, conn: &Connection, event: &PlayerMembershipEvent) -> Result<()> {
        let joined_flag = event.kind == MembershipKind::Joined;
        let joined_at = if joined_flag { i64_of(event.timestamp)? } else { 0 };
        let joined = i64::from(joined_flag);
        let slot = i64_of(event.slot)?;
        run(
            conn,
            "INSERT INTO game_players
      (game_key, player, ticket_index, joined_at, is_joined, updated_slot)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(game_key, player) DO UPDATE SET
       ticket_index=CASE WHEN excluded.updated_slot >= game_players.updated_slot
         THEN excluded.ticket_index ELSE game_players.ticket_index END,
       joined_at=CASE WHEN excluded.joined_at > 0 AND
         (game_players.joined_at = 0 OR excluded.joined_at < game_players.joined_at)
         THEN excluded.joined_at ELSE game_players.joined_at END,
       is_joined=CASE WHEN excluded.updated_slot >= game_players.updated_slot
         THEN excluded.is_joined ELSE game_players.is_joined END,
       updated_slot=MAX(game_players.updated_slot, excluded.updated_slot)",
            params![event.game_key, event.player, event.ticket_index, joined_at, joined, slot],
        )?;
        run(
            conn,
            "INSERT INTO active_game_players
          (game_key, player, ticket_index, joined_at, is_joined, updated_slot)
         SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS
           (SELECT 1 FROM active_games WHERE game_key = ?)
         ON CONFLICT(game_key, player) DO UPDATE SET
           ticket_index=CASE WHEN excluded.updated_slot >= active_game_players.updated_slot
             THEN excluded.ticket_index ELSE active_game_players.ticket_index END,
           joined_at=CASE WHEN excluded.joined_at > 0 AND
             (active_game_players.joined_at = 0 OR excluded.joined_at < active_game_players.joined_at)
             THEN excluded.joined_at ELSE active_game_players.joined_at END,
           is_joined=CASE WHEN excluded.updated_slot >= active_game_players.updated_slot
             THEN excluded.is_joined ELSE active_game_players.is_joined END,
           updated_slot=MAX(active_game_players.updated_slot, excluded.updated_slot)",
            params![event.game_key, event.player, event.ticket_index, joined_at, joined, slot, event.game_key],
        )?;
        run(
            conn,
            "UPDATE active_games SET current_tickets=(SELECT COUNT(*) FROM active_game_players
           WHERE game_key = ? AND is_joined = 1), indexed_at=? WHERE game_key=?",
            params![event.game_key, self.now_seconds(), event.game_key],
        )?;
        Ok(())
    }

    fn apply_completed(&self, conn: &Connection, game: &GameCompletedEvent) -> Result<bool> {
        let now = self.now_seconds();
        let mint = query_one(
            conn,
            "SELECT token_mint FROM game_initializations WHERE game_key = ?
             UNION ALL SELECT token_mint FROM active_games WHERE game_key = ? LIMIT 1",
            params![game.game_key, game.game_key],
        )?
        .and_then(|row| match field(&row, "token_mint") {
            Value::Null => None,
            other => Some(other),
        })
        .map(|value| sql_bind(&value))
        .unwrap_or_else(|| SqlValue::Text(DEFAULT_TOKEN_MINT.into()));
        let changes = run(
            conn,
            "INSERT OR IGNORE INTO games
          (signature, game_key, winner, winner_amount, fee_amount, tickets_count,
           token_mint, timestamp, slot, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                game.signature,
                game.game_key,
                game.winner,
                i64_of(game.winner_amount)?,
                i64_of(game.fee_amount)?,
                game.tickets_count,
                mint,
                i64_of(game.timestamp)?,
                i64_of(game.slot)?,
                now
            ],
        )?;
        remove_active_game(conn, &game.game_key)?;
        self.refresh_lifecycle(conn, &game.game_key)?;
        Ok(changes > 0)
    }

    fn apply_closed(&self, conn: &Connection, game: &GameClosedEvent) -> Result<()> {
        let now = self.now_seconds();
        run(
            conn,
            "INSERT INTO game_closures (game_key, signature, timestamp, slot, indexed_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(game_key) DO UPDATE SET
           signature=excluded.signature, timestamp=excluded.timestamp,
           slot=excluded.slot, indexed_at=excluded.indexed_at",
            params![game.game_key, game.signature, i64_of(game.timestamp)?, i64_of(game.slot)?, now],
        )?;
        remove_active_game(conn, &game.game_key)?;
        self.refresh_lifecycle(conn, &game.game_key)
    }

    pub fn remove_stale_active_games(&self, game_keys: &[String]) -> Result<()> {
        if game_keys.is_empty() {
            return Ok(());
        }
        self.transaction(|conn| {
            for key in game_keys {
                remove_active_game(conn, key)?;
            }
            Ok(())
        })
    }

    fn refresh_lifecycle(&self, conn: &Connection, game_key: &str) -> Result<()> {
        run(
            conn,
            "INSERT INTO game_lifecycle
          (game_key, signature, token_mint, status, creator, game_type, ticket_amount,
           total_amount, max_tickets, min_tickets, is_private, created_at,
           timestamp, slot, indexed_at)
         SELECT i.game_key,
           COALESCE(g.signature, c.signature, i.signature), i.token_mint,
           CASE WHEN g.game_key IS NOT NULL THEN 'completed'
             WHEN c.game_key IS NOT NULL THEN 'cancelled' ELSE 'active' END,
           i.creator, i.game_type, i.ticket_amount, i.total_amount,
           i.max_tickets, i.min_tickets, i.is_private, i.created_at,
           COALESCE(g.timestamp, c.timestamp, i.created_at),
           COALESCE(g.slot, c.slot, i.slot), ?
         FROM game_initializations i
         LEFT JOIN games g ON g.game_key=i.game_key
         LEFT JOIN game_closures c ON c.game_key=i.game_key
         WHERE i.game_key=?
         ON CONFLICT(game_key) DO UPDATE SET signature=excluded.signature,
           token_mint=excluded.token_mint, status=excluded.status,
           creator=excluded.creator, game_type=excluded.game_type,
           ticket_amount=excluded.ticket_amount, total_amount=excluded.total_amount,
           max_tickets=excluded.max_tickets, min_tickets=excluded.min_tickets,
           is_private=excluded.is_private, created_at=excluded.created_at,
           timestamp=excluded.timestamp, slot=excluded.slot, indexed_at=excluded.indexed_at",
            params![self.now_seconds(), game_key],
        )?;
        Ok(())
    }

    // -- materialized caches -------------------------------------------------

    pub fn rebuild_caches(&self) -> Result<()> {
        self.transaction(|conn| {
            let mut cache = self.cache.lock().unwrap();
            self.rebuild_caches_in(conn, &mut cache)
        })
    }

    fn rebuild_caches_in(&self, conn: &Connection, cache: &mut CacheState) -> Result<()> {
        let started_at = (self.clock)();
        cache.leaderboard_windows.clear();
        cache.generation += 1;
        let now = self.now_seconds();
        conn.execute_batch("DELETE FROM token_stats_cache")?;
        conn.execute_batch(
            "INSERT INTO token_stats_cache
      (token_mint, games, unique_players, total_volume, total_fees, biggest_win_amount,
       biggest_win_winner, biggest_win_signature, latest_timestamp)
      SELECT totals.token_mint, totals.games, totals.unique_players,
        totals.total_volume, totals.total_fees,
        biggest.winner_amount, biggest.winner, biggest.signature, totals.latest_timestamp
      FROM (
        SELECT token_mint, COUNT(*) games, COUNT(DISTINCT winner) unique_players,
          SUM(winner_amount + fee_amount) total_volume,
          SUM(fee_amount) total_fees, MAX(timestamp) latest_timestamp
        FROM games GROUP BY token_mint
      ) totals
      LEFT JOIN games biggest ON biggest.signature=(
        SELECT signature FROM games candidate WHERE candidate.token_mint=totals.token_mint
        ORDER BY winner_amount DESC, slot DESC LIMIT 1
      )",
        )?;
        conn.execute_batch("DELETE FROM token_summary_cache")?;
        conn.execute_batch(
            "INSERT INTO token_summary_cache (token_mint, games, latest_timestamp)
      SELECT token_mint, COUNT(DISTINCT game_key), MAX(timestamp) FROM (
        SELECT game_key, token_mint, timestamp FROM gameplay_events
        UNION ALL SELECT game_key, token_mint, timestamp FROM games
      ) GROUP BY token_mint",
        )?;
        conn.execute_batch("DELETE FROM leaderboard_cache")?;
        conn.execute_batch(
            "INSERT INTO leaderboard_cache
      (scope, player, games_won, total_winnings, avg_win)
      SELECT '*', winner, COUNT(*), NULL, NULL FROM games GROUP BY winner",
        )?;
        conn.execute_batch(
            "INSERT INTO leaderboard_cache
      (scope, player, games_won, total_winnings, avg_win)
      SELECT token_mint, winner, COUNT(*), SUM(winner_amount), AVG(winner_amount)
      FROM games GROUP BY token_mint, winner",
        )?;
        let aggregate = query_one(
            conn,
            "SELECT (SELECT COUNT(DISTINCT game_key) FROM (
             SELECT game_key FROM games UNION ALL SELECT game_key FROM gameplay_events
           )) total_games, COUNT(DISTINCT winner) unique_players FROM games",
            [],
        )?;
        let last = query_one(conn, "SELECT signature FROM games ORDER BY slot DESC LIMIT 1", [])?;
        let total_games = or(aggregate.as_ref().map(|r| field(r, "total_games")), Value::from(0));
        let unique_players = or(aggregate.as_ref().map(|r| field(r, "unique_players")), Value::from(0));
        let last_signature = or(last.as_ref().map(|r| field(r, "signature")), Value::Null);
        run(
            conn,
            "UPDATE stats_cache SET total_games=?, unique_players=?,
         last_indexed_signature=?, updated_at=? WHERE id=1",
            params![sql_bind(&total_games), sql_bind(&unique_players), sql_bind(&last_signature), now],
        )?;
        // Only a rebuild that completed clears the flag; a failed one is retried by the next flush.
        cache.dirty = false;
        cache.last_rebuild_at = Some(started_at);
        Ok(())
    }

    // -- reads ---------------------------------------------------------------

    pub fn get_stats(&self, token_mint: Option<&str>) -> Result<IndexerStats> {
        let token_mint = non_empty(token_mint);
        self.with_conn(|conn| {
            let cache =
                query_one(conn, "SELECT total_games, unique_players, updated_at FROM stats_cache WHERE id=1", [])?;
            let stats = match token_mint {
                Some(mint) => query_all(conn, "SELECT * FROM token_stats_cache WHERE token_mint=?", params![mint])?,
                None => query_all(conn, "SELECT * FROM token_stats_cache ORDER BY latest_timestamp DESC", [])?,
            };
            let scoped = match token_mint {
                Some(mint) => query_one(
                    conn,
                    "SELECT s.games, COALESCE(t.unique_players, 0) players
               FROM token_summary_cache s LEFT JOIN token_stats_cache t
                 ON t.token_mint=s.token_mint WHERE s.token_mint=?",
                    params![mint],
                )?,
                None => None,
            };
            let cache_field = |key: &str| or(cache.as_ref().map(|r| field(r, key)), Value::from(0));
            let scoped_field = |key: &str| or(scoped.as_ref().map(|r| field(r, key)), Value::from(0));
            Ok(IndexerStats {
                total_games: if token_mint.is_some() { scoped_field("games") } else { cache_field("total_games") },
                unique_players: if token_mint.is_some() {
                    scoped_field("players")
                } else {
                    cache_field("unique_players")
                },
                financials: stats
                    .iter()
                    .map(|item| TokenFinancials {
                        token_mint: js_string(&field(item, "token_mint")),
                        total_volume: js_number(&field(item, "total_volume")),
                        total_fees: js_number(&field(item, "total_fees")),
                        biggest_win: if field(item, "biggest_win_winner").is_null() {
                            None
                        } else {
                            Some(BiggestWin {
                                amount: js_number(&field(item, "biggest_win_amount")),
                                winner: js_string(&field(item, "biggest_win_winner")),
                                signature: js_string(&field(item, "biggest_win_signature")),
                            })
                        },
                    })
                    .collect(),
                last_updated: cache_field("updated_at"),
            })
        })
    }

    pub fn get_games(&self, limit: i64, offset: i64, token_mint: Option<&str>) -> Result<GamesPage> {
        let token_mint = non_empty(token_mint);
        self.with_conn(|conn| {
            let (games, count) = match token_mint {
                Some(mint) => (
                    query_all(
                        conn,
                        "SELECT * FROM games WHERE token_mint=? ORDER BY timestamp DESC, slot DESC LIMIT ? OFFSET ?",
                        params![mint, limit, offset],
                    )?,
                    query_one(conn, "SELECT COUNT(*) count FROM games WHERE token_mint=?", params![mint])?,
                ),
                None => (
                    query_all(
                        conn,
                        "SELECT * FROM games ORDER BY timestamp DESC, slot DESC LIMIT ? OFFSET ?",
                        params![limit, offset],
                    )?,
                    query_one(conn, "SELECT COUNT(*) count FROM games", [])?,
                ),
            };
            Ok(GamesPage { games, total: or(count.map(|r| field(&r, "count")), Value::from(0)) })
        })
    }

    pub fn get_lifecycle(&self, limit: i64, token_mint: Option<&str>, game_type: Option<&str>) -> Result<Vec<Row>> {
        let mut conditions = Vec::new();
        let mut bindings: Vec<SqlValue> = Vec::new();
        if let Some(mint) = non_empty(token_mint) {
            conditions.push("l.token_mint=?");
            bindings.push(SqlValue::Text(mint.into()));
        }
        if let Some(kind) = non_empty(game_type) {
            conditions.push("l.game_type=?");
            bindings.push(SqlValue::Text(kind.into()));
        }
        bindings.push(SqlValue::Integer(limit));
        let filter = if conditions.is_empty() { String::new() } else { format!("WHERE {}", conditions.join(" AND ")) };
        let sql = format!(
            "SELECT l.*, COALESCE(a.timeout, i.timeout) timeout,
             g.winner, g.winner_amount, g.fee_amount, g.tickets_count
           FROM game_lifecycle l LEFT JOIN games g ON g.game_key=l.game_key
           LEFT JOIN active_games a ON a.game_key=l.game_key
           LEFT JOIN game_initializations i ON i.game_key=l.game_key
           {filter}
           ORDER BY l.timestamp DESC, l.slot DESC LIMIT ?"
        );
        self.with_conn(|conn| Ok(query_all(conn, &sql, params_from_iter(bindings))?))
    }

    pub fn get_game(&self, game_key: &str) -> Result<Option<Row>> {
        self.with_conn(|conn| {
            Ok(query_one(
                conn,
                "SELECT l.*, COALESCE(a.timeout, i.timeout) timeout,
             g.winner, g.winner_amount, g.fee_amount, g.tickets_count
           FROM game_lifecycle l LEFT JOIN games g ON g.game_key=l.game_key
           LEFT JOIN active_games a ON a.game_key=l.game_key
           LEFT JOIN game_initializations i ON i.game_key=l.game_key
           WHERE l.game_key=? LIMIT 1",
                params![game_key],
            )?)
        })
    }

    pub fn get_leaderboard(&self, limit: i64, token_mint: Option<&str>, period: LeaderboardPeriod) -> Result<Vec<Row>> {
        if let Some(window_seconds) = period.window_seconds() {
            return self.get_windowed_leaderboard(limit, period, window_seconds, token_mint);
        }
        // `tokenMint ?? "*"`: an empty string is a (never matching) scope.
        let scope = token_mint.unwrap_or("*");
        self.with_conn(|conn| {
            Ok(query_all(
                conn,
                "SELECT player, games_won, total_winnings, avg_win FROM leaderboard_cache
           WHERE scope=? ORDER BY
             CASE WHEN ?='*' THEN games_won ELSE total_winnings END DESC,
             player ASC LIMIT ?",
                params![scope, scope, limit],
            )?)
        })
    }

    fn get_windowed_leaderboard(
        &self,
        limit: i64,
        period: LeaderboardPeriod,
        window_seconds: i64,
        token_mint: Option<&str>,
    ) -> Result<Vec<Row>> {
        let take = |rows: &[Row]| -> Vec<Row> {
            rows.iter().take(usize::try_from(limit.max(0)).unwrap_or(usize::MAX)).cloned().collect()
        };
        let key = format!("{}:{}", period.as_str(), token_mint.unwrap_or("*"));
        let now = (self.clock)();
        let generation = {
            let cache = self.cache.lock().unwrap();
            if let Some((expires_at, rows)) = cache.leaderboard_windows.get(&key) {
                if *expires_at > now {
                    return Ok(take(rows));
                }
            }
            cache.generation
        };
        let since = now.div_euclid(1000) - window_seconds;
        // Served by idx_games_token (token_mint, timestamp) or idx_games_timestamp.
        let result = self.with_conn(|conn| {
            Ok(match non_empty(token_mint) {
                Some(mint) => query_all(
                    conn,
                    "SELECT winner player, COUNT(*) games_won, SUM(winner_amount) total_winnings,
                 AVG(winner_amount) avg_win
               FROM games WHERE token_mint=? AND timestamp>=?
               GROUP BY winner ORDER BY total_winnings DESC, player ASC LIMIT ?",
                    params![mint, since, LEADERBOARD_MAX_ROWS],
                )?,
                None => query_all(
                    conn,
                    "SELECT winner player, COUNT(*) games_won, NULL total_winnings, NULL avg_win
               FROM games WHERE timestamp>=?
               GROUP BY winner ORDER BY games_won DESC, player ASC LIMIT ?",
                    params![since, LEADERBOARD_MAX_ROWS],
                )?,
            })
        })?;
        self.store_window(key, generation, now, &result);
        Ok(take(&result))
    }

    /// The cache generation a windowed query starts from.
    #[cfg(test)]
    pub(super) fn cache_generation(&self) -> u64 {
        self.cache.lock().unwrap().generation
    }

    /// Caches a windowed result unless a rebuild ran since `generation` was read:
    /// the rows may predate it, and the rebuild already cleared the windows.
    pub(super) fn store_window(&self, key: String, generation: u64, now: i64, rows: &[Row]) {
        let mut cache = self.cache.lock().unwrap();
        if cache.leaderboard_windows.len() >= LEADERBOARD_CACHE_MAX_ENTRIES {
            cache.leaderboard_windows.clear();
        }
        if self.leaderboard_cache_ttl_ms > 0 && cache.generation == generation {
            cache.leaderboard_windows.insert(key, (now + self.leaderboard_cache_ttl_ms, rows.to_vec()));
        }
    }

    pub fn get_tokens(&self) -> Result<Vec<Row>> {
        self.with_conn(|conn| {
            Ok(query_all(
                conn,
                "SELECT token_mint tokenMint, games, latest_timestamp latestTimestamp
           FROM token_summary_cache ORDER BY games DESC, latest_timestamp DESC",
                [],
            )?)
        })
    }

    pub fn get_active_games(&self, player: Option<&str>) -> Result<Vec<Row>> {
        let player = non_empty(player);
        let rows = self.with_conn(|conn| {
            Ok(match player {
                Some(player) => query_all(
                    conn,
                    "SELECT DISTINCT a.*, l.game_type FROM active_games a
             LEFT JOIN active_game_players p ON p.game_key=a.game_key AND p.is_joined=1
             LEFT JOIN game_lifecycle l ON l.game_key=a.game_key
             WHERE a.creator=? OR p.player=? ORDER BY a.created_at DESC",
                    params![player, player],
                )?,
                None => query_all(
                    conn,
                    "SELECT a.*, l.game_type FROM active_games a
             LEFT JOIN game_lifecycle l ON l.game_key=a.game_key ORDER BY a.created_at DESC",
                    [],
                )?,
            })
        })?;
        Ok(rows
            .into_iter()
            .map(|mut game| {
                let normalized = boolean_integer(&field(&game, "is_private"));
                game.insert("is_private".into(), normalized);
                game
            })
            .collect())
    }

    pub fn get_player_games(&self, player: &str, limit: i64, offset: i64) -> Result<Vec<Row>> {
        let sql = format!(
            "SELECT l.*, COALESCE(a.timeout, i.timeout) timeout,
             g.winner, g.winner_amount, g.fee_amount,
             COALESCE(g.tickets_count, a.current_tickets,
               (SELECT COUNT(*) FROM game_players joined
                WHERE joined.game_key=l.game_key AND joined.is_joined=1)) tickets_count,
             CASE WHEN l.creator=? THEN 1 ELSE 0 END is_creator,
             CASE WHEN p.player IS NOT NULL THEN 1 ELSE 0 END is_player,
             COALESCE(p.is_joined, 0) is_joined
           FROM game_lifecycle l LEFT JOIN games g ON g.game_key=l.game_key
           LEFT JOIN active_games a ON a.game_key=l.game_key
           LEFT JOIN game_initializations i ON i.game_key=l.game_key
           LEFT JOIN game_players p ON p.game_key=l.game_key AND p.player=?
           WHERE l.game_key IN ({PLAYER_GAME_KEYS_SQL})
           ORDER BY l.timestamp DESC, l.slot DESC LIMIT ? OFFSET ?"
        );
        self.with_conn(|conn| Ok(query_all(conn, &sql, params![player, player, player, player, limit, offset])?))
    }

    pub fn get_player_profile(&self, player: &str) -> Result<PlayerProfile> {
        let summary_sql = format!(
            "SELECT COUNT(*) related_games,
              COALESCE(SUM(CASE WHEN l.creator=? THEN 1 ELSE 0 END),0) created_games,
              COALESCE(SUM(CASE WHEN p.player IS NOT NULL THEN 1 ELSE 0 END),0) played_games,
              COALESCE(SUM(CASE WHEN l.status='active' THEN 1 ELSE 0 END),0) active_games,
              COALESCE(SUM(CASE WHEN l.status='completed' THEN 1 ELSE 0 END),0) completed_games,
              COALESCE(SUM(CASE WHEN l.status='cancelled' THEN 1 ELSE 0 END),0) cancelled_games,
              COALESCE(SUM(CASE WHEN l.status='completed' AND g.winner=? THEN 1 ELSE 0 END),0) wins,
              COALESCE(SUM(CASE WHEN l.status='completed' AND p.player IS NOT NULL
                AND g.winner IS NOT NULL AND g.winner!=? THEN 1 ELSE 0 END),0) losses,
              MAX(l.timestamp) last_activity
             FROM game_lifecycle l LEFT JOIN games g ON g.game_key=l.game_key
             LEFT JOIN game_players p ON p.game_key=l.game_key AND p.player=?
             WHERE l.game_key IN ({PLAYER_GAME_KEYS_SQL})"
        );
        self.with_conn(|conn| {
            // An aggregate without GROUP BY always yields exactly one row.
            let summary = query_one(conn, &summary_sql, params![player, player, player, player, player, player])?
                .ok_or_else(|| anyhow!("Player summary query returned no row"))?;
            let tokens = query_all(
                conn,
                "SELECT l.token_mint, COUNT(*) games_played,
            COALESCE(SUM(CASE WHEN l.game_type='coinflip' THEN COALESCE(l.ticket_amount,0) ELSE 0 END),0) staked_amount,
            COALESCE(SUM(CASE WHEN g.winner=? THEN COALESCE(g.winner_amount,0) ELSE 0 END),0) won_amount
           FROM game_players p JOIN game_lifecycle l ON l.game_key=p.game_key
           LEFT JOIN games g ON g.game_key=l.game_key WHERE p.player=?
           GROUP BY l.token_mint ORDER BY games_played DESC, l.token_mint",
                params![player, player],
            )?;
            let frequent_players = query_all(
                conn,
                "SELECT other.player, COUNT(DISTINCT mine.game_key) games_together
           FROM game_players mine JOIN game_players other
             ON other.game_key=mine.game_key AND other.player!=mine.player
           JOIN game_lifecycle l ON l.game_key=mine.game_key AND l.status='completed'
           WHERE mine.player=? GROUP BY other.player
           ORDER BY games_together DESC, other.player LIMIT 5",
                params![player],
            )?;
            let backfill =
                query_one(conn, "SELECT complete FROM historical_backfill WHERE name=?", params![BACKFILL_NAME])?;
            Ok(PlayerProfile {
                summary,
                tokens,
                frequent_players,
                history_complete: backfill.map(|row| field(&row, "complete")) == Some(Value::from(1)),
            })
        })
    }

    pub fn get_backfill_state(&self) -> Result<HistoricalBackfillState> {
        let result = self.with_conn(|conn| {
            Ok(query_one(conn, "SELECT * FROM historical_backfill WHERE name=?", params![BACKFILL_NAME])?)
        })?;
        let get = |key: &str| or(result.as_ref().map(|r| field(r, key)), Value::from(0));
        let number = |key: &str| js_number(&get(key)).as_i64().unwrap_or(0);
        let before = result.as_ref().map(|r| field(r, "before_signature")).unwrap_or(Value::Null);
        Ok(HistoricalBackfillState {
            before_signature: if before.is_null() { None } else { js_string(&before).as_str().map(String::from) },
            pages: number("pages"),
            transactions: number("transactions"),
            initialized_events: number("initialized_events"),
            closed_events: number("closed_events"),
            complete: js_number(&get("complete")) == 1,
        })
    }
}

fn sql_bind(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Value::Number(n) => match n.as_i64() {
            Some(i) => SqlValue::Integer(i),
            None => SqlValue::Real(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

fn remove_active_game(conn: &Connection, game_key: &str) -> Result<()> {
    run(conn, "DELETE FROM active_game_players WHERE game_key = ?", params![game_key])?;
    run(conn, "DELETE FROM active_games WHERE game_key = ?", params![game_key])?;
    Ok(())
}

fn migrate_legacy_schema(conn: &Connection) -> Result<()> {
    let table = query_one(
        conn,
        "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?",
        params!["active_game_players"],
    )?;
    if table.is_none() {
        return Ok(());
    }
    let columns: Vec<String> = query_all(conn, "PRAGMA table_info(active_game_players)", [])?
        .iter()
        .filter_map(|column| column.get("name").and_then(Value::as_str).map(String::from))
        .collect();
    let mut changed = false;
    if !columns.iter().any(|c| c == "is_joined") {
        conn.execute_batch("ALTER TABLE active_game_players ADD COLUMN is_joined INTEGER NOT NULL DEFAULT 1")?;
        changed = true;
    }
    if !columns.iter().any(|c| c == "updated_slot") {
        conn.execute_batch("ALTER TABLE active_game_players ADD COLUMN updated_slot INTEGER NOT NULL DEFAULT 0")?;
        changed = true;
    }
    if changed {
        conn.execute_batch("DROP INDEX IF EXISTS idx_active_player")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory() -> IndexerDatabase {
        IndexerDatabase::open(":memory:").unwrap()
    }

    #[test]
    fn parses_and_names_leaderboard_periods() {
        for (text, period) in
            [("24h", LeaderboardPeriod::Day), ("7d", LeaderboardPeriod::Week), ("all", LeaderboardPeriod::All)]
        {
            assert_eq!(LeaderboardPeriod::parse(text), Some(period));
            assert_eq!(period.as_str(), text);
        }
        assert_eq!(LeaderboardPeriod::parse("bogus"), None);
        assert_eq!(LeaderboardPeriod::parse(""), None);
        assert_eq!(LeaderboardPeriod::default(), LeaderboardPeriod::All);
    }

    #[test]
    fn only_rolling_periods_have_a_window() {
        assert_eq!(LeaderboardPeriod::Day.window_seconds(), Some(86_400));
        assert_eq!(LeaderboardPeriod::Week.window_seconds(), Some(604_800));
        assert_eq!(LeaderboardPeriod::All.window_seconds(), None);
    }

    #[test]
    fn reads_every_sqlite_type_as_json() {
        let rows = memory()
            .with_conn(|conn| Ok(query_all(conn, "SELECT NULL n, 7 i, 1.0 whole, 1.5 f, 'text' t, x'0aff' b", [])?))
            .unwrap();
        assert_eq!(
            Value::from(rows[0].clone().into_iter().collect::<serde_json::Map<_, _>>()),
            serde_json::json!({ "n": null, "i": 7, "whole": 1, "f": 1.5, "t": "text", "b": [10, 255] })
        );
    }

    #[test]
    fn binds_json_values_as_the_matching_sqlite_types() {
        assert_eq!(sql_bind(&Value::Null), SqlValue::Null);
        assert_eq!(sql_bind(&Value::Bool(true)), SqlValue::Integer(1));
        assert_eq!(sql_bind(&Value::Bool(false)), SqlValue::Integer(0));
        assert_eq!(sql_bind(&Value::from(-7)), SqlValue::Integer(-7));
        assert_eq!(sql_bind(&Value::from(1.5)), SqlValue::Real(1.5));
        // Beyond the signed 64-bit range a number can only be bound as a float.
        assert_eq!(sql_bind(&Value::from(u64::MAX)), SqlValue::Real(u64::MAX as f64));
        assert_eq!(sql_bind(&Value::from("text")), SqlValue::Text("text".into()));
        assert_eq!(sql_bind(&serde_json::json!([1, "a"])), SqlValue::Text("[1,\"a\"]".into()));
        assert_eq!(sql_bind(&serde_json::json!({ "k": 1 })), SqlValue::Text("{\"k\":1}".into()));
    }

    /// A file database whose connection is made to fail at close time.
    fn file_db() -> (tempfile::TempDir, std::path::PathBuf, IndexerDatabase) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("indexer.sqlite");
        let db = IndexerDatabase::open(&path).unwrap();
        db.save_verified_game("kept", "payload").unwrap();
        (dir, path, db)
    }

    fn kept_after_reopening(path: &Path) -> Option<String> {
        IndexerDatabase::open(path).unwrap().get_verified_game("kept").unwrap()
    }

    #[test]
    fn closing_survives_a_failed_checkpoint_and_keeps_committed_data() {
        let (_dir, path, db) = file_db();
        // An open transaction makes the WAL checkpoint fail.
        db.conn.lock().unwrap().as_ref().unwrap().execute_batch("BEGIN IMMEDIATE").unwrap();
        db.close();
        assert!(!db.is_open());
        assert_eq!(kept_after_reopening(&path).as_deref(), Some("payload"));
    }

    #[test]
    fn closing_survives_a_connection_that_refuses_to_close() {
        let (_dir, path, db) = file_db();
        {
            let guard = db.conn.lock().unwrap();
            // An unfinalized statement makes `sqlite3_close` report the handle busy.
            std::mem::forget(guard.as_ref().unwrap().prepare("SELECT 1").unwrap());
        }
        db.close();
        assert!(!db.is_open());
        assert_eq!(kept_after_reopening(&path).as_deref(), Some("payload"));
    }

    #[test]
    fn surfaces_a_failure_while_collecting_frequent_players() {
        let db = memory();
        let initialized = GameInitializedEvent {
            game_key: "g".into(),
            creator: "me".into(),
            game_type: "coinflip".into(),
            ticket_amount: 1,
            total_amount: 2,
            max_tickets: 2,
            min_tickets: 2,
            token_mint: "m".into(),
            is_private: false,
            created_at: 1,
            timeout: 1,
            signature: "s0".into(),
            slot: 1,
        };
        let joined = |player: &str, ticket_index| PlayerMembershipEvent {
            kind: MembershipKind::Joined,
            game_key: "g".into(),
            player: player.into(),
            tickets_count: 1,
            ticket_index,
            moved_participant: None,
            timestamp: 2,
            signature: "s1".into(),
            slot: 2,
        };
        let completed = GameCompletedEvent {
            game_key: "g".into(),
            winner: "me".into(),
            tickets_count: 2,
            winner_amount: 3,
            fee_amount: 0,
            timestamp: 3,
            signature: "s2".into(),
            slot: 3,
        };
        let opponent = "o".repeat(600);
        let events = IndexedEvents {
            initialized: vec![initialized],
            membership: vec![joined("me", 0), joined(&opponent, 1)],
            completed: vec![completed],
            closed: vec![],
        };
        db.apply(&events, &IndexerCursor { signature: "s2".into(), slot: 3 }).unwrap();
        let profile = db.get_player_profile("me").unwrap();
        assert_eq!(profile.frequent_players.len(), 1);

        // Reading the opponent's oversized row now fails, after the summary and
        // token queries (which only read the player's own rows) succeeded.
        db.with_conn(|conn| {
            // SAFETY: the connection is alive and locked for the whole call.
            unsafe { rusqlite::ffi::sqlite3_limit(conn.handle(), rusqlite::ffi::SQLITE_LIMIT_LENGTH, 400) };
            Ok(())
        })
        .unwrap();
        assert_eq!(db.get_player_games("me", 10, 0).unwrap().len(), 1);
        let error = db.get_player_profile("me").unwrap_err();
        assert!(error.to_string().to_lowercase().contains("too big"), "{error:#}");
    }
}
