import { PublicKey, Connection, Keypair } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { randomBytes, createHash } from 'crypto';
import { OracleDatabase } from "./database.ts";
import type { Coinflip } from "./idl/idlType.ts";
import idl from "./idl/idl.json" with { type: "json" };
import * as fs from "fs";
import * as path from "path";

// Constants
const KEYPAIR_FILE = "admin-keypair.json";
const SECRET_KEY_LENGTH = 32;
const MAX_COMPLETION_ATTEMPTS = 5;
// DEFAULT_DELAY_MS: Delay between processing games in scanAndCompleteActiveGames.
// Purpose: Prevents overwhelming the Solana RPC node and the service itself, especially during bursts of activity.
// Tuning: This value can be tuned based on observed RPC performance, expected load, and desired throughput.
// A smaller value might increase throughput if RPC calls are consistently fast, while a larger value provides more buffer.
const DEFAULT_DELAY_MS = 1000;

// Game types that include secret keys in response
const GAMES_WITH_SECRET_KEYS = new Set(['dumbflip', 'snowball']);

// Event handling types
type EventHandler = (event: any) => Promise<void> | void;
type GameEvent = 'playerJoined' | 'playerUnjoined' | 'playerRolled' | 'gameInitialized' | 'gameCompleted' | 'gameClosed' | 'playerParticipationCleaned';

// Types
interface GameCompletionResult {
  success: boolean;
  notReady?: boolean;
  error?: string;
  txHash?: string;
}

interface GameSecrets {
  randomHash: string;
  gameAddress: string;
  secretKey?: string;
}

interface CompletionStats {
  completed: number;
  errors: number;
  notReady: number;
}

export class OracleService {
  private static instance: OracleService;
  private program: anchor.Program<Coinflip>;
  private connection: Connection;
  private adminKeypair: Keypair;
  private db: OracleDatabase;
  private eventListeners: number[] = [];
  private isListening: boolean = false;

  /**
   * Private constructor to enforce singleton pattern.
   * Initializes database, connection, admin keypair, and the Anchor program.
   */
  private constructor() {
    this.db = OracleDatabase.getInstance();
    this.connection = this.initializeConnection();
    this.adminKeypair = this.loadAdminKeypair();
    this.program = this.initializeProgram();
  }

  /**
   * Gets the singleton instance of the OracleService.
   * @returns The singleton OracleService instance.
   */
  public static getInstance(): OracleService {
    if (!OracleService.instance) {
      OracleService.instance = new OracleService();
    }
    return OracleService.instance;
  }

  // SUGGESTION: Consider implementing a centralized environment variable check
  // at application startup (e.g., in index.ts or a dedicated config module)
  // to ensure all required variables (SOLANA_NETWORK, ORACLE_PORT, etc.)
  // are present and valid. This helps the application fail fast with clear errors.
  /**
   * Initializes the Solana connection based on the SOLANA_NETWORK environment variable.
   * @returns A Connection object.
   * @throws Error if SOLANA_NETWORK environment variable is not set.
   * @private
   */
  private initializeConnection(): Connection {
    const networkUrl = process.env["SOLANA_NETWORK"];
    if (!networkUrl) {
      throw new Error("SOLANA_NETWORK environment variable is required");
    }
    return new Connection(networkUrl, "confirmed");
  }

  /**
   * Loads the admin keypair from the specified KEYPAIR_FILE.
   * @returns The loaded Keypair.
   * @throws Error if the keypair file cannot be read or parsed.
   * @private
   */
  private loadAdminKeypair(): Keypair {
    try {
      const keypairPath = path.join(process.cwd(), KEYPAIR_FILE);
      const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
      const keypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
      console.log(`✅ Loaded admin keypair: ${keypair.publicKey.toBase58()}`);
      return keypair;
    } catch (error: any) {
      // Enhance error message for better debugging
      throw new Error(`Failed to load admin keypair from ${KEYPAIR_FILE}: ${error.message}`);
    }
  }

