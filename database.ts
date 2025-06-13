import { Database } from "bun:sqlite";

// Constants
const DATABASE_FILE = "oracle.sqlite";
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

  /**
   * Private constructor to enforce singleton pattern.
   * Initializes the database connection and sets up tables.
   * @param dbPath - Path to the SQLite database file. Defaults to DATABASE_FILE.
   * @param options - Options for the database connection.
   */
  private constructor(dbPath: string = DATABASE_FILE, options = { create: true }) {
    this.db = new Database(dbPath, options);
    this.initializeDatabase();
  }

  /**
   * Gets the singleton instance of the OracleDatabase.
   * @returns The singleton OracleDatabase instance.
   */
  public static getInstance(): OracleDatabase {
    if (!OracleDatabase.instance) {
      OracleDatabase.instance = new OracleDatabase();
    }
    return OracleDatabase.instance;
  }

  /**
   * Initializes the database by creating necessary tables.
   * Throws an error if initialization fails.
   */
  private initializeDatabase(): void {
    try {
      this.createTables();
      console.log("✅ Oracle database initialized");
    } catch (error: any) {
      console.error("❌ Database initialization failed:", error.message);
      throw error;
    }
  }

  /**
   * Creates the database tables if they do not already exist.
   * This includes tables for secret keys, game tracking, and game players,
   * along with necessary indexes for performance.
   */
  private createTables(): void {
    // Secret keys table: Stores generated secrets, their creation time, and usage status.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS secret_keys (
        game_address TEXT PRIMARY KEY,
        secret_key TEXT NOT NULL,
        random_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL, -- Timestamp of when the secret was created
        used BOOLEAN DEFAULT FALSE -- Flag indicating if the secret has been used
      )
    `);

    // Game tracking table: Monitors the status, attempts, and timestamps of games.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS game_tracking (
        game_address TEXT PRIMARY KEY, -- Foreign key to secret_keys.game_address
        status TEXT NOT NULL DEFAULT '${DEFAULT_STATUS}', -- e.g., pending, completed, cancelled
        last_checked INTEGER NOT NULL, -- Timestamp of the last status check or update
        completion_attempts INTEGER DEFAULT 0, -- Number of times completion has been attempted
        completed_at INTEGER -- Timestamp of when the game was completed or cancelled
      )
    `);

    // Game players table: Tracks players who have joined specific games.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS game_players (
        id INTEGER PRIMARY KEY AUTOINCREMENT, -- Unique identifier for each player entry
        game_address TEXT NOT NULL, -- Foreign key to game_tracking.game_address
        player_address TEXT NOT NULL, -- Address of the player
        joined_at INTEGER NOT NULL, -- Timestamp of when the player joined
        UNIQUE(game_address, player_address) -- Ensures a player can only join a game once
      )
    `);

    // Create indexes for performance optimization

    // Index for efficient cleanup of old secret keys
    this.db.run('CREATE INDEX IF NOT EXISTS idx_secret_keys_created_at ON secret_keys(created_at);');

    // Index for querying pending games by status and last_checked time
    this.db.run('CREATE INDEX IF NOT EXISTS idx_game_tracking_status_last_checked ON game_tracking(status, last_checked);');

    // Index for cleaning up game_tracking records by status and completion time
    this.db.run('CREATE INDEX IF NOT EXISTS idx_game_tracking_status_completed_at ON game_tracking(status, completed_at);');

    // Index for fetching players of a game, ordered by join time
    this.db.run('CREATE INDEX IF NOT EXISTS idx_game_players_game_address_joined_at ON game_players(game_address, joined_at);');
  }

  /**
   * Executes a database operation and handles potential errors.
   * Logs an error message and optionally returns a default value or re-throws.
   * @template T - The expected return type of the operation.
   * @param operation - A function containing the database operation to execute.
   * @param errorMessage - The error message to log if the operation fails.
   * @param defaultValue - An optional default value to return on failure. If not provided, errors are re-thrown.
   * @returns The result of the operation or the default value.
   * @throws Re-throws the original error if no defaultValue is provided and an error occurs.
   */
  private executeDbOperation<T>(operation: () => T, errorMessage: string, defaultValue?: T): T {
    try {
      return operation();
    } catch (error: any) {
      console.error(`❌ ${errorMessage}:`, error.message);
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      throw new Error(`${errorMessage}: ${error.message}`);
    }
  }

  // Secret key management

  /**
   * Saves a new secret key, its corresponding random hash, and game address to the database.
   * @param gameAddress - The game address associated with the secret.
   * @param secretKey - The secret key (hex string).
   * @param randomHash - The random hash derived from the secret key (hex string).
   */
  public saveSecretKey(gameAddress: string, secretKey: string, randomHash: string): void {
    this.executeDbOperation(
      () => {
        // Inserts a new secret key record.
        const stmt = this.db.prepare(
          'INSERT INTO secret_keys (game_address, secret_key, random_hash, created_at) VALUES (?, ?, ?, ?)'
        );
        stmt.run(gameAddress, secretKey, randomHash, Date.now());
      },
      `Failed to save secret key for game ${gameAddress}`
    );
  }

  /**
   * Retrieves an unused secret key and its random hash for a given game address.
   * @param gameAddress - The game address to look up.
   * @returns A SecretKeyData object if an unused key is found, otherwise null.
   */
  public getSecretKey(gameAddress: string): SecretKeyData | null {
    return this.executeDbOperation(
      () => {
        // Retrieves an unused secret key and its corresponding random hash for a given game address.
        const stmt = this.db.prepare(
          'SELECT secret_key, random_hash FROM secret_keys WHERE game_address = ? AND used = FALSE'
        );
        const result = stmt.get(gameAddress) as { secret_key: string; random_hash: string } | undefined;

        return result ? {
          secretKey: result.secret_key,
          randomHash: result.random_hash
        } : null;
      },
      "Failed to get secret key",
      null
    );
  }

  /**
   * Marks a secret key associated with a game address as used.
   * @param gameAddress - The game address whose secret key is to be marked as used.
   */
  public markSecretKeyUsed(gameAddress: string): void {
    this.executeDbOperation(
      () => {
        // Marks a specific secret key as used.
        const stmt = this.db.prepare('UPDATE secret_keys SET used = TRUE WHERE game_address = ?');
        stmt.run(gameAddress);
      },
      `Failed to mark secret key as used for game ${gameAddress}`
    );
  }

  // Game tracking

  /**
   * Tracks a new game or updates an existing one with 'pending' status and current timestamp.
   * Uses 'INSERT OR REPLACE' to handle both new and existing game tracking entries.
   * @param gameAddress - The game address to track.
   */
  public trackGame(gameAddress: string): void {
    this.executeDbOperation(
      () => {
        // Inserts a new game into tracking with 'pending' status or replaces if it already exists.
        // 'INSERT OR REPLACE' ensures that if a game is re-tracked, its status and last_checked time are updated.
        const stmt = this.db.prepare(
          'INSERT OR REPLACE INTO game_tracking (game_address, status, last_checked) VALUES (?, ?, ?)'
        );
        stmt.run(gameAddress, DEFAULT_STATUS, Date.now());
      },
      "Failed to track game"
    );
  }

  /**
   * Marks a game as completed, updating its status and recording the completion time.
   * @param gameAddress - The game address to mark as completed.
   */
  public markGameCompleted(gameAddress: string): void {
    this.executeDbOperation(
      () => {
        // Updates a game's status to 'completed' and records the completion time.
        const now = Date.now();
        const stmt = this.db.prepare(
          'UPDATE game_tracking SET status = ?, completed_at = ?, last_checked = ? WHERE game_address = ?'
        );
        stmt.run('completed', now, now, gameAddress);
      },
      `Failed to mark game ${gameAddress} as completed`
    );
  }

  /**
   * Marks a game as closed (e.g., cancelled or timed out), updating its status and recording the time.
   * @param gameAddress - The game address to mark as closed.
   */
  public markGameClosed(gameAddress: string): void {
    this.executeDbOperation(
      () => {
        // Updates a game's status to 'cancelled' (e.g. if it timed out or was invalidated) and records the time.
        const now = Date.now();
        const stmt = this.db.prepare(
          'UPDATE game_tracking SET status = ?, completed_at = ?, last_checked = ? WHERE game_address = ?'
        );
        stmt.run('cancelled', now, now, gameAddress);
      },
      `Failed to mark game ${gameAddress} as closed`
    );
  }

  /**
   * Increments the completion attempt counter for a game and updates its last_checked timestamp.
   * @param gameAddress - The game address to update.
   */
  public incrementCompletionAttempts(gameAddress: string): void {
    this.executeDbOperation(
      () => {
        // Increments the number of completion attempts for a game and updates the last_checked timestamp.
        const stmt = this.db.prepare(
          'UPDATE game_tracking SET completion_attempts = completion_attempts + 1, last_checked = ? WHERE game_address = ?'
        );
        stmt.run(Date.now(), gameAddress);
      },
      `Failed to increment completion attempts for game ${gameAddress}`
    );
  }

  /**
   * Retrieves a list of pending games, ordered by the last_checked timestamp, up to a defined limit.
   * @returns An array of PendingGame objects.
   */
  public getPendingGames(): PendingGame[] {
    return this.executeDbOperation(
      () => {
        // Retrieves a list of pending games, ordered by when they were last checked, up to a defined limit.
        // This helps prioritize games that haven't been checked recently.
        const stmt = this.db.prepare(
          'SELECT game_address, completion_attempts FROM game_tracking WHERE status = ? ORDER BY last_checked ASC LIMIT ?'
        );
        return stmt.all(DEFAULT_STATUS, PENDING_SCAN_LIMIT) as PendingGame[];
      },
      "Failed to get pending games",
      []
    );
  }

  // Statistics

  /**
   * Retrieves overall statistics for secrets and games from the database.
   * @returns A DatabaseStats object containing various counts.
   */
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
    } catch (error: any) {
      console.error("❌ Failed to get stats:", error.message);
      return { totalSecrets: 0, usedSecrets: 0, pendingGames: 0, completedGames: 0, cancelledGames: 0 };
    }
  }

  /**
   * Retrieves statistics about secret keys (total and used).
   * @returns An object containing total and used counts for secret keys.
   * @private
   */
  private getSecretsStats(): { total: number; used: number } {
    // Calculates total and used secret keys.
    const stmt = this.db.prepare(
      'SELECT COUNT(*) as total, SUM(CASE WHEN used = TRUE THEN 1 ELSE 0 END) as used FROM secret_keys'
    );
    return stmt.get() as { total: number; used: number };
  }

  /**
   * Retrieves statistics about games (pending, completed, cancelled).
   * @returns An object containing counts for games in different statuses.
   * @private
   */
  private getGamesStats(): { pending: number; completed: number; cancelled: number } {
    // Calculates game counts by status (pending, completed, cancelled).
    const stmt = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) as pending, -- Counts games with the default pending status
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed, -- Counts completed games
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled -- Counts cancelled games
      FROM game_tracking
    `);
    return stmt.get(DEFAULT_STATUS) as { pending: number; completed: number; cancelled: number };
  }

  // Utility methods

  /**
   * Cleans up old records from secret_keys and game_tracking tables.
   * @param hoursOld - The age in hours beyond which records should be considered old and deleted. Defaults to 48.
   * @returns An object containing counts of deleted secrets and games.
   */
  public cleanupOldRecords(hoursOld: number = 48): { deletedSecrets: number; deletedGames: number } {
    try {
      const cutoffTime = Date.now() - (hoursOld * 60 * 60 * 1000);

      // Deletes secret keys older than the specified cutoff time.
      const secretsStmt = this.db.prepare('DELETE FROM secret_keys WHERE created_at < ?');
      const secretsResult = secretsStmt.run(cutoffTime);

      // Deletes old game tracking records.
      // This includes:
      // 1. Non-pending games (e.g., 'completed', 'cancelled') that were completed before the cutoff time.
      // 2. Pending games that haven't been checked (last_checked) since before the cutoff time (stale pending games).
      const trackingStmt = this.db.prepare(
        'DELETE FROM game_tracking WHERE (status != ? AND completed_at IS NOT NULL AND completed_at < ?) OR (status = ? AND last_checked < ?)'
      );
      const trackingResult = trackingStmt.run('pending', cutoffTime, 'pending', cutoffTime);

      const deletedCounts = {
        deletedSecrets: secretsResult.changes,
        deletedGames: trackingResult.changes
      };

      console.log(`🧹 Cleanup completed - Secrets: ${deletedCounts.deletedSecrets}, Games: ${deletedCounts.deletedGames}`);

      return deletedCounts;
    } catch (error: any) {
      console.error("❌ Failed to cleanup old records:", error.message);
      return { deletedSecrets: 0, deletedGames: 0 };
    }
  }

  /**
   * Closes the database connection.
   * Logs an error if closing fails.
   */
  public close(): void {
    try {
      this.db.close();
    } catch (error: any) {
      console.error("❌ Failed to close database:", error.message);
    }
  }

  /**
   * Gets information about the database connection.
   * @returns An object containing the database file path and whether the connection is open.
   */
  public getConnectionInfo(): { file: string; isOpen: boolean } {
    return {
      file: this.db.filename, // Use db.filename for the actual path
      // As there's no direct 'isClosed' or 'isOpen' boolean property on bun:sqlite.Database
      // according to the TS error (which suggests 'close()' method instead of a 'closed' property),
      // we'll assume the database is "open" if this instance is operational and db object exists.
      // Runtime errors would occur if operations are attempted on an actually closed db.
      isOpen: true
    };
  }

  /**
   * Adds a player to a specific game.
   * If the player is already in the game (based on unique constraint), the operation is ignored.
   * @param gameAddress - The address of the game.
   * @param playerAddress - The address of the player.
   */
  public addPlayerToGame(gameAddress: string, playerAddress: string): void {
    this.executeDbOperation(
      () => {
        // Adds a player to a game if they haven't joined already.
        // 'INSERT OR IGNORE' prevents errors if the player-game combination already exists due to the UNIQUE constraint.
        const stmt = this.db.prepare(
          'INSERT OR IGNORE INTO game_players (game_address, player_address, joined_at) VALUES (?, ?, ?)'
        );
        stmt.run(gameAddress, playerAddress, Date.now());
      },
      `Failed to add player ${playerAddress} to game ${gameAddress}`
    );
  }

  /**
   * Removes a player from a specific game.
   * @param gameAddress - The address of the game.
   * @param playerAddress - The address of the player to remove.
   */
  public removePlayerFromGame(gameAddress: string, playerAddress: string): void {
    this.executeDbOperation(
      () => {
        // Removes a specific player from a specific game.
        const stmt = this.db.prepare(
          'DELETE FROM game_players WHERE game_address = ? AND player_address = ?'
        );
        stmt.run(gameAddress, playerAddress);
      },
      `Failed to remove player ${playerAddress} from game ${gameAddress}`
    );
  }

  /**
   * Clears all player entries for a specific game.
   * Useful for cleaning up when a game is completed or cancelled.
   * @param gameAddress - The address of the game for which to clear players.
   */
  public clearStalePlayersForGame(gameAddress: string): void {
    this.executeDbOperation(
      () => {
        // Removes all players associated with a given game address.
        // Useful when a game is completed or cancelled to clean up player entries.
        const stmt = this.db.prepare(
          'DELETE FROM game_players WHERE game_address = ?'
        );
        stmt.run(gameAddress);
        console.log(`🧹 Cleared stale player data for game ${gameAddress}`);
      },
      `Failed to clear stale players for game ${gameAddress}`
    );
  }

  /**
   * Retrieves a list of all player addresses participating in a specific game, ordered by join time.
   * @param gameAddress - The address of the game.
   * @returns An array of player address strings.
   */
  public getGamePlayers(gameAddress: string): string[] {
    return this.executeDbOperation(
      () => {
        // Retrieves all player addresses for a given game, ordered by when they joined.
        const stmt = this.db.prepare(
          'SELECT player_address FROM game_players WHERE game_address = ? ORDER BY joined_at ASC'
        );
        const results = stmt.all(gameAddress) as { player_address: string }[];
        return results.map(row => row.player_address);
      },
      "Failed to get game players",
      []
    );
  }
}
