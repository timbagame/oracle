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
const DEFAULT_DELAY_MS = 1000;

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
  secretKey?: string; // Only for dumbflip and snowball games
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

  private constructor() {
    this.db = OracleDatabase.getInstance();
    this.connection = this.initializeConnection();
    this.adminKeypair = this.loadAdminKeypair();
    this.program = this.initializeProgram();
  }

  public static getInstance(): OracleService {
    if (!OracleService.instance) {
      OracleService.instance = new OracleService();
    }
    return OracleService.instance;
  }

  private initializeConnection(): Connection {
    const networkUrl = process.env["SOLANA_NETWORK"];
    if (!networkUrl) {
      throw new Error("SOLANA_NETWORK environment variable is required");
    }
    return new Connection(networkUrl, "confirmed");
  }

  private loadAdminKeypair(): Keypair {
    try {
      const keypairPath = path.join(process.cwd(), KEYPAIR_FILE);
      const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
      const keypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
      console.log(`✅ Loaded admin keypair: ${keypair.publicKey.toBase58()}`);
      return keypair;
    } catch (error) {
      throw new Error(`Failed to load admin keypair from ${KEYPAIR_FILE}`);
    }
  }

  private initializeProgram(): anchor.Program<Coinflip> {
    const adminWallet = new anchor.Wallet(this.adminKeypair);
    const provider = new anchor.AnchorProvider(this.connection, adminWallet, { commitment: "confirmed" });
    anchor.setProvider(provider);
    return new anchor.Program(idl as Coinflip, provider) as anchor.Program<Coinflip>;
  }

  public async startEventListening(): Promise<void> {
    if (this.isListening) return;

    console.log("🎧 Starting event listeners...");
    try {
      const listeners = await this.setupEventListeners();
      this.eventListeners.push(...listeners);
      this.isListening = true;
    } catch (error) {
      console.error("❌ Failed to start event listeners:", error);
      throw error;
    }
  }

  private async setupEventListeners(): Promise<number[]> {
    return [
      this.program.addEventListener("playerJoined", this.handlePlayerJoinedEvent.bind(this)),
      this.program.addEventListener("playerUnjoined", this.handlePlayerUnjoinedEvent.bind(this)),
      this.program.addEventListener("playerRolled", this.handlePlayerRolledEvent.bind(this)),
      this.program.addEventListener("gameInitialized", this.handleGameInitializedEvent.bind(this)),
      this.program.addEventListener("gameCompleted", this.handleGameCompletedEvent.bind(this)),
      this.program.addEventListener("gameClosed", this.handleGameClosedEvent.bind(this)),
      this.program.addEventListener("playerParticipationCleaned", this.handlePlayerParticipationCleanedEvent.bind(this))
    ];
  }

  public async stopEventListening(): Promise<void> {
    if (!this.isListening) return;

    await Promise.allSettled(
      this.eventListeners.map(listenerId => this.program.removeEventListener(listenerId))
    );
    this.eventListeners = [];
    this.isListening = false;
  }

  private async handlePlayerJoinedEvent(event: any): Promise<void> {
    try {
      const gameAddress = event.gameKey.toBase58();
      const playerAddress = event.player.toBase58();
      const currentPlayers = Number(event.playersCount);

      this.db.updatePlayerCount(gameAddress, currentPlayers);
      this.db.addPlayerToGame(gameAddress, playerAddress);

      if (this.db.isGameReadyForCompletion(gameAddress)) {
        console.log(`🎯 Auto-completing game ${gameAddress}`);
        const result = await this.completeGame(gameAddress);
        if (!result.success && !result.notReady) {
          console.error(`❌ Auto-completion failed: ${result.error}`);
        }
      }
    } catch (error) {
      console.error("❌ Error in PlayerJoined event:", error);
    }
  }

  private async handlePlayerUnjoinedEvent(event: any): Promise<void> {
    try {
      const gameAddress = event.gameKey.toBase58();
      const playerAddress = event.player.toBase58();
      const currentPlayers = Number(event.playersCount);

      this.db.updatePlayerCount(gameAddress, currentPlayers);
      this.db.removePlayerFromGame(gameAddress, playerAddress);

      if (this.db.isGameReadyForCompletion(gameAddress)) {
        console.log(`🎯 Auto-completing game ${gameAddress}`);
        const result = await this.completeGame(gameAddress);
        if (!result.success && !result.notReady) {
          console.error(`❌ Auto-completion failed: ${result.error}`);
        }
      }
    } catch (error) {
      console.error("❌ Error in PlayerUnjoined event:", error);
    }
  }

  private async handlePlayerRolledEvent(event: any): Promise<void> {
    try {
      const gameAddress = event.gameKey.toBase58();
      const playerAddress = event.player.toBase58();

      console.log(`🎲 Player ${playerAddress} rolled in game ${gameAddress}`);

      // The PlayerRolled event updates slot entropy which affects winner calculation
      // We should trigger completion check since rolling might make the game ready
      if (this.db.isGameReadyForCompletion(gameAddress)) {
        console.log(`🎯 Auto-completing game ${gameAddress} after roll`);
        const result = await this.completeGame(gameAddress);
        if (!result.success && !result.notReady) {
          console.error(`❌ Auto-completion failed: ${result.error}`);
        }
      }
    } catch (error) {
      console.error("❌ Error in PlayerRolled event:", error);
    }
  }

  private async handleGameInitializedEvent(event: any): Promise<void> {
    try {
      const gameAddress = event.gameKey.toBase58();
      const expiresAt = Number(event.createdAt) + Number(event.timeout);

      this.db.saveGameMetadata(
        gameAddress,
        event.minPlayers,
        event.maxPlayers,
        expiresAt
      );
      this.db.trackGame(gameAddress);
    } catch (error) {
      console.error("❌ Error in GameInitialized event:", error);
    }
  }

  private handleGameCompletedEvent(event: any): void {
    const gameAddress = event.gameKey.toBase58();
    this.db.markGameCompleted(gameAddress);
  }

  private handleGameClosedEvent(event: any): void {
    const gameAddress = event.gameKey.toBase58();
    this.db.markGameClosed(gameAddress);
    console.log(`🚫 Game closed: ${gameAddress}`);
  }

  private async handlePlayerParticipationCleanedEvent(event: any): Promise<void> {
    try {
      const gameAddress = event.gameKey.toBase58();
      const playerAddress = event.player.toBase58();

      console.log(`🧹 Player ${playerAddress} cleaned from game ${gameAddress}`);

      // Remove the player from our local tracking
      this.db.removePlayerFromGame(gameAddress, playerAddress);
    } catch (error) {
      console.error("❌ Error in PlayerParticipationCleaned event:", error);
    }
  }

  public generateGameSecrets(gameType?: string): GameSecrets {
    const secretKey = randomBytes(SECRET_KEY_LENGTH);
    const randomHash = createHash('sha256').update(secretKey).digest();
    const gamePda = this.getGamePDA(randomHash);
    const gameAddress = gamePda.toBase58();

    this.db.saveSecretKey(gameAddress, secretKey.toString('hex'), randomHash.toString('hex'));
    this.db.trackGame(gameAddress);

    const result: GameSecrets = {
      randomHash: randomHash.toString('hex'),
      gameAddress
    };

    // For dumbflip and snowball games, also return the secret key
    if (gameType === 'dumbflip' || gameType === 'snowball') {
      result.secretKey = secretKey.toString('hex');
    }

    return result;
  }

  public async isGameReadyForCompletion(gamePda: PublicKey): Promise<boolean> {
    const gameAddress = gamePda.toBase58();

    // Try cached check first
    if (this.db.isGameReadyForCompletion(gameAddress)) {
      return true;
    }

    // Fallback to blockchain check
    try {
      const gameAccount = await this.program.account.game.fetch(gamePda);
      const blockTime = await this.getBlockchainTime();

      const expiresAt = Number(gameAccount.createdAt) + Number(gameAccount.timeout);
      const isExpired = blockTime > expiresAt;
      const isFull = gameAccount.playersCount >= gameAccount.maxPlayers;
      const hasMinPlayers = gameAccount.playersCount >= gameAccount.minPlayers;

      // Update cache
      this.db.saveGameMetadata(
        gameAddress,
        gameAccount.minPlayers,
        gameAccount.maxPlayers,
        expiresAt
      );

      return isFull || (isExpired && hasMinPlayers);
    } catch (error: any) {
      if (this.isAccountNotFoundError(error)) {
        this.db.markGameCompleted(gameAddress);
        return false;
      }
      throw error;
    }
  }

  public async completeGame(gameAddress: string): Promise<GameCompletionResult> {
    try {
      const gamePda = new PublicKey(gameAddress);
      const secretData = this.db.getSecretKey(gameAddress);

      if (!secretData) {
        return { success: false, error: "No secret key found" };
      }

      if (!(await this.isGameReadyForCompletion(gamePda))) {
        return { success: false, notReady: true };
      }

      const gameAccount = await this.program.account.game.fetch(gamePda);

      // Get players for this game from database
      const players = this.db.getGamePlayers(gameAddress);

      if (players.length === 0) {
        return { success: false, error: "No players found for game" };
      }

      const secretKeyBuffer = Buffer.from(secretData.secretKey, "hex");
      const randomHashBuffer = Buffer.from(secretData.randomHash, "hex");
      const winnerIndex = this.calculateWinnerIndex(secretKeyBuffer, gameAccount.lastSlot, players.length);
      const winnerPlayerAddress = players[winnerIndex];

      if (!winnerPlayerAddress) {
        return { success: false, error: "Unable to determine winner" };
      }

      const winnerAddress = new PublicKey(winnerPlayerAddress);

      // Check if this player participation PDA exists to verify they're actually in the game
      if (!(await this.verifyPlayerInGame(gamePda, winnerAddress))) {
        console.log(`⚠️ Selected winner ${winnerPlayerAddress} not found in game, clearing stale player data`);
        // Clear stale player data and try again
        this.db.clearStalePlayersForGame(gameAddress);
        return { success: false, notReady: true };
      }

      const tx = await this.executeGameCompletion(
        winnerAddress,
        gameAccount.creator,
        randomHashBuffer,
        secretKeyBuffer
      );
      await this.confirmTransaction(tx);

      this.db.markSecretKeyUsed(gameAddress);
      this.db.markGameCompleted(gameAddress);

      return { success: true, txHash: tx };
    } catch (error: any) {
      this.db.incrementCompletionAttempts(gameAddress);
      return { success: false, error: error.message };
    }
  }

  private async executeGameCompletion(
    winnerAddress: PublicKey,
    creatorAddress: PublicKey,
    randomHashBuffer: Buffer,
    secretKeyBuffer: Buffer
  ): Promise<string> {
    return await this.program.methods
      .completeGame([...randomHashBuffer], [...secretKeyBuffer])
      .accounts({
        authority: this.adminKeypair.publicKey,
        winner: winnerAddress,
        creator: creatorAddress,
      })
      .signers([this.adminKeypair])
      .rpc();
  }

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

    throw new Error("Unable to generate unbiased random number - game must be cancelled");
  }

  private async getBlockchainTime(): Promise<number> {
    try {
      const slot = await this.connection.getSlot();
      const blockTime = await this.connection.getBlockTime(slot);
      return blockTime || Math.floor(Date.now() / 1000);
    } catch {
      return Math.floor(Date.now() / 1000);
    }
  }

  private async confirmTransaction(signature: string): Promise<void> {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
    await this.connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight
    });
  }

  private isAccountNotFoundError(error: any): boolean {
    return error.message?.includes('Account does not exist');
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  public cleanupOldRecords(hoursOld: number = 48) {
    return this.db.cleanupOldRecords(hoursOld);
  }

  public getStats() {
    return {
      ...this.db.getStats(),
      eventListening: this.isListening,
      activeListeners: this.eventListeners.length
    };
  }

  public async scanAndCompleteActiveGames(): Promise<CompletionStats> {
    const stats: CompletionStats = { completed: 0, errors: 0, notReady: 0 };
    const pendingGames = this.db.getPendingGames();

    if (pendingGames.length === 0) return stats;

    for (const game of pendingGames) {
      if (game.completion_attempts >= MAX_COMPLETION_ATTEMPTS) continue;

      try {
        const result = await this.completeGame(game.game_address);
        if (result.success) {
          stats.completed++;
        } else if (result.notReady) {
          stats.notReady++;
        } else {
          stats.errors++;
        }
        await this.delay(DEFAULT_DELAY_MS);
      } catch (error) {
        stats.errors++;
      }
    }

    if (stats.completed > 0 || stats.errors > 0 || stats.notReady > 0) {
      const parts = [];
      if (stats.completed > 0) parts.push(`${stats.completed} completed`);
      if (stats.errors > 0) parts.push(`${stats.errors} errors`);
      if (stats.notReady > 0) parts.push(`${stats.notReady} not ready`);
      console.log(`📊 Scan: ${parts.join(', ')}`);
    }

    return stats;
  }

  private getGamePDA(randomHash: Buffer): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game", 'utf8'), randomHash],
      this.program.programId
    );
    return pda;
  }

  private async verifyPlayerInGame(gamePda: PublicKey, playerAddress: PublicKey): Promise<boolean> {
    try {
      // Check if PlayerParticipation PDA exists for this game and player
      const [playerParticipationPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("player_participation", 'utf8'), gamePda.toBuffer(), playerAddress.toBuffer()],
        this.program.programId
      );

      // Try to fetch the PlayerParticipation account
      await this.program.account.playerParticipation.fetch(playerParticipationPda);
      return true;
    } catch (error) {
      // If account doesn't exist, player is not in the game
      return false;
          }
    }
  }
