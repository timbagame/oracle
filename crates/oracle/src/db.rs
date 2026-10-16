//! Oracle SQLite store for commitments, game tracking, player registries and
//! token policies (port of `database.ts`). Schema and SQL are unchanged so
//! existing databases open as-is.

use std::sync::Mutex;

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use timba_common::time::now_ms;
use timba_common::{error, info, warn};

use crate::token::policy::{normalize_mint, normalize_token_decimals, StoredTokenPolicy};

const DEFAULT_STATUS: &str = "pending";
const PENDING_SCAN_LIMIT: i64 = 50;
pub const COMPLETION_RECOVERY_COOLDOWN_MS: i64 = 5 * 60 * 1000;

mod sql {
    pub const INSERT_SECRET_KEY: &str =
        "INSERT INTO secret_keys (game_address, secret_key, random_hash, created_at) VALUES (?, ?, ?, ?)";
    pub const MARK_SECRET_KEY_USED: &str =
        "UPDATE secret_keys SET used = TRUE, committed_at = COALESCE(committed_at, created_at) WHERE game_address = ?";
    pub const MARK_SECRET_KEY_SIGNED: &str = "UPDATE secret_keys SET signed_at = COALESCE(signed_at, ?) WHERE game_address = ? AND used = FALSE AND committed_at IS NULL AND NOT EXISTS (SELECT 1 FROM game_tracking WHERE game_address = secret_keys.game_address AND status IN ('completed', 'cancelled'))";
    pub const MARK_SECRET_KEY_COMMITTED: &str =
        "UPDATE secret_keys SET committed_at = COALESCE(committed_at, ?) WHERE game_address = ? AND used = FALSE";
    pub const REACTIVATE_SECRET_KEY: &str =
        "UPDATE secret_keys SET used = FALSE, committed_at = COALESCE(committed_at, created_at) WHERE game_address = ?";
    pub const DELETE_SECRET_KEY: &str = "DELETE FROM secret_keys WHERE game_address = ?";
    pub const UPSERT_GAME_TRACKING: &str =
        "INSERT INTO game_tracking (game_address, status, game_type, last_checked, auto_complete_disabled)
     VALUES (?, ?, ?, ?, COALESCE((SELECT auto_complete_disabled FROM game_tracking WHERE game_address = ?), FALSE))
     ON CONFLICT(game_address) DO UPDATE SET
       status = excluded.status,
       game_type = excluded.game_type,
       last_checked = excluded.last_checked,
       auto_complete_disabled = COALESCE(game_tracking.auto_complete_disabled, excluded.auto_complete_disabled, FALSE)";
    pub const UPDATE_GAME_STATUS: &str = "UPDATE game_tracking SET status = ?, completion_failure_kind = NULL, completion_retry_after = NULL, completed_at = ?, last_checked = ? WHERE game_address = ?";
    pub const DELETE_GAME_PLAYERS: &str = "DELETE FROM game_players WHERE game_address = ?";
    pub const INCREMENT_COMPLETION_ATTEMPTS: &str = "UPDATE game_tracking SET completion_attempts = completion_attempts + 1, completion_failure_kind = 'permanent', completion_retry_after = NULL, last_checked = ? WHERE game_address = ?";
    pub const RECORD_TRANSIENT_COMPLETION_FAILURE: &str = "UPDATE game_tracking SET completion_failure_kind = CASE WHEN completion_failure_kind = 'permanent' THEN completion_failure_kind ELSE 'transient' END, last_checked = ? WHERE game_address = ? AND status = 'pending'";
    pub const SET_COMPLETION_RETRY_AFTER: &str = "UPDATE game_tracking SET completion_failure_kind = CASE WHEN completion_failure_kind = 'permanent' THEN completion_failure_kind ELSE 'transient' END, completion_retry_after = ?, last_checked = ? WHERE game_address = ? AND status = 'pending' AND (completion_retry_after IS NULL OR completion_retry_after <= ?)";
    pub const CLEAR_COMPLETION_RETRY_AFTER: &str =
        "UPDATE game_tracking SET completion_retry_after = NULL WHERE game_address = ?";
    pub const TOUCH_PENDING_GAME: &str = "UPDATE game_tracking SET last_checked = ? WHERE game_address = ?";
    pub const RESET_COMPLETION_ATTEMPTS: &str = "UPDATE game_tracking SET status = ?, completion_attempts = 0, completion_failure_kind = NULL, completion_retry_after = NULL, completed_at = NULL, last_checked = ? WHERE game_address = ?";
    pub const UPSERT_GAME_PLAYER: &str =
        "INSERT OR REPLACE INTO game_players (game_address, player_address, ticket_index, joined_at) VALUES (?, ?, ?, ?)";
    pub const DELETE_GAME_PLAYER_BY_TICKET: &str =
        "DELETE FROM game_players WHERE game_address = ? AND ticket_index = ?";
    pub const DELETE_GAME_PLAYER_BY_ADDRESS: &str =
        "DELETE FROM game_players WHERE game_address = ? AND player_address = ?";
    pub const UPDATE_GAME_METADATA: &str =
        "UPDATE game_tracking SET game_type = ?, last_checked = ? WHERE game_address = ?";
    pub const MARK_GAME_DESYNCED: &str = "UPDATE game_tracking SET status = ?, completion_failure_kind = 'permanent', completion_retry_after = NULL, completed_at = NULL, last_checked = ? WHERE game_address = ?";
    pub const SET_AUTO_COMPLETE_DISABLED: &str =
        "UPDATE game_tracking SET auto_complete_disabled = ?, last_checked = ? WHERE game_address = ?";
    pub const UPSERT_TOKEN_POLICY: &str =
        "INSERT INTO token_policies (mint, enabled, minimum_amount_raw, decimals, revision, effective_at)
    VALUES (?, ?, '0', ?, 1, ?)
    ON CONFLICT(mint) DO UPDATE SET
      enabled = excluded.enabled,
      minimum_amount_raw = '0',
      decimals = excluded.decimals,
      revision = token_policies.revision + 1,
      effective_at = excluded.effective_at";

