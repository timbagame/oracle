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
      this.program.addEventListener("gameInitialized", this.handleGameInitializedEvent.bind(this)),
      this.program.addEventListener("gameCompleted", this.handleGameCompletedEvent.bind(this))
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
      const currentPlayers = Number(event.currentPlayers);

      this.db.updatePlayerCount(gameAddress, currentPlayers);

      if (this.db.isGameReadyForCompletion(gameAddress)) {
        console.log(`🎯 Auto-completing game ${gameAddress}`);
        const result = await this.completeGame(gameAddress);
        if (!result.success) {
          console.error(`❌ Auto-completion failed: ${result.error}`);
        }
      }
    } catch (error) {
      console.error("❌ Error in PlayerJoined event:", error);
    }
  }

  private async handleGameInitializedEvent(event: any): Promise<void> {
    try {
      const gameAddress = event.gameKey.toBase58();

      this.db.saveGameMetadata(
        gameAddress,
        event.minPlayers,
        event.maxPlayers,
        Number(event.createdAt),
        event.timeout
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

  public generateGameSecrets(): GameSecrets {
    const secretKey = randomBytes(SECRET_KEY_LENGTH);
    const randomHash = createHash('sha256').update(secretKey).digest();
    const gamePda = this.getGamePDA(randomHash);
    const gameAddress = gamePda.toBase58();

    this.db.saveSecretKey(gameAddress, secretKey.toString('hex'), randomHash.toString('hex'));
    this.db.trackGame(gameAddress);

    return {
      randomHash: randomHash.toString('hex'),
      gameAddress
    };
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

      const createdAt = Number(gameAccount.createdAt);
      const timeout = Number(gameAccount.timeout);
      const isExpired = blockTime > (createdAt + timeout);
      const isFull = gameAccount.players.length >= gameAccount.maxPlayers;
      const hasMinPlayers = gameAccount.players.length >= gameAccount.minPlayers;

      // Update cache
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
        return { success: false, error: "Game not ready" };
      }

      const gameAccount = await this.program.account.game.fetch(gamePda);
      const secretKeyBuffer = Buffer.from(secretData.secretKey, "hex");
      const winnerIndex = this.calculateWinnerIndex(secretKeyBuffer, gameAccount.players.length);
      const winnerAddress = gameAccount.players[winnerIndex];

      if (!winnerAddress) {
        return { success: false, error: "Unable to determine winner" };
      }

      const tx = await this.executeGameCompletion(gamePda, winnerAddress, gameAccount.creator, secretKeyBuffer);
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
    const stats: CompletionStats = { completed: 0, errors: 0 };
    const pendingGames = this.db.getPendingGames();

    if (pendingGames.length === 0) return stats;

    for (const game of pendingGames) {
      if (game.completion_attempts >= MAX_COMPLETION_ATTEMPTS) continue;

      try {
        const result = await this.completeGame(game.game_address);
        if (result.success) {
          stats.completed++;
        } else {
          stats.errors++;
        }
        await this.delay(DEFAULT_DELAY_MS);
      } catch (error) {
        stats.errors++;
      }
    }

    if (stats.completed > 0 || stats.errors > 0) {
      console.log(`Scan: ${stats.completed} completed, ${stats.errors} errors`);
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

  public getStats() {
    return {
      ...this.db.getStats(),
      eventListening: this.isListening,
      activeListeners: this.eventListeners.length
    };
  }
}
