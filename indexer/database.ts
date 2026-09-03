import { Database } from "bun:sqlite";
import type {
  ActiveGameRow,
  GameClosedEvent,
  GameCompletedEvent,
  GameInitializedEvent,
  HistoricalBackfillState,
  IndexedEvents,
  IndexerCursor,
  LifecycleRow,
  PlayerHistoryRow,
  PlayerMembershipEvent,
} from "./types.ts";

const PROGRAM_CURSOR = "program-transactions";
const BACKFILL_NAME = "game-lifecycle-v3-player-history";
const DEFAULT_TOKEN_MINT = "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS games (
  signature TEXT PRIMARY KEY, game_key TEXT NOT NULL, winner TEXT NOT NULL,
  winner_amount INTEGER NOT NULL, fee_amount INTEGER NOT NULL,
  tickets_count INTEGER NOT NULL, token_mint TEXT NOT NULL,
  timestamp INTEGER NOT NULL, slot INTEGER NOT NULL, indexed_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_games_game_key_unique ON games(game_key);
CREATE INDEX IF NOT EXISTS idx_games_timestamp ON games(timestamp DESC, slot DESC);
CREATE INDEX IF NOT EXISTS idx_games_winner ON games(winner);
CREATE INDEX IF NOT EXISTS idx_games_token ON games(token_mint, timestamp DESC);

