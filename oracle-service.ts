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
const SECRET_KEY_LENGTH = 64;
const RANDOM_BYTES_LENGTH = 8;
const MAX_COMPLETION_ATTEMPTS = 5;
const DEFAULT_DELAY_MS = 1000;

// Types
interface GameCompletionResult {
  success: boolean;
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
      console.error("❌ Failed to load admin keypair:", error);
      throw new Error(`Failed to load admin keypair from ${KEYPAIR_FILE}`);
    }
  }

  private initializeProgram(): anchor.Program<Coinflip> {
    const adminWallet = new anchor.Wallet(this.adminKeypair);
    const provider = new anchor.AnchorProvider(
      this.connection,
      adminWallet,
      { commitment: "confirmed" }
    );
    anchor.setProvider(provider);
    return new anchor.Program(idl as Coinflip, provider) as anchor.Program<Coinflip>;
  }

  public async startEventListening(): Promise<void> {
    if (this.isListening) {
      console.log("⚠️ Event listening already started");
      return;
    }

    console.log("🎧 Starting event listeners...");

    try {
      const listeners = await this.setupEventListeners();
      this.eventListeners.push(...listeners);
      this.isListening = true;
      console.log("✅ Event listeners started successfully");
    } catch (error) {
      console.error("❌ Failed to start event listeners:", error);
      throw error;
    }
  }

  private async setupEventListeners(): Promise<number[]> {
    const listeners: number[] = [];

    // Player joined events
    const playerJoinedListener = this.program.addEventListener(
      "playerJoined",
      this.handlePlayerJoinedEvent.bind(this)
    );

    // Game initialized events
    const gameInitializedListener = this.program.addEventListener(
      "gameInitialized",
      this.handleGameInitializedEvent.bind(this)
    );

    // Game completed events (for cleanup)
    const gameCompletedListener = this.program.addEventListener(
      "gameCompleted",
      this.handleGameCompletedEvent.bind(this)
    );

    listeners.push(playerJoinedListener, gameInitializedListener, gameCompletedListener);
    return listeners;
  }

  public async stopEventListening(): Promise<void> {
    if (!this.isListening) return;

    console.log("🔇 Stopping event listeners...");

    await Promise.allSettled(
      this.eventListeners.map(listenerId =>
        this.program.removeEventListener(listenerId)
      )
    );

    this.eventListeners = [];
    this.isListening = false;
    console.log("✅ Event listeners stopped");
  }

  private async handlePlayerJoinedEvent(event: any): Promise<void> {
    try {
      const gameAddress = event.gameKey.toBase58();
      const currentPlayers = Number(event.currentPlayers);
      const maxPlayers = Number(event.maxPlayers);

      console.log(`👤 Player joined: ${gameAddress} (${currentPlayers}/${maxPlayers})`);

      // Update local player count with actual blockchain count
      this.db.updatePlayerCount(gameAddress, currentPlayers);
      const isReady = this.db.isGameReadyForCompletion(gameAddress);

      if (isReady) {
        console.log(`🎯 Game ${gameAddress} ready for completion (${currentPlayers} players)`);
        const result = await this.completeGame(gameAddress);

        if (result.success) {
          console.log(`✅ Auto-completed game ${gameAddress}`);
        } else {
          console.error(`❌ Failed to auto-complete game ${gameAddress}:`, result.error);
        }
      } else {
        console.log(`⏳ Game ${gameAddress} not yet ready (${currentPlayers} players)`);
      }
    } catch (error) {
      console.error("❌ Error handling PlayerJoined event:", error);
    }
  }

  private async handleGameInitializedEvent(event: any): Promise<void> {
    try {
      const gameAddress = event.gameKey.toBase58();
      console.log(`📝 Tracking new game: ${gameAddress} (${event.minPlayers}-${event.maxPlayers} players, ${event.timeout}s timeout)`);

      // Store game metadata for local readiness checks
      this.db.saveGameMetadata(
        gameAddress,
        event.minPlayers,
        event.maxPlayers,
        Number(event.createdAt),
        event.timeout
      );

      // Track the game
      this.db.trackGame(gameAddress);
    } catch (error) {
      console.error("❌ Error handling GameInitialized event:", error);
    }
  }

  private handleGameCompletedEvent(event: any): void {
    try {
      const gameAddress = event.gameKey.toBase58();
      console.log(`✅ Game completed: ${gameAddress}`);
      this.db.markGameCompleted(gameAddress);
    } catch (error) {
      console.error("❌ Error handling GameCompleted event:", error);
    }
  }

  public generateGameSecrets(): GameSecrets {
    const secretKey = randomBytes(SECRET_KEY_LENGTH);
    const randomHash = createHash('sha256').update(secretKey).digest();
    const gamePda = this.getGamePDA(randomHash);
    const gameAddress = gamePda.toBase58();

    this.db.saveSecretKey(
      gameAddress,
      secretKey.toString('hex'),
      randomHash.toString('hex')
    );
    this.db.trackGame(gameAddress);

    console.log(`🔑 Generated secrets for game: ${gameAddress}`);

    return {
      randomHash: randomHash.toString('hex'),
      gameAddress
    };
  }

  public async isGameReadyForCompletion(gamePda: PublicKey): Promise<boolean> {
    const gameAddress = gamePda.toBase58();

    // First try to check using cached metadata (much faster)
    const cachedResult = this.db.isGameReadyForCompletion(gameAddress);
    if (cachedResult) {
      return true;
    }

    // Fallback to blockchain check (for games we might not have cached metadata for)
    try {
      const gameAccount = await this.program.account.game.fetch(gamePda);
      const blockTime = await this.getBlockchainTime();

      const createdAt = Number(gameAccount.createdAt);
      const timeout = Number(gameAccount.timeout);
      const expiresAt = createdAt + timeout;
      const isExpired = blockTime > expiresAt;

      const isFull = gameAccount.players.length >= gameAccount.maxPlayers;
      const hasMinPlayers = gameAccount.players.length >= gameAccount.minPlayers;

      // Update our cache with current blockchain data
      this.db.saveGameMetadata(
        gameAddress,
        gameAccount.minPlayers,
        gameAccount.maxPlayers,
        createdAt,
        timeout
      );

      return isFull || (isExpired && hasMinPlayers);
    } catch (error: any) {
      if (this.isAccountNotFoundError(error)) {
        console.log(`Game ${gameAddress} completed or closed`);
        this.db.markGameCompleted(gameAddress);
        return false;
      }
      throw error;
    }
  }

  public async completeGame(gameAddress: string): Promise<GameCompletionResult> {
    try {
      const gamePda = new PublicKey(gameAddress);

      // Validate game and get secret
      const secretData = this.db.getSecretKey(gameAddress);
      if (!secretData) {
        return { success: false, error: "No secret key found for game" };
      }

      const isReady = await this.isGameReadyForCompletion(gamePda);
      if (!isReady) {
        return { success: false, error: "Game is not ready for completion" };
      }

      // Get fresh game data from blockchain for completion
      const gameAccount = await this.program.account.game.fetch(gamePda);
      const secretKeyBuffer = Buffer.from(secretData.secretKey, "hex");
      const winnerIndex = this.calculateWinnerIndex(secretKeyBuffer, gameAccount.players.length);
      const winnerAddress = gameAccount.players[winnerIndex];

      if (!winnerAddress) {
        return { success: false, error: "Unable to determine winner" };
      }

      console.log(`🎲 Completing game ${gameAddress}, winner: ${winnerAddress.toBase58()}`);

      // Execute completion transaction
      const tx = await this.executeGameCompletion(gamePda, winnerAddress, gameAccount.creator, secretKeyBuffer);
      await this.confirmTransaction(tx);

      // Update database
      this.db.markSecretKeyUsed(gameAddress);
      this.db.markGameCompleted(gameAddress);

      console.log(`✅ Successfully completed game ${gameAddress}, tx: ${tx}`);
      return { success: true, txHash: tx };

    } catch (error: any) {
      console.error(`❌ Error completing game ${gameAddress}:`, error);
      this.db.incrementCompletionAttempts(gameAddress);
      return { success: false, error: error.message };
    }
  }

  private async executeGameCompletion(
    gamePda: PublicKey,
    winnerAddress: PublicKey,
    creatorAddress: PublicKey,
    secretKeyBuffer: Buffer
  ): Promise<string> {
    return await this.program.methods
      .completeGame([...secretKeyBuffer])
      .accounts({
        game: gamePda,
        player: winnerAddress,
        creator: creatorAddress,
        authority: this.adminKeypair.publicKey,
      })
      .signers([this.adminKeypair])
      .rpc();
  }

  public async scanAndCompleteActiveGames(): Promise<CompletionStats> {
    console.log('🔍 Scanning for active games (fallback check)...');

    const stats: CompletionStats = { completed: 0, errors: 0 };

    try {
      const pendingGames = this.db.getPendingGames();
      console.log(`Found ${pendingGames.length} pending games`);

      for (const pendingGame of pendingGames) {
        if (pendingGame.completion_attempts > MAX_COMPLETION_ATTEMPTS) {
          continue;
        }

        try {
          const result = await this.completeGame(pendingGame.game_address);
          if (result.success) {
            stats.completed++;
          } else {
            stats.errors++;
          }

          await this.delay(DEFAULT_DELAY_MS);
        } catch (error) {
          stats.errors++;
          console.error(`❌ Error processing game ${pendingGame.game_address}:`, error);
        }
      }

      console.log(`Fallback scan complete: ${stats.completed} completed, ${stats.errors} errors`);
      return stats;

    } catch (error) {
      console.error('❌ Error in scan process:', error);
      return { completed: stats.completed, errors: stats.errors + 1 };
    }
  }

  private getGamePDA(randomHash: Buffer): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game", 'utf8'), randomHash],
      this.program.programId
    );
    return pda;
  }

  private calculateWinnerIndex(secretKeyBuffer: Buffer, nPlayers: number): number {
    if (nPlayers <= 1) return 0;

    const randomBytes = secretKeyBuffer.subarray(0, RANDOM_BYTES_LENGTH);
    const randomNumber = BigInt('0x' + Buffer.from(randomBytes).reverse().toString('hex'));
    const maxValid = BigInt('0xFFFFFFFFFFFFFFFF') - (BigInt('0xFFFFFFFFFFFFFFFF') % BigInt(nPlayers));
    const finalNumber = randomNumber % maxValid;
    return Number(finalNumber % BigInt(nPlayers));
  }

  private async getBlockchainTime(): Promise<number> {
    try {
      const slot = await this.connection.getSlot();
      const blockTime = await this.connection.getBlockTime(slot);
      return blockTime || Math.floor(Date.now() / 1000);
    } catch (error) {
      console.warn("⚠️ Failed to get blockchain time, using local time");
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

  public getStats() {
    return {
      ...this.db.getStats(),
      eventListening: this.isListening,
      activeListeners: this.eventListeners.length
    };
  }
}