  /**
   * Initializes the Anchor program for interacting with the Coinflip smart contract.
   * @returns The initialized Anchor Program.
   * @private
   */
  private initializeProgram(): anchor.Program<Coinflip> {
    const adminWallet = new anchor.Wallet(this.adminKeypair);
    const provider = new anchor.AnchorProvider(this.connection, adminWallet, { commitment: "confirmed" });
    anchor.setProvider(provider);
    return new anchor.Program(idl as Coinflip, provider) as anchor.Program<Coinflip>;
  }

  /**
   * Starts listening to blockchain events from the Coinflip program.
   * Idempotent: does nothing if already listening.
   * @throws Error if setting up event listeners fails.
   */
  public async startEventListening(): Promise<void> {
    if (this.isListening) return;

    console.log("🎧 Starting event listeners...");
    try {
      const listeners = await this.setupEventListeners();
      this.eventListeners.push(...listeners);
      this.isListening = true;
    } catch (error: any) {
      console.error("❌ Failed to start event listeners:", error.message);
      throw error; // Re-throw to allow caller to handle
    }
  }

  /**
   * Sets up individual event listeners for all relevant game events.
   * @returns A promise that resolves to an array of listener IDs.
   * @private
   */
  private async setupEventListeners(): Promise<number[]> {
    const eventMap: Array<[GameEvent, EventHandler]> = [
      ['playerJoined', this.handlePlayerEvent.bind(this, 'joined')],
      ['playerUnjoined', this.handlePlayerEvent.bind(this, 'unjoined')],
      ['playerRolled', this.handlePlayerEvent.bind(this, 'rolled')],
      ['gameInitialized', this.handleGameInitialized.bind(this)],
      ['gameCompleted', this.handleGameStatusChange.bind(this, 'completed')],
      ['gameClosed', this.handleGameStatusChange.bind(this, 'closed')],
      ['playerParticipationCleaned', this.handlePlayerCleaned.bind(this)]
    ];

    return eventMap.map(([eventName, handler]) =>
      this.program.addEventListener(eventName, handler)
    );
  }

  public async stopEventListening(): Promise<void> {
    if (!this.isListening) return;

    await Promise.allSettled(
      this.eventListeners.map(listenerId => this.program.removeEventListener(listenerId))
    );
    this.eventListeners = [];
    this.isListening = false;
    console.log("🛑 Event listeners stopped.");
  }

  /**
   * Handles player-related events ('joined', 'unjoined', 'rolled').
   * Updates the database and attempts auto-completion if applicable.
   * @param action - The type of player action.
   * @param event - The event data from the blockchain.
   * @private
   */
  private async handlePlayerEvent(action: 'joined' | 'unjoined' | 'rolled', event: any): Promise<void> {
    const { gameAddress, playerAddress } = this.extractEventData(event);

    try {
      console.log(`Player event: ${action} for player ${playerAddress} in game ${gameAddress}`);
      // Handle player database operations
      switch (action) {
        case 'joined':
          this.db.addPlayerToGame(gameAddress, playerAddress);
          break;
        case 'unjoined':
          this.db.removePlayerFromGame(gameAddress, playerAddress);
          break;
        case 'rolled':
          console.log(`🎲 Player ${playerAddress} rolled in game ${gameAddress}`);
          break;
      }

      // Check for auto-completion after player events
      await this.tryAutoComplete(event.gameKey, gameAddress, action);
    } catch (error: any) {
      console.error(`❌ Error in player ${action} event for game ${gameAddress}:`, error.message);
    }
  }

  /**
   * Handles game status change events ('completed', 'closed').
   * Updates the game status in the database.
   * @param status - The new status of the game.
   * @param event - The event data from the blockchain.
   * @private
   */
  private handleGameStatusChange(status: 'completed' | 'closed', event: any): void {
    const { gameAddress } = this.extractEventData(event);

    try {
      console.log(`Game status change: ${status} for game ${gameAddress}`);
      if (status === 'completed') {
        this.db.markGameCompleted(gameAddress);
      } else {
        this.db.markGameClosed(gameAddress);
        this.db.clearStalePlayersForGame(gameAddress); // Also clear players for closed games
        console.log(`🚫 Game closed: ${gameAddress}`);
      }
    } catch (error: any) {
      console.error(`❌ Error in game ${status} event for game ${gameAddress}:`, error.message);
    }
  }

