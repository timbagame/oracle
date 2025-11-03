import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { randomBytes, createHash } from "crypto";
import * as fs from "fs";
import { OracleDatabase } from "./database.ts";
import { getConfig, type OracleRuntimeConfig } from "./config.ts";
import { getOracleMetrics, type OracleMetrics } from "./metrics.ts";
import { OracleEventProcessor, EVENT_HANDLER_CONFIG } from "./oracle-event-processor.ts";
import { GameCompletionManager } from "./oracle-completion-manager.ts";
import { ScanLoopRunner } from "./oracle-scan-runner.ts";
import {
  type AttemptGameCompletionOptions,
  type GameCompletionResult,
  type GameOnChainContext,
  type GameReadinessSnapshot,
  type GameSecrets,
  type GenerateGameSecretsOptions,
} from "./oracle-service.types.ts";
import type { PublicKeyLike } from "./solana-utils.ts";
import type { Timba } from "./idl/idlType.ts";
import idl from "./idl/idl.json" with { type: "json" };

export { deriveGameAccounts, type DerivedGameAccounts } from "./oracle-accounts.ts";
export {
  createEmptyCompletionStats,
  type CompletionStats,
  type ScanLoopOptions,
  type ScanLoopSummary,
} from "./oracle-service.types.ts";

const SECRET_KEY_LENGTH = 32;
const MAX_COMPLETION_ATTEMPTS = 5;
export const EVENT_LISTENER_FAILURE_MESSAGE = "❌ Failed to start event listeners:";
const NO_SECRET_KEY_MESSAGE = "No secret key found";

export class OracleService {
  private static instance: OracleService;
  public static readonly EVENT_HANDLER_CONFIG = EVENT_HANDLER_CONFIG;

  private readonly config: OracleRuntimeConfig;
  private readonly db: OracleDatabase;
  private readonly metrics: OracleMetrics;
  private readonly connection: anchor.web3.Connection;
  private readonly adminKeypair: anchor.web3.Keypair;
  private readonly program: anchor.Program<Timba>;
  private readonly interGameDelayMs: number;
  private readonly eventProcessor: OracleEventProcessor;
  private readonly completion: GameCompletionManager;
  private readonly scanner: ScanLoopRunner;
  public readonly readinessCache: Map<string, GameReadinessSnapshot>;
  public readonly tokenProgramCache: Map<string, PublicKey>;

  private constructor(db?: OracleDatabase, metrics?: OracleMetrics) {
    this.config = getConfig();
    this.db = db ?? OracleDatabase.getInstance();
    this.metrics = metrics ?? getOracleMetrics();
    this.connection = this.initializeConnection();
    this.adminKeypair = this.loadAdminKeypair();
    this.program = this.initializeProgram();
    this.interGameDelayMs = this.config.scanThrottleMs;
    this.readinessCache = new Map();
    this.tokenProgramCache = new Map();

    this.completion = new GameCompletionManager({
      db: this.db,
      metrics: this.metrics,
      getConnection: () => this.connection,
      getProgram: () => this.program,
      adminKeypair: this.adminKeypair,
      readinessCache: this.readinessCache,
      tokenProgramCache: this.tokenProgramCache,
      secretKeyLength: SECRET_KEY_LENGTH,
      noSecretKeyMessage: NO_SECRET_KEY_MESSAGE,
      confirmTransaction: (signature) => this.confirmTransaction(signature),
    });

    this.eventProcessor = new OracleEventProcessor({
      getProgram: () => this.program,
      db: this.db,
      tryAutoComplete: (gameKey, gameAddress, trigger) =>
        this.tryAutoComplete(gameKey ?? this.ensureGameKey(gameAddress), gameAddress, trigger),
      config: EVENT_HANDLER_CONFIG,
      clearTokenProgramCache: () => this.completion.clearTokenProgramCache(),
    });

    this.scanner = new ScanLoopRunner({
      db: this.db,
      metrics: this.metrics,
      completion: {
        resolveContextAndReadiness: (address, options) =>
          this.completion.resolveContextAndReadiness(address, options),
        attemptGameCompletion: (options) => this.attemptGameCompletion(options),
        consumeReadiness: (address) => this.completion.consumeReadiness(address),
        getBlockchainTime: () => this.completion.getBlockchainTime(),
      },
      interGameDelayMs: this.interGameDelayMs,
      maxCompletionAttempts: MAX_COMPLETION_ATTEMPTS,
      cleanupOldRecords: (hours) => this.cleanupOldRecords(hours),
    });
  }

