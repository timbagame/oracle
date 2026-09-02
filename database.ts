import { Database } from "bun:sqlite";
import { getConfig } from "./config.ts";
import { logger } from "./logger.ts";
import {
  normalizeMinimumAmountRaw,
  normalizeMint,
  type StoredTokenPolicy,
} from "./token-policy.ts";

// Constants
const DEFAULT_STATUS = "pending";
const PENDING_SCAN_LIMIT = 50;

const SQL_STATEMENTS = Object.freeze({
  insertSecretKey:
    "INSERT INTO secret_keys (game_address, secret_key, random_hash, created_at) VALUES (?, ?, ?, ?)",
  markSecretKeyUsed: "UPDATE secret_keys SET used = TRUE WHERE game_address = ?",
  markSecretKeySigned:
    "UPDATE secret_keys SET signed_at = COALESCE(signed_at, ?) WHERE game_address = ? AND used = FALSE",
  markSecretKeyCommitted:
    "UPDATE secret_keys SET committed_at = COALESCE(committed_at, ?) WHERE game_address = ? AND used = FALSE",
  reactivateSecretKey: "UPDATE secret_keys SET used = FALSE WHERE game_address = ?",
  deleteSecretKey: "DELETE FROM secret_keys WHERE game_address = ?",
  upsertGameTracking: `INSERT INTO game_tracking (game_address, status, game_type, last_checked, auto_complete_disabled)
     VALUES (?, ?, ?, ?, COALESCE((SELECT auto_complete_disabled FROM game_tracking WHERE game_address = ?), FALSE))
     ON CONFLICT(game_address) DO UPDATE SET
       status = excluded.status,
       game_type = excluded.game_type,
       last_checked = excluded.last_checked,
       auto_complete_disabled = COALESCE(game_tracking.auto_complete_disabled, excluded.auto_complete_disabled, FALSE)`,
  updateGameStatus:
    "UPDATE game_tracking SET status = ?, completed_at = ?, last_checked = ? WHERE game_address = ?",
  deleteGamePlayers: "DELETE FROM game_players WHERE game_address = ?",
  incrementCompletionAttempts:
    "UPDATE game_tracking SET completion_attempts = completion_attempts + 1, last_checked = ? WHERE game_address = ?",
  touchPendingGame: "UPDATE game_tracking SET last_checked = ? WHERE game_address = ?",
  resetCompletionAttempts:
    "UPDATE game_tracking SET status = ?, completion_attempts = 0, completed_at = NULL, last_checked = ? WHERE game_address = ?",
  upsertGamePlayer:
    "INSERT OR REPLACE INTO game_players (game_address, player_address, ticket_index, joined_at) VALUES (?, ?, ?, ?)",
  deleteGamePlayerByTicket: "DELETE FROM game_players WHERE game_address = ? AND ticket_index = ?",
  deleteGamePlayerByAddress:
    "DELETE FROM game_players WHERE game_address = ? AND player_address = ?",
  updateGameMetadata:
    "UPDATE game_tracking SET game_type = ?, last_checked = ? WHERE game_address = ?",
  markGameDesynced:
    "UPDATE game_tracking SET status = ?, completed_at = NULL, last_checked = ? WHERE game_address = ?",
  setAutoCompleteDisabled:
    "UPDATE game_tracking SET auto_complete_disabled = ?, last_checked = ? WHERE game_address = ?",
  upsertTokenPolicy: `INSERT INTO token_policies (mint, enabled, minimum_amount_raw, revision, effective_at)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(mint) DO UPDATE SET
      enabled = excluded.enabled,
      minimum_amount_raw = excluded.minimum_amount_raw,
      revision = token_policies.revision + 1,
      effective_at = excluded.effective_at`,
} satisfies Record<string, string>);

const COMPLETED_GAME_PREDICATE = "status != ? AND completed_at IS NOT NULL AND completed_at < ?";

