import { Database } from "bun:sqlite";

// Constants
const DATABASE_FILE = process.env["DATABASE_FILE"] || "oracle.sqlite";
const DEFAULT_STATUS = "pending";
const PENDING_SCAN_LIMIT = 50;

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

  private constructor() {
    this.db = new Database(DATABASE_FILE, { create: true });
    this.initializeDatabase();
  }

  public static getInstance(): OracleDatabase {
    if (!OracleDatabase.instance) {
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

    // Game players table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS game_players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_address TEXT NOT NULL,
        player_address TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        UNIQUE(game_address, player_address)
      )
    `);
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

  // Secret key management
  public saveSecretKey(
    gameAddress: string,
    secretKey: string,
    randomHash: string
  ): void {
    this.executeDbOperation(() => {
      const stmt = this.db.prepare(
        "INSERT INTO secret_keys (game_address, secret_key, random_hash, created_at) VALUES (?, ?, ?, ?)"
      );
      stmt.run(gameAddress, secretKey, randomHash, Date.now());
    }, `Failed to save secret key for game ${gameAddress}`);
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
    this.executeDbOperation(() => {
      const stmt = this.db.prepare(
        "UPDATE secret_keys SET used = TRUE WHERE game_address = ?"
      );
      stmt.run(gameAddress);
    }, "Failed to mark secret key as used");
  }

  // Game tracking
  public trackGame(gameAddress: string, gameType?: string): void {
    this.executeDbOperation(() => {
      const stmt = this.db.prepare(
        "INSERT OR REPLACE INTO game_tracking (game_address, status, game_type, last_checked) VALUES (?, ?, ?, ?)"
      );
      stmt.run(gameAddress, DEFAULT_STATUS, gameType || null, Date.now());
    }, "Failed to track game");
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
    this.executeDbOperation(() => {
      const now = Date.now();
      const stmt = this.db.prepare(
        "UPDATE game_tracking SET status = ?, completed_at = ?, last_checked = ? WHERE game_address = ?"
      );
      stmt.run(status, now, now, gameAddress);
    }, errorMessage);
  }

  public markGameCompleted(gameAddress: string): void {
    this.updateGameStatus(gameAddress, "completed", "Failed to mark game as completed");
  }

  public markGameClosed(gameAddress: string): void {
    this.updateGameStatus(gameAddress, "cancelled", "Failed to mark game as closed");
  }

  public incrementCompletionAttempts(gameAddress: string): void {
    this.executeDbOperation(() => {
      const stmt = this.db.prepare(
        "UPDATE game_tracking SET completion_attempts = completion_attempts + 1, last_checked = ? WHERE game_address = ?"
      );
      stmt.run(Date.now(), gameAddress);
    }, "Failed to increment completion attempts");
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

      // Clean up old secret keys
      const secretsStmt = this.db.prepare(
        "DELETE FROM secret_keys WHERE created_at < ?"
      );
      const secretsResult = secretsStmt.run(cutoffTime);

      // Clean up old game tracking records (completed/cancelled games older than cutoff)
      const trackingStmt = this.db.prepare(
        "DELETE FROM game_tracking WHERE (status != ? AND completed_at IS NOT NULL AND completed_at < ?) OR (status = ? AND last_checked < ?)"
      );
      const trackingResult = trackingStmt.run(
        "pending",
        cutoffTime,
        "pending",
        cutoffTime
      );

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
    } catch (error) {
      console.error("❌ Failed to close database:", error);
    }
  }

  public getConnectionInfo(): { file: string; isOpen: boolean } {
    return {
      file: DATABASE_FILE,
      isOpen: this.db !== null,
    };
  }

  public addPlayerToGame(gameAddress: string, playerAddress: string): void {
    this.executeDbOperation(() => {
      const stmt = this.db.prepare(
        "INSERT OR IGNORE INTO game_players (game_address, player_address, joined_at) VALUES (?, ?, ?)"
      );
      stmt.run(gameAddress, playerAddress, Date.now());
    }, "Failed to add player to game");
  }

  public removePlayerFromGame(
    gameAddress: string,
    playerAddress: string
  ): void {
    this.executeDbOperation(() => {
      const stmt = this.db.prepare(
        "DELETE FROM game_players WHERE game_address = ? AND player_address = ?"
      );
      stmt.run(gameAddress, playerAddress);
    }, "Failed to remove player from game");
  }

  public clearStalePlayersForGame(gameAddress: string): void {
    this.executeDbOperation(() => {
      const stmt = this.db.prepare(
        "DELETE FROM game_players WHERE game_address = ?"
      );
      stmt.run(gameAddress);
      console.log(`🧹 Cleared stale player data for game ${gameAddress}`);
    }, "Failed to clear stale players for game");
  }

  public getGamePlayers(gameAddress: string): string[] {
    return this.executeDbOperation(
      () => {
        const stmt = this.db.prepare(
          "SELECT player_address FROM game_players WHERE game_address = ? ORDER BY joined_at ASC"
        );
        const results = stmt.all(gameAddress) as { player_address: string }[];
        return results.map((row) => row.player_address);
      },
      "Failed to get game players",
      []
    );
  }
}