  public static getInstance(): OracleService {
    if (!OracleService.instance) {
      OracleService.instance = new OracleService();
    }
    return OracleService.instance;
  }

  public static createWith(
    db: OracleDatabase,
    options: { metrics?: OracleMetrics } = {},
  ): OracleService {
    return new OracleService(db, options.metrics);
  }

  private initializeConnection(): anchor.web3.Connection {
    return new anchor.web3.Connection(this.config.solanaNetwork, "confirmed");
  }

  private loadAdminKeypair(): anchor.web3.Keypair {
    const { adminKeypairPath, adminKeypairSource, useEphemeralKeypair } = this.config;
    try {
      const keypairData = JSON.parse(fs.readFileSync(adminKeypairPath, "utf-8"));
      const keypair = anchor.web3.Keypair.fromSecretKey(new Uint8Array(keypairData));
      console.log(`✅ Loaded admin keypair: ${keypair.publicKey.toBase58()}`);
      return keypair;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const isMissingFile =
        typeof error === "object" &&
        error !== null &&
        (("code" in error && (error as { code?: string }).code === "ENOENT") ||
          ("message" in error && typeof (error as { message?: unknown }).message === "string" &&
            (error as { message: string }).message.includes("ENOENT")));

      if (isMissingFile && useEphemeralKeypair) {
        const keypair = anchor.web3.Keypair.generate();
        console.warn(
          `⚠️  Using ephemeral admin keypair ${keypair.publicKey.toBase58()} because ${adminKeypairSource} was not found.`,
        );
        return keypair;
      }

      console.error(`❌ Failed to load admin keypair from ${adminKeypairPath}:`, message);
      throw new Error(`Failed to load admin keypair from ${adminKeypairSource}`);
    }
  }

  private initializeProgram(): anchor.Program<Timba> {
    const adminWallet = new anchor.Wallet(this.adminKeypair);
    const provider = new anchor.AnchorProvider(
      this.connection,
      adminWallet,
      { commitment: "confirmed" },
    );
    anchor.setProvider(provider);
    return new anchor.Program(idl as Timba, provider) as anchor.Program<Timba>;
  }

  public async startEventListening(): Promise<void> {
    if (this.eventProcessor.isListening()) return;

    try {
      await this.eventProcessor.startListening();
    } catch (error) {
      console.error(EVENT_LISTENER_FAILURE_MESSAGE, error);
      throw error;
    }
  }

  public async stopEventListening(): Promise<void> {
    if (!this.eventProcessor.isListening()) return;
    await this.eventProcessor.stopListening();
  }

  public generateGameSecrets(
    options: GenerateGameSecretsOptions = {},
  ): GameSecrets {
    const secretKey = randomBytes(SECRET_KEY_LENGTH);
    const randomHash = createHash("sha256").update(secretKey).digest();
    const gamePda = this.completion.getGamePDA(randomHash);
    const gameAddress = gamePda.toBase58();

    this.db.saveSecretKey(gameAddress, secretKey.toString("hex"), randomHash.toString("hex"));
    this.db.trackGame(gameAddress, options.gameType);

    return {
      randomHash: randomHash.toString("hex"),
      gameAddress,
    };
  }

  public async completeGame(
    gameAddress: string,
    cachedReadiness?: GameReadinessSnapshot,
    sharedContext?: GameOnChainContext,
  ): Promise<GameCompletionResult> {
    return this.completion.completeGame(gameAddress, cachedReadiness, sharedContext);
  }

