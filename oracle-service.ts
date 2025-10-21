import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { randomBytes, createHash } from "crypto";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { OracleDatabase } from "./database.ts";
import { delay as delayHelper } from "./delay.ts";
import type { Timba } from "./idl/idlType.ts";
import idl from "./idl/idl.json" with { type: "json" };
import * as fs from "fs";
import * as path from "path";

class MissingSecretError extends Error {
  constructor(gameAddress: string) {
    super(`No secret data found for game ${gameAddress}`);
    this.name = "MissingSecretError";
  }
}

// Constants
const KEYPAIR_FILE = "admin-keypair.json";
const SECRET_KEY_LENGTH = 32;
const MAX_COMPLETION_ATTEMPTS = 5;
const DEFAULT_DELAY_MS = 1000;


// Event handling types
type EventHandler = (event: any) => Promise<void> | void;
type EventMap = {
  gameInitialized: any;
  playerJoined: any;
  playerUnjoined: any;
  gameCompleted: any;
  gameClosed: any;
  oracleInitialized: any;
  oracleUpdated: any;

  tokenFeeWithdrawn: any;
  tokenInitialized: any;
  tokenUpdated: any;
};

// Types
interface GameCompletionResult {
  success: boolean;
  notReady?: boolean;
  error?: string;
  txHash?: string;
}

type PublicKeyLike =
  | PublicKey
  | anchor.web3.PublicKey
  | string
  | { [key: string]: any }
  | null
  | undefined;

interface GameSecrets {
  randomHash: string;
  gameAddress: string;
}

interface CompletionStats {
  completed: number;
  errors: number;
  notReady: number;
}

interface GameReadinessSnapshot {
  ready: boolean;
  gameAccount: any | null;
}

interface GameOnChainContext {
  gamePda: PublicKey;
  secretData: { secretKey: string; randomHash: string };
  randomHashBuffer: Buffer;
  readiness?: GameReadinessSnapshot;
}

interface ResolveGameContextOptions {
  readiness?: GameReadinessSnapshot;
  requireOnChain?: boolean;
}

export class OracleService {
  private static instance: OracleService;
  private program: anchor.Program<Timba>;
  private connection: anchor.web3.Connection;
  private adminKeypair: anchor.web3.Keypair;
  private db: OracleDatabase;
  private eventListeners: number[] = [];
  private isListening: boolean = false;
  private readinessCache: Map<string, GameReadinessSnapshot> = new Map();

