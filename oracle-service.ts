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
import { delay as delayHelper, DEFAULT_DELAY_MS } from "./delay.ts";
import type { Timba } from "./idl/idlType.ts";
import idl from "./idl/idl.json" with { type: "json" };
import * as fs from "fs";
import * as path from "path";
import { shouldUseEphemeralKeypair } from "./env.ts";
import { coercePublicKey, ensurePublicKey, toBase58 } from "./solana-utils.ts";
import type { PublicKeyLike } from "./solana-utils.ts";

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
export const EVENT_LISTENER_FAILURE_MESSAGE = "❌ Failed to start event listeners:";
const NO_SECRET_KEY_MESSAGE = "No secret key found";
// PDA seed buffers (treated as immutable; do not mutate in place)
const GAME_SEED = Buffer.from("game", "utf8");
const ORACLE_SEED = Buffer.from("oracle", "utf8");
const GAME_TOKEN_SEED = Buffer.from("game_token", "utf8");
const GAME_VAULT_SEED = Buffer.from("game_vault", "utf8");

export interface DerivedGameAccounts {
  gamePda: PublicKey;
  oraclePda: PublicKey;
  gameTokenPda: PublicKey;
  gameVaultPda: PublicKey;
  winnerTokenAccount: PublicKey;
  gameTokenAccount: PublicKey;
}