const SQL_QUERIES = Object.freeze({
  selectSecretKey:
    "SELECT secret_key, random_hash FROM secret_keys WHERE game_address = ? AND used = FALSE",
  selectSecretKeyAny:
    "SELECT secret_key, random_hash, used FROM secret_keys WHERE game_address = ?",
  selectGameType: "SELECT game_type FROM game_tracking WHERE game_address = ?",
  selectGameStatus: "SELECT status, game_type FROM game_tracking WHERE game_address = ?",
  selectGameStatusWithAttempts:
    "SELECT status, completion_attempts, auto_complete_disabled FROM game_tracking WHERE game_address = ?",
  selectGameStatusWithAutoFlag:
    "SELECT status, auto_complete_disabled FROM game_tracking WHERE game_address = ?",
  selectPendingGames:
    "SELECT game_address, completion_attempts FROM game_tracking WHERE status = ? ORDER BY last_checked ASC LIMIT ?",
  selectPendingGamesActive:
    "SELECT game_address, completion_attempts FROM game_tracking WHERE status = ? AND auto_complete_disabled = FALSE ORDER BY last_checked ASC LIMIT ?",
  selectPendingGamesWithAttempts:
    "SELECT game_address, completion_attempts FROM game_tracking WHERE status = ? AND completion_attempts < ? ORDER BY last_checked ASC LIMIT ?",
  selectPendingGamesWithAttemptsActive:
    "SELECT game_address, completion_attempts FROM game_tracking WHERE status = ? AND auto_complete_disabled = FALSE AND completion_attempts < ? ORDER BY last_checked ASC LIMIT ?",
  selectSecretsStats:
    "SELECT COUNT(*) as total, SUM(CASE WHEN used = TRUE THEN 1 ELSE 0 END) as used FROM secret_keys",
  selectGamesStats: `SELECT
        SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled
      FROM game_tracking`,
  selectPlayersForGame:
    "SELECT player_address FROM game_players WHERE game_address = ? ORDER BY ticket_index ASC",
  selectPlayerTicketStats:
    "SELECT COUNT(*) as count, MAX(ticket_index) as max_index, MIN(ticket_index) as min_index FROM game_players WHERE game_address = ?",
  selectTokenPolicy:
    "SELECT mint, enabled, minimum_amount_raw, revision, effective_at FROM token_policies WHERE mint = ?",
  selectTokenPolicies:
    "SELECT mint, enabled, minimum_amount_raw, revision, effective_at FROM token_policies ORDER BY mint ASC",
} satisfies Record<string, string>);

const COMPLETED_GAME_SUBQUERY = `
  SELECT game_address FROM game_tracking
  WHERE ${COMPLETED_GAME_PREDICATE}
`;
const DELETE_COMPLETED_GAMES_SQL = `
  DELETE FROM game_tracking
  WHERE ${COMPLETED_GAME_PREDICATE}
`;

function getDatabaseFile(): string {
  return getConfig().databaseFile;
}

// Types
interface SecretKeyData {
  secretKey: string;
  randomHash: string;
}

interface PendingGame {
  game_address: string;
  completion_attempts: number;
}

interface DatabaseStats {
  totalSecrets: number;
  usedSecrets: number;
  pendingGames: number;
  completedGames: number;
  cancelledGames: number;
}

export type ResetCompletionAttemptsResult =
  { success: true } | { success: false; reason: "not-found" | "finalized" | "unchanged" };

export type ToggleAutoCompleteResult =
  | { success: true; autoCompleteDisabled: boolean }
  | { success: false; reason: "invalid-address" | "not-found" | "finalized" | "unchanged" };

const TABLE_DEFINITIONS: ReadonlyArray<{
  sql: string;
  log: string;
  error: string;
}> = [
  {
    sql: `
      CREATE TABLE IF NOT EXISTS secret_keys (
        game_address TEXT PRIMARY KEY,
        secret_key TEXT NOT NULL,
        random_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        signed_at INTEGER,
        committed_at INTEGER,
        used BOOLEAN DEFAULT FALSE
      )
    `,
    log: "Ensuring secret_keys table exists",
    error: "Failed to ensure secret_keys table",
  },
  {
    sql: `
      CREATE TABLE IF NOT EXISTS game_tracking (
        game_address TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT '${DEFAULT_STATUS}',
        game_type TEXT,
        last_checked INTEGER NOT NULL,
        completion_attempts INTEGER DEFAULT 0,
        completed_at INTEGER,
        auto_complete_disabled BOOLEAN NOT NULL DEFAULT FALSE
      )
    `,
    log: "Ensuring game_tracking table exists",
    error: "Failed to ensure game_tracking table",
  },
  {
    sql: `
      CREATE TABLE IF NOT EXISTS game_players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_address TEXT NOT NULL,
        player_address TEXT NOT NULL,
        ticket_index INTEGER NOT NULL,
        joined_at INTEGER NOT NULL,
        UNIQUE(game_address, ticket_index)
      )
    `,
    log: "Ensuring game_players table exists",
    error: "Failed to ensure game_players table",
  },
  {
    sql: `
      CREATE TABLE IF NOT EXISTS token_policies (
        mint TEXT PRIMARY KEY,
        enabled BOOLEAN NOT NULL,
        minimum_amount_raw TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        effective_at INTEGER NOT NULL
      )
    `,
    log: "Ensuring token_policies table exists",
    error: "Failed to ensure token_policies table",
  },
];

const LEGACY_TICKET_MIGRATIONS: ReadonlyArray<{
  sql: string;
  log: string;
  error: string;
}> = [
  {
    sql: "ALTER TABLE game_players ADD COLUMN ticket_index INTEGER",
    log: "Adding ticket_index column to game_players",
    error: "Failed to add ticket_index column to game_players",
  },
  {
    sql: "DELETE FROM game_players",
    log: "Clearing legacy game_players rows after ticket_index migration",
    error: "Failed to clear legacy game_players rows during migration",
  },
];

const PLAYER_INDEX_DEFINITIONS: ReadonlyArray<{
  sql: string;
  log: string;
  error: string;
}> = [
  {
    sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_game_players_ticket ON game_players (game_address, ticket_index)",
    log: "Ensuring idx_game_players_ticket index exists",
    error: "Failed to ensure idx_game_players_ticket index",
  },
  {
    sql: "CREATE INDEX IF NOT EXISTS idx_game_players_game ON game_players (game_address)",
    log: "Ensuring idx_game_players_game index exists",
    error: "Failed to ensure idx_game_players_game index",
  },
];