    pub const SELECT_SECRET_KEY: &str =
        "SELECT secret_key, random_hash FROM secret_keys WHERE game_address = ? AND used = FALSE";
    pub const SELECT_SECRET_KEY_ANY: &str =
        "SELECT secret_key, random_hash, used FROM secret_keys WHERE game_address = ?";
    pub const SELECT_GAME_TYPE: &str = "SELECT game_type FROM game_tracking WHERE game_address = ?";
    pub const SELECT_GAME_STATUS: &str = "SELECT status, game_type FROM game_tracking WHERE game_address = ?";
    pub const SELECT_GAME_STATUS_WITH_ATTEMPTS: &str = "SELECT status, completion_attempts, completion_failure_kind, completion_retry_after, auto_complete_disabled FROM game_tracking WHERE game_address = ?";
    pub const SELECT_GAME_STATUS_WITH_AUTO_FLAG: &str =
        "SELECT status, auto_complete_disabled FROM game_tracking WHERE game_address = ?";
    pub const SELECT_PENDING_GAMES: &str =
        "SELECT game_address, completion_attempts FROM game_tracking WHERE status = ? ORDER BY last_checked ASC LIMIT ?";
    pub const SELECT_PENDING_GAMES_ACTIVE: &str = "SELECT game_address, completion_attempts FROM game_tracking WHERE status = ? AND auto_complete_disabled = FALSE AND (completion_retry_after IS NULL OR completion_retry_after <= ?) ORDER BY last_checked ASC LIMIT ?";
    pub const SELECT_PENDING_GAMES_WITH_ATTEMPTS: &str = "SELECT game_address, completion_attempts FROM game_tracking WHERE status = ? AND completion_attempts < ? ORDER BY last_checked ASC LIMIT ?";
    pub const SELECT_PENDING_GAMES_WITH_ATTEMPTS_ACTIVE: &str =
        "SELECT game_address, completion_attempts FROM game_tracking
      WHERE status = ?
        AND auto_complete_disabled = FALSE
        AND (completion_retry_after IS NULL OR completion_retry_after <= ?)
        AND (
          completion_attempts < ?
          OR (
            (completion_failure_kind IN ('transient')
             OR completion_failure_kind IS NULL)
            AND last_checked <= ?
          )
        )
      ORDER BY last_checked ASC LIMIT ?";
    pub const SELECT_SECRETS_STATS: &str =
        "SELECT COUNT(*) as total, SUM(CASE WHEN used = TRUE THEN 1 ELSE 0 END) as used FROM secret_keys";
    pub const SELECT_GAMES_STATS: &str = "SELECT
        SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled
      FROM game_tracking";
    pub const SELECT_PLAYERS_FOR_GAME: &str =
        "SELECT player_address FROM game_players WHERE game_address = ? ORDER BY ticket_index ASC";
    pub const SELECT_PLAYER_TICKET_STATS: &str = "SELECT COUNT(*) as count, MAX(ticket_index) as max_index, MIN(ticket_index) as min_index FROM game_players WHERE game_address = ?";
    pub const SELECT_TOKEN_POLICY: &str =
        "SELECT mint, enabled, decimals, revision, effective_at FROM token_policies WHERE mint = ?";
    pub const SELECT_TOKEN_POLICIES: &str =
        "SELECT mint, enabled, decimals, revision, effective_at FROM token_policies ORDER BY mint ASC";

    pub const COMPLETED_GAME_PREDICATE: &str = "status != ? AND completed_at IS NOT NULL AND completed_at < ?";
}

struct SchemaStep {
    sql: &'static str,
    log: &'static str,
    error: &'static str,
}

const TABLE_DEFINITIONS: &[SchemaStep] = &[
    SchemaStep {
        sql: "
      CREATE TABLE IF NOT EXISTS secret_keys (
        game_address TEXT PRIMARY KEY,
        secret_key TEXT NOT NULL,
        random_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        signed_at INTEGER,
        committed_at INTEGER,
        used BOOLEAN DEFAULT FALSE
      )
    ",
        log: "Ensuring secret_keys table exists",
        error: "Failed to ensure secret_keys table",
    },
    SchemaStep {
        sql: "
      CREATE TABLE IF NOT EXISTS game_tracking (
        game_address TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        game_type TEXT,
        last_checked INTEGER NOT NULL,
        completion_attempts INTEGER DEFAULT 0,
        completion_failure_kind TEXT,
        completion_retry_after INTEGER,
        completed_at INTEGER,
        auto_complete_disabled BOOLEAN NOT NULL DEFAULT FALSE
      )
    ",
        log: "Ensuring game_tracking table exists",
        error: "Failed to ensure game_tracking table",
    },
    SchemaStep {
        sql: "
      CREATE TABLE IF NOT EXISTS game_players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_address TEXT NOT NULL,
        player_address TEXT NOT NULL,
        ticket_index INTEGER NOT NULL,
        joined_at INTEGER NOT NULL,
        UNIQUE(game_address, ticket_index)
      )
    ",
        log: "Ensuring game_players table exists",
        error: "Failed to ensure game_players table",
    },
    SchemaStep {
        sql: "
      CREATE TABLE IF NOT EXISTS token_policies (
        mint TEXT PRIMARY KEY,
        enabled BOOLEAN NOT NULL,
        minimum_amount_raw TEXT NOT NULL DEFAULT '0',
        decimals INTEGER NOT NULL CHECK (decimals >= 0 AND decimals <= 15),
        revision INTEGER NOT NULL CHECK (revision > 0),
        effective_at INTEGER NOT NULL
      )
    ",
        log: "Ensuring token_policies table exists",
        error: "Failed to ensure token_policies table",
    },
];

const LEGACY_TICKET_MIGRATIONS: &[SchemaStep] = &[
    SchemaStep {
        sql: "ALTER TABLE game_players ADD COLUMN ticket_index INTEGER",
        log: "Adding ticket_index column to game_players",
        error: "Failed to add ticket_index column to game_players",
    },
    SchemaStep {
        sql: "DELETE FROM game_players",
        log: "Clearing legacy game_players rows after ticket_index migration",
        error: "Failed to clear legacy game_players rows during migration",
    },
];

const PLAYER_INDEX_DEFINITIONS: &[SchemaStep] = &[
    SchemaStep {
        sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_game_players_ticket ON game_players (game_address, ticket_index)",
        log: "Ensuring idx_game_players_ticket index exists",
        error: "Failed to ensure idx_game_players_ticket index",
    },
    SchemaStep {
        sql: "CREATE INDEX IF NOT EXISTS idx_game_players_game ON game_players (game_address)",
        log: "Ensuring idx_game_players_game index exists",
        error: "Failed to ensure idx_game_players_game index",
    },
];

const TRACKING_INDEX_DEFINITIONS: &[SchemaStep] = &[
    SchemaStep {
        sql: "CREATE INDEX IF NOT EXISTS idx_tracking_pending ON game_tracking (status, completion_attempts, last_checked)",
        log: "Ensuring idx_tracking_pending index exists",
        error: "Failed to ensure idx_tracking_pending index",
    },
    SchemaStep {
        sql: "CREATE INDEX IF NOT EXISTS idx_tracking_completed_at ON game_tracking (status, completed_at)",
        log: "Ensuring idx_tracking_completed_at index exists",
        error: "Failed to ensure idx_tracking_completed_at index",
    },
    SchemaStep {
        sql: "CREATE INDEX IF NOT EXISTS idx_tracking_completion_retry_after ON game_tracking (status, auto_complete_disabled, completion_retry_after, last_checked)",
        log: "Ensuring idx_tracking_completion_retry_after index exists",
        error: "Failed to ensure idx_tracking_completion_retry_after index",
    },
];

#[derive(Clone, PartialEq, Eq)]
pub struct SecretKeyData {
    pub secret_key: String,
    pub random_hash: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct SecretKeyInfo {
    pub secret_key: String,
    pub random_hash: String,
    pub used: bool,
}

/// The commitment secret never appears in `Debug` output (logs, panics).
impl std::fmt::Debug for SecretKeyData {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretKeyData")
            .field("secret_key", &"[redacted]")
            .field("random_hash", &self.random_hash)
            .finish()
    }
}