CREATE TABLE IF NOT EXISTS active_games (
  game_key TEXT PRIMARY KEY, creator TEXT NOT NULL, ticket_amount INTEGER NOT NULL,
  total_amount INTEGER NOT NULL, max_tickets INTEGER NOT NULL,
  min_tickets INTEGER NOT NULL, current_tickets INTEGER NOT NULL DEFAULT 0,
  token_mint TEXT NOT NULL, is_private INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, timeout INTEGER NOT NULL, signature TEXT NOT NULL,
  slot INTEGER NOT NULL, indexed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_active_created ON active_games(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_active_creator ON active_games(creator);

CREATE TABLE IF NOT EXISTS active_game_players (
  game_key TEXT NOT NULL, player TEXT NOT NULL, ticket_index INTEGER NOT NULL,
  joined_at INTEGER NOT NULL, is_joined INTEGER NOT NULL, updated_slot INTEGER NOT NULL,
  PRIMARY KEY (game_key, player),
  FOREIGN KEY (game_key) REFERENCES active_games(game_key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_active_player ON active_game_players(player, is_joined);

CREATE TABLE IF NOT EXISTS game_players (
  game_key TEXT NOT NULL, player TEXT NOT NULL, ticket_index INTEGER NOT NULL,
  joined_at INTEGER NOT NULL, is_joined INTEGER NOT NULL, updated_slot INTEGER NOT NULL,
  PRIMARY KEY (game_key, player)
);
CREATE INDEX IF NOT EXISTS idx_game_players_player ON game_players(player, is_joined);

CREATE TABLE IF NOT EXISTS gameplay_events (
  signature TEXT PRIMARY KEY, game_key TEXT NOT NULL, token_mint TEXT NOT NULL,
  timestamp INTEGER NOT NULL, slot INTEGER NOT NULL, indexed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gameplay_token ON gameplay_events(token_mint);

CREATE TABLE IF NOT EXISTS game_initializations (
  game_key TEXT PRIMARY KEY, signature TEXT NOT NULL, creator TEXT NOT NULL,
  game_type TEXT NOT NULL CHECK (game_type IN ('coinflip', 'giveaway')),
  ticket_amount INTEGER NOT NULL, total_amount INTEGER NOT NULL,
  max_tickets INTEGER NOT NULL, min_tickets INTEGER NOT NULL, token_mint TEXT NOT NULL,
  is_private INTEGER NOT NULL, created_at INTEGER NOT NULL, timeout INTEGER NOT NULL,
  slot INTEGER NOT NULL, indexed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS game_closures (
  game_key TEXT PRIMARY KEY, signature TEXT NOT NULL, timestamp INTEGER NOT NULL,
  slot INTEGER NOT NULL, indexed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS game_lifecycle (
  game_key TEXT PRIMARY KEY, signature TEXT NOT NULL, token_mint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
  creator TEXT, game_type TEXT CHECK (game_type IN ('coinflip', 'giveaway')),
  ticket_amount INTEGER, total_amount INTEGER, max_tickets INTEGER, min_tickets INTEGER,
  is_private INTEGER, created_at INTEGER, timestamp INTEGER NOT NULL,
  slot INTEGER NOT NULL, indexed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_timestamp ON game_lifecycle(timestamp DESC, slot DESC);
CREATE INDEX IF NOT EXISTS idx_lifecycle_token ON game_lifecycle(token_mint);
CREATE INDEX IF NOT EXISTS idx_lifecycle_creator ON game_lifecycle(creator, timestamp DESC);

CREATE TABLE IF NOT EXISTS indexer_state (
  name TEXT PRIMARY KEY, signature TEXT NOT NULL, slot INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS historical_backfill (
  name TEXT PRIMARY KEY, before_signature TEXT, pages INTEGER NOT NULL DEFAULT 0,
  transactions INTEGER NOT NULL DEFAULT 0, initialized_events INTEGER NOT NULL DEFAULT 0,
  closed_events INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Retained for direct compatibility with a Cloudflare D1 export.
CREATE TABLE IF NOT EXISTS stats_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1), total_games INTEGER NOT NULL DEFAULT 0,
  total_volume INTEGER NOT NULL DEFAULT 0, total_fees INTEGER NOT NULL DEFAULT 0,
  unique_players INTEGER NOT NULL DEFAULT 0, biggest_win_amount INTEGER NOT NULL DEFAULT 0,
  biggest_win_winner TEXT, biggest_win_signature TEXT, last_indexed_signature TEXT,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO stats_cache
  (id, total_games, total_volume, total_fees, unique_players, biggest_win_amount, updated_at)
VALUES (1, 0, 0, 0, 0, 0, 0);

CREATE TABLE IF NOT EXISTS token_stats_cache (
  token_mint TEXT PRIMARY KEY, games INTEGER NOT NULL, total_volume INTEGER NOT NULL,
  unique_players INTEGER NOT NULL, total_fees INTEGER NOT NULL,
  biggest_win_amount INTEGER, biggest_win_winner TEXT,
  biggest_win_signature TEXT, latest_timestamp INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS token_summary_cache (
  token_mint TEXT PRIMARY KEY, games INTEGER NOT NULL, latest_timestamp INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS leaderboard_cache (
  scope TEXT NOT NULL, player TEXT NOT NULL, games_won INTEGER NOT NULL,
  total_winnings INTEGER, avg_win REAL, PRIMARY KEY (scope, player)
);
CREATE INDEX IF NOT EXISTS idx_leaderboard_rank
  ON leaderboard_cache(scope, games_won DESC, total_winnings DESC);
`;

type SqlValue = string | number | bigint | boolean | null;
type Row = Record<string, unknown>;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function rows<T>(value: unknown): T[] {
  return value as T[];
}

function row<T>(value: unknown): T | null {
  return (value ?? null) as T | null;
}

function booleanInteger(value: unknown): 0 | 1 {
  return Number(value) === 1 ? 1 : 0;
}

export class IndexerDatabase {
  private readonly sqlite: Database;

  constructor(file: string) {
    this.sqlite = new Database(file, { create: true, strict: true });
    this.sqlite.exec("PRAGMA journal_mode = WAL");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    this.sqlite.exec("PRAGMA busy_timeout = 5000");
    this.sqlite.exec(SCHEMA);
  }

  close(): void {
    try {
      this.sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      this.sqlite.close();
    }
  }

  importSql(sql: string): void {
    this.sqlite.transaction(() => this.sqlite.exec(sql))();
    this.rebuildCaches();
  }

  getCursor(): IndexerCursor | null {
    const cursor = row<IndexerCursor>(
      this.sqlite
        .query("SELECT signature, slot FROM indexer_state WHERE name = ?")
        .get(PROGRAM_CURSOR),
    );
    if (cursor) return cursor;
    return row<IndexerCursor>(
      this.sqlite.query("SELECT signature, slot FROM games ORDER BY slot DESC LIMIT 1").get(),
    );
  }

  setCursor(cursor: IndexerCursor): void {
    this.sqlite
      .query(
        `INSERT INTO indexer_state (name, signature, slot, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET signature = excluded.signature,
           slot = excluded.slot, updated_at = excluded.updated_at
         WHERE excluded.slot >= indexer_state.slot`,
      )
      .run(PROGRAM_CURSOR, cursor.signature, cursor.slot, nowSeconds());
  }

  apply(events: IndexedEvents, cursor: IndexerCursor): number {
    let changed = 0;
    this.sqlite.transaction(() => {
      for (const event of events.initialized) {
        this.applyInitialized(event);
        changed++;
      }
      for (const event of events.membership) this.applyMembership(event);
      for (const event of events.completed) {
        changed += this.applyCompleted(event) ? 1 : 0;
      }
      for (const event of events.closed) {
        this.applyClosed(event);
        changed++;
      }
      this.setCursor(cursor);
      if (changed > 0) this.rebuildCachesInTransaction();
    })();
    return changed;
  }

  private applyInitialized(game: GameInitializedEvent): void {
    const now = nowSeconds();
    const values: SqlValue[] = [
      game.gameKey,
      game.signature,
      game.creator,
      game.gameType,
      game.ticketAmount,
      game.totalAmount,
      game.maxTickets,
      game.minTickets,
      game.tokenMint,
      game.isPrivate ? 1 : 0,
      game.createdAt,
      game.timeout,
      game.slot,
      now,
    ];
    this.sqlite
      .query(
        `INSERT INTO game_initializations
           (game_key, signature, creator, game_type, ticket_amount, total_amount,
            max_tickets, min_tickets, token_mint, is_private, created_at, timeout, slot, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(game_key) DO UPDATE SET signature=excluded.signature,
           creator=excluded.creator, game_type=excluded.game_type,
           ticket_amount=excluded.ticket_amount, total_amount=excluded.total_amount,
           max_tickets=excluded.max_tickets, min_tickets=excluded.min_tickets,
           token_mint=excluded.token_mint, is_private=excluded.is_private,
           created_at=excluded.created_at, timeout=excluded.timeout,
           slot=excluded.slot, indexed_at=excluded.indexed_at`,
      )
      .run(...values);
    this.sqlite
      .query(
        `INSERT OR IGNORE INTO gameplay_events
          (signature, game_key, token_mint, timestamp, slot, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(game.signature, game.gameKey, game.tokenMint, game.createdAt, game.slot, now);
    this.sqlite
      .query("UPDATE games SET token_mint = ? WHERE game_key = ?")
      .run(game.tokenMint, game.gameKey);

    const finalized = this.sqlite
      .query(
        "SELECT 1 AS found FROM games WHERE game_key = ? UNION SELECT 1 FROM game_closures WHERE game_key = ? LIMIT 1",
      )
      .get(game.gameKey, game.gameKey);
    if (!finalized) {
      this.sqlite
        .query(
          `INSERT INTO active_games
             (game_key, creator, ticket_amount, total_amount, max_tickets, min_tickets,
              current_tickets, token_mint, is_private, created_at, timeout, signature, slot, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(game_key) DO UPDATE SET creator=excluded.creator,
             ticket_amount=excluded.ticket_amount, total_amount=excluded.total_amount,
             max_tickets=excluded.max_tickets, min_tickets=excluded.min_tickets,
             token_mint=excluded.token_mint, is_private=excluded.is_private,
             created_at=excluded.created_at, timeout=excluded.timeout,
             signature=excluded.signature, slot=excluded.slot, indexed_at=excluded.indexed_at`,
        )
        .run(
          game.gameKey,
          game.creator,
          game.ticketAmount,
          game.totalAmount,
          game.maxTickets,
          game.minTickets,
          game.tokenMint,
          game.isPrivate ? 1 : 0,
          game.createdAt,
          game.timeout,
          game.signature,
          game.slot,
          now,
        );
    }
    this.refreshLifecycle(game.gameKey);
  }

  private applyMembership(event: PlayerMembershipEvent): void {
    const joinedAt = event.kind === "joined" ? event.timestamp : 0;
    const joined = event.kind === "joined" ? 1 : 0;
    const upsert = `INSERT INTO game_players
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
       updated_slot=MAX(game_players.updated_slot, excluded.updated_slot)`;
    this.sqlite
      .query(upsert)
      .run(event.gameKey, event.player, event.ticketIndex, joinedAt, joined, event.slot);
    this.sqlite
      .query(
        `INSERT INTO active_game_players
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
           updated_slot=MAX(active_game_players.updated_slot, excluded.updated_slot)`,
      )
      .run(
        event.gameKey,
        event.player,
        event.ticketIndex,
        joinedAt,
        joined,
        event.slot,
        event.gameKey,
      );
    this.sqlite
      .query(
        `UPDATE active_games SET current_tickets=(SELECT COUNT(*) FROM active_game_players
           WHERE game_key = ? AND is_joined = 1), indexed_at=? WHERE game_key=?`,
      )
      .run(event.gameKey, nowSeconds(), event.gameKey);
  }

  private applyCompleted(game: GameCompletedEvent): boolean {
    const now = nowSeconds();
    const mint =
      row<{ token_mint: string }>(
        this.sqlite
          .query(
            `SELECT token_mint FROM game_initializations WHERE game_key = ?
             UNION ALL SELECT token_mint FROM active_games WHERE game_key = ? LIMIT 1`,
          )
          .get(game.gameKey, game.gameKey),
      )?.token_mint ?? DEFAULT_TOKEN_MINT;
    const result = this.sqlite
      .query(
        `INSERT OR IGNORE INTO games
          (signature, game_key, winner, winner_amount, fee_amount, tickets_count,
           token_mint, timestamp, slot, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        game.signature,
        game.gameKey,
        game.winner,
        game.winnerAmount,
        game.feeAmount,
        game.ticketsCount,
        mint,
        game.timestamp,
        game.slot,
        now,
      );
    this.removeActiveGame(game.gameKey);
    this.refreshLifecycle(game.gameKey);
    return result.changes > 0;
  }

  private applyClosed(game: GameClosedEvent): void {
    const now = nowSeconds();
    this.sqlite
      .query(
        `INSERT INTO game_closures (game_key, signature, timestamp, slot, indexed_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(game_key) DO UPDATE SET
           signature=excluded.signature, timestamp=excluded.timestamp,
           slot=excluded.slot, indexed_at=excluded.indexed_at`,
      )
      .run(game.gameKey, game.signature, game.timestamp, game.slot, now);
    this.removeActiveGame(game.gameKey);
    this.refreshLifecycle(game.gameKey);
  }

  private removeActiveGame(gameKey: string): void {
    this.sqlite.query("DELETE FROM active_game_players WHERE game_key = ?").run(gameKey);
    this.sqlite.query("DELETE FROM active_games WHERE game_key = ?").run(gameKey);
  }

  removeStaleActiveGames(gameKeys: string[]): void {
    if (gameKeys.length === 0) return;
    this.sqlite.transaction(() => {
      for (const gameKey of gameKeys) this.removeActiveGame(gameKey);
    })();
  }

  private refreshLifecycle(gameKey: string): void {
    this.sqlite
      .query(
        `INSERT INTO game_lifecycle
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
           timestamp=excluded.timestamp, slot=excluded.slot, indexed_at=excluded.indexed_at`,
      )
      .run(nowSeconds(), gameKey);
  }

  rebuildCaches(): void {
    this.sqlite.transaction(() => this.rebuildCachesInTransaction())();
  }

  private rebuildCachesInTransaction(): void {
    const now = nowSeconds();
    this.sqlite.exec("DELETE FROM token_stats_cache");
    this.sqlite.exec(`INSERT INTO token_stats_cache
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
      )`);
    this.sqlite.exec("DELETE FROM token_summary_cache");
    this.sqlite.exec(`INSERT INTO token_summary_cache (token_mint, games, latest_timestamp)
      SELECT token_mint, COUNT(DISTINCT game_key), MAX(timestamp) FROM (
        SELECT game_key, token_mint, timestamp FROM gameplay_events
        UNION ALL SELECT game_key, token_mint, timestamp FROM games
      ) GROUP BY token_mint`);
    this.sqlite.exec("DELETE FROM leaderboard_cache");
    this.sqlite.exec(`INSERT INTO leaderboard_cache
      (scope, player, games_won, total_winnings, avg_win)
      SELECT '*', winner, COUNT(*), NULL, NULL FROM games GROUP BY winner`);
    this.sqlite.exec(`INSERT INTO leaderboard_cache
      (scope, player, games_won, total_winnings, avg_win)
      SELECT token_mint, winner, COUNT(*), SUM(winner_amount), AVG(winner_amount)
      FROM games GROUP BY token_mint, winner`);
    const aggregate = row<{ total_games: number; unique_players: number }>(
      this.sqlite
        .query(
          `SELECT (SELECT COUNT(DISTINCT game_key) FROM (
             SELECT game_key FROM games UNION ALL SELECT game_key FROM gameplay_events
           )) total_games, COUNT(DISTINCT winner) unique_players FROM games`,
        )
        .get(),
    );
    const last = row<{ signature: string }>(
      this.sqlite.query("SELECT signature FROM games ORDER BY slot DESC LIMIT 1").get(),
    );
    this.sqlite
      .query(
        `UPDATE stats_cache SET total_games=?, unique_players=?,
         last_indexed_signature=?, updated_at=? WHERE id=1`,
      )
      .run(
        aggregate?.total_games ?? 0,
        aggregate?.unique_players ?? 0,
        last?.signature ?? null,
        now,
      );
  }

  getStats(tokenMint?: string): {
    totalGames: number;
    uniquePlayers: number;
    financials: Array<{
      tokenMint: string;
      totalVolume: number;
      totalFees: number;
      biggestWin: { amount: number; winner: string; signature: string } | null;
    }>;
    lastUpdated: number;
  } {
    const cache = row<{ total_games: number; unique_players: number; updated_at: number }>(
      this.sqlite
        .query("SELECT total_games, unique_players, updated_at FROM stats_cache WHERE id=1")
        .get(),
    );
    const stats = tokenMint
      ? rows<Row>(
          this.sqlite.query("SELECT * FROM token_stats_cache WHERE token_mint=?").all(tokenMint),
        )
      : rows<Row>(
          this.sqlite.query("SELECT * FROM token_stats_cache ORDER BY latest_timestamp DESC").all(),
        );
    const scopedCounts = tokenMint
      ? row<{ games: number; players: number }>(
          this.sqlite
            .query(
              `SELECT s.games, COALESCE(t.unique_players, 0) players
               FROM token_summary_cache s LEFT JOIN token_stats_cache t
                 ON t.token_mint=s.token_mint WHERE s.token_mint=?`,
            )
            .get(tokenMint),
        )
      : null;
    return {
      totalGames: tokenMint ? (scopedCounts?.games ?? 0) : (cache?.total_games ?? 0),
      uniquePlayers: tokenMint ? (scopedCounts?.players ?? 0) : (cache?.unique_players ?? 0),
      financials: stats.map((item) => ({
        tokenMint: String(item["token_mint"]),
        totalVolume: Number(item["total_volume"]),
        totalFees: Number(item["total_fees"]),
        biggestWin:
          item["biggest_win_winner"] == null
            ? null
            : {
                amount: Number(item["biggest_win_amount"]),
                winner: String(item["biggest_win_winner"]),
                signature: String(item["biggest_win_signature"]),
              },
      })),
      lastUpdated: cache?.updated_at ?? 0,
    };
  }

  getGames(limit: number, offset: number, tokenMint?: string): { games: Row[]; total: number } {
    const games = tokenMint
      ? rows<Row>(
          this.sqlite
            .query(
              "SELECT * FROM games WHERE token_mint=? ORDER BY timestamp DESC, slot DESC LIMIT ? OFFSET ?",
            )
            .all(tokenMint, limit, offset),
        )
      : rows<Row>(
          this.sqlite
            .query("SELECT * FROM games ORDER BY timestamp DESC, slot DESC LIMIT ? OFFSET ?")
            .all(limit, offset),
        );
    const count = tokenMint
      ? row<{ count: number }>(
          this.sqlite.query("SELECT COUNT(*) count FROM games WHERE token_mint=?").get(tokenMint),
        )
      : row<{ count: number }>(this.sqlite.query("SELECT COUNT(*) count FROM games").get());
    return { games, total: count?.count ?? 0 };
  }

  getLifecycle(limit: number, tokenMint?: string, gameType?: string): LifecycleRow[] {
    const conditions: string[] = [];
    const bindings: SqlValue[] = [];
    if (tokenMint) {
      conditions.push("l.token_mint=?");
      bindings.push(tokenMint);
    }
    if (gameType) {
      conditions.push("l.game_type=?");
      bindings.push(gameType);
    }
    return rows<LifecycleRow>(
      this.sqlite
        .query(
          `SELECT l.*, COALESCE(a.timeout, i.timeout) timeout,
             g.winner, g.winner_amount, g.fee_amount, g.tickets_count
           FROM game_lifecycle l LEFT JOIN games g ON g.game_key=l.game_key
           LEFT JOIN active_games a ON a.game_key=l.game_key
           LEFT JOIN game_initializations i ON i.game_key=l.game_key
           ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
           ORDER BY l.timestamp DESC, l.slot DESC LIMIT ?`,
        )
        .all(...bindings, limit),
    );
  }

  getGame(gameKey: string): LifecycleRow | null {
    return row<LifecycleRow>(
      this.sqlite
        .query(
          `SELECT l.*, COALESCE(a.timeout, i.timeout) timeout,
             g.winner, g.winner_amount, g.fee_amount, g.tickets_count
           FROM game_lifecycle l LEFT JOIN games g ON g.game_key=l.game_key
           LEFT JOIN active_games a ON a.game_key=l.game_key
           LEFT JOIN game_initializations i ON i.game_key=l.game_key
           WHERE l.game_key=? LIMIT 1`,
        )
        .get(gameKey),
    );
  }

  getLeaderboard(limit: number, tokenMint?: string): Row[] {
    const scope = tokenMint ?? "*";
    return rows<Row>(
      this.sqlite
        .query(
          `SELECT player, games_won, total_winnings, avg_win FROM leaderboard_cache
           WHERE scope=? ORDER BY
             CASE WHEN ?='*' THEN games_won ELSE total_winnings END DESC,
             player ASC LIMIT ?`,
        )
        .all(scope, scope, limit),
    );
  }

  getTokens(): Row[] {
    return rows<Row>(
      this.sqlite
        .query(
          `SELECT token_mint tokenMint, games, latest_timestamp latestTimestamp
           FROM token_summary_cache ORDER BY games DESC, latest_timestamp DESC`,
        )
        .all(),
    );
  }

  getActiveGames(player?: string): ActiveGameRow[] {
    const result = player
      ? this.sqlite
          .query(
            `SELECT DISTINCT a.*, l.game_type FROM active_games a
             LEFT JOIN active_game_players p ON p.game_key=a.game_key AND p.is_joined=1
             LEFT JOIN game_lifecycle l ON l.game_key=a.game_key
             WHERE a.creator=? OR p.player=? ORDER BY a.created_at DESC`,
          )
          .all(player, player)
      : this.sqlite
          .query(
            `SELECT a.*, l.game_type FROM active_games a
             LEFT JOIN game_lifecycle l ON l.game_key=a.game_key ORDER BY a.created_at DESC`,
          )
          .all();
    return rows<ActiveGameRow>(result).map((game) => ({
      ...game,
      is_private: booleanInteger(game.is_private),
    }));
  }

  getPlayerGames(player: string, limit: number, offset: number): PlayerHistoryRow[] {
    return rows<PlayerHistoryRow>(
      this.sqlite
        .query(
          `SELECT l.*, COALESCE(a.timeout, i.timeout) timeout,
             g.winner, g.winner_amount, g.fee_amount,
             COALESCE(g.tickets_count, a.current_tickets) tickets_count,
             CASE WHEN l.creator=? THEN 1 ELSE 0 END is_creator,
             CASE WHEN p.player IS NOT NULL THEN 1 ELSE 0 END is_player,
             COALESCE(p.is_joined, 0) is_joined
           FROM game_lifecycle l LEFT JOIN games g ON g.game_key=l.game_key
           LEFT JOIN active_games a ON a.game_key=l.game_key
           LEFT JOIN game_initializations i ON i.game_key=l.game_key
           LEFT JOIN game_players p ON p.game_key=l.game_key AND p.player=?
           WHERE l.creator=? OR p.player IS NOT NULL
           ORDER BY l.timestamp DESC, l.slot DESC LIMIT ? OFFSET ?`,
        )
        .all(player, player, player, limit, offset),
    );
  }

  getPlayerProfile(player: string): {
    summary: Row;
    tokens: Row[];
    frequentPlayers: Row[];
    historyComplete: boolean;
  } {
    const summary = row<Row>(
      this.sqlite
        .query(
          `SELECT COUNT(*) related_games,
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
             WHERE l.creator=? OR p.player IS NOT NULL`,
        )
        .get(player, player, player, player, player),
    ) ?? {
      related_games: 0,
      created_games: 0,
      played_games: 0,
      active_games: 0,
      completed_games: 0,
      cancelled_games: 0,
      wins: 0,
      losses: 0,
      last_activity: null,
    };
    const tokens = rows<Row>(
      this.sqlite
        .query(
          `SELECT l.token_mint, COUNT(*) games_played,
            COALESCE(SUM(CASE WHEN l.game_type='coinflip' THEN COALESCE(l.ticket_amount,0) ELSE 0 END),0) staked_amount,
            COALESCE(SUM(CASE WHEN g.winner=? THEN COALESCE(g.winner_amount,0) ELSE 0 END),0) won_amount
           FROM game_players p JOIN game_lifecycle l ON l.game_key=p.game_key
           LEFT JOIN games g ON g.game_key=l.game_key WHERE p.player=?
           GROUP BY l.token_mint ORDER BY games_played DESC, l.token_mint`,
        )
        .all(player, player),
    );
    const frequentPlayers = rows<Row>(
      this.sqlite
        .query(
          `SELECT other.player, COUNT(DISTINCT mine.game_key) games_together
           FROM game_players mine JOIN game_players other
             ON other.game_key=mine.game_key AND other.player!=mine.player
           JOIN game_lifecycle l ON l.game_key=mine.game_key AND l.status='completed'
           WHERE mine.player=? GROUP BY other.player
           ORDER BY games_together DESC, other.player LIMIT 5`,
        )
        .all(player),
    );
    const backfill = row<{ complete: number }>(
      this.sqlite.query("SELECT complete FROM historical_backfill WHERE name=?").get(BACKFILL_NAME),
    );
    return { summary, tokens, frequentPlayers, historyComplete: backfill?.complete === 1 };
  }

  getBackfillState(): HistoricalBackfillState {
    const result = row<Row>(
      this.sqlite.query("SELECT * FROM historical_backfill WHERE name=?").get(BACKFILL_NAME),
    );
    return {
      beforeSignature:
        result?.["before_signature"] == null ? null : String(result["before_signature"]),
      pages: Number(result?.["pages"] ?? 0),
      transactions: Number(result?.["transactions"] ?? 0),
      initializedEvents: Number(result?.["initialized_events"] ?? 0),
      closedEvents: Number(result?.["closed_events"] ?? 0),
      complete: Number(result?.["complete"] ?? 0) === 1,
    };
  }
}