export function deriveGameAccounts(params: {
  programId: PublicKey;
  randomHash: Buffer;
  tokenMint: PublicKey;
  winner: PublicKey;
  tokenProgramId: PublicKey;
  gamePda?: PublicKey;
}): DerivedGameAccounts {
  const { programId, randomHash, tokenMint, winner, tokenProgramId, gamePda } = params;

  const [resolvedGamePda] = gamePda
    ? [gamePda]
    : PublicKey.findProgramAddressSync([GAME_SEED, randomHash], programId);
  const [oraclePda] = PublicKey.findProgramAddressSync([ORACLE_SEED], programId);
  const [gameTokenPda] = PublicKey.findProgramAddressSync(
    [GAME_TOKEN_SEED, tokenMint.toBuffer()],
    programId
  );
  const [gameVaultPda] = PublicKey.findProgramAddressSync(
    [GAME_VAULT_SEED, tokenMint.toBuffer()],
    programId
  );
  const winnerTokenAccount = getAssociatedTokenAddressSync(
    tokenMint,
    winner,
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

  return {
    gamePda: resolvedGamePda,
    oraclePda,
    gameTokenPda,
    gameVaultPda,
    winnerTokenAccount,
    gameTokenAccount,
  };
}


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

interface GameSecrets {
  randomHash: string;
  gameAddress: string;
}

export interface CompletionStats {
  completed: number;
  errors: number;
  notReady: number;
}

export function createEmptyCompletionStats(): CompletionStats {
  return { completed: 0, errors: 0, notReady: 0 };
}

export interface ScanLoopOptions {
  waitBetweenCyclesMs?: number;
  waitForPendingOnly?: boolean;
  cleanupAfterCycleHours?: number;
  shouldContinue?: (stats: CompletionStats, cycle: number) => boolean;
  signal?: AbortSignal;
  onCycleStart?: (cycle: number) => void;
  onCycleComplete?: (cycle: number, stats: CompletionStats) => void;
}

export interface ScanLoopSummary {
  cycles: number;
  totalCompleted: number;
  totalErrors: number;
  totalNotReady: number;
  lastStats: CompletionStats | null;
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

interface AttemptGameCompletionOptions {
  gameAddress: string;
  gameKey?: PublicKeyLike;
  context?: GameOnChainContext | null;
  readiness?: GameReadinessSnapshot;
  skipReadinessCheck?: boolean;
  onResult?: (result: GameCompletionResult) => void;
  successLog?: (gameAddress: string) => string;
  failureLog?: (gameAddress: string, error?: string) => string;
}

export class OracleService {
  private static instance: OracleService;
  public static readonly EVENT_HANDLER_CONFIG: ReadonlyArray<{
    event: keyof EventMap;
    createHandler: (service: OracleService) => EventHandler;
  }> = [
    {
      event: "playerJoined",
      createHandler: (service) =>
        service.handlePlayerEvent.bind(service, "joined"),
    },
    {
      event: "playerUnjoined",
      createHandler: (service) =>
        service.handlePlayerEvent.bind(service, "unjoined"),
    },
    {
      event: "gameInitialized",
      createHandler: (service) =>
        service.handleGameInitialized.bind(service),
    },
    {
      event: "gameCompleted",
      createHandler: (service) =>
        service.handleGameStatusChange.bind(service, "completed"),
    },
    {
      event: "gameClosed",
      createHandler: (service) =>
        service.handleGameStatusChange.bind(service, "closed"),
    },
  ];
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
      if ((error?.code === "ENOENT" || error?.message?.includes("ENOENT")) && shouldUseEphemeralKeypair()) {
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
      console.error(EVENT_LISTENER_FAILURE_MESSAGE, error);
      throw error;
    }
  }

  private async setupEventListeners(): Promise<number[]> {
    const listenerIds = await Promise.all(
      OracleService.EVENT_HANDLER_CONFIG.map(({ event, createHandler }) =>
        this.program.addEventListener(event, createHandler(this))
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
      gameAddress: toBase58(gameKey) ?? "",
      playerAddress: toBase58(playerKey),
      ticketIndex: resolveIndex(event.ticketIndex ?? event.ticket_index),
    };
  }

  private async tryAutoComplete(
    gameKey: PublicKeyLike,
    gameAddress: string,
    trigger: string
  ): Promise<void> {
    await this.attemptGameCompletion({
      gameAddress,
      gameKey,
      successLog: () =>
        `🎯 Auto-completed game ${gameAddress} after ${trigger}`,
      failureLog: (_address, error) =>
        `❌ Auto-completion failed: ${error ?? "Unknown error"}`,
    });
  }

  private async attemptGameCompletion(
    options: AttemptGameCompletionOptions
  ): Promise<GameCompletionResult | null> {
    const {
      gameAddress,
      gameKey,
      context = null,
      readiness,
      skipReadinessCheck = false,
      onResult,
      successLog,
      failureLog,
    } = options;

    const resolvedPda =
      context?.gamePda ?? (gameKey ? coercePublicKey(gameKey) : null);

    if (!resolvedPda) {
      return null;
    }

    if (!skipReadinessCheck) {
      const ready = await this.isGameReadyForCompletion(resolvedPda);
      if (!ready) {
        const result: GameCompletionResult = { success: false, notReady: true };
        onResult?.(result);
        return result;
      }
    }

    const sharedContext = context ?? undefined;
    const completion = await this.completeGame(
      gameAddress,
      readiness,
      sharedContext
    );

    onResult?.(completion);

    if (completion.success) {
      const message = successLog?.(gameAddress);
      if (message) {
        console.log(message);
      }
    } else if (!completion.notReady) {
      const message = failureLog?.(gameAddress, completion.error);
      if (message) {
        console.error(message);
      }
    }

    return completion;
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
    const normalized = ensurePublicKey(gamePda);
    const gameAddress = normalized.toBase58();
    const readiness = await this.evaluateAndCacheReadiness(normalized, gameAddress);
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
      const { context, readiness, notReady } = await this.resolveContextAndReadiness(
        gameAddress,
        {
          context: sharedContext ?? null,
          readiness: cachedReadiness,
        }
      );

      if (!context) {
        return recordFailure(NO_SECRET_KEY_MESSAGE);
      }

      if (notReady || !readiness) {
        return { success: false, notReady: true };
      }

      const { secretData, randomHashBuffer } = context;
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

      this.db.finalizeCompletedGame(gameAddress);

      return { success: true, txHash };
    } catch (error: any) {
      return recordFailure(error instanceof Error ? error.message : String(error));
    }
  }

  private async resolveContextAndReadiness(
    gameAddress: string,
    options: {
      context?: GameOnChainContext | null;
      readiness?: GameReadinessSnapshot;
      requireOnChain?: boolean;
    } = {}
  ): Promise<{
    context: GameOnChainContext | null;
    readiness?: GameReadinessSnapshot;
    notReady: boolean;
  }> {
    const { context: providedContext = null, readiness: providedReadiness, requireOnChain = false } = options;

    const attachReadiness = (
      ctx: GameOnChainContext | null,
      readinessValue?: GameReadinessSnapshot
    ): GameOnChainContext | null => {
      if (ctx && readinessValue) {
        return ctx.readiness === readinessValue ? ctx : { ...ctx, readiness: readinessValue };
      }
      return ctx;
    };

    const finalize = (
      ctx: GameOnChainContext | null,
      readinessValue: GameReadinessSnapshot | undefined,
      notReady: boolean
    ) => ({
      context: attachReadiness(ctx, readinessValue),
      readiness: readinessValue,
      notReady,
    });

    const resolvedContext = await this.resolveGameContext(
      gameAddress,
      providedContext,
      requireOnChain
    );

    if (!resolvedContext) {
      return finalize(null, undefined, false);
    }

    const { readiness, notReady, missingOnChain } = await this.resolveReadinessState({
      gameAddress,
      context: resolvedContext,
      providedReadiness: providedReadiness ?? providedContext?.readiness,
      requireOnChain,
    });

    if (missingOnChain && requireOnChain) {
      console.log(`⚠️  Game ${gameAddress} no longer exists on-chain`);
      return finalize(null, undefined, false);
    }

    return finalize(resolvedContext, readiness, notReady);
  }

  private async resolveGameContext(
    gameAddress: string,
    context: GameOnChainContext | null,
    requireOnChain: boolean
  ): Promise<GameOnChainContext | null> {
    if (context) {
      return context;
    }

    try {
      const resolved = this.resolveStoredGame(gameAddress, {
        throwIfMissing: requireOnChain,
      });
      if (!resolved) {
        this.logMissingSecret(gameAddress, requireOnChain);
        return null;
      }
      return resolved;
    } catch (error: any) {
      if (error instanceof MissingSecretError) {
        this.logMissingSecret(gameAddress, requireOnChain);
        return null;
      }
      throw error;
    }
  }

  private async resolveReadinessState(args: {
    gameAddress: string;
    context: GameOnChainContext;
    providedReadiness?: GameReadinessSnapshot;
    requireOnChain: boolean;
  }): Promise<{
    readiness?: GameReadinessSnapshot;
    notReady: boolean;
    missingOnChain: boolean;
  }> {
    const { gameAddress, context, providedReadiness, requireOnChain } = args;

    let readinessSnapshot = providedReadiness ?? context.readiness;
    let missingOnChain = false;

    if (readinessSnapshot && requireOnChain && !readinessSnapshot.gameAccount) {
      readinessSnapshot = undefined;
    }

    if (!readinessSnapshot && !requireOnChain) {
      readinessSnapshot = this.consumeReadiness(gameAddress);
    }

    const shouldEvaluateReadiness = requireOnChain || !readinessSnapshot;

    if (shouldEvaluateReadiness) {
      const evaluation = await this.evaluateAndCacheReadiness(
        context.gamePda,
        gameAddress
      );

      if (!evaluation.gameAccount) {
        missingOnChain = true;
        readinessSnapshot = undefined;
      } else if (!requireOnChain && !evaluation.ready) {
        return { readiness: undefined, notReady: true, missingOnChain };
      } else {
        readinessSnapshot = evaluation;
      }
    }

    const notReady =
      !readinessSnapshot ||
      !readinessSnapshot.ready ||
      !readinessSnapshot.gameAccount;

    return { readiness: readinessSnapshot, notReady, missingOnChain };
  }

  private async evaluateAndCacheReadiness(
    gamePda: PublicKey,
    gameAddress: string
  ): Promise<GameReadinessSnapshot> {
    const readiness = await this.evaluateGameReadiness(gamePda, gameAddress);

    if (readiness.ready) {
      this.readinessCache.set(gameAddress, readiness);
    } else {
      this.readinessCache.delete(gameAddress);
    }

    return readiness;
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
    const tokenMint = new PublicKey(gameAccount.tokenMint);
    const tokenProgramId = await this.resolveTokenProgram(
      gameAccount.tokenProgram,
      tokenMint
    );
    const programId = ensurePublicKey(this.program.programId);
    const {
      gamePda,
      oraclePda,
      gameTokenPda,
      gameVaultPda,
      winnerTokenAccount,
      gameTokenAccount,
    } = deriveGameAccounts({
      programId,
      randomHash: randomHashBuffer,
      tokenMint,
      winner: winnerAddress,
      tokenProgramId,
    });

    const gameTokenCtx = {
      tokenMint,
      gameToken: gameTokenPda,
      gameVault: gameVaultPda,
      gameTokenAccount,
      tokenProgram: tokenProgramId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    } as const;

    const txHash = await this.program.methods
      .completeGame([...randomHashBuffer], [...secretKeyBuffer], winnerIndex)
      .accountsPartial({
        game: gamePda,
        oracle: oraclePda,
        oracleOperator: this.adminKeypair.publicKey,
        winner: winnerAddress,
        creator: creatorPublicKey,
        gameTokenCtx,
        systemProgram: anchor.web3.SystemProgram.programId,
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
    const directProgram = coercePublicKey(tokenProgram);

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
    const stats: CompletionStats = createEmptyCompletionStats();
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
        const { context: onChainContext, readiness } =
          await this.resolveContextAndReadiness(game.game_address, {
            requireOnChain: true,
          });
        if (!onChainContext) {
          this.db.markGameCompleted(game.game_address);
          continue;
        }

        const result = await this.attemptGameCompletion({
          gameAddress: game.game_address,
          context: onChainContext,
          readiness,
          skipReadinessCheck: true,
        });

        if (result) {
          this.updateScanStats(stats, result);
        }

        await delayHelper(DEFAULT_DELAY_MS);
      } catch (error) {
        stats.errors++;
        console.error(`❌ Error completing game ${game.game_address}:`, error);
      }
    }

    this.logScanResults(stats);
    return stats;
  }

  public async runScanLoop(options: ScanLoopOptions = {}): Promise<ScanLoopSummary> {
    const {
      waitBetweenCyclesMs = DEFAULT_DELAY_MS,
      waitForPendingOnly = false,
      cleanupAfterCycleHours,
      shouldContinue,
      signal,
      onCycleStart,
      onCycleComplete,
    } = options;

    const totals: CompletionStats = createEmptyCompletionStats();
    let lastStats: CompletionStats | null = null;
    let cycle = 0;

    const shouldAbort = () => Boolean(signal?.aborted);

    const waitForNextCycle = async () => {
      if (waitBetweenCyclesMs <= 0) {
        return;
      }

      await delayHelper(waitBetweenCyclesMs, { signal });
    };

    while (!shouldAbort()) {
      cycle += 1;
      onCycleStart?.(cycle);

      const stats = await this.scanAndCompleteActiveGames();
      lastStats = stats;

      totals.completed += stats.completed;
      totals.errors += stats.errors;
      totals.notReady += stats.notReady;

      if (cleanupAfterCycleHours !== undefined) {
        this.cleanupOldRecords(cleanupAfterCycleHours);
      }

      onCycleComplete?.(cycle, stats);

      if (shouldAbort()) {
        break;
      }

      const continueLoop = shouldContinue
        ? shouldContinue(stats, cycle)
        : stats.completed > 0 || stats.notReady > 0;

      if (!continueLoop) {
        break;
      }

      if (waitBetweenCyclesMs > 0 && (!waitForPendingOnly || stats.notReady > 0)) {
        await waitForNextCycle();
      }
    }

    return {
      cycles: cycle,
      totalCompleted: totals.completed,
      totalErrors: totals.errors,
      totalNotReady: totals.notReady,
      lastStats,
    };
  }

  private logMissingSecret(gameAddress: string, requireOnChain: boolean): void {
    if (!requireOnChain) {
      return;
    }
    console.log(`⚠️  ${NO_SECRET_KEY_MESSAGE} for game ${gameAddress}`);
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
    const programId = ensurePublicKey(this.program.programId);
    const [pda] = PublicKey.findProgramAddressSync([GAME_SEED, randomHash], programId);
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
