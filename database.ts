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
    // Secret keys table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS secret_keys (
        game_address TEXT PRIMARY KEY,
        secret_key TEXT NOT NULL,
        random_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        used BOOLEAN DEFAULT FALSE
      )
    `);

    // Game tracking table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS game_tracking (
        game_address TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT '${DEFAULT_STATUS}',
        game_type TEXT,
        last_checked INTEGER NOT NULL,
        completion_attempts INTEGER DEFAULT 0,
        completed_at INTEGER
      )
    `);

    // Game players table (per-ticket entries)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS game_players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_address TEXT NOT NULL,
        player_address TEXT NOT NULL,
        ticket_index INTEGER NOT NULL,
        joined_at INTEGER NOT NULL,
        UNIQUE(game_address, ticket_index)
      )
    `);

    this.ensureTicketSchema();
  }

  private ensureTicketSchema(): void {
    const tableInfo = this.db
      .query("PRAGMA table_info('game_players')")
      .all() as Array<{ name: string }>;
    const hasTicketIndex = tableInfo.some((column) => column.name === "ticket_index");

    if (!hasTicketIndex) {
      this.db.run("ALTER TABLE game_players ADD COLUMN ticket_index INTEGER");
      this.db.run("DELETE FROM game_players");
    }

    this.db.run(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_game_players_ticket ON game_players (game_address, ticket_index)"
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_game_players_game ON game_players (game_address)"
    );
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
    params: unknown[],
    errorMessage: string
  ): ReturnType<ReturnType<Database["prepare"]>["run"]> {
    return this.executeDbOperation(() => {
      const stmt = this.db.prepare(sql);
      return stmt.run(...params);
    }, errorMessage);
  }

  // Secret key management
  public saveSecretKey(
    gameAddress: string,
    secretKey: string,
    randomHash: string
  ): void {
    this.runStatement(
      "INSERT INTO secret_keys (game_address, secret_key, random_hash, created_at) VALUES (?, ?, ?, ?)",
      [gameAddress, secretKey, randomHash, Date.now()],
      `Failed to save secret key for game ${gameAddress}`
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
      [gameAddress],
      "Failed to mark secret key as used"
    );
  }

  // Game tracking
  public trackGame(gameAddress: string, gameType?: string): void {
    this.runStatement(
      "INSERT OR REPLACE INTO game_tracking (game_address, status, game_type, last_checked) VALUES (?, ?, ?, ?)",
      [gameAddress, DEFAULT_STATUS, gameType || null, Date.now()],
      "Failed to track game"
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
      [status, now, now, gameAddress],
      errorMessage
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
      [Date.now(), gameAddress],
      "Failed to increment completion attempts"
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
        totalSecrets: secretsStats.total || 0,
        usedSecrets: secretsStats.used || 0,
        pendingGames: gamesStats.pending || 0,
        completedGames: gamesStats.completed || 0,
        cancelledGames: gamesStats.cancelled || 0,
      };
    } catch (error) {
      console.error("❌ Failed to get stats:", error);
      return {
        totalSecrets: 0,
        usedSecrets: 0,
        pendingGames: 0,
        completedGames: 0,
        cancelledGames: 0,
      };
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
      const secretsStmt = this.db.prepare(
        `DELETE FROM secret_keys
         WHERE created_at < ?
           AND (
             used = TRUE OR
             game_address IN (
               SELECT game_address FROM game_tracking WHERE status != ?
             )
           )`
      );
      const secretsResult = secretsStmt.run(cutoffTime, DEFAULT_STATUS);

      // Clean up old game tracking records (completed/cancelled games older than cutoff)
      const trackingStmt = this.db.prepare(
        `DELETE FROM game_tracking
         WHERE status != ?
           AND completed_at IS NOT NULL
           AND completed_at < ?`
      );
      const trackingResult = trackingStmt.run(DEFAULT_STATUS, cutoffTime);

      const deletedCounts = {
        deletedSecrets: secretsResult.changes,
        deletedGames: trackingResult.changes,
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
      [gameAddress, playerAddress, ticketIndex, Date.now()],
      "Failed to add player to game"
    );
  }

  public removePlayerFromGame(
    gameAddress: string,
    ticketIndex: number
  ): void {
    this.runStatement(
      "DELETE FROM game_players WHERE game_address = ? AND ticket_index = ?",
      [gameAddress, ticketIndex],
      "Failed to remove player from game"
    );
  }

  public clearStalePlayersForGame(gameAddress: string): void {
    this.runStatement(
      "DELETE FROM game_players WHERE game_address = ?",
      [gameAddress],
      "Failed to clear stale players for game"
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
