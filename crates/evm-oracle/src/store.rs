//! Durable oracle state (port of `evm/store.ts`). The schema and SQL are unchanged so
//! databases written by the TypeScript service open as-is.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use timba_common::time::now_ms;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredGame {
    pub id: String,
    pub secret: String,
    pub intent: String,
    pub request: String,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingTransaction {
    pub game: String,
    pub raw: String,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cursor {
    pub block: i64,
    pub hash: String,
}

/// One decoded log ready for `INSERT OR IGNORE INTO events`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexedEvent {
    pub block: i64,
    pub hash: String,
    pub log_index: i64,
    pub data: String,
}

const SCHEMA: &str = "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), deployment TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS authorizations (id TEXT PRIMARY KEY, secret TEXT NOT NULL UNIQUE, intent TEXT NOT NULL, request TEXT NOT NULL, signature TEXT NOT NULL, next_check INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS pending (singleton INTEGER PRIMARY KEY CHECK(singleton=1), game TEXT NOT NULL, raw TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (block INTEGER NOT NULL, hash TEXT NOT NULL, log_index INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(hash,log_index));
      CREATE TABLE IF NOT EXISTS cursor (singleton INTEGER PRIMARY KEY CHECK(singleton=1), block INTEGER NOT NULL, hash TEXT NOT NULL);";

const LISTED_GAMES: &str = "
      SELECT json_extract(c.data, '$.event.reference.gameId') AS id
      FROM events c WHERE json_extract(c.data, '$.event.kind')='created'
      AND ((?1 IS NULL AND json_extract(c.data, '$.event.isPrivate')=0)
        OR (?1 IS NOT NULL AND (lower(json_extract(c.data, '$.event.creator'))=?1 OR EXISTS (
          SELECT 1 FROM events j WHERE json_extract(j.data, '$.event.reference.gameId')=json_extract(c.data, '$.event.reference.gameId') AND lower(json_extract(j.data, '$.event.player'))=?1))))
      ORDER BY c.block DESC, c.log_index DESC LIMIT 21 OFFSET ?2
    ";

