import { address, type Address, type KeyPairSigner } from "@solana/kit";
import { randomBytes, createHash } from "crypto";
import * as fs from "fs";
import {
  OracleDatabase,
  type ResetCompletionAttemptsResult,
  type ToggleAutoCompleteResult,
} from "./database.ts";
import { getConfig, type OracleRuntimeConfig } from "./config.ts";
import { getOracleMetrics, type OracleMetrics } from "./metrics.ts";
import { OracleEventProcessor, EVENT_HANDLER_CONFIG } from "./oracle-event-processor.ts";
import { GameCompletionManager } from "./oracle-completion-manager.ts";
import { ScanLoopRunner } from "./oracle-scan-runner.ts";
import { logger } from "./logger.ts";

import { RpcEndpointManager } from "./rpc-endpoints.ts";
import {
  type AttemptGameCompletionOptions,
  type GameCompletionResult,
  type GameOnChainContext,
  type GameReadinessSnapshot,
  type GameSecrets,
  type GenerateGameSecretsOptions,
} from "./oracle-service.types.ts";
import type { PublicKeyLike } from "./solana-utils.ts";
import { coerceAddress, confirmTransaction, ensureAddress } from "./solana-utils.ts";
import { PlayerRegistrySync } from "./player-registry-sync.ts";
import type { OracleRpc } from "./solana-kit.ts";
import { createSyncSigner, generateSyncSigner } from "./solana-kit.ts";
import { TimbaProgramClient } from "./timba-program-client.ts";
import {
  signGameTransactionWithPolicy,
  TransactionPolicyError,
} from "./game-transaction-signer.ts";
import {
  computeMinimumAmountRaw,
  normalizeMint,
  toApiTokenPolicy,
  type CreationPolicyRejectionCode,
  type StoredTokenPolicy,
  type TokenPolicy,
} from "./token-policy.ts";
import { JupiterTokenPriceResolver, type TokenPriceResolver } from "./token-price.ts";
import { createRestClient } from "@timbagame/protocol/common";
import { botContract } from "@timbagame/protocol/bot";
import { prepareGameToken } from "./token-onboarding.ts";

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

export type RequeueGameFailureReason =
  "invalid-address" | "missing-secret" | "not-found" | "finalized" | "unchanged";

export type RequeueGameResult =
  { success: true } | { success: false; reason: RequeueGameFailureReason };

/** A client-supplied transaction failed the oracle's signing policy. */
export class GameTransactionValidationError extends Error {
  public override readonly name: string = "GameTransactionValidationError";
}

/** A valid initialize-game transaction was rejected by the current creation policy. */
export class CreationPolicyValidationError extends GameTransactionValidationError {
  public override readonly name = "CreationPolicyValidationError";