  /**
   * Handles the 'gameInitialized' event.
   * Tracks the new game in the database.
   * @param event - The event data from the blockchain.
   * @private
   */
  private handleGameInitialized(event: any): void {
    const { gameAddress } = this.extractEventData(event);
    try {
      console.log(`Game initialized: ${gameAddress}`);
      this.db.trackGame(gameAddress);
    } catch (error: any) {
      console.error(`❌ Error in gameInitialized event for game ${gameAddress}:`, error.message);
    }
  }

  /**
   * Handles the 'playerParticipationCleaned' event.
   * Removes the player from the game in the database.
   * @param event - The event data from the blockchain.
   * @private
   */
  private async handlePlayerCleaned(event: any): Promise<void> {
    const { gameAddress, playerAddress } = this.extractEventData(event);

    try {
      console.log(`🧹 Player ${playerAddress} cleaned from game ${gameAddress}`);
      this.db.removePlayerFromGame(gameAddress, playerAddress);
    } catch (error: any) {
      console.error(`❌ Error in playerParticipationCleaned event for game ${gameAddress}, player ${playerAddress}:`, error.message);
    }
  }

  /**
   * Extracts game and player addresses from blockchain event data.
   * @param event - The event data.
   * @returns An object containing gameAddress and playerAddress (if available).
   * @private
   */
  private extractEventData(event: any): { gameAddress: string; playerAddress: string } {
    // Ensure event and event.gameKey are not null before calling toBase58()
    const gameAddress = event?.gameKey?.toBase58() || '';
    const playerAddress = event?.player?.toBase58() || '';
    if (!gameAddress) {
      console.warn("⚠️ extractEventData: gameKey is missing or invalid in event data.", event);
    }
    return { gameAddress, playerAddress };
  }

  /**
   * Attempts to automatically complete a game if it's ready.
   * Called after player events that might make a game ready for completion.
   * @param gamePda - The PublicKey of the game's Program Derived Address.
   * @param gameAddress - The string representation of the game address.
   * @param trigger - A string describing the event that triggered this attempt.
   * @private
   */
  private async tryAutoComplete(gamePda: PublicKey, gameAddress: string, trigger: string): Promise<void> {
    try {
      if (await this.isGameReadyForCompletion(gamePda)) {
        console.log(`🎯 Auto-completing game ${gameAddress} after ${trigger}`);
        const result = await this.completeGame(gameAddress);
        if (!result.success && !result.notReady) {
          console.error(`❌ Auto-completion failed for game ${gameAddress}: ${result.error}`);
        }
      }
    } catch (error: any) {
      console.error(`❌ Error during auto-completion check for game ${gameAddress} (triggered by ${trigger}):`, error.message);
    }
  }

  /**
   * Generates new game secrets (secret key, random hash) and a game address (PDA).
   * Stores the secrets in the database and tracks the game.
   * @param gameType - Optional game type string. If it's a type that requires revealing the secret key (e.g., 'dumbflip', 'snowball'), the secret key is included in the response.
   * @returns A GameSecrets object containing the randomHash, gameAddress, and optionally the secretKey.
   */
  public generateGameSecrets(gameType?: string): GameSecrets {
    const secretKey = randomBytes(SECRET_KEY_LENGTH);
    const randomHash = createHash('sha256').update(secretKey).digest();
    const gamePda = this.getGamePDA(randomHash); // Ensure getGamePDA is robust
    const gameAddress = gamePda.toBase58();

    // Store in database
    this.db.saveSecretKey(gameAddress, secretKey.toString('hex'), randomHash.toString('hex'));
    this.db.trackGame(gameAddress); // Ensure this is correctly initialized

    const secrets: GameSecrets = {
      randomHash: randomHash.toString('hex'),
      gameAddress
    };

    // Include secret key for specific game types
    if (gameType && GAMES_WITH_SECRET_KEYS.has(gameType.toLowerCase())) {
      secrets.secretKey = secretKey.toString('hex');
    }
    console.log(`Generated secrets for game ${gameAddress}, type: ${gameType || 'default'}`);
    return secrets;
  }

