import { Database } from "bun:sqlite";

// Constants
const DEFAULT_STATUS = "pending";
const PENDING_SCAN_LIMIT = 50;

function getDatabaseFile(): string {
  return process.env["DATABASE_FILE"] || "oracle.sqlite";
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
        completed_at INTEGER
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

const EMPTY_DATABASE_STATS: Readonly<DatabaseStats> = Object.freeze({
  totalSecrets: 0,
  usedSecrets: 0,
  pendingGames: 0,
  completedGames: 0,
  cancelledGames: 0,
});

function createEmptyStats(): DatabaseStats {
  return { ...EMPTY_DATABASE_STATS };
}

/**
 * Oracle Database for storing secret keys and tracking game completion
 */
export class OracleDatabase {
  private static instance: OracleDatabase;
  private db: Database;
  private closed: boolean = false;

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
      this.createTables();
      console.log("✅ Oracle database initialized");
    } catch (error) {
      console.error("❌ Database initialization failed:", error);
      throw error;
    }
  }

  private createTables(): void {
    for (const definition of TABLE_DEFINITIONS) {
      this.runSchemaStatement(definition.sql, definition.log, definition.error);
    }

    this.ensureTicketSchema();
  }

  private ensureTicketSchema(): void {
    const tableInfo = this.db
      .query("PRAGMA table_info('game_players')")
      .all() as Array<{ name: string }>;
    const hasTicketIndex = tableInfo.some((column) => column.name === "ticket_index");

    if (!hasTicketIndex) {
      for (const statement of LEGACY_TICKET_MIGRATIONS) {
        this.runSchemaStatement(statement.sql, statement.log, statement.error);
      }
    }

    for (const definition of PLAYER_INDEX_DEFINITIONS) {
      this.runSchemaStatement(definition.sql, definition.log, definition.error);
    }
  }

  private runSchemaStatement(
    sql: string,
    logMessage: string,
    errorMessage: string,
    ...params: Parameters<ReturnType<Database["prepare"]>["run"]>
  ): ReturnType<ReturnType<Database["prepare"]>["run"]> {
    console.log(`🛠️ ${logMessage}`);
    return this.runStatement(sql, errorMessage, ...params);
  }

  private executeDbOperation<T>(
    operation: () => T,
    errorMessage: string,
    defaultValue?: T
  ): T {
    try {
      return operation();
    } catch (error) {
      console.error(`❌ ${errorMessage}:`, error);
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      throw new Error(errorMessage);
    }
  }

  private runStatement(
    sql: string,
    errorMessage: string,
    ...params: Parameters<ReturnType<Database["prepare"]>["run"]>
  ): ReturnType<ReturnType<Database["prepare"]>["run"]> {
    return this.executeDbOperation(() => {
      const stmt = this.db.prepare(sql);
      return stmt.run(...params);
    }, errorMessage);
  }

  private runDelete(
    sql: string,
    errorMessage: string,
    ...params: Parameters<ReturnType<Database["prepare"]>["run"]>
  ): number {
    const result = this.runStatement(sql, errorMessage, ...params);
    return typeof result?.changes === "number" ? result.changes : 0;
  }

  // Secret key management
  public saveSecretKey(
    gameAddress: string,
    secretKey: string,
    randomHash: string
  ): void {
    this.runStatement(
      "INSERT INTO secret_keys (game_address, secret_key, random_hash, created_at) VALUES (?, ?, ?, ?)",
      `Failed to save secret key for game ${gameAddress}`,
      gameAddress,
      secretKey,
      randomHash,
      Date.now()
    );
  }

  public getSecretKey(gameAddress: string): SecretKeyData | null {
    return this.executeDbOperation(
      () => {
        const stmt = this.db.prepare(
          "SELECT secret_key, random_hash FROM secret_keys WHERE game_address = ? AND used = FALSE"
        );
        const result = stmt.get(gameAddress) as
          | { secret_key: string; random_hash: string }
          | undefined;

        return result
          ? {
              secretKey: result.secret_key,
              randomHash: result.random_hash,
            }
          : null;
      },
      "Failed to get secret key",
      null
    );
  }

  public markSecretKeyUsed(gameAddress: string): void {
    this.runStatement(
      "UPDATE secret_keys SET used = TRUE WHERE game_address = ?",
      "Failed to mark secret key as used",
      gameAddress
    );
  }

  // Game tracking
  public trackGame(gameAddress: string, gameType?: string): void {
    this.runStatement(
      "INSERT OR REPLACE INTO game_tracking (game_address, status, game_type, last_checked) VALUES (?, ?, ?, ?)",
      "Failed to track game",
      gameAddress,
      DEFAULT_STATUS,
      gameType || null,
      Date.now()
    );
  }

  public getGameType(gameAddress: string): string | null {
    return this.executeDbOperation(() => {
      const stmt = this.db.prepare(
        "SELECT game_type FROM game_tracking WHERE game_address = ?"
      );
      const result = stmt.get(gameAddress) as
        | { game_type: string | null }
        | undefined;
      return result?.game_type || null;
    }, "Failed to get game type");
  }

  private updateGameStatus(
    gameAddress: string,
    status: "completed" | "cancelled",
    errorMessage: string
  ): void {
    const now = Date.now();
    this.runStatement(
      "UPDATE game_tracking SET status = ?, completed_at = ?, last_checked = ? WHERE game_address = ?",
      errorMessage,
      status,
      now,
      now,
      gameAddress
    );
  }

  public markGameCompleted(gameAddress: string): void {
    this.updateGameStatus(gameAddress, "completed", "Failed to mark game as completed");
  }

  public markGameClosed(gameAddress: string): void {
    this.updateGameStatus(gameAddress, "cancelled", "Failed to mark game as closed");
  }

  public incrementCompletionAttempts(gameAddress: string): void {
    this.runStatement(
      "UPDATE game_tracking SET completion_attempts = completion_attempts + 1, last_checked = ? WHERE game_address = ?",
      "Failed to increment completion attempts",
      Date.now(),
      gameAddress
    );
  }

  public getPendingGames(): PendingGame[] {
    return this.executeDbOperation(
      () => {
        const stmt = this.db.prepare(
          "SELECT game_address, completion_attempts FROM game_tracking WHERE status = ? ORDER BY last_checked ASC LIMIT ?"
        );
        return stmt.all(DEFAULT_STATUS, PENDING_SCAN_LIMIT) as PendingGame[];
      },
      "Failed to get pending games",
      []
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
      console.error("❌ Failed to get stats:", error);
      return createEmptyStats();
    }
  }

  private getSecretsStats(): { total: number; used: number } {
    const stmt = this.db.prepare(
      "SELECT COUNT(*) as total, SUM(CASE WHEN used = TRUE THEN 1 ELSE 0 END) as used FROM secret_keys"
    );
    return stmt.get() as { total: number; used: number };
  }

  private getGamesStats(): {
    pending: number;
    completed: number;
    cancelled: number;
  } {
    const stmt = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled
      FROM game_tracking
    `);
    return stmt.get(DEFAULT_STATUS) as {
      pending: number;
      completed: number;
      cancelled: number;
    };
  }

  // Utility methods
  public cleanupOldRecords(hoursOld: number = 48): {
    deletedSecrets: number;
    deletedGames: number;
  } {
    try {
      const cutoffTime = Date.now() - hoursOld * 60 * 60 * 1000;

      // Clean up old secret keys that have already been used or whose game is finished.
      const deletedSecrets = this.runDelete(
        `DELETE FROM secret_keys
         WHERE created_at < ?
           AND (
             used = TRUE OR
             game_address IN (
               SELECT game_address FROM game_tracking WHERE status != ?
             )
           )`,
        "Failed to delete old secret keys",
        cutoffTime,
        DEFAULT_STATUS
      );

      // Clean up old game tracking records (completed/cancelled games older than cutoff)
      const deletedGames = this.runDelete(
        `DELETE FROM game_tracking
         WHERE status != ?
           AND completed_at IS NOT NULL
           AND completed_at < ?`,
        "Failed to delete old game tracking rows",
        DEFAULT_STATUS,
        cutoffTime
      );

      const deletedCounts = {
        deletedSecrets,
        deletedGames,
      };

      console.log(
        `🧹 Cleanup completed - Secrets: ${deletedCounts.deletedSecrets}, Games: ${deletedCounts.deletedGames}`
      );

      return deletedCounts;
    } catch (error) {
      console.error("❌ Failed to cleanup old records:", error);
      return { deletedSecrets: 0, deletedGames: 0 };
    }
  }

  public close(): void {
    try {
      this.db.close();
      this.closed = true;
    } catch (error) {
      console.error("❌ Failed to close database:", error);
    }
  }

  public getConnectionInfo(): { file: string; isOpen: boolean } {
    return {
      file: getDatabaseFile(),
      isOpen: !this.closed,
    };
  }

  public addPlayerToGame(
    gameAddress: string,
    playerAddress: string,
    ticketIndex: number
  ): void {
    this.runStatement(
      "INSERT OR REPLACE INTO game_players (game_address, player_address, ticket_index, joined_at) VALUES (?, ?, ?, ?)",
      "Failed to add player to game",
      gameAddress,
      playerAddress,
      ticketIndex,
      Date.now()
    );
  }

  public removePlayerFromGame(
    gameAddress: string,
    ticketIndex: number
  ): void {
    this.runStatement(
      "DELETE FROM game_players WHERE game_address = ? AND ticket_index = ?",
      "Failed to remove player from game",
      gameAddress,
      ticketIndex
    );
  }

  public clearStalePlayersForGame(gameAddress: string): void {
    this.runStatement(
      "DELETE FROM game_players WHERE game_address = ?",
      "Failed to clear stale players for game",
      gameAddress
    );
    console.log(`🧹 Cleared stale player data for game ${gameAddress}`);
  }

  public getGamePlayers(gameAddress: string): string[] {
    return this.executeDbOperation(
      () => {
        const stmt = this.db.prepare(
          "SELECT player_address FROM game_players WHERE game_address = ? ORDER BY ticket_index ASC"
        );
        const results = stmt.all(gameAddress) as { player_address: string }[];
        return results.map((row) => row.player_address);
      },
      "Failed to get game players",
      []
    );
  }
}
