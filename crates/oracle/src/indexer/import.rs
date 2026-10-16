//! One-off import of a Cloudflare D1 export into a fresh indexer database
//! (port of `scripts/import-indexer.ts`).

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use rusqlite::Connection;

use super::database::IndexerDatabase;

pub const USAGE: &str = "Usage: timba-oracle import-indexer <d1-export.sql> [indexer.sqlite]";
pub const DEFAULT_TARGET: &str = "indexer.sqlite";

fn absolute(path: &Path) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

fn exec_file(path: &Path, sql: &str) -> Result<()> {
    let conn = Connection::open(path)?;
    // bun:sqlite leaves foreign keys off; the bundled SQLite turns them on, which
    // would reject exports that list child rows before their parents.
    conn.execute_batch("PRAGMA foreign_keys = OFF")?;
    let result = conn.execute_batch(sql).and_then(|()| conn.query_row("PRAGMA journal_mode = DELETE", [], |_| Ok(())));
    drop(conn);
    Ok(result?)
}

/// Imports `source` (a D1 SQL export) into a new indexer database at
/// `target`. Returns the absolute target path.
pub fn import_d1_export(source: impl AsRef<Path>, target: impl AsRef<Path>) -> Result<PathBuf> {
    let source = absolute(source.as_ref())?;
    let target = absolute(target.as_ref())?;
    if !source.exists() {
        bail!("D1 export not found: {}", source.display());
    }
    if target.exists() {
        bail!("Refusing to overwrite existing indexer database: {}", target.display());
    }

    let temporary = PathBuf::from(format!("{}.importing-{}", target.display(), std::process::id()));
    let result = (|| -> Result<()> {
        let sql = std::fs::read_to_string(&source).with_context(|| format!("Failed to read {}", source.display()))?;
        exec_file(&temporary, &sql)?;

        let indexer = IndexerDatabase::open(&temporary)?;
        let prepared = indexer.assert_d1_import_ready().and_then(|()| indexer.rebuild_caches());
        indexer.close();
        prepared?;

        exec_file(&temporary, "")?;
        std::fs::rename(&temporary, &target)?;
        Ok(())
    })();
    for suffix in ["", "-wal", "-shm"] {
        let path = PathBuf::from(format!("{}{suffix}", temporary.display()));
        let _ = std::fs::remove_file(path);
    }
    result?;
    Ok(target)
}

/// `timba-oracle import-indexer <d1-export.sql> [indexer.sqlite]`.
pub fn main(args: &[String]) -> Result<()> {
    let Some(source) = args.first() else {
        bail!(USAGE);
    };
    let target = args.get(1).map(String::as_str).unwrap_or(DEFAULT_TARGET);
    let imported = import_d1_export(source, target)?;
    println!("Imported D1 history into {}", imported.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HISTORY: &str = "
CREATE TABLE games (
  signature TEXT PRIMARY KEY, game_key TEXT NOT NULL, winner TEXT NOT NULL,
  winner_amount INTEGER NOT NULL, fee_amount INTEGER NOT NULL,
  tickets_count INTEGER NOT NULL, token_mint TEXT NOT NULL,
  timestamp INTEGER NOT NULL, slot INTEGER NOT NULL, indexed_at INTEGER NOT NULL
);
INSERT INTO games VALUES ('sig-1', 'game-1', 'winner-1', 190, 10, 2, 'mint-1', 1000, 5, 1000);
CREATE TABLE historical_backfill (
  name TEXT PRIMARY KEY, before_signature TEXT, pages INTEGER NOT NULL DEFAULT 0,
  transactions INTEGER NOT NULL DEFAULT 0, initialized_events INTEGER NOT NULL DEFAULT 0,
  closed_events INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
";

    fn complete_backfill() -> String {
        format!(
            "{HISTORY}INSERT INTO historical_backfill (name, complete, updated_at) VALUES ('game-lifecycle-v3-player-history', 1, 1000);"
        )
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".importing-"))
            .collect()
    }

    #[test]
    fn imports_a_complete_d1_export_and_rebuilds_caches() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("export.sql");
        let target = dir.path().join("indexer.sqlite");
        std::fs::write(&source, complete_backfill()).unwrap();

        let imported = import_d1_export(&source, &target).unwrap();
        assert_eq!(imported, target);
        assert!(leftovers(dir.path()).is_empty());

        let conn = Connection::open(&target).unwrap();
        let mode: String = conn.query_row("PRAGMA journal_mode", [], |row| row.get(0)).unwrap();
        assert_eq!(mode, "delete");
        drop(conn);
        let db = IndexerDatabase::open(&target).unwrap();
        let stats = db.get_stats(None).unwrap();
        assert_eq!(stats.total_games, serde_json::json!(1));
        assert_eq!(stats.financials.len(), 1);
        assert!(db.get_backfill_state().unwrap().complete);
        db.close();
    }

    #[test]
    fn imports_exports_that_list_child_rows_before_their_parents() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("export.sql");
        let target = dir.path().join("indexer.sqlite");
        let schema = include_str!("schema.sql");
        let rows = "INSERT INTO active_game_players VALUES ('game-2', 'player-1', 0, 1000, 1, 5);