  /**
   * Checks if a game is ready for completion based on its on-chain state.
   * A game is ready if it's full or if it's expired and has the minimum number of players.
   * @param gamePda - The PublicKey of the game's Program Derived Address.
   * @returns A Promise resolving to true if the game is ready, false otherwise.
   * @throws Error if fetching game account fails for reasons other than not found.
   */
  public async isGameReadyForCompletion(gamePda: PublicKey): Promise<boolean> {
    const gameAddress = gamePda.toBase58();
    try {
      const gameAccount = await this.program.account.game.fetch(gamePda);
      const blockTime = await this.getBlockchainTime();

      // Ensure createdAt and timeout are valid numbers before arithmetic
      const createdAt = Number(gameAccount.createdAt);
      const timeout = Number(gameAccount.timeout);
      if (isNaN(createdAt) || isNaN(timeout)) {
        console.error(`⚠️ Invalid createdAt or timeout for game ${gameAddress}: ${gameAccount.createdAt}, ${gameAccount.timeout}`);
        return false; // Or handle as an error
      }

      const expiresAt = createdAt + timeout;
      const isExpired = blockTime > expiresAt;
      const isFull = gameAccount.playersCount >= gameAccount.maxPlayers;
      const hasMinPlayers = gameAccount.playersCount >= gameAccount.minPlayers;

      return isFull || (isExpired && hasMinPlayers);
    } catch (error: any) {
      if (this.isAccountNotFoundError(error)) {
        console.log(`⚠️ Game account ${gameAddress} not found. Marking as completed/closed in DB.`);
        this.db.markGameClosed(gameAddress); // Or markGameCompleted, depending on desired logic
        return false;
      }
      console.error(`❌ Error checking if game ${gameAddress} is ready for completion:`, error.message);
      throw error; // Re-throw unexpected errors
    }
  }

