import { Database } from "bun:sqlite";

/**
 * Oracle Database for storing secret keys and tracking game completion
 */
export class OracleDatabase {
  private static instance: OracleDatabase;
  private db: Database;

  private constructor() {
    this.db = new Database("oracle.sqlite", { create: true });
    this.initDb();
  }

  public static getInstance(): OracleDatabase {
    if (!OracleDatabase.instance) {
      OracleDatabase.instance = new OracleDatabase();
    }
    return OracleDatabase.instance;
  }

  private initDb(): void {
    try {
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

      // Simple game tracking
      this.db.run(`
        CREATE TABLE IF NOT EXISTS game_tracking (
          game_address TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'pending',
          last_checked INTEGER NOT NULL,
          completion_attempts INTEGER DEFAULT 0,
          completed_at INTEGER
        )
      `);

      console.log("Oracle database initialized");
    } catch (error) {
      console.error("Error initializing oracle database:", error);
      throw error;
    }
  }

  // Secret key management
  public saveSecretKey(gameAddress: string, secretKey: string, randomHash: string): void {
    try {
      const stmt = this.db.prepare(
        'INSERT INTO secret_keys (game_address, secret_key, random_hash, created_at) VALUES (?, ?, ?, ?)'
      );
      stmt.run(gameAddress, secretKey, randomHash, Date.now());
    } catch (error) {
      console.error("Error saving secret key:", error);
      throw error;
    }
  }

  public getSecretKey(gameAddress: string): { secretKey: string; randomHash: string } | null {
    try {
      const stmt = this.db.prepare('SELECT secret_key, random_hash FROM secret_keys WHERE game_address = ? AND used = FALSE');
      const result = stmt.get(gameAddress) as { secret_key: string; random_hash: string } | undefined;

      if (!result) return null;

      return {
        secretKey: result.secret_key,
        randomHash: result.random_hash
      };
    } catch (error) {
      console.error("Error getting secret key:", error);
      return null;
    }
  }

  public markSecretKeyUsed(gameAddress: string): void {
    try {
      const stmt = this.db.prepare('UPDATE secret_keys SET used = TRUE WHERE game_address = ?');
      stmt.run(gameAddress);
    } catch (error) {
      console.error("Error marking secret key as used:", error);
    }
  }

  // Game tracking
  public trackGame(gameAddress: string): void {
    try {
      const now = Date.now();
      const stmt = this.db.prepare(
        'INSERT OR REPLACE INTO game_tracking (game_address, status, last_checked) VALUES (?, ?, ?)'
      );
      stmt.run(gameAddress, 'pending', now);
    } catch (error) {
      console.error("Error tracking game:", error);
    }
  }

  public markGameCompleted(gameAddress: string): void {
    try {
      const stmt = this.db.prepare(
        'UPDATE game_tracking SET status = ?, completed_at = ?, last_checked = ? WHERE game_address = ?'
      );
      stmt.run('completed', Date.now(), Date.now(), gameAddress);
    } catch (error) {
      console.error("Error marking game as completed:", error);
    }
  }

  public incrementCompletionAttempts(gameAddress: string): void {
    try {
      const stmt = this.db.prepare(
        'UPDATE game_tracking SET completion_attempts = completion_attempts + 1, last_checked = ? WHERE game_address = ?'
      );
      stmt.run(Date.now(), gameAddress);
    } catch (error) {
      console.error("Error incrementing completion attempts:", error);
    }
  }

  public getPendingGames(): Array<{ game_address: string; completion_attempts: number }> {
    try {
      const stmt = this.db.prepare(
        'SELECT game_address, completion_attempts FROM game_tracking WHERE status = "pending" ORDER BY last_checked ASC LIMIT 50'
      );
      return stmt.all() as Array<{ game_address: string; completion_attempts: number }>;
    } catch (error) {
      console.error("Error getting pending games:", error);
      return [];
    }
  }

  // Basic stats
  public getStats(): {
    totalSecrets: number;
    usedSecrets: number;
    pendingGames: number;
    completedGames: number;
  } {
    try {
      const secretsStmt = this.db.prepare('SELECT COUNT(*) as total, SUM(CASE WHEN used = TRUE THEN 1 ELSE 0 END) as used FROM secret_keys');
      const secretsResult = secretsStmt.get() as { total: number; used: number };

      const gamesStmt = this.db.prepare(`
        SELECT
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
        FROM game_tracking
      `);
      const gamesResult = gamesStmt.get() as { pending: number; completed: number };

      return {
        totalSecrets: secretsResult.total || 0,
        usedSecrets: secretsResult.used || 0,
        pendingGames: gamesResult.pending || 0,
        completedGames: gamesResult.completed || 0
      };
    } catch (error) {
      console.error("Error getting stats:", error);
      return {
        totalSecrets: 0,
        usedSecrets: 0,
        pendingGames: 0,
        completedGames: 0
      };
    }
  }
}