impl std::fmt::Debug for SecretKeyInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretKeyInfo")
            .field("secret_key", &"[redacted]")
            .field("random_hash", &self.random_hash)
            .field("used", &self.used)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingGame {
    pub game_address: String,
    pub completion_attempts: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompletionFailureKind {
    Transient,
    Permanent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionAttemptState {
    pub status: String,
    pub completion_attempts: i64,
    pub completion_failure_kind: Option<CompletionFailureKind>,
    pub completion_retry_after: Option<i64>,
    pub auto_complete_disabled: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStats {
    pub total_secrets: i64,
    pub used_secrets: i64,
    pub pending_games: i64,
    pub completed_games: i64,
    pub cancelled_games: i64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CleanupCounts {
    pub deleted_secrets: usize,
    pub deleted_games: usize,
    pub deleted_players: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResetFailure {
    NotFound,
    Finalized,
    Unchanged,
}

impl ResetFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotFound => "not-found",
            Self::Finalized => "finalized",
            Self::Unchanged => "unchanged",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToggleFailure {
    InvalidAddress,
    NotFound,
    Finalized,
    Unchanged,
}

impl ToggleFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidAddress => "invalid-address",
            Self::NotFound => "not-found",
            Self::Finalized => "finalized",
            Self::Unchanged => "unchanged",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlayerMutation {
    Joined { player_address: String, ticket_index: i64 },
    Unjoined { ticket_index: i64, moved_participant: Option<String> },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PlayerTicketStats {
    pub count: i64,
    pub max_index: Option<i64>,
    pub min_index: Option<i64>,
}

pub struct OracleDatabase {
    conn: Mutex<Option<Connection>>,
    file: String,
}

/// Logs and returns a default instead of failing (`executeDbOperation` with a default).
fn or_default<T>(result: Result<T>, message: &str, default: T) -> T {
    match result {
        Ok(value) => value,
        Err(e) => {
            error!("❌ {message}: {e:#}");
            default
        }
    }
}

/// Logs and wraps the error (`executeDbOperation` without a default).
fn strict<T>(result: rusqlite::Result<T>, message: &str) -> Result<T> {
    result.map_err(|e| {
        error!("❌ {message}: {e}");
        anyhow::Error::new(e).context(message.to_string())
    })
}

fn run(conn: &Connection, sql: &str, message: &str, params: impl rusqlite::Params) -> Result<usize> {
    strict(conn.prepare_cached(sql).and_then(|mut s| s.execute(params)), message)
}

fn mark_secret_key_committed(conn: &Connection, game: &str) -> Result<usize> {
    run(conn, sql::MARK_SECRET_KEY_COMMITTED, "Failed to mark secret key as committed", params![now_ms(), game])
}

fn update_game_status(conn: &Connection, game: &str, status: &str, message: &str) -> Result<()> {
    let now = now_ms();
    mark_secret_key_committed(conn, game)?;
    run(conn, sql::UPDATE_GAME_STATUS, message, params![status, now, now, game])?;
    Ok(())
}

impl OracleDatabase {
    pub fn open(file: &str) -> Result<Self> {
        let conn = Connection::open(file).with_context(|| format!("Failed to open database {file}"))?;
        let db = Self { conn: Mutex::new(Some(conn)), file: file.to_string() };
        if let Err(e) = db.initialize() {
            error!("❌ Database initialization failed: {e:#}");
            return Err(e);
        }
        info!("✅ Oracle database initialized");
        Ok(db)
    }

    pub fn file(&self) -> &str {
        &self.file
    }

    pub fn is_open(&self) -> bool {
        self.conn.lock().unwrap().is_some()
    }

    /// Queries block the calling worker (see `timba_common::blocking`).
    fn with_conn<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
        timba_common::blocking::blocking(|| {
            let mut guard = self.conn.lock().unwrap();
            let conn = guard.as_mut().ok_or_else(|| anyhow!("Database is closed"))?;
            f(conn)
        })
    }

    fn transaction<T>(&self, message: &str, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        self.with_conn(|conn| {
            let tx = strict(conn.transaction(), message)?;
            let value = f(&tx).map_err(|e| e.context(message.to_string()))?;
            strict(tx.commit(), message)?;
            Ok(value)
        })
    }

    fn initialize(&self) -> Result<()> {
        self.with_conn(|conn| {
            let pragmas = || -> rusqlite::Result<()> {
                conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
                conn.execute_batch("PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;")
            };
            if let Err(e) = pragmas() {
                warn!("⚠️ Failed to apply SQLite PRAGMAs: {e}");
            }
            execute_steps(conn, TABLE_DEFINITIONS)?;
            ensure_secret_schema(conn)?;
            let columns = table_columns(conn, "game_players")?;
            if !columns.iter().any(|c| c == "ticket_index") {
                execute_steps(conn, LEGACY_TICKET_MIGRATIONS)?;
            }
            execute_steps(conn, PLAYER_INDEX_DEFINITIONS)?;
            ensure_tracking_schema(conn)?;
            ensure_token_policy_schema(conn)?;
            execute_steps(conn, TRACKING_INDEX_DEFINITIONS)
        })
    }

    // -- secret keys ----------------------------------------------------------

    pub fn save_secret_key(&self, game: &str, secret_key: &str, random_hash: &str) -> Result<()> {
        self.with_conn(|c| {
            run(
                c,
                sql::INSERT_SECRET_KEY,
                &format!("Failed to save secret key for game {game}"),
                params![game, secret_key, random_hash, now_ms()],
            )
            .map(drop)
        })
    }

    pub fn delete_secret_key(&self, game: &str) -> Result<()> {
        self.with_conn(|c| run(c, sql::DELETE_SECRET_KEY, "Failed to delete secret key", [game]).map(drop))
    }

    pub fn get_secret_key(&self, game: &str) -> Option<SecretKeyData> {
        let result = self.with_conn(|c| {
            Ok(c.prepare_cached(sql::SELECT_SECRET_KEY)?
                .query_row([game], |r| Ok(SecretKeyData { secret_key: r.get(0)?, random_hash: r.get(1)? }))
                .optional()?)
        });
        or_default(result, "Failed to get secret key", None)
    }

    pub fn get_secret_key_info(&self, game: &str) -> Option<SecretKeyInfo> {
        let result = self.with_conn(|c| {
            Ok(c.prepare_cached(sql::SELECT_SECRET_KEY_ANY)?
                .query_row([game], |r| {
                    Ok(SecretKeyInfo {
                        secret_key: r.get(0)?,
                        random_hash: r.get(1)?,
                        used: r.get::<_, Option<bool>>(2)?.unwrap_or(false),
                    })
                })
                .optional()?)
        });
        or_default(result, "Failed to get secret key info", None)
    }

    pub fn mark_secret_key_used(&self, game: &str) -> Result<()> {
        self.with_conn(|c| run(c, sql::MARK_SECRET_KEY_USED, "Failed to mark secret key as used", [game]).map(drop))
    }

    pub fn mark_secret_key_signed(&self, game: &str) -> Result<()> {
        let changes = self.with_conn(|c| {
            run(c, sql::MARK_SECRET_KEY_SIGNED, "Failed to mark secret key as signed", params![now_ms(), game])
        })?;
        if changes != 1 {
            anyhow::bail!("Commitment is no longer eligible for creation signing");
        }
        Ok(())
    }

    pub fn mark_secret_key_committed(&self, game: &str) -> Result<()> {
        self.with_conn(|c| mark_secret_key_committed(c, game).map(drop))
    }

    pub fn cleanup_unsigned_commitments(&self, minutes_old: i64) -> usize {
        if minutes_old <= 0 {
            return 0;
        }
        let cutoff = now_ms() - minutes_old * 60 * 1000;
        let result = self.transaction("Failed to clean up unsigned commitments", |c| {
            c.execute(
                "DELETE FROM game_players
             WHERE game_address IN (
               SELECT game_address FROM secret_keys
               WHERE committed_at IS NULL AND signed_at IS NULL AND used = FALSE AND created_at < ?
             )",
                [cutoff],
            )?;
            c.execute(
                "DELETE FROM game_tracking
             WHERE status = ? AND game_address IN (
               SELECT game_address FROM secret_keys
               WHERE committed_at IS NULL AND signed_at IS NULL AND used = FALSE AND created_at < ?
             )",
                params![DEFAULT_STATUS, cutoff],
            )?;
            Ok(c.execute(
                "DELETE FROM secret_keys
             WHERE committed_at IS NULL
               AND signed_at IS NULL
               AND used = FALSE
               AND created_at < ?
               AND game_address NOT IN (
                 SELECT game_address FROM game_tracking WHERE status != ?
               )",
                params![cutoff, DEFAULT_STATUS],
            )?)
        });
        or_default(result, "Failed to clean up unsigned commitments", 0)
    }

    pub fn reactivate_secret_key(&self, game: &str) -> Result<bool> {
        self.with_conn(|c| run(c, sql::REACTIVATE_SECRET_KEY, "Failed to reactivate secret key", [game]).map(|n| n > 0))
    }

    // -- game tracking --------------------------------------------------------

    pub fn track_game(&self, game: &str, game_type: Option<&str>, preserve_finalized: bool) -> Result<()> {
        let game_type = game_type.filter(|t| !t.is_empty());
        if preserve_finalized {
            let existing = or_default(
                self.with_conn(|c| {
                    Ok(c.prepare_cached(sql::SELECT_GAME_STATUS)?
                        .query_row([game], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))
                        .optional()?)
                }),
                "Failed to lookup existing game status",
                None,
            );
            if let Some((status, existing_type)) = existing {
                if status != DEFAULT_STATUS {
                    if let Some(game_type) = game_type {
                        if existing_type.as_deref() != Some(game_type) {
                            self.with_conn(|c| {
                                run(
                                    c,
                                    sql::UPDATE_GAME_METADATA,
                                    "Failed to update finalized game metadata",
                                    params![game_type, now_ms(), game],
                                )
                            })?;
                        }
                    }
                    return Ok(());
                }
            }
        }
        self.with_conn(|c| {
            run(
                c,
                sql::UPSERT_GAME_TRACKING,
                "Failed to track game",
                params![game, DEFAULT_STATUS, game_type, now_ms(), game],
            )
            .map(drop)
        })
    }

    fn status_with_auto_flag(&self, game: &str, message: &str) -> Option<(String, bool)> {
        or_default(
            self.with_conn(|c| {
                Ok(c.prepare_cached(sql::SELECT_GAME_STATUS_WITH_AUTO_FLAG)?
                    .query_row([game], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<bool>>(1)?.unwrap_or(false))))
                    .optional()?)
            }),
            message,
            None,
        )
    }

    pub fn set_auto_complete_disabled(
        &self,
        game: &str,
        disabled: bool,
    ) -> Result<std::result::Result<bool, ToggleFailure>> {
        let normalized = game.trim();
        if normalized.is_empty() {
            return Ok(Err(ToggleFailure::InvalidAddress));
        }
        let Some((status, current)) = self.status_with_auto_flag(normalized, "Failed to lookup game status") else {
            return Ok(Err(ToggleFailure::NotFound));
        };
        let pending = status == DEFAULT_STATUS || status == "desynced";
        let finalized = status == "completed" || status == "cancelled";
        if !pending {
            return Ok(Err(if finalized { ToggleFailure::Finalized } else { ToggleFailure::Unchanged }));
        }
        if current == disabled {
            return Ok(Err(ToggleFailure::Unchanged));
        }
        self.with_conn(|c| {
            run(
                c,
                sql::SET_AUTO_COMPLETE_DISABLED,
                "Failed to update auto-complete state",
                params![disabled, now_ms(), normalized],
            )
        })?;
        Ok(Ok(disabled))
    }

    pub fn is_auto_complete_disabled(&self, game: &str) -> Option<bool> {
        let normalized = game.trim();
        if normalized.is_empty() {
            return None;
        }
        self.status_with_auto_flag(normalized, "Failed to lookup auto-complete status").map(|(_, d)| d)
    }

    pub fn get_completion_attempt_state(&self, game: &str) -> Option<CompletionAttemptState> {
        let normalized = game.trim();
        if normalized.is_empty() {
            return None;
        }
        or_default(
            self.with_conn(|c| {
                Ok(c.prepare_cached(sql::SELECT_GAME_STATUS_WITH_ATTEMPTS)?
                    .query_row([normalized], |r| {
                        let kind: Option<String> = r.get(2)?;
                        Ok(CompletionAttemptState {
                            status: r.get(0)?,
                            completion_attempts: r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                            completion_failure_kind: match kind.as_deref() {
                                Some("transient") => Some(CompletionFailureKind::Transient),
                                Some("permanent") => Some(CompletionFailureKind::Permanent),
                                _ => None,
                            },
                            completion_retry_after: r.get(3)?,
                            auto_complete_disabled: r.get::<_, Option<bool>>(4)?.unwrap_or(false),
                        })
                    })
                    .optional()?)
            }),
            "Failed to lookup completion state",
            None,
        )
    }

    // -- token policies -------------------------------------------------------

    pub fn set_token_policy(&self, mint: &str, enabled: bool, decimals: u32) -> Result<StoredTokenPolicy> {
        let mint = normalize_mint(mint).map_err(|e| anyhow!(e))?;
        let decimals = normalize_token_decimals(decimals as i64).map_err(|e| anyhow!(e))?;
        self.with_conn(|c| {
            run(
                c,
                sql::UPSERT_TOKEN_POLICY,
                &format!("Failed to update token policy for {mint}"),
                params![mint, enabled, decimals, now_ms()],
            )
        })?;
        self.get_token_policy(&mint)?.ok_or_else(|| anyhow!("Failed to load updated token policy for {mint}"))
    }

    fn map_policy(row: &rusqlite::Row<'_>) -> rusqlite::Result<(String, bool, Option<i64>, i64, i64)> {
        Ok((row.get(0)?, row.get::<_, Option<bool>>(1)?.unwrap_or(false), row.get(2)?, row.get(3)?, row.get(4)?))
    }

    fn to_policy(
        (mint, enabled, decimals, revision, effective_at): (String, bool, Option<i64>, i64, i64),
    ) -> Result<StoredTokenPolicy> {
        let decimals = decimals
            .ok_or_else(|| anyhow!("token decimals must be an integer from 0 to 15"))
            .and_then(|d| normalize_token_decimals(d).map_err(|e| anyhow!(e)))?;
        Ok(StoredTokenPolicy { mint, enabled, decimals, revision, effective_at_ms: effective_at })
    }

    pub fn get_token_policy(&self, mint: &str) -> Result<Option<StoredTokenPolicy>> {
        let mint = normalize_mint(mint).map_err(|e| anyhow!(e))?;
        let row = self.with_conn(|c| {
            strict(
                c.prepare_cached(sql::SELECT_TOKEN_POLICY)
                    .and_then(|mut s| s.query_row([&mint], Self::map_policy).optional()),
                "Failed to get token policy",
            )
        })?;
        row.map(Self::to_policy).transpose()
    }

    pub fn get_token_policies(&self) -> Result<Vec<StoredTokenPolicy>> {
        let rows = self.with_conn(|c| {
            strict(
                c.prepare_cached(sql::SELECT_TOKEN_POLICIES)
                    .and_then(|mut s| s.query_map([], Self::map_policy)?.collect::<rusqlite::Result<Vec<_>>>()),
                "Failed to list token policies",
            )
        })?;
        rows.into_iter().map(Self::to_policy).collect()
    }

    // -- status ---------------------------------------------------------------

    pub fn get_game_type(&self, game: &str) -> Option<String> {
        or_default(
            self.with_conn(|c| {
                Ok(c.prepare_cached(sql::SELECT_GAME_TYPE)?
                    .query_row([game], |r| r.get::<_, Option<String>>(0))
                    .optional()?
                    .flatten())
            }),
            "Failed to get game type",
            None,
        )
        .filter(|t| !t.is_empty())
    }

    pub fn get_game_status(&self, game: &str) -> Option<String> {
        or_default(
            self.with_conn(|c| {
                Ok(c.prepare_cached(sql::SELECT_GAME_STATUS)?
                    .query_row([game], |r| r.get::<_, String>(0))
                    .optional()?)
            }),
            "Failed to get game status",
            None,
        )
    }

    pub fn mark_game_completed(&self, game: &str) -> Result<()> {
        self.with_conn(|c| update_game_status(c, game, "completed", "Failed to mark game as completed"))
    }

    pub fn mark_game_closed(&self, game: &str) -> Result<()> {
        self.with_conn(|c| update_game_status(c, game, "cancelled", "Failed to mark game as closed"))
    }

    pub fn mark_game_desynced(&self, game: &str) -> Result<()> {
        self.with_conn(|c| {
            run(c, sql::MARK_GAME_DESYNCED, "Failed to mark game as desynced", params!["desynced", now_ms(), game])
                .map(drop)
        })
    }

    pub fn finalize_completed_game(&self, game: &str) -> Result<()> {
        self.transaction(&format!("Failed to finalize completed game {game}"), |c| {
            run(c, sql::MARK_SECRET_KEY_USED, "Failed to mark secret key as used", [game])?;
            update_game_status(c, game, "completed", "Failed to mark game as completed")?;
            run(c, sql::DELETE_GAME_PLAYERS, "Failed to delete player rows for completed game", [game])?;
            Ok(())
        })
    }

    pub fn increment_completion_attempts(&self, game: &str) -> Result<()> {
        self.with_conn(|c| {
            run(
                c,
                sql::INCREMENT_COMPLETION_ATTEMPTS,
                "Failed to increment completion attempts",
                params![now_ms(), game],
            )
            .map(drop)
        })
    }

    pub fn record_transient_completion_failure(&self, game: &str) -> Result<()> {
        self.with_conn(|c| {
            run(
                c,
                sql::RECORD_TRANSIENT_COMPLETION_FAILURE,
                "Failed to record transient completion failure",
                params![now_ms(), game],
            )
            .map(drop)
        })
    }

    /// Records the end of a transient automatic-completion burst. The first
    /// deadline wins if callers race; a later caller cannot extend it.
    pub fn set_completion_retry_after(&self, game: &str, retry_after_ms: i64) -> Result<bool> {
        let now = now_ms();
        self.with_conn(|c| {
            run(
                c,
                sql::SET_COMPLETION_RETRY_AFTER,
                "Failed to set completion retry cooldown",
                params![retry_after_ms, now, game, now],
            )
            .map(|n| n > 0)
        })
    }

    pub fn clear_completion_retry_after(&self, game: &str) -> Result<()> {
        self.with_conn(|c| {
            run(c, sql::CLEAR_COMPLETION_RETRY_AFTER, "Failed to clear completion retry cooldown", [game]).map(drop)
        })
    }

    pub fn reset_completion_attempts(
        &self,
        game: &str,
        allow_finalized: bool,
    ) -> Result<std::result::Result<(), ResetFailure>> {
        let Some(status) = self.get_game_status_or_log(game, "Failed to lookup existing game status") else {
            return Ok(Err(ResetFailure::NotFound));
        };
        let pending = status == DEFAULT_STATUS || status == "desynced";
        let finalized = status == "completed" || status == "cancelled";
        if !pending && !(allow_finalized && finalized) {
            return Ok(Err(ResetFailure::Finalized));
        }
        let updated = self.with_conn(|c| {
            run(
                c,
                sql::RESET_COMPLETION_ATTEMPTS,
                "Failed to reset completion attempts",
                params![DEFAULT_STATUS, now_ms() - 1, game],
            )
        })? > 0;
        if !updated {
            let state = self.get_completion_attempt_state(game);
            if state.is_some_and(|s| s.status == DEFAULT_STATUS && s.completion_attempts == 0) {
                return Ok(Ok(()));
            }
            return Ok(Err(ResetFailure::Unchanged));
        }
        Ok(Ok(()))
    }

    fn get_game_status_or_log(&self, game: &str, message: &str) -> Option<String> {
        or_default(
            self.with_conn(|c| {
                Ok(c.prepare_cached(sql::SELECT_GAME_STATUS)?
                    .query_row([game], |r| r.get::<_, String>(0))
                    .optional()?)
            }),
            message,
            None,
        )
    }

    pub fn touch_game_check(&self, game: &str) -> Result<()> {
        self.with_conn(|c| {
            run(c, sql::TOUCH_PENDING_GAME, "Failed to update last_checked for pending game", params![now_ms(), game])
                .map(drop)
        })
    }

    fn query_pending(&self, sql: &str, params: impl rusqlite::Params) -> Vec<PendingGame> {
        or_default(
            self.with_conn(|c| {
                Ok(c.prepare_cached(sql)?
                    .query_map(params, |r| {
                        Ok(PendingGame {
                            game_address: r.get(0)?,
                            completion_attempts: r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            }),
            "Failed to get pending games",
            Vec::new(),
        )
    }

    pub fn get_pending_games(&self, max_attempts: Option<i64>) -> Vec<PendingGame> {
        match max_attempts {
            Some(max) => self.query_pending(
                sql::SELECT_PENDING_GAMES_WITH_ATTEMPTS,
                params![DEFAULT_STATUS, max, PENDING_SCAN_LIMIT],
            ),
            None => self.query_pending(sql::SELECT_PENDING_GAMES, params![DEFAULT_STATUS, PENDING_SCAN_LIMIT]),
        }
    }

    pub fn get_active_pending_games(&self, max_attempts: Option<i64>) -> Vec<PendingGame> {
        let now = now_ms();
        match max_attempts {
            Some(max) => self.query_pending(
                sql::SELECT_PENDING_GAMES_WITH_ATTEMPTS_ACTIVE,
                params![DEFAULT_STATUS, now, max, now - COMPLETION_RECOVERY_COOLDOWN_MS, PENDING_SCAN_LIMIT],
            ),
            None => {
                self.query_pending(sql::SELECT_PENDING_GAMES_ACTIVE, params![DEFAULT_STATUS, now, PENDING_SCAN_LIMIT])
            }
        }
    }

    // -- statistics -----------------------------------------------------------

    pub fn get_stats(&self) -> DatabaseStats {
        let secrets = or_default(
            self.with_conn(|c| {
                Ok(c.query_row(sql::SELECT_SECRETS_STATS, [], |r| {
                    Ok((r.get::<_, Option<i64>>(0)?.unwrap_or(0), r.get::<_, Option<i64>>(1)?.unwrap_or(0)))
                })?)
            }),
            "Failed to get secrets stats",
            (0, 0),
        );
        let games = or_default(
            self.with_conn(|c| {
                Ok(c.query_row(sql::SELECT_GAMES_STATS, [DEFAULT_STATUS], |r| {
                    Ok((
                        r.get::<_, Option<i64>>(0)?.unwrap_or(0),
                        r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                        r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                    ))
                })?)
            }),
            "Failed to get games stats",
            (0, 0, 0),
        );
        DatabaseStats {
            total_secrets: secrets.0,
            used_secrets: secrets.1,
            pending_games: games.0,
            completed_games: games.1,
            cancelled_games: games.2,
        }
    }

    pub fn cleanup_old_records(&self, hours_old: i64) -> CleanupCounts {
        if hours_old == 0 {
            return CleanupCounts::default();
        }
        let cutoff = now_ms() - hours_old * 60 * 60 * 1000;
        let result = self.transaction("Failed to cleanup old records", |c| {
            let deleted_secrets = run(
                c,
                "DELETE FROM secret_keys
         WHERE created_at < ?
           AND game_address IN (
             SELECT game_address FROM game_tracking
             WHERE status IN ('completed', 'cancelled')
           )",
                "Failed to delete old secret keys",
                [cutoff],
            )?;
            let deleted_players = run(
                c,
                &format!(
                    "DELETE FROM game_players WHERE game_address IN (SELECT game_address FROM game_tracking WHERE {})",
                    sql::COMPLETED_GAME_PREDICATE
                ),
                "Failed to delete old player rows",
                params![DEFAULT_STATUS, cutoff],
            )?;
            let deleted_games = run(
                c,
                &format!("DELETE FROM game_tracking WHERE {}", sql::COMPLETED_GAME_PREDICATE),
                "Failed to delete old game tracking rows",
                params![DEFAULT_STATUS, cutoff],
            )?;
            info!(
                "🧹 Cleanup completed - Secrets: {deleted_secrets}, Games: {deleted_games}, Players: {deleted_players}"
            );
            Ok(CleanupCounts { deleted_secrets, deleted_games, deleted_players })
        });
        or_default(result, "Failed to cleanup old records", CleanupCounts::default())
    }

    pub fn close(&self) {
        let Some(conn) = self.conn.lock().unwrap().take() else { return };
        if let Err(e) = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())) {
            warn!("Failed to checkpoint WAL during close: {e}");
        }
        match conn.close() {
            Ok(()) => info!("📁 Database closed successfully"),
            Err((_, e)) => error!("❌ Failed to close database: {e}"),
        }
    }

    // -- players --------------------------------------------------------------

    pub fn add_player_to_game(&self, game: &str, player: &str, ticket_index: i64) -> Result<()> {
        self.with_conn(|c| {
            run(
                c,
                sql::UPSERT_GAME_PLAYER,
                "Failed to add player to game",
                params![game, player, ticket_index, now_ms()],
            )
            .map(drop)
        })
    }

    pub fn remove_player_from_game(&self, game: &str, ticket_index: i64) -> Result<()> {
        self.with_conn(|c| {
            run(c, sql::DELETE_GAME_PLAYER_BY_TICKET, "Failed to remove player from game", params![game, ticket_index])
                .map(drop)
        })
    }

    pub fn remove_player_address_from_game(&self, game: &str, player: &str) -> Result<()> {
        self.with_conn(|c| {
            run(
                c,
                sql::DELETE_GAME_PLAYER_BY_ADDRESS,
                "Failed to remove moved player from its previous index",
                params![game, player],
            )
            .map(drop)
        })
    }

    pub fn apply_player_mutations(&self, game: &str, operations: &[PlayerMutation]) -> Result<()> {
        if operations.is_empty() {
            return Ok(());
        }
        self.transaction(&format!("Failed to apply player mutations for game {game}"), |c| {
            let base = now_ms();
            for (index, op) in operations.iter().enumerate() {
                let joined_at = base + index as i64;
                match op {
                    PlayerMutation::Joined { player_address, ticket_index } => {
                        run(
                            c,
                            sql::UPSERT_GAME_PLAYER,
                            "Failed to add player to game",
                            params![game, player_address, ticket_index, joined_at],
                        )?;
                    }
                    PlayerMutation::Unjoined { ticket_index, moved_participant } => {
                        run(
                            c,
                            sql::DELETE_GAME_PLAYER_BY_TICKET,
                            "Failed to remove player from game",
                            params![game, ticket_index],
                        )?;
                        if let Some(moved) = moved_participant.as_deref().filter(|m| !m.is_empty()) {
                            run(
                                c,
                                sql::DELETE_GAME_PLAYER_BY_ADDRESS,
                                "Failed to remove moved player from its previous index",
                                params![game, moved],
                            )?;
                            run(
                                c,
                                sql::UPSERT_GAME_PLAYER,
                                "Failed to move player after unjoin",
                                params![game, moved, ticket_index, joined_at],
                            )?;
                        }
                    }
                }
            }
            Ok(())
        })
    }

    pub fn clear_stale_players_for_game(&self, game: &str) -> Result<()> {
        self.with_conn(|c| run(c, sql::DELETE_GAME_PLAYERS, "Failed to clear stale players for game", [game]))?;
        info!("🧹 Cleared stale player data for game {game}");
        Ok(())
    }

    pub fn get_game_players(&self, game: &str) -> Vec<String> {
        or_default(
            self.with_conn(|c| {
                Ok(c.prepare_cached(sql::SELECT_PLAYERS_FOR_GAME)?
                    .query_map([game], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            }),
            "Failed to get game players",
            Vec::new(),
        )
    }

    pub fn replace_game_players(&self, game: &str, players: &[String]) -> Result<()> {
        self.transaction(&format!("Failed to replace player registry for game {game}"), |c| {
            run(c, sql::DELETE_GAME_PLAYERS, "Failed to clear player registry for synchronization", [game])?;
            let base = now_ms();
            for (index, player) in players.iter().enumerate() {
                run(
                    c,
                    sql::UPSERT_GAME_PLAYER,
                    "Failed to replace player during registry synchronization",
                    params![game, player, index as i64, base + index as i64],
                )?;
            }
            Ok(())
        })
    }

    pub fn get_player_ticket_stats(&self, game: &str) -> PlayerTicketStats {
        or_default(
            self.with_conn(|c| {
                Ok(c.prepare_cached(sql::SELECT_PLAYER_TICKET_STATS)?.query_row([game], |r| {
                    Ok(PlayerTicketStats { count: r.get(0)?, max_index: r.get(1)?, min_index: r.get(2)? })
                })?)
            }),
            "Failed to query player ticket statistics",
            PlayerTicketStats::default(),
        )
    }
}

fn execute_steps(conn: &Connection, steps: &[SchemaStep]) -> Result<()> {
    for step in steps {
        info!("🛠️ {}", step.log);
        run(conn, step.sql, step.error, [])?;
    }
    Ok(())
}

fn table_columns(conn: &Connection, table: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info('{table}')"))?;
    let names = stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names)
}

fn ensure_secret_schema(conn: &Connection) -> Result<()> {
    let columns = table_columns(conn, "secret_keys")?;
    if !columns.iter().any(|c| c == "signed_at") {
        execute_steps(
            conn,
            &[
                SchemaStep {
                    sql: "ALTER TABLE secret_keys ADD COLUMN signed_at INTEGER",
                    log: "Adding signed_at column to secret_keys",
                    error: "Failed to add signed_at column to secret_keys",
                },
                SchemaStep {
                    sql: "UPDATE secret_keys SET signed_at = created_at WHERE signed_at IS NULL",
                    log: "Preserving existing commitments as signed",
                    error: "Failed to preserve existing commitments",
                },
            ],
        )?;
    }
    if !columns.iter().any(|c| c == "committed_at") {
        execute_steps(
            conn,
            &[
                SchemaStep {
                    sql: "ALTER TABLE secret_keys ADD COLUMN committed_at INTEGER",
                    log: "Adding committed_at column to secret_keys",
                    error: "Failed to add committed_at column to secret_keys",
                },
                SchemaStep {
                    sql: "UPDATE secret_keys SET committed_at = COALESCE(signed_at, created_at) WHERE committed_at IS NULL",
                    log: "Preserving existing commitments",
                    error: "Failed to preserve existing commitments",
                },
            ],
        )?;
    }
    Ok(())
}

fn ensure_tracking_schema(conn: &Connection) -> Result<()> {
    let columns = table_columns(conn, "game_tracking")?;
    if !columns.iter().any(|c| c == "auto_complete_disabled") {
        execute_steps(
            conn,
            &[SchemaStep {
                sql: "ALTER TABLE game_tracking ADD COLUMN auto_complete_disabled BOOLEAN NOT NULL DEFAULT FALSE",
                log: "Adding auto_complete_disabled column to game_tracking",
                error: "Failed to add auto_complete_disabled column to game_tracking",
            }],
        )?;
    }
    if !columns.iter().any(|c| c == "completion_failure_kind") {
        execute_steps(
            conn,
            &[SchemaStep {
                sql: "ALTER TABLE game_tracking ADD COLUMN completion_failure_kind TEXT",
                log: "Adding completion_failure_kind column to game_tracking",
                error: "Failed to add completion_failure_kind column to game_tracking",
            }],
        )?;
    }
    if !columns.iter().any(|c| c == "completion_retry_after") {
        execute_steps(
            conn,
            &[SchemaStep {
                sql: "ALTER TABLE game_tracking ADD COLUMN completion_retry_after INTEGER",
                log: "Adding completion_retry_after column to game_tracking",
                error: "Failed to add completion_retry_after column to game_tracking",
            }],
        )?;
    }
    Ok(())
}

fn ensure_token_policy_schema(conn: &Connection) -> Result<()> {
    let columns = table_columns(conn, "token_policies")?;
    if !columns.iter().any(|c| c == "decimals") {
        execute_steps(
            conn,
            &[SchemaStep {
                sql: "ALTER TABLE token_policies ADD COLUMN decimals INTEGER",
                log: "Adding decimals column to token_policies",
                error: "Failed to add decimals column to token_policies",
            }],
        )?;
    }
    run(
        conn,
        "UPDATE token_policies SET enabled = FALSE, decimals = 0 WHERE decimals IS NULL",
        "Failed to disable legacy token policies",
        [],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn debug_output_hides_commitment_secrets() {
        let data = super::SecretKeyData { secret_key: "s3cr3t".into(), random_hash: "hash".into() };
        let info = super::SecretKeyInfo { secret_key: "s3cr3t".into(), random_hash: "hash".into(), used: true };
        for printed in [format!("{data:?}"), format!("{info:?}")] {
            assert!(!printed.contains("s3cr3t") && printed.contains("hash"), "{printed}");
        }
    }

    use super::*;

    fn db() -> OracleDatabase {
        OracleDatabase::open(":memory:").unwrap()
    }

    #[test]
    fn secret_lifecycle() {
        let db = db();
        db.save_secret_key("g1", "aa", "bb").unwrap();
        db.track_game("g1", Some("coinflip"), false).unwrap();
        assert_eq!(db.get_secret_key("g1").unwrap().random_hash, "bb");
        db.mark_secret_key_signed("g1").unwrap();
        // Signing is idempotent (COALESCE) while the commitment stays unpublished.
        db.mark_secret_key_signed("g1").unwrap();
        db.mark_secret_key_committed("g1").unwrap();
        assert_eq!(
            db.mark_secret_key_signed("g1").unwrap_err().to_string(),
            "Commitment is no longer eligible for creation signing"
        );
        db.finalize_completed_game("g1").unwrap();
        assert!(db.get_secret_key("g1").is_none());
        assert!(db.get_secret_key_info("g1").unwrap().used);
        assert_eq!(db.get_game_status("g1").as_deref(), Some("completed"));
        let stats = db.get_stats();
        assert_eq!((stats.total_secrets, stats.used_secrets, stats.completed_games), (1, 1, 1));
        assert!(db.reactivate_secret_key("g1").unwrap());
        assert!(db.get_secret_key("g1").is_some());
    }

    #[test]
    fn preserve_finalized_tracking() {
        let db = db();
        db.track_game("g", Some("a"), false).unwrap();
        db.mark_game_closed("g").unwrap();
        db.track_game("g", Some("b"), true).unwrap();
        assert_eq!(db.get_game_status("g").as_deref(), Some("cancelled"));
        assert_eq!(db.get_game_type("g").as_deref(), Some("b"));
        db.track_game("g", None, false).unwrap();
        assert_eq!(db.get_game_status("g").as_deref(), Some("pending"));
        assert_eq!(db.get_game_type("g"), None);
    }

    #[test]
    fn retry_cooldown_and_pending_queries() {
        let db = db();
        db.track_game("g", None, false).unwrap();
        assert_eq!(db.get_active_pending_games(Some(5)).len(), 1);
        assert!(db.set_completion_retry_after("g", now_ms() + 60_000).unwrap());
        // A later caller cannot extend an existing cooldown.
        assert!(!db.set_completion_retry_after("g", now_ms() + 120_000).unwrap());
        assert!(db.get_active_pending_games(Some(5)).is_empty());
        db.clear_completion_retry_after("g").unwrap();
        for _ in 0..5 {
            db.increment_completion_attempts("g").unwrap();
        }
        assert!(db.get_active_pending_games(Some(5)).is_empty());
        let state = db.get_completion_attempt_state("g").unwrap();
        assert_eq!(state.completion_attempts, 5);
        assert_eq!(state.completion_failure_kind, Some(CompletionFailureKind::Permanent));
        assert_eq!(db.reset_completion_attempts("g", false).unwrap(), Ok(()));
        assert_eq!(db.get_active_pending_games(Some(5)).len(), 1);
        assert_eq!(db.reset_completion_attempts("missing", false).unwrap(), Err(ResetFailure::NotFound));
    }

    #[test]
    fn auto_complete_toggle() {
        let db = db();
        assert_eq!(db.set_auto_complete_disabled(" ", true).unwrap(), Err(ToggleFailure::InvalidAddress));
        assert_eq!(db.set_auto_complete_disabled("g", true).unwrap(), Err(ToggleFailure::NotFound));
        db.track_game("g", None, false).unwrap();
        assert_eq!(db.set_auto_complete_disabled("g", true).unwrap(), Ok(true));
        assert_eq!(db.set_auto_complete_disabled("g", true).unwrap(), Err(ToggleFailure::Unchanged));
        // Re-tracking keeps the operator's flag.
        db.track_game("g", None, false).unwrap();
        assert_eq!(db.is_auto_complete_disabled("g"), Some(true));
        assert!(db.get_active_pending_games(None).is_empty());
        db.mark_game_completed("g").unwrap();
        assert_eq!(db.set_auto_complete_disabled("g", false).unwrap(), Err(ToggleFailure::Finalized));
    }

    #[test]
    fn player_mutations() {
        let db = db();
        db.apply_player_mutations(
            "g",
            &[
                PlayerMutation::Joined { player_address: "a".into(), ticket_index: 0 },
                PlayerMutation::Joined { player_address: "b".into(), ticket_index: 1 },
                PlayerMutation::Joined { player_address: "c".into(), ticket_index: 2 },
                PlayerMutation::Unjoined { ticket_index: 0, moved_participant: Some("c".into()) },
            ],
        )
        .unwrap();
        assert_eq!(db.get_game_players("g"), vec!["c", "b"]);
        let stats = db.get_player_ticket_stats("g");
        assert_eq!((stats.count, stats.min_index, stats.max_index), (2, Some(0), Some(1)));
        db.replace_game_players("g", &["x".into()]).unwrap();
        assert_eq!(db.get_game_players("g"), vec!["x"]);
        db.clear_stale_players_for_game("g").unwrap();
        assert_eq!(db.get_player_ticket_stats("g"), PlayerTicketStats::default());
    }

    #[test]
    fn token_policies() {
        let db = db();
        let mint = "So11111111111111111111111111111111111111112";
        let first = db.set_token_policy(mint, true, 9).unwrap();
        assert_eq!(first.revision, 1);
        let second = db.set_token_policy(mint, false, 9).unwrap();
        assert_eq!((second.revision, second.enabled), (2, false));
        assert_eq!(db.get_token_policies().unwrap().len(), 1);
        assert!(db.set_token_policy("bad", true, 9).is_err());
        assert!(db.set_token_policy(mint, true, 16).is_err());
    }

    #[test]
    fn cleanup_unsigned_and_old() {
        let db = db();
        db.save_secret_key("g", "s", "h").unwrap();
        db.track_game("g", None, false).unwrap();
        db.with_conn(|c| Ok(c.execute("UPDATE secret_keys SET created_at = 0", [])?)).unwrap();
        assert_eq!(db.cleanup_unsigned_commitments(10), 1);
        assert_eq!(db.get_stats().pending_games, 0);

        db.save_secret_key("h", "s", "h").unwrap();
        db.track_game("h", None, false).unwrap();
        db.mark_game_completed("h").unwrap();
        db.with_conn(|c| Ok(c.execute("UPDATE secret_keys SET created_at = 0; ", [])?)).unwrap();
        db.with_conn(|c| Ok(c.execute("UPDATE game_tracking SET completed_at = 0", [])?)).unwrap();
        let counts = db.cleanup_old_records(48);
        assert_eq!((counts.deleted_secrets, counts.deleted_games), (1, 1));
        assert_eq!(db.cleanup_old_records(0), CleanupCounts::default());
    }

    #[test]
    fn migrates_legacy_schema() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.sqlite");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE secret_keys (game_address TEXT PRIMARY KEY, secret_key TEXT NOT NULL, random_hash TEXT NOT NULL, created_at INTEGER NOT NULL, used BOOLEAN DEFAULT FALSE);
                 INSERT INTO secret_keys VALUES ('g', 's', 'h', 5, FALSE);
                 CREATE TABLE game_tracking (game_address TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending', game_type TEXT, last_checked INTEGER NOT NULL, completion_attempts INTEGER DEFAULT 0, completed_at INTEGER);
                 CREATE TABLE game_players (id INTEGER PRIMARY KEY AUTOINCREMENT, game_address TEXT NOT NULL, player_address TEXT NOT NULL, joined_at INTEGER NOT NULL);
                 INSERT INTO game_players (game_address, player_address, joined_at) VALUES ('g', 'p', 1);
                 CREATE TABLE token_policies (mint TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL, minimum_amount_raw TEXT NOT NULL DEFAULT '0', revision INTEGER NOT NULL, effective_at INTEGER NOT NULL);
                 INSERT INTO token_policies VALUES ('So11111111111111111111111111111111111111112', TRUE, '5', 1, 1);",
            )
            .unwrap();
        }
        let db = OracleDatabase::open(path.to_str().unwrap()).unwrap();
        assert!(db.get_game_players("g").is_empty());
        let policy = &db.get_token_policies().unwrap()[0];
        assert!(!policy.enabled);
        assert_eq!(policy.decimals, 0);
        db.track_game("g", None, false).unwrap();
        // committed_at was backfilled, so the old commitment can no longer be signed.
        assert!(db.mark_secret_key_signed("g").is_err());
        db.close();
        assert!(!db.is_open());
    }
}