  /**
   * Attempts to complete a game by determining a winner and sending a transaction to the smart contract.
   * @param gameAddress - The address of the game to complete.
   * @returns A Promise resolving to a GameCompletionResult object indicating success or failure.
   */
  public async completeGame(gameAddress: string): Promise<GameCompletionResult> {
    try {
      const secretData = this.db.getSecretKey(gameAddress);
      if (!secretData) {
        console.warn(`⚠️ No secret key found for game ${gameAddress} during completion attempt.`);
        return { success: false, error: `No secret key found for game ${gameAddress}` };
      }

      const gamePda = this.getGamePDAFromAddress(gameAddress); // This can throw if secretData was compromised earlier
      if (!(await this.isGameReadyForCompletion(gamePda))) {
        // Log this condition as it might indicate a race condition or logic flaw
        console.log(`ℹ️ Game ${gameAddress} is not ready for completion when completeGame was called.`);
        return { success: false, notReady: true };
      }

      const gameAccount = await this.program.account.game.fetch(gamePda);
      const players = this.db.getGamePlayers(gameAddress);

      if (players.length === 0) {
        console.warn(`⚠️ No players found in DB for game ${gameAddress} during completion, though it was ready.`);
        // It's possible players were cleaned up between readiness check and now.
        // Or the game was in a state (e.g. expired with 0 players) that should be handled.
        this.db.markGameClosed(gameAddress); // Close it to prevent further attempts if it's in a weird state
        return { success: false, error: `No players found for game ${gameAddress}` };
      }

      const secretKeyBuffer = Buffer.from(secretData.secretKey, "hex");
      const randomHashBuffer = Buffer.from(secretData.randomHash, "hex");
      const winnerIndex = this.calculateWinnerIndex(secretKeyBuffer, gameAccount.lastSlot, players.length);
      const winnerPlayerAddress = players[winnerIndex]; // winnerIndex must be valid

      if (!winnerPlayerAddress) { // Should not happen if players.length > 0 and calculateWinnerIndex is correct
        console.error(`❌ Critical: Unable to determine winner for game ${gameAddress} despite having ${players.length} players.`);
        return { success: false, error: `Unable to determine winner for game ${gameAddress}` };
      }

      const winnerAddress = new PublicKey(winnerPlayerAddress);

      // Verify the selected winner is actually part of the game on-chain.
      // This is a safeguard against DB inconsistencies or complex race conditions.
      if (!(await this.verifyPlayerInGame(gamePda, winnerAddress))) {
        console.warn(`⚠️ Selected winner ${winnerPlayerAddress} (from DB) not found in game ${gameAddress} on-chain. Clearing local stale player data.`);
        this.db.clearStalePlayersForGame(gameAddress); // Clear DB players as they don't match chain
        // This situation might require the game to be re-evaluated or error out.
        // For now, returning notReady to allow rescan, but this indicates an issue.
        return { success: false, notReady: true, error: `Selected winner ${winnerPlayerAddress} not on-chain.` };
      }

      console.log(`🏆 Attempting to complete game ${gameAddress} with winner ${winnerPlayerAddress}`);
      const txHash = await this.executeGameCompletion(
        gameAddress, // Pass gameAddress for logging within executeGameCompletion
        winnerAddress,
        gameAccount.creator,
        randomHashBuffer,
        secretKeyBuffer
      );

      this.db.markSecretKeyUsed(gameAddress);
      this.db.markGameCompleted(gameAddress);
      console.log(`✅ Game ${gameAddress} completed successfully. Tx: ${txHash}`);
      return { success: true, txHash };
    } catch (error: any) {
      console.error(`❌ Error during completeGame for ${gameAddress}:`, error.message);
      this.db.incrementCompletionAttempts(gameAddress);
      return { success: false, error: error.message };
    }
  }

  /**
   * Executes the actual 'completeGame' transaction on the blockchain.
   * @param gameAddressForLogging - The string representation of the game address, for logging.
   * @param winnerAddress - The PublicKey of the winner.
   * @param creatorAddress - The PublicKey of the game's creator.
   * @param randomHashBuffer - Buffer containing the random hash.
   * @param secretKeyBuffer - Buffer containing the secret key.
   * @returns A Promise resolving to the transaction hash.
   * @private
   */
  private async executeGameCompletion(
    gameAddressForLogging: string, // Added for logging
    winnerAddress: PublicKey,
    creatorAddress: PublicKey,
    randomHashBuffer: Buffer,
    secretKeyBuffer: Buffer
  ): Promise<string> {
    const txHash = await this.program.methods
      .completeGame([...randomHashBuffer], [...secretKeyBuffer])
      .accounts({
        authority: this.adminKeypair.publicKey,
        winner: winnerAddress,
        creator: creatorAddress,
      })
      .signers([this.adminKeypair])
      .rpc();

    await this.confirmTransaction(txHash);
    console.log(`Transaction confirmed for game ${gameAddressForLogging}: ${txHash}`);
    return txHash;
  }