fn stored_game(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredGame> {
    Ok(StoredGame {
        id: row.get("id")?,
        secret: row.get("secret")?,
        intent: row.get("intent")?,
        request: row.get("request")?,
        signature: row.get("signature")?,
    })
}

/// One database per deployment, also checked on open to prevent accidental cross-chain reuse.
pub struct EvmStore {
    pub db: Connection,
}

impl EvmStore {
    pub fn open(path: &str, deployment: &str) -> anyhow::Result<Self> {
        let db = Connection::open(path)?;
        #[cfg(unix)]
        if path != ":memory:" {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
        db.execute_batch(SCHEMA)?;
        db.execute("INSERT OR IGNORE INTO identity VALUES (1, ?)", [deployment])?;
        let saved: Option<String> = db.query_row("SELECT deployment FROM identity", [], |row| row.get(0)).optional()?;
        if saved.as_deref() != Some(deployment) {
            anyhow::bail!("EVM database belongs to a different deployment");
        }
        Ok(Self { db })
    }

    pub fn game(&self, id: &str) -> anyhow::Result<Option<StoredGame>> {
        Ok(self.db.query_row("SELECT * FROM authorizations WHERE id=?", [id], stored_game).optional()?)
    }

    /// Authorizations due for a settlement check, oldest check first.
    pub fn games(&self) -> anyhow::Result<Vec<StoredGame>> {
        let mut statement =
            self.db.prepare("SELECT * FROM authorizations WHERE next_check <= ? ORDER BY next_check LIMIT 100")?;
        let rows = statement.query_map([now_ms()], stored_game)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Saves terms and signature; the secret of an existing game id never changes.
    pub fn save(&self, game: &StoredGame) -> anyhow::Result<()> {
        self.db.execute(
            "INSERT INTO authorizations (id,secret,intent,request,signature) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET request=excluded.request, signature=excluded.signature,intent=excluded.intent,next_check=0",
            params![game.id, game.secret, game.intent, game.request, game.signature],
        )?;
        Ok(())
    }

    pub fn defer(&self, id: &str, milliseconds: i64) -> anyhow::Result<()> {
        self.db.execute("UPDATE authorizations SET next_check=? WHERE id=?", params![now_ms() + milliseconds, id])?;
        Ok(())
    }

    pub fn pending(&self) -> anyhow::Result<Option<PendingTransaction>> {
        Ok(self
            .db
            .query_row("SELECT game,raw,hash FROM pending", [], |row| {
                Ok(PendingTransaction { game: row.get(0)?, raw: row.get(1)?, hash: row.get(2)? })
            })
            .optional()?)
    }

    pub fn submit(&self, tx: &PendingTransaction) -> anyhow::Result<()> {
        self.db.execute("INSERT INTO pending VALUES (1, ?, ?, ?)", params![tx.game, tx.raw, tx.hash])?;
        Ok(())
    }

    pub fn clear_pending(&self) -> anyhow::Result<()> {
        self.db.execute_batch("DELETE FROM pending")?;
        Ok(())
    }

    pub fn cursor(&self) -> anyhow::Result<Option<Cursor>> {
        Ok(self
            .db
            .query_row("SELECT block,hash FROM cursor", [], |row| Ok(Cursor { block: row.get(0)?, hash: row.get(1)? }))
            .optional()?)
    }

    pub fn reset_index(&mut self) -> anyhow::Result<()> {
        let tx = self.db.transaction()?;
        tx.execute_batch("DELETE FROM events; DELETE FROM cursor; UPDATE authorizations SET next_check=0")?;
        tx.commit()?;
        Ok(())
    }

    /// Stores one scanned block range and advances the cursor atomically.
    pub fn record_index(&mut self, events: &[IndexedEvent], block: i64, hash: &str) -> anyhow::Result<()> {
        let tx = self.db.transaction()?;
        {
            let mut insert = tx.prepare("INSERT OR IGNORE INTO events VALUES (?,?,?,?)")?;
            for event in events {
                insert.execute(params![event.block, event.hash, event.log_index, event.data])?;
            }
            tx.execute(
                "INSERT INTO cursor VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET block=excluded.block,hash=excluded.hash",
                params![block, hash],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Up to 100 latest indexed events, optionally for one game.
    pub fn events(&self, game: Option<&str>) -> anyhow::Result<Vec<Value>> {
        let mut statement = self.db.prepare(
            "SELECT data FROM events WHERE (?1 IS NULL OR json_extract(data, '$.event.reference.gameId')=?1) ORDER BY block DESC,log_index DESC LIMIT 100",
        )?;
        let game = game.map(str::to_lowercase);
        let rows = statement.query_map([game], |row| row.get::<_, String>(0))?;
        rows.map(|data| Ok(serde_json::from_str(&data?)?)).collect()
    }

    /// Up to 21 indexed game ids (one extra to detect another page).
    pub fn listed_game_ids(&self, offset: i64, player: Option<&str>) -> anyhow::Result<Vec<String>> {
        let mut statement = self.db.prepare(LISTED_GAMES)?;
        let player = player.map(str::to_lowercase);
        let rows = statement.query_map(params![player, offset], |row| row.get::<_, Option<String>>(0))?;
        Ok(rows.map(|id| id.map(Option::unwrap_or_default)).collect::<rusqlite::Result<_>>()?)
    }

    pub fn close(self) {
        drop(self.db);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn id() -> String {
        format!("0x{}", "11".repeat(32))
    }

    fn secret() -> String {
        format!("0x{}", "22".repeat(32))
    }

    #[test]
    fn secrets_pending_bytes_and_database_identity_survive_restart() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("oracle.sqlite");
        let path = path.to_str().unwrap();
        let store = EvmStore::open(path, "31337:proxy").unwrap();
        let game = |secret: String, intent: &str, request: &str, signature: &str| StoredGame {
            id: id(),
            secret,
            intent: intent.into(),
            request: request.into(),
            signature: signature.into(),
        };
        store.save(&game(secret(), "terms", "first", "0x12")).unwrap();
        store.save(&game(format!("0x{}", "33".repeat(32)), "changed", "renewed", "0x34")).unwrap();
        let pending = PendingTransaction { game: id(), raw: "0xab".into(), hash: id() };
        store.submit(&pending).unwrap();
        store.close();

        let error = EvmStore::open(path, "1:proxy").err().unwrap();
        assert!(error.to_string().contains("different deployment"));
        let restored = EvmStore::open(path, "31337:proxy").unwrap();
        let saved = restored.game(&id()).unwrap().unwrap();
        assert_eq!(saved.secret, secret());
        assert_eq!(saved.intent, "changed");
        assert_eq!(saved.request, "renewed");
        assert_eq!(restored.pending().unwrap(), Some(pending));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    fn insert(store: &EvmStore, block: i64, event: Value) {
        store
            .db
            .execute(
                "INSERT INTO events VALUES (?,?,?,?)",
                params![block, format!("hash{block}"), 0, json!({ "event": event }).to_string()],
            )
            .unwrap();
    }

    #[test]
    fn indexed_game_discovery_excludes_private_games_from_public_lists() {
        let mut store = EvmStore::open(":memory:", "test").unwrap();
        insert(
            &store,
            1,
            json!({ "kind": "created", "reference": { "gameId": "0x1111" }, "creator": "alice", "isPrivate": false }),
        );
        insert(
            &store,
            2,
            json!({ "kind": "created", "reference": { "gameId": "0x2222" }, "creator": "bob", "isPrivate": true }),
        );
        insert(&store, 3, json!({ "kind": "joined", "reference": { "gameId": "0x2222" }, "player": "alice" }));
        assert_eq!(store.listed_game_ids(0, None).unwrap(), ["0x1111"]);
        assert_eq!(store.listed_game_ids(0, Some("ALICE")).unwrap(), ["0x2222", "0x1111"]);
        assert!(store.listed_game_ids(0, Some("stranger")).unwrap().is_empty());
        assert_eq!(store.events(Some("0x2222")).unwrap().len(), 2);
        store.reset_index().unwrap();
        assert!(store.listed_game_ids(0, Some("alice")).unwrap().is_empty());
    }

    #[test]
    fn defers_and_resets_settlement_checks() {
        let mut store = EvmStore::open(":memory:", "test").unwrap();
        store
            .save(&StoredGame {
                id: id(),
                secret: secret(),
                intent: "{}".into(),
                request: "{}".into(),
                signature: "0x".into(),
            })
            .unwrap();
        assert_eq!(store.games().unwrap().len(), 1);
        store.defer(&id(), 60_000).unwrap();
        assert!(store.games().unwrap().is_empty());
        store.reset_index().unwrap();
        assert_eq!(store.games().unwrap().len(), 1);
        store.record_index(&[], 9, "0xabc").unwrap();
        assert_eq!(store.cursor().unwrap(), Some(Cursor { block: 9, hash: "0xabc".into() }));
    }
}
