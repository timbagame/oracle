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
  expires_at: number;
  current_players: number;
  nonce?: number;
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
        last_checked INTEGER NOT NULL,
        completion_attempts INTEGER DEFAULT 0,
        completed_at INTEGER
      )
    `);

    // Game metadata table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS game_metadata (
        game_address TEXT PRIMARY KEY,
        min_players INTEGER NOT NULL,
        max_players INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        current_players INTEGER DEFAULT 0,
        nonce INTEGER
      )
    `);

    // Game players table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS game_players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_address TEXT NOT NULL,
        player_address TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        FOREIGN KEY (game_address) REFERENCES game_metadata (game_address),
        UNIQUE(game_address, player_address)
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
      console.error("❌ Failed to save secret key:", error);
      throw new Error(`Failed to save secret key for game ${gameAddress}`);
    }
  }

  public getSecretKey(gameAddress: string): SecretKeyData | null {
    try {
      const stmt = this.db.prepare(
        'SELECT secret_key, random_hash FROM secret_keys WHERE game_address = ? AND used = FALSE'
      );
      const result = stmt.get(gameAddress) as { secret_key: string; random_hash: string } | undefined;

      return result ? {
        secretKey: result.secret_key,
        randomHash: result.random_hash
      } : null;
    } catch (error) {
      console.error("❌ Failed to get secret key:", error);
      return null;
    }
  }

  public markSecretKeyUsed(gameAddress: string): void {
    try {
      const stmt = this.db.prepare('UPDATE secret_keys SET used = TRUE WHERE game_address = ?');
      stmt.run(gameAddress);
    } catch (error) {
      console.error("❌ Failed to mark secret key as used:", error);
    }
  }

  // Game metadata management
  public saveGameMetadata(gameAddress: string, minPlayers: number, maxPlayers: number, expiresAt: number, nonce?: number): void {
    try {
      if (nonce !== undefined) {
        const stmt = this.db.prepare(
          'INSERT OR REPLACE INTO game_metadata (game_address, min_players, max_players, expires_at, current_players, nonce) VALUES (?, ?, ?, ?, 0, ?)'
        );
        stmt.run(gameAddress, minPlayers, maxPlayers, expiresAt, nonce);
      } else {
        const stmt = this.db.prepare(
          'INSERT OR REPLACE INTO game_metadata (game_address, min_players, max_players, expires_at, current_players) VALUES (?, ?, ?, ?, 0)'
        );
        stmt.run(gameAddress, minPlayers, maxPlayers, expiresAt);
      }
    } catch (error) {
      console.error("❌ Failed to save game metadata:", error);
    }
  }

  public getGameMetadata(gameAddress: string): GameMetadata | null {
    try {
      const stmt = this.db.prepare('SELECT * FROM game_metadata WHERE game_address = ?');
      return stmt.get(gameAddress) as GameMetadata | null;
    } catch (error) {
      console.error("❌ Failed to get game metadata:", error);
      return null;
    }
  }

  public updatePlayerCount(gameAddress: string, playerCount: number): void {
    try {
      const stmt = this.db.prepare('UPDATE game_metadata SET current_players = ? WHERE game_address = ?');
      stmt.run(playerCount, gameAddress);
    } catch (error) {
      console.error("❌ Failed to update player count:", error);
    }
  }

  public isGameReadyForCompletion(gameAddress: string): boolean {
    try {
      const metadata = this.getGameMetadata(gameAddress);
      if (!metadata) return false;

      const currentTime = Math.floor(Date.now() / 1000);
      const isExpired = currentTime > metadata.expires_at;
      const isFull = metadata.current_players >= metadata.max_players;
      const hasMinPlayers = metadata.current_players >= metadata.min_players;

      return isFull || (isExpired && hasMinPlayers);
    } catch (error) {
      console.error("❌ Failed to check game readiness:", error);
      return false;
    }
  }

  // Game tracking
  public trackGame(gameAddress: string): void {
    try {
      const stmt = this.db.prepare(
        'INSERT OR REPLACE INTO game_tracking (game_address, status, last_checked) VALUES (?, ?, ?)'
      );
      stmt.run(gameAddress, DEFAULT_STATUS, Date.now());
    } catch (error) {
      console.error("❌ Failed to track game:", error);
    }
  }

  public markGameCompleted(gameAddress: string): void {
    try {
      const now = Date.now();
      const stmt = this.db.prepare(
        'UPDATE game_tracking SET status = ?, completed_at = ?, last_checked = ? WHERE game_address = ?'
      );
      stmt.run('completed', now, now, gameAddress);
    } catch (error) {
      console.error("❌ Failed to mark game as completed:", error);
    }
  }

  public markGameCancelled(gameAddress: string): void {
    try {
      const now = Date.now();
      const stmt = this.db.prepare(
        'UPDATE game_tracking SET status = ?, completed_at = ?, last_checked = ? WHERE game_address = ?'
      );
      stmt.run('cancelled', now, now, gameAddress);
    } catch (error) {
      console.error("❌ Failed to mark game as cancelled:", error);
    }
  }

  public incrementCompletionAttempts(gameAddress: string): void {
    try {
      const stmt = this.db.prepare(
        'UPDATE game_tracking SET completion_attempts = completion_attempts + 1, last_checked = ? WHERE game_address = ?'
      );
      stmt.run(Date.now(), gameAddress);
    } catch (error) {
      console.error("❌ Failed to increment completion attempts:", error);
    }
  }

  public getPendingGames(): PendingGame[] {
    try {
      const stmt = this.db.prepare(
        'SELECT game_address, completion_attempts FROM game_tracking WHERE status = ? ORDER BY last_checked ASC LIMIT 50'
      );
      return stmt.all(DEFAULT_STATUS) as PendingGame[];
    } catch (error) {
      console.error("❌ Failed to get pending games:", error);
      return [];
    }
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
        cancelledGames: gamesStats.cancelled || 0
      };
    } catch (error) {
      console.error("❌ Failed to get stats:", error);
      return { totalSecrets: 0, usedSecrets: 0, pendingGames: 0, completedGames: 0, cancelledGames: 0 };
    }
  }

  private getSecretsStats(): { total: number; used: number } {
    const stmt = this.db.prepare(
      'SELECT COUNT(*) as total, SUM(CASE WHEN used = TRUE THEN 1 ELSE 0 END) as used FROM secret_keys'
    );
    return stmt.get() as { total: number; used: number };
  }

  private getGamesStats(): { pending: number; completed: number; cancelled: number } {
    const stmt = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled
      FROM game_tracking
    `);
    return stmt.get(DEFAULT_STATUS) as { pending: number; completed: number; cancelled: number };
  }

  // Utility methods
  public cleanupOldRecords(hoursOld: number = 48): { deletedSecrets: number; deletedGames: number; deletedMetadata: number } {
    try {
      const cutoffTime = Date.now() - (hoursOld * 60 * 60 * 1000);
      const cutoffTimeSeconds = Math.floor(cutoffTime / 1000); // Convert to seconds for expires_at comparison

      // Clean up old secret keys
      const secretsStmt = this.db.prepare('DELETE FROM secret_keys WHERE created_at < ?');
      const secretsResult = secretsStmt.run(cutoffTime);

      // Clean up old game tracking records (completed/cancelled games older than cutoff)
      const trackingStmt = this.db.prepare(
        'DELETE FROM game_tracking WHERE (status != ? AND completed_at IS NOT NULL AND completed_at < ?) OR (status = ? AND last_checked < ?)'
      );
      const trackingResult = trackingStmt.run('pending', cutoffTime, 'pending', cutoffTime);

      // Clean up old game metadata - use expires_at since there's no created_at column
      const metadataStmt = this.db.prepare('DELETE FROM game_metadata WHERE expires_at < ?');
      const metadataResult = metadataStmt.run(cutoffTimeSeconds);

      const deletedCounts = {
        deletedSecrets: secretsResult.changes,
        deletedGames: trackingResult.changes,
        deletedMetadata: metadataResult.changes
      };

      console.log(`🧹 Cleanup completed - Secrets: ${deletedCounts.deletedSecrets}, Games: ${deletedCounts.deletedGames}, Metadata: ${deletedCounts.deletedMetadata}`);

      return deletedCounts;
    } catch (error) {
      console.error("❌ Failed to cleanup old records:", error);
      return { deletedSecrets: 0, deletedGames: 0, deletedMetadata: 0 };
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
      isOpen: this.db !== null
    };
  }

  public addPlayerToGame(gameAddress: string, playerAddress: string): void {
    try {
      const stmt = this.db.prepare(
        'INSERT OR IGNORE INTO game_players (game_address, player_address, joined_at) VALUES (?, ?, ?)'
      );
      stmt.run(gameAddress, playerAddress, Date.now());
    } catch (error) {
      console.error("❌ Failed to add player to game:", error);
    }
  }

  public removePlayerFromGame(gameAddress: string, playerAddress: string): void {
    try {
      const stmt = this.db.prepare(
        'DELETE FROM game_players WHERE game_address = ? AND player_address = ?'
      );
      stmt.run(gameAddress, playerAddress);
    } catch (error) {
      console.error("❌ Failed to remove player from game:", error);
    }
  }

  public clearStalePlayersForGame(gameAddress: string): void {
    try {
      const stmt = this.db.prepare(
        'DELETE FROM game_players WHERE game_address = ?'
      );
      stmt.run(gameAddress);
      console.log(`🧹 Cleared stale player data for game ${gameAddress}`);
    } catch (error) {
      console.error("❌ Failed to clear stale players for game:", error);
    }
  }

  public getGamePlayers(gameAddress: string): string[] {
    try {
      const stmt = this.db.prepare(
        'SELECT player_address FROM game_players WHERE game_address = ? ORDER BY joined_at ASC'
      );
      const results = stmt.all(gameAddress) as { player_address: string }[];
      return results.map(row => row.player_address);
    } catch (error) {
      console.error("❌ Failed to get game players:", error);
      return [];
    }
  }
}