  /**
   * Calculates the winner index based on a secret key, the last blockchain slot, and the number of players.
   * This logic is designed to be cryptographically secure and deterministic, matching the on-chain
   * Rust/Anchor program's winner selection mechanism. It's crucial that this implementation remains
   * perfectly synchronized with the smart contract's counterpart to ensure fairness and verifiability.
   * The process involves hashing the secret key with the last slot to generate entropy, then
   * using that entropy to select a winner in an unbiased way.
   */
  private calculateWinnerIndex(secretKeyBuffer: Buffer, lastSlot: bigint, nPlayers: number): number {
    if (nPlayers <= 1) {
      return 0;
    }

    // Hash combination of secret key and last_slot for additional entropy (matching contract logic)
    const combinedData = Buffer.alloc(40); // 32 bytes secret + 8 bytes last_slot
    secretKeyBuffer.copy(combinedData, 0, 0, 32);

    // Convert bigint to little-endian bytes (matching contract's to_le_bytes())
    const lastSlotBytes = Buffer.alloc(8);
    const lastSlotNum = Number(lastSlot);
    lastSlotBytes.writeUInt32LE(lastSlotNum & 0xffffffff, 0);
    lastSlotBytes.writeUInt32LE(Math.floor(lastSlotNum / 0x100000000), 4);
    lastSlotBytes.copy(combinedData, 32);

    // Hash the combined data (matching contract's hash() function)
    const entropyHash = createHash('sha256').update(combinedData).digest();

    const maxU64 = BigInt('0xFFFFFFFFFFFFFFFF');
    const nPlayersBig = BigInt(nPlayers);
    const maxValid = maxU64 - (maxU64 % nPlayersBig);

    // Try sliding 8-byte windows through the hashed entropy
    for (let startPos = 0; startPos <= (32 - 8); startPos++) {
      // Extract 8 bytes and convert to u64 using little-endian (matching contract)
      const window = entropyHash.subarray(startPos, startPos + 8);

      // Convert to BigInt using little-endian format
      let randomU64 = BigInt(0);
      for (let i = 0; i < 8; i++) {
        const byte = window[i];
        if (byte === undefined) {
          throw new Error("Invalid entropy hash buffer size");
        }
        randomU64 |= BigInt(byte) << (BigInt(i) * BigInt(8));
      }

      // Use this value if it's in the unbiased range
      if (randomU64 < maxValid) {
        return Number(randomU64 % nPlayersBig);
      }
    }

    // If all windows fail, this indicates an issue with entropy or logic that should not happen in practice.
    // The contract would also likely fail or stall in a similar way.
    throw new Error("Unable to generate unbiased random number - game must be cancelled");
  }

  /**
   * Retrieves the current blockchain time (approximated by block time).
   * Falls back to local system time if blockchain time is unavailable.
   * @returns A Promise resolving to the blockchain time in seconds since epoch.
   * @private
   */
  private async getBlockchainTime(): Promise<number> {
    try {
      const slot = await this.connection.getSlot();
      const blockTime = await this.connection.getBlockTime(slot);
      if (blockTime === null) {
        console.warn("⚠️ getBlockTime returned null, falling back to system time.");
        return Math.floor(Date.now() / 1000);
      }
      return blockTime;
    } catch (error: any) {
      console.warn("⚠️ Failed to get blockchain time, falling back to system time:", error.message);
      return Math.floor(Date.now() / 1000);
    }
  }

  /**
   * Confirms a Solana transaction using the latest blockhash.
   * @param signature - The transaction signature to confirm.
   * @private
   */
  private async confirmTransaction(signature: string): Promise<void> {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
    await this.connection.confirmTransaction(
      {
        signature,
        blockhash,
        lastValidBlockHeight,
      },
      "confirmed" // Explicitly use 'confirmed' commitment
    );
  }

  /**
   * Checks if an error object indicates that a Solana account was not found.
   * @param error - The error object (typically of type any or Error).
   * @returns True if the error message suggests an account was not found, false otherwise.
   * @private
   */
  private isAccountNotFoundError(error: any): boolean {
    // Robust check for error message content
    const errorMessage = error?.message || '';
    return errorMessage.includes('Account does not exist') || errorMessage.includes('could not find account');
  }

  /**
   * Simple utility to pause execution for a specified duration.
   * @param ms - The delay duration in milliseconds.
   * @returns A Promise that resolves after the delay.
   * @private
   */
  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Triggers the database cleanup process for old records.
   * @param hoursOld - The age in hours beyond which records are considered old. Defaults to 48.
   * @returns The result of the database cleanup operation.
   */
  public cleanupOldRecords(hoursOld: number = 48) {
    console.log(`Initiating cleanup of records older than ${hoursOld} hours.`);
    return this.db.cleanupOldRecords(hoursOld);
  }

