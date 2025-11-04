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
import { logger } from "./logger.ts";
import {
  type AttemptGameCompletionOptions,
  type GameCompletionResult,
  type GameOnChainContext,
  type GameReadinessSnapshot,
  type GameSecrets,
  type GenerateGameSecretsOptions,
} from "./oracle-service.types.ts";
import type { PublicKeyLike } from "./solana-utils.ts";
import { coercePublicKey, confirmTransaction } from "./solana-utils.ts";
import { PlayerRegistrySync } from "./player-registry-sync.ts";
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
  private readonly registrySync: PlayerRegistrySync;
  public readonly readinessCache: Map<string, GameReadinessSnapshot>;
  public readonly tokenProgramCache: Map<string, PublicKey>;

  private constructor(db?: OracleDatabase, metrics?: OracleMetrics) {
    this.config = getConfig();
    this.db = db ?? OracleDatabase.getInstance();
    this.metrics = metrics ?? getOracleMetrics();
    this.connection = this.initConnection();
    this.adminKeypair = this.loadAdminKeypair();
    this.program = this.initProgram();
    this.registrySync = this.initPlayerRegistrySync();
    this.interGameDelayMs = this.config.scanThrottleMs;
    this.readinessCache = new Map();
    this.tokenProgramCache = new Map();

    this.completion = this.initCompletion();
    this.eventProcessor = this.initEventProcessor();
    this.scanner = this.initScanner();
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

  private initConnection(): anchor.web3.Connection {
    return new anchor.web3.Connection(this.config.solanaNetwork, "confirmed");
  }

  private initCompletion(): GameCompletionManager {
    return new GameCompletionManager({
      db: this.db,
      metrics: this.metrics,
      getConnection: () => this.connection,
      getProgram: () => this.program,
      adminKeypair: this.adminKeypair,
      readinessCache: this.readinessCache,
      tokenProgramCache: this.tokenProgramCache,
      secretKeyLength: SECRET_KEY_LENGTH,
      noSecretKeyMessage: NO_SECRET_KEY_MESSAGE,
      confirmTransaction: (signature) => confirmTransaction(this.connection, signature),
      recoverPlayerRegistry: async ({ context, expectedTickets }) =>
        this.registrySync.fetchPlayersFromChain({
          gamePda: context.gamePda,
          expectedTickets,
        }),
      markGameDesynced: (gameAddress) => this.db.markGameDesynced(gameAddress),
    });
  }

  private initEventProcessor(): OracleEventProcessor {
    return new OracleEventProcessor({
      getProgram: () => this.program,
      db: this.db,
      tryAutoComplete: (gameKey, gameAddress, trigger) =>
        this.tryAutoComplete(gameKey ?? this.ensureGameKey(gameAddress), gameAddress, trigger),
      config: EVENT_HANDLER_CONFIG,
      clearTokenProgramCache: () => this.completion.clearTokenProgramCache(),
      syncPlayerRegistry: (options) => this.syncPlayerRegistry(options),
    });
  }

  private initScanner(): ScanLoopRunner {
    return new ScanLoopRunner({
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

  private loadAdminKeypair(): anchor.web3.Keypair {
    const { adminKeypairPath, adminKeypairSource, useEphemeralKeypair } = this.config;
    const { keypair, error } = this.readAdminKeypairFromFile(adminKeypairPath);

    if (keypair) {
      this.logAdminKeypairLoaded(keypair);
      return keypair;
    }

    if (useEphemeralKeypair && this.isMissingFileError(error)) {
      return this.createEphemeralAdminKeypair(adminKeypairSource);
    }

    this.logAdminKeypairFailure(adminKeypairPath, error);
    throw new Error(`Failed to load admin keypair from ${adminKeypairSource}`);
  }

  private readAdminKeypairFromFile(
    path: string,
  ): { keypair?: anchor.web3.Keypair; error?: unknown } {
    try {
      const content = fs.readFileSync(path, "utf-8");
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) {
        throw new Error("Admin keypair file must contain an array of numbers");
      }
      const keypair = anchor.web3.Keypair.fromSecretKey(new Uint8Array(parsed));
      return { keypair };
    } catch (error: unknown) {
      return { error };
    }
  }

  private isMissingFileError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }

    const code = "code" in error ? (error as { code?: string }).code : undefined;
    if (code === "ENOENT") {
      return true;
    }

    const message = "message" in error ? (error as { message?: unknown }).message : undefined;
    return typeof message === "string" && message.includes("ENOENT");
  }

  private createEphemeralAdminKeypair(missingSource: string): anchor.web3.Keypair {
    const keypair = anchor.web3.Keypair.generate();
    logger.warning(
      `Using ephemeral admin keypair ${keypair.publicKey.toBase58()} because ${missingSource} was not found.`,
    );
    return keypair;
  }

  private logAdminKeypairLoaded(keypair: anchor.web3.Keypair): void {
    logger.success(`Loaded admin keypair: ${keypair.publicKey.toBase58()}`);
  }

  private logAdminKeypairFailure(path: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    logger.failure(`Failed to load admin keypair from ${path}:`, message);
  }

  private initProgram(): anchor.Program<Timba> {
    const adminWallet = new anchor.Wallet(this.adminKeypair);
    const provider = new anchor.AnchorProvider(
      this.connection,
      adminWallet,
      { commitment: "confirmed" },
    );
    anchor.setProvider(provider);
    return new anchor.Program(idl as Timba, provider) as anchor.Program<Timba>;
  }

  private initPlayerRegistrySync(): PlayerRegistrySync {
    return new PlayerRegistrySync({
      connection: this.connection,
      program: this.program,
    });
  }

  private async syncPlayerRegistry(options: {
    gameAddress: string;
    expectedTickets?: number;
    trigger: string;
    gameKey?: PublicKeyLike;
  }): Promise<boolean> {
    let gamePda = options.gameKey ? coercePublicKey(options.gameKey) : null;

    if (!gamePda) {
      const stored = this.completion.resolveStoredGame(options.gameAddress);
      gamePda = stored?.gamePda ?? null;
    }

    if (!gamePda) {
      logger.warn(
        `⚠️  Unable to reconcile players for ${options.gameAddress}; missing game PDA after ${options.trigger}`,
      );
      return false;
    }

    try {
      const players = await this.registrySync.fetchPlayersFromChain({
        gamePda,
        expectedTickets: options.expectedTickets,
      });

      if (!players) {
        return false;
      }

      this.db.replaceGamePlayers(options.gameAddress, players);
      logger.info(
        `♻️  Synchronized ${players.length} players for ${options.gameAddress} after ${options.trigger}`,
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.failure(
        `Failed to synchronize players for ${options.gameAddress}: ${message}`,
      );
      return false;
    }
  }

  public async startEventListening(): Promise<void> {
    if (this.eventProcessor.isListening()) return;

    try {
      await this.eventProcessor.startListening();
    } catch (error) {
      logger.failure(EVENT_LISTENER_FAILURE_MESSAGE, error);
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
    try {
      this.db.trackGame(gameAddress, options.gameType);
    } catch (error) {
      this.db.deleteSecretKey(gameAddress);
      throw error;
    }

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
    const complete = this.completeGame.bind(this);

    return this.completion.attemptGameCompletion(options, {
      completeGame: complete,
    });
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