  public constructor(
    public readonly code: CreationPolicyRejectionCode,
    message: string,
    public readonly details: {
      mint?: string;
      minimumAmountRaw?: string;
      acceptedMinimumAmountRaw?: string;
      revision?: number;
    } = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class OracleService {
  private static instance: OracleService;
  public static readonly EVENT_HANDLER_CONFIG = EVENT_HANDLER_CONFIG;

  private readonly config: OracleRuntimeConfig;
  private readonly db: OracleDatabase;
  private readonly metrics: OracleMetrics;
  private readonly connection: OracleRpc;
  private readonly rpcEndpointManager: RpcEndpointManager;
  private readonly operatorKeypair: KeyPairSigner;
  private readonly program: TimbaProgramClient;
  private readonly interGameDelayMs: number;
  private readonly eventProcessor: OracleEventProcessor;
  private readonly completion: GameCompletionManager;
  private readonly scanner: ScanLoopRunner;
  private readonly registrySync: PlayerRegistrySync;
  private readonly tokenPriceResolver: TokenPriceResolver;
  public readonly readinessCache: Map<string, GameReadinessSnapshot>;

  private constructor(
    db?: OracleDatabase,
    metrics?: OracleMetrics,
    tokenPriceResolver?: TokenPriceResolver,
  ) {
    this.config = getConfig();
    this.db = db ?? OracleDatabase.getInstance();
    this.metrics = metrics ?? getOracleMetrics();
    this.rpcEndpointManager = this.initRpcEndpointManager();
    this.connection = this.rpcEndpointManager.getConnection();
    this.tokenPriceResolver =
      tokenPriceResolver ?? new JupiterTokenPriceResolver(this.config.jupiterApiKey);
    this.operatorKeypair = this.loadOperatorKeypair();
    this.program = this.initProgram();
    this.registrySync = this.initPlayerRegistrySync();
    this.interGameDelayMs = this.config.scanThrottleMs;
    this.readinessCache = new Map();

    this.completion = this.initCompletion();
    this.eventProcessor = this.initEventProcessor();
    this.registerRpcEndpointFailoverListener();
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
    options: { metrics?: OracleMetrics; tokenPriceResolver?: TokenPriceResolver } = {},
  ): OracleService {
    return new OracleService(db, options.metrics, options.tokenPriceResolver);
  }

  public getConnection(): OracleRpc {
    return this.connection;
  }

  public getProgramId(): Address {
    return this.program.programId;
  }

  private initRpcEndpointManager(): RpcEndpointManager {
    return new RpcEndpointManager(this.config.solanaNetworks, {
      commitment: "confirmed",
      logger: {
        info: (...args: unknown[]) => logger.info(...args),
        warn: (...args: unknown[]) => logger.warn(...args),
        error: (...args: unknown[]) => logger.error(...args),
      },
    });
  }

  private initCompletion(): GameCompletionManager {
    return new GameCompletionManager({
      contractVersion: this.config.contractVersion,
      db: this.db,
      metrics: this.metrics,
      getConnection: () => this.connection,
      getProgram: () => this.program,
      operatorKeypair: this.operatorKeypair,
      readinessCache: this.readinessCache,
      secretKeyLength: SECRET_KEY_LENGTH,
      noSecretKeyMessage: NO_SECRET_KEY_MESSAGE,
      confirmTransaction: (signature, latestBlockhash) =>
        confirmTransaction(this.connection, signature, latestBlockhash),
      recoverPlayerRegistry: async ({ context, expectedTickets }) =>
        this.registrySync.fetchPlayersFromChain({
          gamePda: ensureAddress(context.gamePda),
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
      config:
        this.config.contractVersion === "0.2.0"
          ? EVENT_HANDLER_CONFIG.filter(({ event }) => event !== "operatorGameClosed")
          : EVENT_HANDLER_CONFIG,
      syncPlayerRegistry: (options) => this.syncPlayerRegistry(options),
      onGameFinalized: (gameAddress) => this.completion.resetRegistryPrefetchSchedule(gameAddress),
      playerEventFlushDebounceMs: this.config.playerEventFlushDebounceMs,
      playerEventFlushMaxOperations: this.config.playerEventFlushMaxOperations,
      autoCompleteDebounceMs: this.config.autoCompleteDebounceMs,
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

  private registerRpcEndpointFailoverListener(): void {
    this.rpcEndpointManager.onActiveEndpointChange(async ({ endpoint, previousEndpoint }) => {
      if (!this.eventProcessor.isListening()) {
        return;
      }

      logger.warning(
        `RPC endpoint changed from ${previousEndpoint} to ${endpoint}; restarting event listeners.`,
      );

      await this.restartEventListenersWithRetries(endpoint);
    });
  }

  private async restartEventListenersWithRetries(endpoint: string): Promise<void> {
    const maxAttempts = 3;
    const baseDelayMs = 250;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await this.stopEventListenersSafely();

      try {
        await this.eventProcessor.startListening();
        logger.info(`Re-subscribed event listeners on ${endpoint}`);
        return;
      } catch (error) {
        lastError = error;
        this.eventProcessor.clearRegistrySyncs();
        const message = error instanceof Error ? error.message : String(error);

        if (attempt < maxAttempts - 1) {
          const delayMs = baseDelayMs * (attempt + 1);
          logger.warning(
            `Failed to restart event listeners on ${endpoint} (attempt ${attempt + 1}/${maxAttempts}): ${message}. Retrying in ${delayMs}ms.`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        logger.failure(
          `Failed to restart event listeners after switching to ${endpoint}: ${message}`,
        );
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error(String(lastError ?? "Unknown restart failure"));
  }

  private async stopEventListenersSafely(): Promise<void> {
    try {
      await this.eventProcessor.stopListening();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to stop event listeners before RPC restart: ${message}`);
    }
  }

  private loadOperatorKeypair(): KeyPairSigner {
    const { operatorKeypairPath, operatorKeypairSource, useEphemeralKeypair } = this.config;
    const { keypair, error } = this.readOperatorKeypairFromFile(operatorKeypairPath);

    if (keypair) {
      this.logOperatorKeypairLoaded(keypair);
      return keypair;
    }

    if (useEphemeralKeypair && error) {
      const reason = this.describeOperatorKeypairError(operatorKeypairSource, error);
      return this.createEphemeralOperatorKeypair(operatorKeypairSource, reason);
    }

    const details = error
      ? this.describeOperatorKeypairError(operatorKeypairSource, error)
      : `Failed to load operator keypair from ${operatorKeypairSource}`;

    this.logOperatorKeypairFailure(operatorKeypairPath, error);
    throw new Error(details);
  }

  private readOperatorKeypairFromFile(path: string): {
    keypair?: KeyPairSigner;
    error?: unknown;
  } {
    try {
      const stats = fs.statSync(path);
      const mode = stats.mode & 0o777;
      if ((mode & 0o077) !== 0) {
        throw new Error(
          `Operator keypair file ${path} has insecure permissions (${mode.toString(8)}). It must be accessible only by the owner (e.g. 600).`,
        );
      }

      const content = fs.readFileSync(path, "utf-8");
      const parsed: unknown = JSON.parse(content);
      if (!Array.isArray(parsed)) {
        throw new Error("Operator keypair file must contain an array of numbers");
      }

      const numbers = parsed.map((value) => {
        if (typeof value !== "number" || !Number.isInteger(value)) {
          throw new Error("Operator keypair file must contain integer byte values");
        }
        if (value < 0 || value > 255) {
          throw new Error("Operator keypair file contains byte values outside the 0-255 range");
        }
        return value;
      });

      const keypair = createSyncSigner(new Uint8Array(numbers));
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

  private isPermissionError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }

    const code = "code" in error ? (error as { code?: string }).code : undefined;
    if (code === "EACCES" || code === "EPERM") {
      return true;
    }

    const message = "message" in error ? (error as { message?: unknown }).message : undefined;
    return typeof message === "string" && /permission denied/i.test(message);
  }

  private describeOperatorKeypairError(source: string, error: unknown): string {
    if (this.isMissingFileError(error)) {
      return `${source} was not found.`;
    }

    if (this.isPermissionError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      return `${source} could not be read: ${message}`;
    }

    const message = error instanceof Error ? error.message : String(error);
    return `${source} could not be loaded: ${message}`;
  }

  private createEphemeralOperatorKeypair(source: string, reason?: string): KeyPairSigner {
    const keypair = generateSyncSigner();
    logger.warning(
      `Using ephemeral operator keypair ${keypair.address} because ${reason ?? `${source} was not found.`}`,
    );
    return keypair;
  }

  private logOperatorKeypairLoaded(keypair: KeyPairSigner): void {
    logger.success(`Loaded operator keypair: ${keypair.address}`);
  }

  private logOperatorKeypairFailure(path: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    logger.failure(`Failed to load operator keypair from ${path}:`, message);
  }

  private initProgram(): TimbaProgramClient {
    logger.info(`Using Timba contract ABI ${this.config.contractVersion}`);
    return new TimbaProgramClient(this.connection, this.config.contractVersion, () =>
      this.rpcEndpointManager.getActiveEndpoint(),
    );
  }

  private initPlayerRegistrySync(): PlayerRegistrySync {
    return new PlayerRegistrySync({
      connection: this.connection,
      programId: this.program.programId,
    });
  }

  private async syncPlayerRegistry(options: {
    gameAddress: string;
    expectedTickets?: number;
    trigger: string;
    gameKey?: PublicKeyLike;
  }): Promise<boolean> {
    let gamePda = options.gameKey ? coerceAddress(options.gameKey) : null;

    if (!gamePda) {
      const stored = await this.completion.resolveStoredGame(options.gameAddress);
      gamePda = stored ? coerceAddress(stored.gamePda) : null;
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
      logger.failure(`Failed to synchronize players for ${options.gameAddress}: ${message}`);
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

  public addProgramEventObserver(observer: () => void): () => void {
    return this.eventProcessor.addProgramEventObserver(observer);
  }

  public async close(): Promise<void> {
    await this.stopEventListening();
    this.scanner.stop();
    this.db.close();
  }

  public async generateGameSecrets(options: GenerateGameSecretsOptions = {}): Promise<GameSecrets> {
    const secretKey = randomBytes(SECRET_KEY_LENGTH);
    const randomHash = createHash("sha256").update(secretKey).digest();
    const gameAddress = await this.completion.getGamePDA(randomHash);

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
      oracleOperator: this.operatorKeypair.address,
    };
  }

  public async signGameTransaction(txBase64: string): Promise<string> {
    if (!txBase64 || txBase64.length > 4_000) {
      throw new GameTransactionValidationError("Invalid transaction payload");
    }
    try {
      return await signGameTransactionWithPolicy(txBase64, {
        contractVersion: this.config.contractVersion,
        programId: this.program.programId,
        operator: this.operatorKeypair,
        getGamePda: async (randomHash) => this.completion.getGamePDA(Buffer.from(randomHash)),
        assertCreationPolicy: (tokenMint, amount) => this.assertCreationPolicy(tokenMint, amount),
        assertUnusedCommitment: (gameAddress, randomHashHex) => {
          const secret = this.db.getSecretKeyInfo(gameAddress);
          if (!secret || secret.used || secret.randomHash !== randomHashHex) {
            throw new TransactionPolicyError("Random hash is not an unused oracle commitment");
          }
        },
        markCommitmentSigned: (gameAddress) => this.db.markSecretKeySigned(gameAddress),
      });
    } catch (error) {
      if (error instanceof CreationPolicyValidationError) throw error;
      if (error instanceof TransactionPolicyError) {
        throw new GameTransactionValidationError(error.message, { cause: error });
      }
      throw new GameTransactionValidationError("Transaction could not be signed", {
        cause: error,
      });
    }
  }

  private async resolveTokenPolicy(policy: StoredTokenPolicy): Promise<TokenPolicy> {
    if (!policy.enabled) return toApiTokenPolicy(policy, 0n);
    const prices = await this.tokenPriceResolver.getTokenUsdPrices([policy.mint]);
    const priceUsd = prices.get(policy.mint);
    if (priceUsd === undefined) throw new Error(`Token price is unavailable for ${policy.mint}`);
    return toApiTokenPolicy(policy, computeMinimumAmountRaw(priceUsd, policy.decimals));
  }

  private async assertCreationPolicy(tokenMint: Address, amount: bigint): Promise<void> {
    const mint = tokenMint;
    let policy;
    try {
      policy = this.db.getTokenPolicy(mint);
    } catch (error) {
      throw new CreationPolicyValidationError(
        "policy_unavailable",
        "Token creation policy is unavailable",
        { mint },
        { cause: error },
      );
    }

    if (!policy) {
      throw new CreationPolicyValidationError("unsupported_mint", "Token mint is not supported", {
        mint,
      });
    }
    if (!policy.enabled) {
      throw new CreationPolicyValidationError("token_disabled", "Token mint is disabled", {
        mint,
        revision: policy.revision,
      });
    }
    let resolved: TokenPolicy;
    try {
      resolved = await this.resolveTokenPolicy(policy);
    } catch (error) {
      throw new CreationPolicyValidationError(
        "policy_unavailable",
        "Token creation policy is unavailable",
        { mint, revision: policy.revision },
        { cause: error },
      );
    }
    if (amount < BigInt(resolved.acceptedMinimumAmountRaw)) {
      throw new CreationPolicyValidationError(
        "amount_below_minimum",
        "Game amount is below the token minimum",
        {
          mint,
          minimumAmountRaw: resolved.minimumAmountRaw,
          acceptedMinimumAmountRaw: resolved.acceptedMinimumAmountRaw,
          revision: policy.revision,
        },
      );
    }
  }

  public async getTokenPolicies(): Promise<TokenPolicy[]> {
    const policies = this.db.getTokenPolicies();
    const enabled = policies.filter((policy) => policy.enabled);
    let prices: Map<string, number>;
    try {
      prices = await this.tokenPriceResolver.getTokenUsdPrices(
        enabled.map((policy) => policy.mint),
        { allowPartial: true },
      );
    } catch (error) {
      throw new Error("Token prices are unavailable", { cause: error });
    }
    return policies.flatMap((policy) => {
      if (!policy.enabled) return [toApiTokenPolicy(policy, 0n)];
      const priceUsd = prices.get(policy.mint);
      if (priceUsd === undefined) {
        logger.warning(`Omitting token policy without a current price: ${policy.mint}`);
        return [];
      }
      return [toApiTokenPolicy(policy, computeMinimumAmountRaw(priceUsd, policy.decimals))];
    });
  }

  public async setTokenPolicy(mint: string, enabled: boolean): Promise<TokenPolicy> {
    const normalizedMint = normalizeMint(mint);
    const existingPolicy = this.db.getTokenPolicy(normalizedMint);
    let normalizedDecimals = existingPolicy?.decimals ?? 0;
    let minimumAmountRaw = 0n;
    if (enabled) {
      const prices = await this.tokenPriceResolver.getTokenUsdPrices([normalizedMint]);
      const priceUsd = prices.get(normalizedMint);
      if (priceUsd === undefined)
        throw new Error(`Token price is unavailable for ${normalizedMint}`);
      const prepared = await prepareGameToken({
        connection: this.connection,
        operatorKeypair: this.operatorKeypair,
        mint: address(normalizedMint),
      });
      normalizedDecimals = prepared.decimals;
      minimumAmountRaw = computeMinimumAmountRaw(priceUsd, normalizedDecimals);
    }

    const policy = this.db.setTokenPolicy(normalizedMint, enabled, normalizedDecimals);
    return toApiTokenPolicy(policy, minimumAmountRaw);
  }

  public async completeGame(
    gameAddress: string,
    cachedReadiness?: GameReadinessSnapshot,
    sharedContext?: GameOnChainContext,
  ): Promise<GameCompletionResult> {
    return this.completion.completeGame(gameAddress, cachedReadiness, sharedContext);
  }

  public async completeGameNow(gameAddress: string): Promise<GameCompletionResult | null> {
    const normalized = gameAddress.trim();
    if (!normalized) {
      return {
        success: false,
        error: "gameAddress is required",
      };
    }

    return this.attemptGameCompletion({
      gameAddress: normalized,
      gameKey: this.ensureGameKey(normalized),
      successLog: () => `🎯 Completed game ${normalized} after bot wake-up`,
      failureLog: (_address, error) =>
        `❌ Bot-triggered completion failed: ${error ?? "Unknown error"}`,
    });
  }

  public requeueGame(gameAddress: string): RequeueGameResult {
    const normalized = gameAddress.trim();
    if (!normalized) {
      return { success: false, reason: "invalid-address" };
    }

    const status = this.db.getGameStatus(normalized);
    if (!status) {
      return { success: false, reason: "not-found" };
    }

    const isPendingState = status === "pending" || status === "desynced";
    const isFinalizedState = status === "completed" || status === "cancelled";

    if (!isPendingState && !isFinalizedState) {
      return { success: false, reason: "finalized" };
    }

    let secret = this.db.getSecretKey(normalized);
    let reactivatedSecret = false;

    if (!secret) {
      reactivatedSecret = this.db.reactivateSecretKey(normalized) || reactivatedSecret;
      if (reactivatedSecret) {
        secret = this.db.getSecretKey(normalized);
      }
    }

    if (!secret) {
      return { success: false, reason: "missing-secret" };
    }

    const resetResult = this.db.resetCompletionAttempts(normalized, {
      allowFinalized: isFinalizedState,
    });
    if (!resetResult.success) {
      if (reactivatedSecret) {
        this.db.markSecretKeyUsed(normalized);
      }
      return { success: false, reason: this.mapResetFailure(resetResult) };
    }

    this.readinessCache.delete(normalized);
    return { success: true };
  }

  public setAutoCompleteDisabled(gameAddress: string, disabled: boolean): ToggleAutoCompleteResult {
    const result = this.db.setAutoCompleteDisabled(gameAddress, disabled);
    if (result.success) {
      this.readinessCache.delete(gameAddress.trim());
    }
    return result;
  }

  private async tryAutoComplete(
    gameKey: PublicKeyLike,
    gameAddress: string,
    trigger: string,
  ): Promise<void> {
    const autoCompleteDisabled = this.db.isAutoCompleteDisabled(gameAddress);
    if (autoCompleteDisabled) {
      logger.info(
        `Skipping auto-complete for ${gameAddress} after ${trigger} (auto-complete disabled)`,
      );
      return;
    }

    await this.attemptGameCompletion({
      gameAddress,
      gameKey,
      successLog: () => `🎯 Auto-completed game ${gameAddress} after ${trigger}`,
      failureLog: (_address, error) => `❌ Auto-completion failed: ${error ?? "Unknown error"}`,
    });
  }

  private ensureGameKey(gameAddress: string): PublicKeyLike {
    return ensureAddress(gameAddress);
  }

  private async attemptGameCompletion(
    options: AttemptGameCompletionOptions,
  ): Promise<GameCompletionResult | null> {
    const complete = this.completeGame.bind(this);

    return this.completion.attemptGameCompletion(
      {
        ...options,
        onResult: (result) => {
          if (result.success && result.winnerAddress) {
            this.notifyBotOfCompletion(options.gameAddress, result).catch((error) => {
              logger.warning("Failed to notify bot of completion:", error);
            });
          }
        },
      },
      {
        completeGame: complete,
      },
    );
  }

  private async notifyBotOfCompletion(
    gameAddress: string,
    result: GameCompletionResult,
  ): Promise<void> {
    const botUrl = getConfig().botInternalUrl;
    if (!botUrl) {
      return;
    }
    if (!result.winnerAddress || !result.txHash || result.totalPot === undefined) {
      throw new Error("Completed game result is missing notification data");
    }

    const response = await createRestClient(botContract, { baseUrl: botUrl }).completedGame({
      body: {
        gameAddress,
        winnerAddress: result.winnerAddress,
        winnerTxSignature: result.txHash,
        totalPot: result.totalPot,
      },
    });

    if (response.status !== 200) {
      logger.warning(`Bot notification failed (${response.status}): ${response.data.error}`);
      return;
    }
  }

  private mapResetFailure(
    result: ResetCompletionAttemptsResult & { success: false },
  ): RequeueGameFailureReason {
    switch (result.reason) {
      case "not-found":
        return "not-found";
      case "finalized":
        return "finalized";
      case "unchanged":
      default:
        return "unchanged";
    }
  }

  public cleanupOldRecords(hoursOld: number = 48) {
    const result = this.db.cleanupOldRecords(hoursOld);
    const deletedUnsignedCommitments = hoursOld > 0 ? this.db.cleanupUnsignedCommitments(10) : 0;
    result.deletedSecrets += deletedUnsignedCommitments;
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