const TRACKING_INDEX_DEFINITIONS: ReadonlyArray<{
  sql: string;
  log: string;
  error: string;
}> = [
  {
    sql: "CREATE INDEX IF NOT EXISTS idx_tracking_pending ON game_tracking (status, completion_attempts, last_checked)",
    log: "Ensuring idx_tracking_pending index exists",
    error: "Failed to ensure idx_tracking_pending index",
  },
  {
    sql: "CREATE INDEX IF NOT EXISTS idx_tracking_completed_at ON game_tracking (status, completed_at)",
    log: "Ensuring idx_tracking_completed_at index exists",
    error: "Failed to ensure idx_tracking_completed_at index",
  },
];

interface SchemaStep {
  sql: string;
  log: string;
  error: string;
}

export const EMPTY_DATABASE_STATS: Readonly<DatabaseStats> = Object.freeze({
  totalSecrets: 0,
  usedSecrets: 0,
  pendingGames: 0,
  completedGames: 0,
  cancelledGames: 0,
});

export function createEmptyStats(): DatabaseStats {
  return { ...EMPTY_DATABASE_STATS };
}

/**
 * Oracle Database for storing secret keys and tracking game completion
 */
export class OracleDatabase {
  private static instance: OracleDatabase;
  private db: Database;
  private closed: boolean = false;
  private readonly statementCache = new Map<string, ReturnType<Database["prepare"]>>();

  private constructor() {
    this.db = new Database(getDatabaseFile(), { create: true });
    this.initializeDatabase();
  }

  public static getInstance(): OracleDatabase {
    if (!OracleDatabase.instance || OracleDatabase.instance.closed) {
      OracleDatabase.instance = new OracleDatabase();
    }
    return OracleDatabase.instance;
  }

  private initializeDatabase(): void {
    try {
      this.configureDatabasePragmas();
      this.createTables();
      logger.success("Oracle database initialized");
    } catch (error) {
      logger.failure("Database initialization failed:", error);
      throw error;
    }
  }

  private configureDatabasePragmas(): void {
    // Improve concurrency between multiple Bun processes (e.g., oracle + audit scripts).
    // WAL allows readers to proceed during writes; busy_timeout reduces SQLITE_BUSY errors.
    try {
      this.db.query("PRAGMA journal_mode = WAL").get();
      this.db.query("PRAGMA synchronous = NORMAL").run();
      this.db.query("PRAGMA busy_timeout = 5000").run();
    } catch (error) {
      logger.warning("Failed to apply SQLite PRAGMAs:", error);
    }
  }

  private executeSchemaSteps(steps: ReadonlyArray<SchemaStep>): void {
    for (const step of steps) {
      logger.info(`🛠️ ${step.log}`);
      this.runStatement(step.sql, step.error);
    }
  }

  private createTables(): void {
    this.executeSchemaSteps(TABLE_DEFINITIONS);
    this.ensureSecretSchema();
    this.ensureTicketSchema();
    this.ensureTrackingSchema();
    this.ensureTrackingIndexes();
  }

  private ensureSecretSchema(): void {
    const tableInfo = this.db.query("PRAGMA table_info('secret_keys')").all() as Array<{
      name: string;
    }>;
    if (!tableInfo.some((column) => column.name === "signed_at")) {
      this.executeSchemaSteps([
        {
          sql: "ALTER TABLE secret_keys ADD COLUMN signed_at INTEGER",
          log: "Adding signed_at column to secret_keys",
          error: "Failed to add signed_at column to secret_keys",
        },
        {
          sql: "UPDATE secret_keys SET signed_at = created_at WHERE signed_at IS NULL",
          log: "Preserving existing commitments as signed",
          error: "Failed to preserve existing commitments",
        },
      ]);
    }

    if (!tableInfo.some((column) => column.name === "committed_at")) {
      this.executeSchemaSteps([
        {
          sql: "ALTER TABLE secret_keys ADD COLUMN committed_at INTEGER",
          log: "Adding committed_at column to secret_keys",
          error: "Failed to add committed_at column to secret_keys",
        },
        {
          sql: "UPDATE secret_keys SET committed_at = COALESCE(signed_at, created_at) WHERE committed_at IS NULL",
          log: "Preserving existing commitments",
          error: "Failed to preserve existing commitments",
        },
      ]);
    }
  }

  private ensureTicketSchema(): void {
    const tableInfo = this.db.query("PRAGMA table_info('game_players')").all() as Array<{
      name: string;
    }>;
    const hasTicketIndex = tableInfo.some((column) => column.name === "ticket_index");

    if (!hasTicketIndex) {
      this.executeSchemaSteps(LEGACY_TICKET_MIGRATIONS);
    }

    this.executeSchemaSteps(PLAYER_INDEX_DEFINITIONS);
  }

  private ensureTrackingIndexes(): void {
    this.executeSchemaSteps(TRACKING_INDEX_DEFINITIONS);
  }