  /**
   * Retrieves statistics from the database and combines them with oracle service status.
   * @returns An object containing database stats, event listening status, and active listener count.
   */
  public getStats() {
    const dbStats = this.db.getStats();
    return {
      ...dbStats,
      eventListening: this.isListening,
      activeListeners: this.eventListeners.length,
      adminAccount: this.adminKeypair.publicKey.toBase58() // Added admin account info
    };
  }

  /**
   * Scans for pending games in the database and attempts to complete them if they are ready.
   * @returns A Promise resolving to CompletionStats summarizing the scan results.
   */
  public async scanAndCompleteActiveGames(): Promise<CompletionStats> {
    const stats: CompletionStats = { completed: 0, errors: 0, notReady: 0 };
    const pendingGames = this.db.getPendingGames();

    if (pendingGames.length === 0) {
      // console.log("No pending games to scan."); // Optional: log if no games found
      return stats;
    }

    console.log(`🔍 Scanning ${pendingGames.length} pending games...`);

    for (const game of pendingGames) {
      if (game.completion_attempts >= MAX_COMPLETION_ATTEMPTS) {
        console.log(`⏭️  Skipping game ${game.game_address} (${game.completion_attempts} attempts, max ${MAX_COMPLETION_ATTEMPTS} reached)`);
        // Optionally mark as 'failed' or 'cancelled' in DB if max attempts reached
        // this.db.markGameClosed(game.game_address); // Example: mark as closed
        continue;
      }

      try {
        // Check if game still exists on-chain before attempting completion
        if (!(await this.gameExistsOnChain(game.game_address))) {
          console.log(`Game ${game.game_address} does not exist on-chain. Marking as closed.`);
          this.db.markGameClosed(game.game_address); // Use markGameClosed for consistency
          stats.errors++; // Count as an error or a specific 'cleaned up' stat
          continue;
        }

        const result = await this.completeGame(game.game_address);
        this.updateScanStats(stats, result, game.game_address);

        // Only delay if there are more games or if the operation was quick
        // This simple delay is fine for now as per previous review.
        await this.delay(DEFAULT_DELAY_MS);
      } catch (error: any) { // Catch errors from completeGame or gameExistsOnChain
        stats.errors++;
        console.error(`❌ Error processing game ${game.game_address} during scan:`, error.message);
        // Increment attempts even if an unexpected error occurs in the loop here
        this.db.incrementCompletionAttempts(game.game_address);
      }
    }

    this.logScanResults(stats);
    return stats;
  }

  /**
   * Checks if a game account exists on the blockchain.
   * @param gameAddress - The string representation of the game address.
   * @returns A Promise resolving to true if the game exists, false otherwise.
   * @throws Error if fetching game data fails for reasons other than not found.
   * @private
   */
  private async gameExistsOnChain(gameAddress: string): Promise<boolean> {
    try {
      // No need to get secret key here just to form PDA if gameAddress IS the PDA string
      // However, current getGamePDAFromAddress relies on it. This implies gameAddress might not be PDA string.
      // Assuming getGamePDAFromAddress correctly derives PDA from what gameAddress represents.
      const gamePda = this.getGamePDAFromAddress(gameAddress);
      await this.program.account.game.fetch(gamePda);
      return true;
    } catch (error: any) {
      if (this.isAccountNotFoundError(error)) {
        // This is an expected condition if the game has been closed/completed already by another process or on-chain event.
        console.log(`ℹ️ Game ${gameAddress} not found on-chain (likely already processed or does not exist).`);
        return false;
      }
      // Log unexpected errors but re-throw to be handled by the caller
      console.error(`❌ Unexpected error checking if game ${gameAddress} exists on-chain:`, error.message);
      throw error;
    }
  }

