import { Database } from "bun:sqlite";

// Constants
const DATABASE_FILE = "oracle.sqlite";
const DEFAULT_STATUS = "pending";

// Types
interface SecretKeyData {
  secretKey: string;
  randomHash: string;
}

interface PendingGame {
  game_address: string;
  completion_attempts: number;
}

interface GameMetadata {
  game_address: string;
  min_players: number;
  max_players: number;
  created_at: number;
  timeout: number;
  current_players: number;
}

interface DatabaseStats {
  totalSecrets: number;
  usedSecrets: number;
  pendingGames: number;
  completedGames: number;
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
      this.createSecretKeysTable();
      this.createGameTrackingTable();
      this.createGameMetadataTable();
      console.log("✅ Oracle database initialized");
    } catch (error) {
      console.error("❌ Error initializing oracle database:", error);
      throw error;
    }
  }

  private createSecretKeysTable(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS secret_keys (
        game_address TEXT PRIMARY KEY,
        secret_key TEXT NOT NULL,
        random_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        used BOOLEAN DEFAULT FALSE
      )
    `);
  }

  private createGameTrackingTable(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS game_tracking (
        game_address TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT '${DEFAULT_STATUS}',
        last_checked INTEGER NOT NULL,
        completion_attempts INTEGER DEFAULT 0,
        completed_at INTEGER
      )
    `);
  }

  private createGameMetadataTable(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS game_metadata (
        game_address TEXT PRIMARY KEY,
        min_players INTEGER NOT NULL,
        max_players INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        timeout INTEGER NOT NULL,
        current_players INTEGER DEFAULT 0
      )
    `);
  }

  // Secret key management
  public saveSecretKey(gameAddress: string, secretKey: string, randomHash: string): void {
    try {
      const stmt = this.db.prepare(
        'INSERT INTO secret_keys (game_address, secret_key, random_hash, created_at) VALUES (?, ?, ?, ?)'
      );
      stmt.run(gameAddress, secretKey, randomHash, Date.now());
    } catch (error) {
      console.error("❌ Error saving secret key:", error);
      throw new Error(`Failed to save secret key for game ${gameAddress}`);
    }
  }

  public getSecretKey(gameAddress: string): SecretKeyData | null {
    try {
      const stmt = this.db.prepare(
        'SELECT secret_key, random_hash FROM secret_keys WHERE game_address = ? AND used = FALSE'
      );
      const result = stmt.get(gameAddress) as { secret_key: string; random_hash: string } | undefined;

      if (!result) {
        return null;
      }

      return {
        secretKey: result.secret_key,
        randomHash: result.random_hash
      };
    } catch (error) {
      console.error("❌ Error getting secret key:", error);
      return null;
    }
  }

  public markSecretKeyUsed(gameAddress: string): void {
    try {
      const stmt = this.db.prepare('UPDATE secret_keys SET used = TRUE WHERE game_address = ?');
      const result = stmt.run(gameAddress);

      if (result.changes === 0) {
        console.warn(`⚠️ No secret key found to mark as used for game ${gameAddress}`);
      }
    } catch (error) {
      console.error("❌ Error marking secret key as used:", error);
    }
  }

  // Game metadata management
  public saveGameMetadata(gameAddress: string, minPlayers: number, maxPlayers: number, createdAt: number, timeout: number): void {
    try {
      const stmt = this.db.prepare(
        'INSERT OR REPLACE INTO game_metadata (game_address, min_players, max_players, created_at, timeout, current_players) VALUES (?, ?, ?, ?, ?, 0)'
      );
      stmt.run(gameAddress, minPlayers, maxPlayers, createdAt, timeout);
    } catch (error) {
      console.error("❌ Error saving game metadata:", error);
    }
  }

  public getGameMetadata(gameAddress: string): GameMetadata | null {
    try {
      const stmt = this.db.prepare(
        'SELECT * FROM game_metadata WHERE game_address = ?'
      );
      const result = stmt.get(gameAddress) as GameMetadata | undefined;
      return result || null;
    } catch (error) {
      console.error("❌ Error getting game metadata:", error);
      return null;
    }
  }

  public updatePlayerCount(gameAddress: string, playerCount: number): void {
    try {
      const stmt = this.db.prepare(
        'UPDATE game_metadata SET current_players = ? WHERE game_address = ?'
      );
      const result = stmt.run(playerCount, gameAddress);

      if (result.changes === 0) {
        console.warn(`⚠️ No game metadata found to update players for ${gameAddress}`);
      }
    } catch (error) {
      console.error("❌ Error updating player count:", error);
    }
  }

  public isGameReadyForCompletion(gameAddress: string): boolean {
    try {
      const metadata = this.getGameMetadata(gameAddress);
      if (!metadata) {
        console.warn(`⚠️ No metadata found for game ${gameAddress}`);
        return false;
      }

      const currentTime = Math.floor(Date.now() / 1000);
      const expiresAt = metadata.created_at + metadata.timeout;
      const isExpired = currentTime > expiresAt;
      const isFull = metadata.current_players >= metadata.max_players;
      const hasMinPlayers = metadata.current_players >= metadata.min_players;

      console.log(`🔍 Game ${gameAddress} readiness check:`, {
        currentPlayers: metadata.current_players,
        minPlayers: metadata.min_players,
        maxPlayers: metadata.max_players,
        isFull,
        isExpired,
        hasMinPlayers,
        ready: isFull || (isExpired && hasMinPlayers)
      });

      return isFull || (isExpired && hasMinPlayers);
    } catch (error) {
      console.error("❌ Error checking game readiness:", error);
      return false;
    }
  }

  // Game tracking
  public trackGame(gameAddress: string): void {
    try {
      const now = Date.now();
      const stmt = this.db.prepare(
        'INSERT OR REPLACE INTO game_tracking (game_address, status, last_checked) VALUES (?, ?, ?)'
      );
      stmt.run(gameAddress, DEFAULT_STATUS, now);
    } catch (error) {
      console.error("❌ Error tracking game:", error);
    }
  }

  public markGameCompleted(gameAddress: string): void {
    try {
      const now = Date.now();
      const stmt = this.db.prepare(
        'UPDATE game_tracking SET status = ?, completed_at = ?, last_checked = ? WHERE game_address = ?'
      );
      const result = stmt.run('completed', now, now, gameAddress);

      if (result.changes === 0) {
        console.warn(`⚠️ No game found to mark as completed: ${gameAddress}`);
      }
    } catch (error) {
      console.error("❌ Error marking game as completed:", error);
    }
  }

  public incrementCompletionAttempts(gameAddress: string): void {
    try {
      const stmt = this.db.prepare(
        'UPDATE game_tracking SET completion_attempts = completion_attempts + 1, last_checked = ? WHERE game_address = ?'
      );
      const result = stmt.run(Date.now(), gameAddress);

      if (result.changes === 0) {
        console.warn(`⚠️ No game found to increment attempts: ${gameAddress}`);
      }
    } catch (error) {
      console.error("❌ Error incrementing completion attempts:", error);
    }
  }

  public getPendingGames(): PendingGame[] {
    try {
      const stmt = this.db.prepare(
        'SELECT game_address, completion_attempts FROM game_tracking WHERE status = ? ORDER BY last_checked ASC LIMIT 50'
      );
      return stmt.all(DEFAULT_STATUS) as PendingGame[];
    } catch (error) {
      console.error("❌ Error getting pending games:", error);
      return [];
    }
  }

  // Statistics and analytics
  public getStats(): DatabaseStats {
    try {
      const secretsStats = this.getSecretsStats();
      const gamesStats = this.getGamesStats();

      return {
        totalSecrets: secretsStats.total || 0,
        usedSecrets: secretsStats.used || 0,
        pendingGames: gamesStats.pending || 0,
        completedGames: gamesStats.completed || 0
      };
    } catch (error) {
      console.error("❌ Error getting stats:", error);
      return {
        totalSecrets: 0,
        usedSecrets: 0,
        pendingGames: 0,
        completedGames: 0
      };
    }
  }

  private getSecretsStats(): { total: number; used: number } {
    const stmt = this.db.prepare(
      'SELECT COUNT(*) as total, SUM(CASE WHEN used = TRUE THEN 1 ELSE 0 END) as used FROM secret_keys'
    );
    return stmt.get() as { total: number; used: number };
  }

  private getGamesStats(): { pending: number; completed: number } {
    const stmt = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
      FROM game_tracking
    `);
    return stmt.get(DEFAULT_STATUS) as { pending: number; completed: number };
  }

  // Utility methods
  public close(): void {
    try {
      this.db.close();
      console.log("✅ Database connection closed");
    } catch (error) {
      console.error("❌ Error closing database:", error);
    }
  }

  public getConnectionInfo(): { file: string; isOpen: boolean } {
    return {
      file: DATABASE_FILE,
      isOpen: this.db !== null
    };
  }
}
