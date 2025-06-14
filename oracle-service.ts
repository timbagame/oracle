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
  }

  private async handlePlayerEvent(action: 'joined' | 'unjoined' | 'rolled', event: any): Promise<void> {
    const { gameAddress, playerAddress } = this.extractEventData(event);

    try {
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
    } catch (error) {
      console.error(`❌ Error in player ${action} event:`, error);
    }
  }

  private handleGameStatusChange(status: 'completed' | 'closed', event: any): void {
    const { gameAddress } = this.extractEventData(event);

    try {
      if (status === 'completed') {
        this.db.markGameCompleted(gameAddress);
      } else {
        this.db.markGameClosed(gameAddress);
        this.db.clearStalePlayersForGame(gameAddress);
        console.log(`🚫 Game closed: ${gameAddress}`);
      }
    } catch (error) {
      console.error(`❌ Error in game ${status} event:`, error);
    }
  }

  private handleGameInitialized(event: any): void {
    const { gameAddress } = this.extractEventData(event);
    
    // Extract game type from event
    let gameType: string | undefined = undefined;
    if (event.gameType) {
      // GameType is an enum, extract the variant name
      const gameTypeKeys = Object.keys(event.gameType);
      if (gameTypeKeys.length > 0 && gameTypeKeys[0]) {
        gameType = gameTypeKeys[0].toLowerCase();
      }
    }
    
    console.log(`🎮 Game initialized: ${gameAddress}, Type: ${gameType || 'unknown'}`);
    this.db.trackGame(gameAddress, gameType);
  }

  private async handlePlayerCleaned(event: any): Promise<void> {
    const { gameAddress, playerAddress } = this.extractEventData(event);

    try {
      console.log(`🧹 Player ${playerAddress} cleaned from game ${gameAddress}`);
      this.db.removePlayerFromGame(gameAddress, playerAddress);
    } catch (error) {
      console.error("❌ Error in player participation cleaned event:", error);
    }
  }

  private extractEventData(event: any): { gameAddress: string; playerAddress: string } {
    return {
      gameAddress: event.gameKey.toBase58(),
      playerAddress: event.player?.toBase58() || ''
    };
  }

  private async tryAutoComplete(gamePda: PublicKey, gameAddress: string, trigger: string): Promise<void> {
    if (await this.isGameReadyForCompletion(gamePda)) {
      console.log(`🎯 Auto-completing game ${gameAddress} after ${trigger}`);
      const result = await this.completeGame(gameAddress);
      if (!result.success && !result.notReady) {
        console.error(`❌ Auto-completion failed: ${result.error}`);
      }
    }
  }

  public generateGameSecrets(): GameSecrets {
    const secretKey = randomBytes(SECRET_KEY_LENGTH);
    const randomHash = createHash('sha256').update(secretKey).digest();
    const gamePda = this.getGamePDA(randomHash);
    const gameAddress = gamePda.toBase58();

    // Store in database
    this.db.saveSecretKey(gameAddress, secretKey.toString('hex'), randomHash.toString('hex'));
    this.db.trackGame(gameAddress);

    const secrets: GameSecrets = {
      randomHash: randomHash.toString('hex'),
      gameAddress
    };


    return secrets;
  }

  public async isGameReadyForCompletion(gamePda: PublicKey): Promise<boolean> {
    try {
      const gameAccount = await this.program.account.game.fetch(gamePda);
      const blockTime = await this.getBlockchainTime();

      const expiresAt = Number(gameAccount.createdAt) + Number(gameAccount.timeout);
      const isExpired = blockTime > expiresAt;
      const isFull = gameAccount.playersCount >= gameAccount.maxPlayers;
      const hasMinPlayers = gameAccount.playersCount >= gameAccount.minPlayers;

      return isFull || (isExpired && hasMinPlayers);
    } catch (error: any) {
      if (this.isAccountNotFoundError(error)) {
        const gameAddress = gamePda.toBase58();
        this.db.markGameCompleted(gameAddress);
        return false;
      }
      throw error;
    }
  }

  public async completeGame(gameAddress: string): Promise<GameCompletionResult> {
    try {
      const secretData = this.db.getSecretKey(gameAddress);
      if (!secretData) {
        return { success: false, error: "No secret key found" };
      }

      const gamePda = this.getGamePDAFromAddress(gameAddress);
      if (!(await this.isGameReadyForCompletion(gamePda))) {
        return { success: false, notReady: true };
      }

      const gameAccount = await this.program.account.game.fetch(gamePda);
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

      if (!(await this.verifyPlayerInGame(gamePda, winnerAddress))) {
        console.log(`⚠️ Selected winner ${winnerPlayerAddress} not found in game, clearing stale data`);
        this.db.clearStalePlayersForGame(gameAddress);
        return { success: false, notReady: true };
      }

      const txHash = await this.executeGameCompletion(
        winnerAddress,
        gameAccount.creator,
        randomHashBuffer,
        secretKeyBuffer
      );

      this.db.markSecretKeyUsed(gameAddress);
      this.db.markGameCompleted(gameAddress);

      return { success: true, txHash };
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
    return txHash;
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

  public async getCurrentWinner(gameAddress: string): Promise<{ success: boolean; winner?: string; error?: string }> {
    try {
      // Check if this is a dumbflip or snowball game
      const gameType = this.db.getGameType(gameAddress);
      if (!gameType || (gameType !== 'dumbflip' && gameType !== 'snowball')) {
        return { success: false, error: "Current winner only available for dumbflip and snowball games" };
      }

      const secretData = this.db.getSecretKey(gameAddress);
      if (!secretData) {
        return { success: false, error: "Game not found" };
      }

      const gamePda = this.getGamePDAFromAddress(gameAddress);
      const gameAccount = await this.program.account.game.fetch(gamePda);
      const players = this.db.getGamePlayers(gameAddress);

      if (players.length === 0) {
        return { success: false, error: "No players in game" };
      }

      const secretKeyBuffer = Buffer.from(secretData.secretKey, "hex");
      const winnerIndex = this.calculateWinnerIndex(secretKeyBuffer, gameAccount.lastSlot, players.length);
      const winnerPlayerAddress = players[winnerIndex];

      if (!winnerPlayerAddress) {
        return { success: false, error: "Unable to determine winner" };
      }

      return { success: true, winner: winnerPlayerAddress };
    } catch (error: any) {
      if (this.isAccountNotFoundError(error)) {
        return { success: false, error: "Game not found" };
      }
      return { success: false, error: error.message };
    }
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

    console.log(`🔍 Scanning ${pendingGames.length} pending games...`);

    for (const game of pendingGames) {
      if (game.completion_attempts >= MAX_COMPLETION_ATTEMPTS) {
        console.log(`⏭️  Skipping game ${game.game_address} (${game.completion_attempts} attempts)`);
        continue;
      }

      try {
        // Check if game still exists on-chain
        if (!(await this.gameExistsOnChain(game.game_address))) {
          this.db.markGameCompleted(game.game_address);
          continue;
        }

        const result = await this.completeGame(game.game_address);
        this.updateScanStats(stats, result);

        await this.delay(DEFAULT_DELAY_MS);
      } catch (error) {
        stats.errors++;
        console.error(`❌ Error completing game ${game.game_address}:`, error);
      }
    }

    this.logScanResults(stats);
    return stats;
  }

  private async gameExistsOnChain(gameAddress: string): Promise<boolean> {
    try {
      const secretData = this.db.getSecretKey(gameAddress);
      if (!secretData) {
        console.log(`⚠️  No secret key found for game ${gameAddress}`);
        return false;
      }

      const gamePda = this.getGamePDAFromAddress(gameAddress);
      await this.program.account.game.fetch(gamePda);
      return true;
    } catch (error: any) {
      if (this.isAccountNotFoundError(error)) {
        console.log(`⚠️  Game ${gameAddress} no longer exists on-chain`);
        return false;
      }
      throw error;
    }
  }

  private updateScanStats(stats: CompletionStats, result: GameCompletionResult): void {
    if (result.success) {
      stats.completed++;
    } else if (result.notReady) {
      stats.notReady++;
    } else {
      stats.errors++;
    }
  }

  private logScanResults(stats: CompletionStats): void {
    if (stats.completed > 0 || stats.errors > 0 || stats.notReady > 0) {
      const parts = [];
      if (stats.completed > 0) parts.push(`${stats.completed} completed`);
      if (stats.errors > 0) parts.push(`${stats.errors} errors`);
      if (stats.notReady > 0) parts.push(`${stats.notReady} not ready`);

      console.log(`📊 Scan: ${parts.join(', ')}`);
    }
  }

  private getGamePDA(randomHash: Buffer): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game", 'utf8'), randomHash],
      this.program.programId
    );
    return pda;
  }

  private getGamePDAFromAddress(gameAddress: string): PublicKey {
    // Since we can predict PDAs now, we can reverse engineer from the stored secret
    const secretData = this.db.getSecretKey(gameAddress);
    if (!secretData) {
      throw new Error(`No secret data found for game ${gameAddress}`);
    }
    const randomHash = Buffer.from(secretData.randomHash, "hex");
    return this.getGamePDA(randomHash);
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