  private constructor(db?: OracleDatabase) {
    this.db = db ?? OracleDatabase.getInstance();
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

  // Factory for tests or custom wiring: does not affect the singleton
  public static createWith(db: OracleDatabase): OracleService {
    return new OracleService(db);
  }

  private initializeConnection(): anchor.web3.Connection {
    const networkUrl = process.env["SOLANA_NETWORK"];
    if (!networkUrl) {
      throw new Error("SOLANA_NETWORK environment variable is required");
    }
    return new anchor.web3.Connection(networkUrl, "confirmed");
  }

  private shouldUseEphemeralKeypair(): boolean {
    const env = (process.env["NODE_ENV"] || process.env["BUN_ENV"] || "").toLowerCase();
    if (env.includes("test")) {
      return true;
    }
    if (process.env["CI"] === "true") {
      return true;
    }
    return process.env["USE_FAKE_KEYPAIR"] === "true";
  }

  private loadAdminKeypair(): anchor.web3.Keypair {
    const configured = process.env["ORACLE_KEYPAIR_PATH"];
    const filename = configured && configured.trim().length > 0 ? configured : KEYPAIR_FILE;
    const keypairPath = path.isAbsolute(filename) ? filename : path.join(process.cwd(), filename);
    try {
      const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
      const keypair = anchor.web3.Keypair.fromSecretKey(new Uint8Array(keypairData));
      console.log(`✅ Loaded admin keypair: ${keypair.publicKey.toBase58()}`);
      return keypair;
    } catch (error: any) {
      if ((error?.code === "ENOENT" || error?.message?.includes("ENOENT")) && this.shouldUseEphemeralKeypair()) {
        const keypair = anchor.web3.Keypair.generate();
        console.warn(
          `⚠️  Using ephemeral admin keypair ${keypair.publicKey.toBase58()} because ${filename} was not found.`
        );
        return keypair;
      }

      console.error(`❌ Failed to load admin keypair from ${keypairPath}:`, error?.message || error);
      throw new Error(`Failed to load admin keypair from ${filename}`);
    }
  }

  private initializeProgram(): anchor.Program<Timba> {
    const adminWallet = new anchor.Wallet(this.adminKeypair);
    const provider = new anchor.AnchorProvider(
      this.connection,
      adminWallet,
      { commitment: "confirmed" }
    );
    anchor.setProvider(provider);
    return new anchor.Program(idl as Timba, provider) as anchor.Program<Timba>;
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
    const eventMap: Array<[keyof EventMap, EventHandler]> = [
      ["playerJoined", this.handlePlayerEvent.bind(this, "joined")],
      ["playerUnjoined", this.handlePlayerEvent.bind(this, "unjoined")],
      ["gameInitialized", this.handleGameInitialized.bind(this)],
      ["gameCompleted", this.handleGameStatusChange.bind(this, "completed")],
      ["gameClosed", this.handleGameStatusChange.bind(this, "closed")],
    ];

    const listenerIds = await Promise.all(
      eventMap.map(([eventName, handler]) =>
        Promise.resolve(this.program.addEventListener(eventName, handler))
      )
    );

    return listenerIds;
  }

  public async stopEventListening(): Promise<void> {
    if (!this.isListening) return;

    await Promise.allSettled(
      this.eventListeners.map(listenerId => this.program.removeEventListener(listenerId))
    );
    this.eventListeners = [];
    this.isListening = false;
  }

  private async handlePlayerEvent(action: 'joined' | 'unjoined', event: any): Promise<void> {
    const { gameAddress, playerAddress, ticketIndex } = this.extractEventData(event);

    try {
      if (!gameAddress) {
        console.warn(`⚠️  Missing game address in ${action} event`);
        return;
      }

      if (ticketIndex === undefined) {
        console.warn(`⚠️  Missing ticket index in ${action} event for ${gameAddress}`);
        return;
      }

      // Handle player database operations
      switch (action) {
        case 'joined':
          if (!playerAddress) {
            console.warn(`⚠️  Missing player address in join event for ${gameAddress}`);
            return;
          }
          this.db.addPlayerToGame(gameAddress, playerAddress, ticketIndex);
          break;
        case 'unjoined':
          this.db.removePlayerFromGame(gameAddress, ticketIndex);
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


  private extractEventData(event: any): {
    gameAddress: string;
    playerAddress?: string;
    ticketIndex?: number;
  } {
    const gameKey = event.gameKey as PublicKeyLike;
    const playerKey = event.player as PublicKeyLike;

    const resolveIndex = (value: any): number | undefined => {
      if (value === undefined || value === null) return undefined;
      if (typeof value === "number") return value;
      if (typeof value === "bigint") return Number(value);
      if (typeof value.toNumber === "function") return value.toNumber();
      if (typeof value.valueOf === "function") {
        const raw = value.valueOf();
        if (typeof raw === "number") return raw;
      }
      return undefined;
    };

    return {
      gameAddress: this.toBase58(gameKey) ?? "",
      playerAddress: this.toBase58(playerKey),
      ticketIndex: resolveIndex(event.ticketIndex ?? event.ticket_index),
    };
  }

  private async tryAutoComplete(
    gameKey: PublicKeyLike,
    gameAddress: string,
    trigger: string
  ): Promise<void> {
    const gamePda = this.coercePublicKey(gameKey);
    if (!gamePda) {
      return;
    }

    if (!(await this.isGameReadyForCompletion(gamePda))) {
      return;
    }

    const result = await this.completeGame(gameAddress);
    if (result.success) {
      console.log(`🎯 Auto-completed game ${gameAddress} after ${trigger}`);
      return;
    }

    if (!result.notReady) {
      console.error(`❌ Auto-completion failed: ${result.error}`);
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
    const normalized = this.ensurePublicKey(gamePda);
    const gameAddress = normalized.toBase58();
    const readiness = await this.evaluateGameReadiness(normalized, gameAddress);
    if (readiness.ready) {
      this.readinessCache.set(gameAddress, readiness);
    } else {
      this.readinessCache.delete(gameAddress);
    }
    return readiness.ready;
  }

  public async completeGame(
    gameAddress: string,
    cachedReadiness?: GameReadinessSnapshot,
    sharedContext?: GameOnChainContext
  ): Promise<GameCompletionResult> {
    const recordFailure = (error: string): GameCompletionResult => {
      this.db.incrementCompletionAttempts(gameAddress);
      return { success: false, error };
    };

    try {
      let context = sharedContext ?? null;
      let readiness =
        cachedReadiness ?? sharedContext?.readiness ?? undefined;

      if (!context) {
        const options: ResolveGameContextOptions = {};
        if (readiness) {
          options.readiness = readiness;
        }
        context = await this.resolveGameContext(gameAddress, options);
      }

      if (!context) {
        return recordFailure("No secret key found");
      }

      readiness = readiness ?? context.readiness ?? this.consumeReadiness(gameAddress);
      let shouldAttempt: boolean | undefined;

      if (!readiness) {
        shouldAttempt = await this.isGameReadyForCompletion(context.gamePda);
        readiness = this.consumeReadiness(gameAddress);
      }

      if (!readiness) {
        if (shouldAttempt === false) {
          return { success: false, notReady: true };
        }

        const refreshed = await this.resolveGameContext(gameAddress, {
          requireOnChain: true,
        });

        if (!refreshed || !refreshed.readiness) {
          return { success: false, notReady: true };
        }

        context = refreshed;
        readiness = refreshed.readiness;

        if (shouldAttempt) {
          readiness = { ...readiness, ready: true };
        }
      }

      if (!readiness || !readiness.ready || !readiness.gameAccount) {
        return { success: false, notReady: true };
      }

      const { secretData, randomHashBuffer, gamePda } = context;
      const gameAccount = readiness.gameAccount;
      const players = this.db.getGamePlayers(gameAddress);
      const nEntries = Number(gameAccount.ticketsCount);

      if (players.length === 0) {
        return recordFailure("No players found for game");
      }

      if (players.length !== nEntries) {
        console.error(
          `❌ Ticket registry mismatch for ${gameAddress}: expected ${nEntries}, found ${players.length}`
        );
        return recordFailure("Ticket registry out of sync");
      }

      const secretKeyBuffer = Buffer.from(secretData.secretKey, "hex");
      const winnerIndex = this.calculateWinnerIndex(
        secretKeyBuffer,
        Number(gameAccount.lastSlot),
        nEntries
      );
      const winnerPlayerAddress = players[winnerIndex];

      if (!winnerPlayerAddress) {
        return recordFailure("Unable to determine winner");
      }

      const winnerAddress = new PublicKey(winnerPlayerAddress);

      const txHash = await this.executeGameCompletion({
        gameAccount,
        winnerAddress,
        randomHashBuffer,
        secretKeyBuffer,
        winnerIndex,
      });

      this.db.markSecretKeyUsed(gameAddress);
      this.db.markGameCompleted(gameAddress);

      return { success: true, txHash };
    } catch (error: any) {
      return recordFailure(error instanceof Error ? error.message : String(error));
    }
  }

  private async executeGameCompletion(args: {
    gameAccount: any;
    winnerAddress: PublicKey;
    randomHashBuffer: Buffer;
    secretKeyBuffer: Buffer;
    winnerIndex: number;
  }): Promise<string> {
    const { gameAccount, winnerAddress, randomHashBuffer, secretKeyBuffer, winnerIndex } = args;

    const creatorPublicKey = new PublicKey(gameAccount.creator);
    const gamePda = this.getGamePDA(randomHashBuffer);
    const tokenMint = new PublicKey(gameAccount.tokenMint);
    const tokenProgramId = await this.resolveTokenProgram(
      gameAccount.tokenProgram,
      tokenMint
    );
    const programId = this.ensurePublicKey(this.program.programId);
    const [oraclePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("oracle", "utf8")],
      programId
    );
    const [gameTokenPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game_token", "utf8"), tokenMint.toBuffer()],
      programId
    );
    const [gameVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game_vault", "utf8"), tokenMint.toBuffer()],
      programId
    );
    const winnerTokenAccount = getAssociatedTokenAddressSync(
      tokenMint,
      winnerAddress,
      false,
      tokenProgramId,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const gameTokenAccount = getAssociatedTokenAddressSync(
      tokenMint,
      gameVaultPda,
      true,
      tokenProgramId,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const txHash = await this.program.methods
      .completeGame([...randomHashBuffer], [...secretKeyBuffer], winnerIndex)
      .accountsPartial({
        game: gamePda,
        tokenMint,
        oracle: oraclePda,
        oracleOperator: this.adminKeypair.publicKey,
        winner: winnerAddress,
        creator: creatorPublicKey,
        gameToken: gameTokenPda,
        gameVault: gameVaultPda,
        tokenProgram: tokenProgramId,
        gameTokenAccount,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        winnerTokenAccount,
      })
      .signers([this.adminKeypair])
      .rpc();

    await this.confirmTransaction(txHash);
    return txHash;
  }

  private async resolveTokenProgram(
    tokenProgram: PublicKey | string | null | undefined,
    tokenMint: PublicKey
  ): Promise<PublicKey> {
    const directProgram = this.coercePublicKey(tokenProgram);

    if (directProgram && !directProgram.equals(PublicKey.default)) {
      if (directProgram.equals(TOKEN_PROGRAM_ID)) {
        return TOKEN_PROGRAM_ID;
      }

      if (directProgram.equals(TOKEN_2022_PROGRAM_ID)) {
        return TOKEN_2022_PROGRAM_ID;
      }

      return directProgram;
    }

    try {
      const mintAccount = await this.connection.getAccountInfo(tokenMint);
      const owner = mintAccount?.owner;

      if (owner?.equals(TOKEN_2022_PROGRAM_ID)) {
        return TOKEN_2022_PROGRAM_ID;
      }

      if (owner?.equals(TOKEN_PROGRAM_ID)) {
        return TOKEN_PROGRAM_ID;
      }
    } catch (error) {
      console.warn(
        `⚠️  Unable to resolve token program for mint ${tokenMint.toBase58()}:`,
        error instanceof Error ? error.message : error
      );
    }

    return TOKEN_PROGRAM_ID;
  }

  private toBase58(value: PublicKeyLike): string | undefined {
    const key = this.coercePublicKey(value);
    if (key) {
      return key.toBase58();
    }

    if (typeof value === "string") {
      return value;
    }

    if (value && typeof (value as any).toString === "function") {
      const asString = (value as any).toString();
      return typeof asString === "string" ? asString : undefined;
    }

    return undefined;
  }

  private coercePublicKey(value: PublicKeyLike): PublicKey | null {
    if (!value) {
      return null;
    }

    if (value instanceof PublicKey) {
      return value;
    }

    if (value instanceof anchor.web3.PublicKey) {
      return new PublicKey(value.toBytes());
    }

    if (typeof value === "string") {
      try {
        return new PublicKey(value);
      } catch {
        return null;
      }
    }

    if (typeof value === "object") {
      if (typeof (value as any).toBase58 === "function") {
        try {
          return new PublicKey((value as any).toBase58());
        } catch {
          return null;
        }
      }

      if ("value" in (value as any)) {
        return this.coercePublicKey((value as any).value);
      }

      if ("some" in (value as any)) {
        return this.coercePublicKey((value as any).some);
      }
    }

    try {
      return new PublicKey(value as any);
    } catch {
      return null;
    }
  }

  private ensurePublicKey(value: PublicKeyLike | PublicKey): PublicKey {
    const normalized = value instanceof PublicKey ? value : this.coercePublicKey(value);
    if (!normalized) {
      throw new Error("Invalid public key provided");
    }
    return normalized;
  }

  private calculateWinnerIndex(
    secretKeyBuffer: Buffer,
    lastSlot: number,
    nPlayers: number
  ): number {
    if (nPlayers <= 1) return 0;

    const lastSlotBytes = Buffer.alloc(8);
    lastSlotBytes.writeBigUInt64LE(BigInt(lastSlot));

    const combinedData = Buffer.concat([
      secretKeyBuffer.subarray(0, 32),
      lastSlotBytes,
    ]);

    const entropyHash = createHash("sha256").update(combinedData).digest();

    const maxU64 = 0xffff_ffff_ffff_ffffn;
    const nPlayersBig = BigInt(nPlayers);
    const maxValid = maxU64 - (maxU64 % nPlayersBig);

    for (let startPos = 0; startPos <= entropyHash.length - 8; startPos++) {
      const randomU64 = entropyHash.readBigUInt64LE(startPos);
      if (randomU64 < maxValid) {
        return Number(randomU64 % nPlayersBig);
      }
    }

    throw new Error(
      "Unable to generate unbiased random number - game must be cancelled"
    );
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
    return delayHelper(ms);
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

    console.log(`🔍 Scanning ${pendingGames.length} pending games...`);

    for (const game of pendingGames) {
      if (game.completion_attempts >= MAX_COMPLETION_ATTEMPTS) {
        console.log(`⏭️  Skipping game ${game.game_address} (${game.completion_attempts} attempts)`);
        continue;
      }

      try {
        // Check if game still exists on-chain
        const onChainContext = await this.gameExistsOnChain(game.game_address);
        if (!onChainContext) {
          this.db.markGameCompleted(game.game_address);
          continue;
        }

        const result = await this.completeGame(
          game.game_address,
          onChainContext.readiness,
          onChainContext
        );
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

  private async gameExistsOnChain(
    gameAddress: string
  ): Promise<GameOnChainContext | null> {
    return this.resolveGameContext(gameAddress, { requireOnChain: true });
  }

  private async resolveGameContext(
    gameAddress: string,
    options: ResolveGameContextOptions = {}
  ): Promise<GameOnChainContext | null> {
    const { readiness, requireOnChain = false } = options;

    let resolved: ReturnType<OracleService["resolveStoredGame"]> = null;
    try {
      resolved = this.resolveStoredGame(gameAddress, { throwIfMissing: requireOnChain });
    } catch (error: any) {
      if (error instanceof MissingSecretError) {
        if (requireOnChain) {
          console.log(`⚠️  No secret key found for game ${gameAddress}`);
        }
        return null;
      }
      throw error;
    }

    if (!resolved) {
      if (requireOnChain) {
        console.log(`⚠️  No secret key found for game ${gameAddress}`);
      }
      return null;
    }

    let readinessSnapshot = readiness;

    if (!readinessSnapshot && requireOnChain) {
      readinessSnapshot = await this.evaluateGameReadiness(resolved.gamePda, gameAddress);

      if (!readinessSnapshot.gameAccount) {
        console.log(`⚠️  Game ${gameAddress} no longer exists on-chain`);
        return null;
      }
    }

    return {
      ...resolved,
      readiness: readinessSnapshot,
    };
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

  private resolveStoredGame(
    gameAddress: string,
    options: { throwIfMissing?: boolean } = {}
  ): { secretData: { secretKey: string; randomHash: string }; randomHashBuffer: Buffer; gamePda: PublicKey } | null {
    const secretData = this.db.getSecretKey(gameAddress);
    if (!secretData) {
      if (options.throwIfMissing) {
        throw new MissingSecretError(gameAddress);
      }
      return null;
    }

    const randomHashBuffer = Buffer.from(secretData.randomHash, "hex");
    const gamePda = this.getGamePDA(randomHashBuffer);

    return { secretData, randomHashBuffer, gamePda };
  }

  private getGamePDA(randomHash: Buffer): PublicKey {
    const programId = this.ensurePublicKey(this.program.programId);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game", 'utf8'), randomHash],
      programId
    );
    return pda;
  }

  private async evaluateGameReadiness(
    gamePda: PublicKey,
    gameAddress: string
  ): Promise<GameReadinessSnapshot> {
    const gameAccount = await this.fetchGameAccount(gamePda, gameAddress);
    if (!gameAccount) {
      return { ready: false, gameAccount: null };
    }

    const blockTime = await this.getBlockchainTime();
    const expiresAt = Number(gameAccount.createdAt) + Number(gameAccount.timeout);
    const isExpired = blockTime > expiresAt;
    const ticketsCount = Number(gameAccount.ticketsCount);
    const isFull = ticketsCount >= Number(gameAccount.maxTickets);
    const hasMinTickets = ticketsCount >= Number(gameAccount.minTickets);

    return {
      ready: isFull || (isExpired && hasMinTickets),
      gameAccount,
    };
  }

  private async fetchGameAccount(
    gamePda: PublicKey,
    gameAddress: string
  ): Promise<any | null> {
    try {
      return await this.program.account.game.fetch(gamePda);
    } catch (error: any) {
      if (this.isAccountNotFoundError(error)) {
        this.db.markGameCompleted(gameAddress);
        return null;
      }
      throw error;
    }
  }

  private consumeReadiness(gameAddress: string): GameReadinessSnapshot | undefined {
    const readiness = this.readinessCache.get(gameAddress);
    if (readiness) {
      this.readinessCache.delete(gameAddress);
    }
    return readiness;
  }

}