  /**
   * Updates the scan statistics based on the result of a game completion attempt.
   * @param stats - The CompletionStats object to update.
   * @param result - The GameCompletionResult from the attempt.
   * @param gameAddress - The address of the game, for logging.
   * @private
   */
  private updateScanStats(stats: CompletionStats, result: GameCompletionResult, gameAddress: string): void {
    if (result.success) {
      stats.completed++;
      console.log(`Scan: Game ${gameAddress} completed successfully.`);
    } else if (result.notReady) {
      stats.notReady++;
      console.log(`Scan: Game ${gameAddress} not ready for completion. Will retry if attempts < max.`);
    } else {
      stats.errors++;
      console.warn(`Scan: Game ${gameAddress} failed completion: ${result.error}`);
    }
  }

  /**
   * Logs the results of the game scanning and completion process.
   * @param stats - The CompletionStats object containing scan results.
   * @private
   */
  private logScanResults(stats: CompletionStats): void {
    if (stats.completed > 0 || stats.errors > 0 || stats.notReady > 0) {
      const parts = [];
      if (stats.completed > 0) parts.push(`${stats.completed} completed`);
      if (stats.errors > 0) parts.push(`${stats.errors} errors`);
      if (stats.notReady > 0) parts.push(`${stats.notReady} not ready`);
      console.log(`📊 Scan finished: ${parts.join(', ')}.`);
    } else {
      console.log("📊 Scan finished: No games were processed in this run (or all were skipped).");
    }
  }

  /**
   * Calculates the Program Derived Address (PDA) for a game based on a random hash.
   * @param randomHash - The Buffer containing the random hash used as a seed for the PDA.
   * @returns The PublicKey of the game's PDA.
   * @private
   */
  private getGamePDA(randomHash: Buffer): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game", 'utf8'), randomHash], // Seeds: "game" prefix and the random hash
      this.program.programId
    );
    return pda;
  }

  /**
   * Retrieves the game's Program Derived Address (PDA) using the stored random hash for a given game address.
   * This method assumes that `gameAddress` is an identifier from which a secret key (and thus random hash) can be retrieved.
   * @param gameAddress - The identifier for the game (e.g., the game's address string itself, if it's stored as PK).
   * @returns The PublicKey of the game's PDA.
   * @throws Error if no secret data (and thus random hash) is found for the gameAddress.
   * @private
   */
  private getGamePDAFromAddress(gameAddress: string): PublicKey {
    const secretData = this.db.getSecretKey(gameAddress);
    if (!secretData) {
      // This is a critical issue if called, means DB is missing vital info for an active game.
      console.error(`❌ CRITICAL: No secret data found for game address ${gameAddress} when trying to derive PDA.`);
      throw new Error(`No secret data found for game ${gameAddress}, cannot derive PDA.`);
    }
    const randomHash = Buffer.from(secretData.randomHash, "hex");
    return this.getGamePDA(randomHash);
  }

  /**
   * Verifies if a player is part of a game by checking for their PlayerParticipation account on-chain.
   * @param gamePda - The PublicKey of the game's PDA.
   * @param playerAddress - The PublicKey of the player to verify.
   * @returns A Promise resolving to true if the player is in the game, false otherwise.
   * @private
   */
  private async verifyPlayerInGame(gamePda: PublicKey, playerAddress: PublicKey): Promise<boolean> {
    try {
      const [playerParticipationPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("player_participation", 'utf8'), gamePda.toBuffer(), playerAddress.toBuffer()],
        this.program.programId
      );
      await this.program.account.playerParticipation.fetch(playerParticipationPda);
      return true;
    } catch (error: any) {
      // If account doesn't exist (isAccountNotFoundError), player is not in the game.
      // Log other errors but still return false as player cannot be verified.
      if (!this.isAccountNotFoundError(error)) {
        console.warn(`⚠️ Error verifying player ${playerAddress.toBase58()} in game ${gamePda.toBase58()}: ${error.message}`);
      }
      return false;
    }
  }
}