  private ensureTrackingSchema(): void {
    const tableInfo = this.db.query("PRAGMA table_info('game_tracking')").all() as Array<{
      name: string;
    }>;
    const hasAutoCompleteFlag = tableInfo.some(
      (column) => column.name === "auto_complete_disabled",
    );

    if (!hasAutoCompleteFlag) {
      this.executeSchemaSteps([
        {
          sql: "ALTER TABLE game_tracking ADD COLUMN auto_complete_disabled BOOLEAN NOT NULL DEFAULT FALSE",
          log: "Adding auto_complete_disabled column to game_tracking",
          error: "Failed to add auto_complete_disabled column to game_tracking",
        },
      ]);
    }
  }

  private executeDbOperation<T>(operation: () => T, errorMessage: string, defaultValue?: T): T {
    try {
      return operation();
    } catch (error) {
      logger.failure(`${errorMessage}:`, error);
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      throw new Error(errorMessage, { cause: error });
    }
  }

  private getPreparedStatement(sql: string): ReturnType<Database["prepare"]> {
    let statement = this.statementCache.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statementCache.set(sql, statement);
    }
    return statement;
  }

  private runStatement(
    sql: string,
    errorMessage: string,
    ...params: Parameters<ReturnType<Database["prepare"]>["run"]>
  ): ReturnType<ReturnType<Database["prepare"]>["run"]> {
    return this.executeDbOperation(() => {
      const stmt = this.getPreparedStatement(sql);
      return stmt.run(...params);
    }, errorMessage);
  }

  private runDelete(
    sql: string,
    errorMessage: string,
    ...params: Parameters<ReturnType<Database["prepare"]>["run"]>
  ): number {
    return this.executeDbOperation(() => {
      const stmt = this.getPreparedStatement(sql);
      const result = stmt.run(...params);
      return typeof result?.changes === "number" ? result.changes : 0;
    }, errorMessage);
  }

  private runInTransaction<T>(operation: () => T, errorMessage: string): T {
    return this.executeDbOperation(() => {
      const transaction = this.db.transaction(operation);
      return transaction();
    }, errorMessage);
  }

  private queryOne<T>(
    sql: string,
    errorMessage: string,
    defaultValue: T | null,
    ...params: Parameters<ReturnType<Database["prepare"]>["get"]>
  ): T | null {
    return this.executeDbOperation(
      () => {
        const stmt = this.getPreparedStatement(sql);
        const result = stmt.get(...params) as T;
        return result || defaultValue;
      },
      errorMessage,
      defaultValue,
    );
  }

  private queryAll<T>(
    sql: string,
    errorMessage: string,
    ...params: Parameters<ReturnType<Database["prepare"]>["all"]>
  ): T[] {
    return this.executeDbOperation(
      () => {
        const stmt = this.getPreparedStatement(sql);
        return stmt.all(...params) as T[];
      },
      errorMessage,
      [],
    );
  }

  private queryOneStrict<T>(
    sql: string,
    errorMessage: string,
    ...params: Parameters<ReturnType<Database["prepare"]>["get"]>
  ): T | null {
    return this.executeDbOperation(() => {
      const stmt = this.getPreparedStatement(sql);
      return (stmt.get(...params) as T | null) ?? null;
    }, errorMessage);
  }

  private queryAllStrict<T>(
    sql: string,
    errorMessage: string,
    ...params: Parameters<ReturnType<Database["prepare"]>["all"]>
  ): T[] {
    return this.executeDbOperation(() => {
      const stmt = this.getPreparedStatement(sql);
      return stmt.all(...params) as T[];
    }, errorMessage);
  }

  // Secret key management
  public saveSecretKey(gameAddress: string, secretKey: string, randomHash: string): void {
    this.runStatement(
      SQL_STATEMENTS.insertSecretKey,
      `Failed to save secret key for game ${gameAddress}`,
      gameAddress,
      secretKey,
      randomHash,
      Date.now(),
    );
  }

  public deleteSecretKey(gameAddress: string): void {
    this.runStatement(SQL_STATEMENTS.deleteSecretKey, "Failed to delete secret key", gameAddress);
  }

  public getSecretKey(gameAddress: string): SecretKeyData | null {
    const result = this.queryOne<{ secret_key: string; random_hash: string }>(
      SQL_QUERIES.selectSecretKey,
      "Failed to get secret key",
      null,
      gameAddress,
    );

    return result
      ? {
          secretKey: result.secret_key,
          randomHash: result.random_hash,
        }
      : null;
  }

  public getSecretKeyInfo(gameAddress: string): (SecretKeyData & { used: boolean }) | null {
    const result = this.queryOne<{
      secret_key: string;
      random_hash: string;
      used: number | boolean;
    }>(SQL_QUERIES.selectSecretKeyAny, "Failed to get secret key info", null, gameAddress);

    if (!result) {
      return null;
    }

    return {
      secretKey: result.secret_key,
      randomHash: result.random_hash,
      used: Boolean(result.used),
    };
  }

  public markSecretKeyUsed(gameAddress: string): void {
    this.runStatement(
      SQL_STATEMENTS.markSecretKeyUsed,
      "Failed to mark secret key as used",
      gameAddress,
    );
  }

  public markSecretKeySigned(gameAddress: string): void {
    this.runStatement(
      SQL_STATEMENTS.markSecretKeySigned,
      "Failed to mark secret key as signed",
      Date.now(),
      gameAddress,
    );
  }

  public markSecretKeyCommitted(gameAddress: string): void {
    this.runStatement(
      SQL_STATEMENTS.markSecretKeyCommitted,
      "Failed to mark secret key as committed",
      Date.now(),
      gameAddress,
    );
  }

  public cleanupUnsignedCommitments(minutesOld: number = 10): number {
    if (minutesOld <= 0) return 0;
    const cutoffTime = Date.now() - minutesOld * 60 * 1000;

    return this.executeDbOperation(
      () => {
        const cleanup = this.db.transaction(() => {
          this.db
            .query(
              `DELETE FROM game_players
             WHERE game_address IN (
               SELECT game_address FROM secret_keys
               WHERE committed_at IS NULL AND used = FALSE AND created_at < ?
             )`,
            )
            .run(cutoffTime);
          this.db
            .query(
              `DELETE FROM game_tracking
             WHERE status = ? AND game_address IN (
               SELECT game_address FROM secret_keys
               WHERE committed_at IS NULL AND used = FALSE AND created_at < ?
             )`,
            )
            .run(DEFAULT_STATUS, cutoffTime);
          const result = this.db
            .query(
              `DELETE FROM secret_keys
             WHERE committed_at IS NULL
               AND used = FALSE
               AND created_at < ?
               AND game_address NOT IN (
                 SELECT game_address FROM game_tracking WHERE status != ?
               )`,
            )
            .run(cutoffTime, DEFAULT_STATUS);
          return result.changes;
        });
        return cleanup();
      },
      "Failed to clean up unsigned commitments",
      0,
    );
  }

  public reactivateSecretKey(gameAddress: string): boolean {
    const result = this.runStatement(
      SQL_STATEMENTS.reactivateSecretKey,
      "Failed to reactivate secret key",
      gameAddress,
    );
    return typeof result?.changes === "number" && result.changes > 0;
  }

  // Game tracking
  public trackGame(
    gameAddress: string,
    gameType?: string,
    options: { preserveFinalized?: boolean } = {},
  ): void {
    const preserveFinalized = options.preserveFinalized === true;

    if (preserveFinalized) {
      const existing = this.queryOne<{ status: string; game_type: string | null }>(
        SQL_QUERIES.selectGameStatus,
        "Failed to lookup existing game status",
        null,
        gameAddress,
      );

      if (existing && existing.status !== DEFAULT_STATUS) {
        if (gameType && existing.game_type !== gameType) {
          this.runStatement(
            SQL_STATEMENTS.updateGameMetadata,
            "Failed to update finalized game metadata",
            gameType,
            Date.now(),
            gameAddress,
          );
        }
        return;
      }
    }

    this.runStatement(
      SQL_STATEMENTS.upsertGameTracking,
      "Failed to track game",
      gameAddress,
      DEFAULT_STATUS,
      gameType || null,
      Date.now(),
      gameAddress,
    );
  }

  public setAutoCompleteDisabled(gameAddress: string, disabled: boolean): ToggleAutoCompleteResult {
    const normalized = gameAddress.trim();
    if (!normalized) {
      return { success: false, reason: "invalid-address" };
    }

    const statusRecord = this.queryOne<{
      status: string;
      auto_complete_disabled: number | boolean;
    }>(SQL_QUERIES.selectGameStatusWithAutoFlag, "Failed to lookup game status", null, normalized);

    if (!statusRecord) {
      return { success: false, reason: "not-found" };
    }

    const status = statusRecord.status;
    const currentDisabled = Boolean(statusRecord.auto_complete_disabled);
    const isPendingState = status === DEFAULT_STATUS || status === "desynced";
    const isFinalized = status === "completed" || status === "cancelled";

    if (!isPendingState) {
      return { success: false, reason: isFinalized ? "finalized" : "unchanged" };
    }

    if (currentDisabled === disabled) {
      return { success: false, reason: "unchanged" };
    }

    this.runStatement(
      SQL_STATEMENTS.setAutoCompleteDisabled,
      "Failed to update auto-complete state",
      disabled,
      Date.now(),
      normalized,
    );

    return { success: true, autoCompleteDisabled: disabled };
  }

  public isAutoCompleteDisabled(gameAddress: string): boolean | null {
    const normalized = gameAddress.trim();
    if (!normalized) {
      return null;
    }

    const record = this.queryOne<{ auto_complete_disabled: number | boolean }>(
      SQL_QUERIES.selectGameStatusWithAutoFlag,
      "Failed to lookup auto-complete status",
      null,
      normalized,
    );
    if (!record) {
      return null;
    }
    return Boolean(record.auto_complete_disabled);
  }

  public setTokenPolicy(
    mint: string,
    enabled: boolean,
    minimumAmountRaw: string,
  ): StoredTokenPolicy {
    const normalizedMint = normalizeMint(mint);
    const normalizedMinimum = normalizeMinimumAmountRaw(minimumAmountRaw);
    const effectiveAtMs = Date.now();

    this.runStatement(
      SQL_STATEMENTS.upsertTokenPolicy,
      `Failed to update token policy for ${normalizedMint}`,
      normalizedMint,
      enabled,
      normalizedMinimum,
      effectiveAtMs,
    );

    const policy = this.getTokenPolicy(normalizedMint);
    if (!policy) {
      throw new Error(`Failed to load updated token policy for ${normalizedMint}`);
    }
    return policy;
  }

  public getTokenPolicy(mint: string): StoredTokenPolicy | null {
    const normalizedMint = normalizeMint(mint);
    const row = this.queryOneStrict<{
      mint: string;
      enabled: number | boolean;
      minimum_amount_raw: string;
      revision: number;
      effective_at: number;
    }>(SQL_QUERIES.selectTokenPolicy, "Failed to get token policy", normalizedMint);

    return row ? this.mapTokenPolicy(row) : null;
  }

  public getTokenPolicies(): StoredTokenPolicy[] {
    return this.queryAllStrict<{
      mint: string;
      enabled: number | boolean;
      minimum_amount_raw: string;
      revision: number;
      effective_at: number;
    }>(SQL_QUERIES.selectTokenPolicies, "Failed to list token policies").map((row) =>
      this.mapTokenPolicy(row),
    );
  }

  private mapTokenPolicy(row: {
    mint: string;
    enabled: number | boolean;
    minimum_amount_raw: string;
    revision: number;
    effective_at: number;
  }): StoredTokenPolicy {
    return {
      mint: row.mint,
      enabled: Boolean(row.enabled),
      minimumAmountRaw: row.minimum_amount_raw,
      revision: row.revision,
      effectiveAtMs: row.effective_at,
    };
  }

  public getGameType(gameAddress: string): string | null {
    const result = this.queryOne<{ game_type: string | null }>(
      SQL_QUERIES.selectGameType,
      "Failed to get game type",
      null,
      gameAddress,
    );
    return result?.game_type || null;
  }

  public getGameStatus(gameAddress: string): string | null {
    const result = this.queryOne<{ status: string }>(
      SQL_QUERIES.selectGameStatus,
      "Failed to get game status",
      null,
      gameAddress,
    );
    return result?.status ?? null;
  }

  private updateGameStatus(
    gameAddress: string,
    status: "completed" | "cancelled",
    errorMessage: string,
  ): void {
    const now = Date.now();
    this.runStatement(SQL_STATEMENTS.updateGameStatus, errorMessage, status, now, now, gameAddress);
  }

  public markGameCompleted(gameAddress: string): void {
    this.updateGameStatus(gameAddress, "completed", "Failed to mark game as completed");
  }

  public markGameClosed(gameAddress: string): void {
    this.updateGameStatus(gameAddress, "cancelled", "Failed to mark game as closed");
  }

  public markGameDesynced(gameAddress: string): void {
    const now = Date.now();
    this.runStatement(
      SQL_STATEMENTS.markGameDesynced,
      "Failed to mark game as desynced",
      "desynced",
      now,
      gameAddress,
    );
  }

  public finalizeCompletedGame(gameAddress: string): void {
    this.runInTransaction(() => {
      this.markSecretKeyUsed(gameAddress);
      this.markGameCompleted(gameAddress);
      this.runStatement(
        SQL_STATEMENTS.deleteGamePlayers,
        "Failed to delete player rows for completed game",
        gameAddress,
      );
    }, `Failed to finalize completed game ${gameAddress}`);
  }

  public incrementCompletionAttempts(gameAddress: string): void {
    this.runStatement(
      SQL_STATEMENTS.incrementCompletionAttempts,
      "Failed to increment completion attempts",
      Date.now(),
      gameAddress,
    );
  }

  public resetCompletionAttempts(
    gameAddress: string,
    options: { allowFinalized?: boolean } = {},
  ): ResetCompletionAttemptsResult {
    const allowFinalized = options.allowFinalized === true;
    const statusRecord = this.queryOne<{ status: string }>(
      SQL_QUERIES.selectGameStatus,
      "Failed to lookup existing game status",
      null,
      gameAddress,
    );

    if (!statusRecord) {
      return { success: false, reason: "not-found" };
    }

    const status = statusRecord.status;
    const isPendingState = status === DEFAULT_STATUS || status === "desynced";
    const isFinalizedState = status === "completed" || status === "cancelled";

    if (!isPendingState && !(allowFinalized && isFinalizedState)) {
      return { success: false, reason: "finalized" };
    }

    const result = this.runStatement(
      SQL_STATEMENTS.resetCompletionAttempts,
      "Failed to reset completion attempts",
      DEFAULT_STATUS,
      Date.now() - 1,
      gameAddress,
    );

    const updated = typeof result?.changes === "number" && result.changes > 0;
    if (!updated) {
      const currentState = this.queryOne<{
        status: string;
        completion_attempts: number;
      }>(
        SQL_QUERIES.selectGameStatusWithAttempts,
        "Failed to lookup completion attempts",
        null,
        gameAddress,
      );

      if (
        currentState &&
        currentState.status === DEFAULT_STATUS &&
        (currentState.completion_attempts ?? 0) === 0
      ) {
        return { success: true };
      }

      return { success: false, reason: "unchanged" };
    }

    return { success: true };
  }

  public touchGameCheck(gameAddress: string): void {
    this.runStatement(
      SQL_STATEMENTS.touchPendingGame,
      "Failed to update last_checked for pending game",
      Date.now(),
      gameAddress,
    );
  }

  public getPendingGames(maxAttempts?: number): PendingGame[] {
    if (maxAttempts !== undefined && Number.isFinite(maxAttempts)) {
      return this.queryAll<PendingGame>(
        SQL_QUERIES.selectPendingGamesWithAttempts,
        "Failed to get pending games",
        DEFAULT_STATUS,
        maxAttempts,
        PENDING_SCAN_LIMIT,
      );
    }

    return this.queryAll<PendingGame>(
      SQL_QUERIES.selectPendingGames,
      "Failed to get pending games",
      DEFAULT_STATUS,
      PENDING_SCAN_LIMIT,
    );
  }

  public getActivePendingGames(maxAttempts?: number): PendingGame[] {
    if (maxAttempts !== undefined && Number.isFinite(maxAttempts)) {
      return this.queryAll<PendingGame>(
        SQL_QUERIES.selectPendingGamesWithAttemptsActive,
        "Failed to get pending games",
        DEFAULT_STATUS,
        maxAttempts,
        PENDING_SCAN_LIMIT,
      );
    }

    return this.queryAll<PendingGame>(
      SQL_QUERIES.selectPendingGamesActive,
      "Failed to get pending games",
      DEFAULT_STATUS,
      PENDING_SCAN_LIMIT,
    );
  }

  // Statistics
  public getStats(): DatabaseStats {
    try {
      const secretsStats = this.getSecretsStats();
      const gamesStats = this.getGamesStats();

      return {
        ...createEmptyStats(),
        totalSecrets: secretsStats.total || 0,
        usedSecrets: secretsStats.used || 0,
        pendingGames: gamesStats.pending || 0,
        completedGames: gamesStats.completed || 0,
        cancelledGames: gamesStats.cancelled || 0,
      };
    } catch (error) {
      logger.failure("Failed to get stats:", error);
      return createEmptyStats();
    }
  }

  private getSecretsStats(): { total: number; used: number } {
    return (
      this.queryOne<{ total: number; used: number }>(
        SQL_QUERIES.selectSecretsStats,
        "Failed to get secrets stats",
        { total: 0, used: 0 },
      ) || { total: 0, used: 0 }
    );
  }

  private getGamesStats(): {
    pending: number;
    completed: number;
    cancelled: number;
  } {
    return (
      this.queryOne<{
        pending: number;
        completed: number;
        cancelled: number;
      }>(
        SQL_QUERIES.selectGamesStats,
        "Failed to get games stats",
        { pending: 0, completed: 0, cancelled: 0 },
        DEFAULT_STATUS,
      ) || { pending: 0, completed: 0, cancelled: 0 }
    );
  }

  // Utility methods
  public cleanupOldRecords(hoursOld: number = 48): {
    deletedSecrets: number;
    deletedGames: number;
    deletedPlayers: number;
  } {
    if (hoursOld === 0) {
      return { deletedSecrets: 0, deletedGames: 0, deletedPlayers: 0 };
    }

    const cutoffTime = Date.now() - hoursOld * 60 * 60 * 1000;

    const cleanupWork = () => {
      const deletedSecrets = this.runDelete(
        `DELETE FROM secret_keys
         WHERE created_at < ?
           AND game_address IN (
             SELECT game_address FROM game_tracking
             WHERE status IN ('completed', 'cancelled')
           )`,
        "Failed to delete old secret keys",
        cutoffTime,
      );

      const deletedPlayers = this.runDelete(
        `DELETE FROM game_players
         WHERE game_address IN (
           ${COMPLETED_GAME_SUBQUERY}
         )`,
        "Failed to delete old player rows",
        DEFAULT_STATUS,
        cutoffTime,
      );

      const deletedGames = this.runDelete(
        DELETE_COMPLETED_GAMES_SQL,
        "Failed to delete old game tracking rows",
        DEFAULT_STATUS,
        cutoffTime,
      );

      const deletedCounts = {
        deletedSecrets,
        deletedGames,
        deletedPlayers,
      };

      logger.info(
        `🧹 Cleanup completed - Secrets: ${deletedCounts.deletedSecrets}, Games: ${deletedCounts.deletedGames}, Players: ${deletedCounts.deletedPlayers}`,
      );

      return deletedCounts;
    };

    try {
      return this.runInTransaction(cleanupWork, "Failed to cleanup old records");
    } catch (error) {
      logger.failure("Failed to cleanup old records:", error);
      return { deletedSecrets: 0, deletedGames: 0, deletedPlayers: 0 };
    }
  }

  public close(): void {
    try {
      // Checkpoint WAL to ensure all data is written to main database file
      // This is critical for data persistence when using WAL mode with NORMAL synchronous
      try {
        this.db.query("PRAGMA wal_checkpoint(TRUNCATE)").run();
      } catch (checkpointError) {
        logger.warn("Failed to checkpoint WAL during close:", checkpointError);
      }

      this.finalizePreparedStatements();
      this.db.close();
      this.closed = true;
      logger.info("📁 Database closed successfully");
    } catch (error) {
      logger.failure("Failed to close database:", error);
    }
  }

  private finalizePreparedStatements(): void {
    for (const [sql, statement] of this.statementCache) {
      try {
        statement.finalize();
      } catch (error) {
        logger.warn(`Failed to finalize statement for ${sql}:`, error);
      }
    }
    this.statementCache.clear();
  }

  public getConnectionInfo(): { file: string; isOpen: boolean } {
    return {
      file: getDatabaseFile(),
      isOpen: !this.closed,
    };
  }

  public addPlayerToGame(gameAddress: string, playerAddress: string, ticketIndex: number): void {
    this.runStatement(
      SQL_STATEMENTS.upsertGamePlayer,
      "Failed to add player to game",
      gameAddress,
      playerAddress,
      ticketIndex,
      Date.now(),
    );
  }

  public removePlayerFromGame(gameAddress: string, ticketIndex: number): void {
    this.runStatement(
      SQL_STATEMENTS.deleteGamePlayerByTicket,
      "Failed to remove player from game",
      gameAddress,
      ticketIndex,
    );
  }

  public removePlayerAddressFromGame(gameAddress: string, playerAddress: string): void {
    this.runStatement(
      SQL_STATEMENTS.deleteGamePlayerByAddress,
      "Failed to remove moved player from its previous index",
      gameAddress,
      playerAddress,
    );
  }

  public applyPlayerMutations(
    gameAddress: string,
    operations: ReadonlyArray<
      | { action: "joined"; playerAddress: string; ticketIndex: number }
      | {
          action: "unjoined";
          ticketIndex: number;
          movedParticipant?: string;
        }
    >,
  ): void {
    if (operations.length === 0) {
      return;
    }

    this.runInTransaction(() => {
      const baseTimestamp = Date.now();
      operations.forEach((op, index) => {
        if (op.action === "joined") {
          this.runStatement(
            SQL_STATEMENTS.upsertGamePlayer,
            "Failed to add player to game",
            gameAddress,
            op.playerAddress,
            op.ticketIndex,
            baseTimestamp + index,
          );
          return;
        }

        this.runStatement(
          SQL_STATEMENTS.deleteGamePlayerByTicket,
          "Failed to remove player from game",
          gameAddress,
          op.ticketIndex,
        );
        if (op.movedParticipant) {
          this.runStatement(
            SQL_STATEMENTS.deleteGamePlayerByAddress,
            "Failed to remove moved player from its previous index",
            gameAddress,
            op.movedParticipant,
          );
          this.runStatement(
            SQL_STATEMENTS.upsertGamePlayer,
            "Failed to move player after unjoin",
            gameAddress,
            op.movedParticipant,
            op.ticketIndex,
            baseTimestamp + index,
          );
        }
      });
    }, `Failed to apply player mutations for game ${gameAddress}`);
  }

  public clearStalePlayersForGame(gameAddress: string): void {
    this.runStatement(
      SQL_STATEMENTS.deleteGamePlayers,
      "Failed to clear stale players for game",
      gameAddress,
    );
    logger.info(`🧹 Cleared stale player data for game ${gameAddress}`);
  }

  public getGamePlayers(gameAddress: string): string[] {
    const results = this.queryAll<{ player_address: string }>(
      SQL_QUERIES.selectPlayersForGame,
      "Failed to get game players",
      gameAddress,
    );
    return results.map((row) => row.player_address);
  }

  public replaceGamePlayers(gameAddress: string, players: string[]): void {
    this.runInTransaction(() => {
      this.runStatement(
        SQL_STATEMENTS.deleteGamePlayers,
        "Failed to clear player registry for synchronization",
        gameAddress,
      );

      const baseTimestamp = Date.now();
      players.forEach((playerAddress, index) => {
        this.runStatement(
          SQL_STATEMENTS.upsertGamePlayer,
          "Failed to replace player during registry synchronization",
          gameAddress,
          playerAddress,
          index,
          baseTimestamp + index,
        );
      });
    }, `Failed to replace player registry for game ${gameAddress}`);
  }

  public getPlayerTicketStats(gameAddress: string): {
    count: number;
    maxIndex: number | null;
    minIndex: number | null;
  } {
    const result = this.queryOne<{
      count: number;
      max_index: number | null;
      min_index: number | null;
    }>(
      SQL_QUERIES.selectPlayerTicketStats,
      "Failed to query player ticket statistics",
      { count: 0, max_index: null, min_index: null },
      gameAddress,
    );

    return {
      count: result?.count ?? 0,
      maxIndex: result?.max_index ?? null,
      minIndex: result?.min_index ?? null,
    };
  }
}