INSERT INTO active_games (game_key, creator, ticket_amount, total_amount, max_tickets, min_tickets,
  token_mint, created_at, timeout, signature, slot, indexed_at)
  VALUES ('game-2', 'creator-1', 100, 100, 2, 2, 'mint-1', 1000, 60, 'sig-2', 5, 1000);";
        std::fs::write(&source, format!("{}\n{schema}\n{rows}", complete_backfill())).unwrap();

        import_d1_export(&source, &target).unwrap();
        let conn = Connection::open(&target).unwrap();
        let players: i64 = conn.query_row("SELECT COUNT(*) FROM active_game_players", [], |row| row.get(0)).unwrap();
        assert_eq!(players, 1);
    }

    #[test]
    fn rejects_incomplete_backfills_and_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("export.sql");
        let target = dir.path().join("indexer.sqlite");
        std::fs::write(&source, HISTORY).unwrap();

        let error = import_d1_export(&source, &target).unwrap_err();
        assert!(error.to_string().contains("D1 historical backfill is incomplete"));
        assert!(!target.exists());
        assert!(leftovers(dir.path()).is_empty());
    }

    fn files(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn imports_an_export_without_game_history() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("export.sql");
        let target = dir.path().join("indexer.sqlite");
        std::fs::write(
            &source,
            "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT);\nINSERT INTO d1_migrations VALUES (1, '0001_init.sql');\n",
        )
        .unwrap();
        main(&[source.display().to_string(), target.display().to_string()]).unwrap();
        assert_eq!(files(dir.path()), ["export.sql", "indexer.sqlite"]);
        let conn = Connection::open(&target).unwrap();
        let name: String = conn.query_row("SELECT name FROM d1_migrations", [], |row| row.get(0)).unwrap();
        assert_eq!(name, "0001_init.sql");
        drop(conn);
        let db = IndexerDatabase::open(&target).unwrap();
        assert!(!db.get_backfill_state().unwrap().complete);
        db.close();
    }

    #[test]
    fn removes_the_partial_database_when_the_export_cannot_be_applied() {
        for sql in
            ["THIS IS NOT SQL;\n", "PRAGMA journal_mode = WAL; CREATE TABLE marker (id INTEGER); THIS IS NOT SQL;"]
        {
            let dir = tempfile::tempdir().unwrap();
            let source = dir.path().join("export.sql");
            std::fs::write(&source, sql).unwrap();
            let error = import_d1_export(&source, dir.path().join("indexer.sqlite")).unwrap_err();
            assert!(format!("{error:#}").contains("syntax error"), "{error:#}");
            assert_eq!(files(dir.path()), ["export.sql"]);
        }
    }

    #[test]
    fn refuses_to_overwrite_and_reports_missing_inputs() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("export.sql");
        let target = dir.path().join("indexer.sqlite");
        let missing = import_d1_export(&source, &target).unwrap_err();
        assert_eq!(missing.to_string(), format!("D1 export not found: {}", source.display()));

        std::fs::write(&source, complete_backfill()).unwrap();
        std::fs::write(&target, "existing").unwrap();
        let error = import_d1_export(&source, &target).unwrap_err();
        assert_eq!(error.to_string(), format!("Refusing to overwrite existing indexer database: {}", target.display()));
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "existing");
        assert_eq!(main(&[]).unwrap_err().to_string(), USAGE);
    }
}