  private async tryAutoComplete(
    gameKey: PublicKeyLike,
    gameAddress: string,
    trigger: string,
  ): Promise<void> {
    await this.attemptGameCompletion({
      gameAddress,
      gameKey,
      successLog: () => `🎯 Auto-completed game ${gameAddress} after ${trigger}`,
      failureLog: (_address, error) =>
        `❌ Auto-completion failed: ${error ?? "Unknown error"}`,
    });
  }

  private ensureGameKey(gameAddress: string): PublicKeyLike {
    return new PublicKey(gameAddress);
  }

  private async attemptGameCompletion(
    options: AttemptGameCompletionOptions,
  ): Promise<GameCompletionResult | null> {
    const completeOverride =
      this.completeGame === OracleService.prototype.completeGame
        ? undefined
        : (gameAddress: string, readiness?: GameReadinessSnapshot, sharedContext?: GameOnChainContext) =>
            (this.completeGame as (
              address: string,
              readiness?: GameReadinessSnapshot,
              context?: GameOnChainContext,
            ) => Promise<GameCompletionResult>)(gameAddress, readiness, sharedContext);

    return this.completion.attemptGameCompletion(options, {
      completeGame: completeOverride,
    });
  }

  public async confirmTransaction(signature: string): Promise<void> {
    const connection = this.connection as anchor.web3.Connection & {
      confirmTransaction?: (...args: any[]) => unknown;
      getLatestBlockhash?: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
    };

    if (this.supportsModernConfirmation(connection)) {
      await this.confirmTransactionModern(connection, signature);
      return;
    }

    if (this.supportsLegacyConfirmation(connection)) {
      await this.confirmTransactionLegacy(connection, signature);
      return;
    }

    throw new Error("Connection does not support transaction confirmation");
  }

  private supportsModernConfirmation(
    connection: anchor.web3.Connection & {
      confirmTransaction?: (...args: any[]) => unknown;
      getLatestBlockhash?: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
    }
  ): boolean {
    return (
      typeof connection.getLatestBlockhash === "function" &&
      typeof connection.confirmTransaction === "function"
    );
  }

  private supportsLegacyConfirmation(
    connection: anchor.web3.Connection & {
      confirmTransaction?: (...args: any[]) => unknown;
    }
  ): boolean {
    return typeof connection.confirmTransaction === "function";
  }

  private async confirmTransactionModern(
    connection: anchor.web3.Connection & {
      confirmTransaction: (...args: any[]) => unknown;
      getLatestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
    },
    signature: string
  ): Promise<void> {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const result = connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    });
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      await result;
    }
  }

  private async confirmTransactionLegacy(
    connection: anchor.web3.Connection & {
      confirmTransaction: (...args: any[]) => unknown;
    },
    signature: string
  ): Promise<void> {
    const legacyResult = connection.confirmTransaction(signature as any);
    if (legacyResult && typeof (legacyResult as PromiseLike<unknown>).then === "function") {
      await legacyResult;
    }
  }

  public cleanupOldRecords(hoursOld: number = 48) {
    const result = this.db.cleanupOldRecords(hoursOld);
    this.metrics.recordCleanupSweep({
      hoursOld,
      deletedSecrets: result.deletedSecrets,
      deletedGames: result.deletedGames,
      deletedPlayers: result.deletedPlayers,
    });
    return result;
  }

  public getStats() {
    return {
      ...this.db.getStats(),
      eventListening: this.eventProcessor.isListening(),
      activeListeners: this.eventProcessor.getActiveListenerCount(),
    };
  }

  public get completionManager(): GameCompletionManager {
    return this.completion;
  }

  public get scanRunner(): ScanLoopRunner {
    return this.scanner;
  }

  public get events(): OracleEventProcessor {
    return this.eventProcessor;
  }
}
