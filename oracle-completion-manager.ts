import {
  appendTransactionMessageInstruction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  isSolanaError,
  SOLANA_ERROR__ACCOUNTS__ACCOUNT_NOT_FOUND,
  type Address,
} from "@solana/kit";
import {
  type AttemptGameCompletionOptions,
  type CoreOracleDependencies,
  type GameCompletionResult,
  type GameOnChainContext,
  type GameReadinessSnapshot,
  type ReadinessResolution,
} from "./oracle-service.types.ts";
import type { TimbaGameAccount } from "./types/timba.ts";
import {
  coerceAddress,
  ensureAddress,
  generateUnbiasedRandom,
  resolveNumericLike,
} from "./solana-utils.ts";
import type { PublicKeyLike } from "./solana-utils.ts";
import { GAME_SEED } from "./oracle-accounts.ts";
import {
  derivePdaSync,
  ensureKeyPairSigner,
  sendRpcRequest,
  type LatestBlockhash,
} from "./solana-kit.ts";
import { logger } from "./logger.ts";
import { GameCompletionTransactionBuilder } from "./game-completion-transaction-builder.ts";
import { RegistrySyncManager } from "./registry-sync-manager.ts";
import { TransactionSubmitter } from "./transaction-submitter.ts";
import type { ContractVersion } from "./contract-idl.ts";

export interface GameCompletionManagerOptions extends CoreOracleDependencies {
  contractVersion: ContractVersion;
  readinessCache: Map<string, GameReadinessSnapshot>;
  secretKeyLength: number;
  noSecretKeyMessage: string;
  confirmTransaction: (signature: string, latestBlockhash: LatestBlockhash) => Promise<void>;
  recoverPlayerRegistry?: (options: {
    gameAddress: string;
    context: GameOnChainContext;
    readiness: GameReadinessSnapshot;
    expectedTickets: number;
    reason: string;
  }) => Promise<string[] | null>;
  markGameDesynced?: (gameAddress: string) => void;
  registryPrefetchCooldownMs?: number;
}

type CompletionCallbacks = {
  onResult?: (result: GameCompletionResult) => void;
  successLog?: (gameAddress: string) => string | void;
  failureLog?: (gameAddress: string, error?: string) => string | void;
};

export class GameCompletionManager {
  private readonly inFlightCompletions = new Set<string>();

  // Services
  public readonly transactionBuilder: GameCompletionTransactionBuilder;
  public readonly registrySyncManager: RegistrySyncManager;
  public readonly transactionSubmitter: TransactionSubmitter;

  constructor(private readonly options: GameCompletionManagerOptions) {
    this.transactionBuilder = new GameCompletionTransactionBuilder({
      programId: options.getProgram().programId,
      operator: ensureKeyPairSigner(options.operatorKeypair),
      contractVersion: options.contractVersion,
    });

    this.registrySyncManager = new RegistrySyncManager({
      db: options.db,
      recoverPlayerRegistry: options.recoverPlayerRegistry,
      markGameDesynced: options.markGameDesynced,
      registryPrefetchCooldownMs: options.registryPrefetchCooldownMs,
    });

    this.transactionSubmitter = new TransactionSubmitter({
      getConnection: () => options.getConnection(),
      confirmTransaction: options.confirmTransaction,
    });
  }

  public async isGameReadyForCompletion(gamePda: PublicKeyLike): Promise<boolean> {
    const normalized = ensureAddress(gamePda);
    const gameAddress = normalized;
    const readiness = await this.evaluateAndCacheReadiness(normalized, gameAddress);
    return readiness.ready;
  }

  public async attemptGameCompletion(
    options: AttemptGameCompletionOptions,
    hooks: {
      completeGame?: (
        gameAddress: string,
        readiness?: GameReadinessSnapshot,
        sharedContext?: GameOnChainContext,
      ) => Promise<GameCompletionResult>;
    } = {},
  ): Promise<GameCompletionResult | null> {
    const lockKey = options.gameAddress;
    if (this.inFlightCompletions.has(lockKey)) {
      return null;
    }

    this.inFlightCompletions.add(lockKey);

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

    try {
      const resolvedPda =
        context?.gamePda ??
        (gameKey ? coerceAddress(gameKey) : this.safeCoercePublicKey(gameAddress));

      if (!resolvedPda) {
        return null;
      }

      const readinessResolution = await this.resolveContextAndReadiness(gameAddress, {
        context,
        readiness,
        requireOnChain: !skipReadinessCheck,
      });

      if (readinessResolution.status === "missing-context") {
        return null;
      }

      const completionContext = readinessResolution.context;
      const completionReadiness = readinessResolution.readiness;
      const shouldAbortForReadiness =
        !skipReadinessCheck && readinessResolution.status === "not-ready";

      if (shouldAbortForReadiness) {
        return this.recordNotReady(gameAddress, { onResult });
      }

      const completion = await (hooks.completeGame
        ? hooks.completeGame(gameAddress, completionReadiness, completionContext)
        : this.completeGame(gameAddress, completionReadiness, completionContext));

      return this.finalizeCompletionOutcome(gameAddress, completion, {
        onResult,
        successLog,
        failureLog,
      });
    } finally {
      this.inFlightCompletions.delete(lockKey);
    }
  }

  private recordNotReady(
    gameAddress: string,
    callbacks: Pick<CompletionCallbacks, "onResult"> = {},
  ): GameCompletionResult {
    const result: GameCompletionResult = { success: false, notReady: true };
    return this.finalizeCompletionOutcome(gameAddress, result, callbacks);
  }

  private finalizeCompletionOutcome(
    gameAddress: string,
    result: GameCompletionResult,
    callbacks: CompletionCallbacks = {},
  ): GameCompletionResult {
    const { onResult, successLog, failureLog } = callbacks;

    onResult?.(result);

    this.options.metrics.recordCompletion({
      gameAddress,
      outcome: result.success ? "success" : result.notReady ? "not-ready" : "error",
      error: result.error,
    });

    if (result.success) {
      const message = successLog?.(gameAddress);
      if (message) {
        logger.info(message);
      }
    } else if (!result.notReady) {
      const message = failureLog?.(gameAddress, result.error);
      if (message) {
        logger.error(message);
      }
    }

    return result;
  }

  private safeCoercePublicKey(value: PublicKeyLike | null | undefined): Address | null {
    try {
      return value ? coerceAddress(value) : null;
    } catch {
      return null;
    }
  }

  public async completeGame(
    gameAddress: string,
    cachedReadiness?: GameReadinessSnapshot,
    sharedContext?: GameOnChainContext,
  ): Promise<GameCompletionResult> {
    try {
      const completionState = await this.resolveContextAndReadiness(gameAddress, {
        context: sharedContext ?? null,
        readiness: cachedReadiness,
        requireOnChain: true,
      });

      const validated = this.validateCompletionState(gameAddress, completionState);
      if ("error" in validated) {
        return validated.error;
      }

      const { context: resolvedContext, readiness } = validated;

      const winnerDetails = await this.resolveWinnerDetails(
        gameAddress,
        readiness,
        resolvedContext,
      );
      if ("error" in winnerDetails) {
        return winnerDetails.error;
      }

      const { gameAccount, winnerAddress, winnerIndex, randomHashBuffer, secretKeyBuffer } =
        winnerDetails;

      const txHash = await this.executeGameCompletion({
        gameAccount,
        winnerAddress,
        randomHashBuffer,
        secretKeyBuffer,
        winnerIndex,
      });

      this.finalizeSuccessfulCompletion(gameAddress);

      const totalPot = resolveNumericLike(gameAccount["totalAmount"]);

      return { success: true, txHash, winnerAddress, totalPot };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return this.recordCompletionFailure(gameAddress, message);
    }
  }

  private validateCompletionState(
    gameAddress: string,
    state: ReadinessResolution,
  ):
    | { context: GameOnChainContext; readiness: GameReadinessSnapshot }
    | { error: GameCompletionResult } {
    if (state.status === "missing-context") {
      return {
        error: this.recordFatalCompletionFailure(gameAddress, this.options.noSecretKeyMessage),
      };
    }

    if (state.status === "not-ready") {
      return { error: { success: false, notReady: true } };
    }

    const missingContext = this.guardFatalCompletionRequirement(
      gameAddress,
      state.context,
      this.options.noSecretKeyMessage,
    );
    if (missingContext) {
      return { error: missingContext };
    }

    const missingGameAccount = this.guardFatalCompletionRequirement(
      gameAddress,
      state.readiness.gameAccount,
      "On-chain game account unavailable",
    );
    if (missingGameAccount) {
      return { error: missingGameAccount };
    }

    return {
      context: state.context,
      readiness: state.readiness,
    };
  }

  private async resolveWinnerDetails(
    gameAddress: string,
    readiness: GameReadinessSnapshot,
    context: GameOnChainContext,
  ): Promise<
    | {
        gameAccount: TimbaGameAccount;
        winnerAddress: Address;
        winnerIndex: number;
        randomHashBuffer: Buffer;
        secretKeyBuffer: Buffer;
      }
    | { error: GameCompletionResult }
  > {
    const { secretData, randomHashBuffer } = context;

    const missingSecret = this.guardFatalCompletionRequirement(
      gameAddress,
      secretData,
      this.options.noSecretKeyMessage,
    );
    if (missingSecret) {
      return { error: missingSecret };
    }

    if (!secretData) {
      return {
        error: this.recordFatalCompletionFailure(
          gameAddress,
          "Secret data is missing; cannot determine winner",
        ),
      };
    }

    const gameAccount = readiness.gameAccount;
    const missingGameAccount = this.guardFatalCompletionRequirement(
      gameAddress,
      gameAccount,
      "On-chain game account unavailable",
    );
    if (missingGameAccount) {
      return { error: missingGameAccount };
    }

    const resolvedGameAccount = gameAccount!;

    const expectedEntries = Number(resolvedGameAccount.ticketsCount);

    // Use RegistrySyncManager
    const ensuredPlayers = await this.registrySyncManager.ensurePlayersInSync(
      gameAddress,
      context,
      readiness,
      expectedEntries,
      (addr, err) => this.recordFatalCompletionFailure(addr, err),
    );

    if ("error" in ensuredPlayers) {
      return { error: ensuredPlayers.error };
    }

    const players = ensuredPlayers.players;

    const secretKeyBuffer = Buffer.from(secretData.secretKey, "hex");

    // Calculate winner index using unbiased random generation

    const winnerIndex = this.calculateWinnerIndex(
      secretKeyBuffer,
      Number(resolvedGameAccount.lastSlot),
      players.length,
    );
    const winnerPlayerAddress = players[winnerIndex];

    if (!winnerPlayerAddress) {
      return {
        error: this.recordFatalCompletionFailure(gameAddress, "Unable to determine winner"),
      };
    }

    const winnerAddress = coerceAddress(winnerPlayerAddress!);
    if (!winnerAddress) {
      return {
        error: this.recordFatalCompletionFailure(gameAddress, "Winner address is invalid"),
      };
    }

    return {
      gameAccount: resolvedGameAccount,
      winnerAddress,
      winnerIndex,
      randomHashBuffer,
      secretKeyBuffer,
    };
  }

  private recordCompletionFailure(
    gameAddress: string,
    error: string,
    options: { clearReadiness?: boolean } = {},
  ): GameCompletionResult {
    this.options.db.incrementCompletionAttempts(gameAddress);

    if (options.clearReadiness) {
      this.options.readinessCache.delete(gameAddress);
    }

    return { success: false, error };
  }

  private recordFatalCompletionFailure(gameAddress: string, error: string): GameCompletionResult {
    return this.recordCompletionFailure(gameAddress, error, { clearReadiness: true });
  }

  private guardFatalCompletionRequirement(
    gameAddress: string,
    value: unknown,
    message: string,
  ): GameCompletionResult | null {
    if (value === null || value === undefined) {
      return this.recordFatalCompletionFailure(gameAddress, message);
    }

    return null;
  }

  private finalizeSuccessfulCompletion(gameAddress: string): void {
    this.registrySyncManager.resetRegistryPrefetchSchedule(gameAddress);
    this.options.db.finalizeCompletedGame(gameAddress);
    this.options.readinessCache.delete(gameAddress);
  }

  public async resolveContextAndReadiness(
    gameAddress: string,
    options: {
      context?: GameOnChainContext | null;
      readiness?: GameReadinessSnapshot;
      requireOnChain?: boolean;
      blockTime?: number;
      getBlockTime?: () => Promise<number>;
    } = {},
  ): Promise<ReadinessResolution> {
    const {
      context: providedContext = null,
      readiness: providedReadiness,
      requireOnChain = false,
      blockTime,
      getBlockTime,
    } = options;

    const resolvedContext = await this.resolveGameContext(
      gameAddress,
      providedContext,
      requireOnChain,
    );

    if (!resolvedContext) {
      return { status: "missing-context" };
    }

    const { snapshot, shouldPrefetch } = await this.resolveReadinessSnapshot(
      gameAddress,
      resolvedContext,
      {
        providedReadiness,
        providedContext,
        requireOnChain,
        blockTime,
        getBlockTime,
      },
    );

    if (!snapshot) {
      return { status: "missing-context" };
    }

    const contextWithReadiness =
      resolvedContext.readiness === snapshot
        ? resolvedContext
        : { ...resolvedContext, readiness: snapshot };

    if (shouldPrefetch) {
      await this.registrySyncManager.prefetchPlayerRegistry(
        gameAddress,
        contextWithReadiness,
        snapshot,
      );
    }

    const status: "ready" | "not-ready" =
      snapshot.ready && snapshot.gameAccount ? "ready" : "not-ready";

    return {
      status,
      context: contextWithReadiness,
      readiness: snapshot,
      prefetchScheduled: shouldPrefetch,
    };
  }

  private async resolveReadinessSnapshot(
    gameAddress: string,
    context: GameOnChainContext,
    options: {
      providedReadiness?: GameReadinessSnapshot;
      providedContext?: GameOnChainContext | null;
      requireOnChain: boolean;
      blockTime?: number;
      getBlockTime?: () => Promise<number>;
    },
  ): Promise<{ snapshot: GameReadinessSnapshot | null; shouldPrefetch: boolean }> {
    const { providedReadiness, providedContext, requireOnChain, blockTime, getBlockTime } = options;

    const providedCandidate = this.getProvidedReadinessCandidate(
      providedReadiness,
      providedContext,
      requireOnChain,
    );
    if (providedCandidate) {
      return { snapshot: providedCandidate, shouldPrefetch: false };
    }

    const cachedCandidate = this.consumeCachedReadiness(gameAddress, requireOnChain);
    if (cachedCandidate) {
      return { snapshot: cachedCandidate, shouldPrefetch: false };
    }

    const evaluationBlockTime = blockTime ?? (getBlockTime ? await getBlockTime() : undefined);

    const evaluation = await this.evaluateAndCacheReadiness(
      ensureAddress(context.gamePda),
      gameAddress,
      evaluationBlockTime,
    );

    if (!evaluation.gameAccount && requireOnChain) {
      logger.warning(`Game ${gameAddress} no longer exists on-chain`);
      return { snapshot: null, shouldPrefetch: false };
    }

    return {
      snapshot: evaluation,
      shouldPrefetch: Boolean(evaluation.gameAccount),
    };
  }

  private getProvidedReadinessCandidate(
    providedReadiness: GameReadinessSnapshot | undefined,
    providedContext: GameOnChainContext | null | undefined,
    requireOnChain: boolean,
  ): GameReadinessSnapshot | undefined {
    const candidate = providedReadiness ?? providedContext?.readiness;
    if (!candidate) {
      return undefined;
    }
    if (requireOnChain && !candidate.gameAccount) {
      return undefined;
    }
    return candidate;
  }

  private consumeCachedReadiness(
    gameAddress: string,
    requireOnChain: boolean,
  ): GameReadinessSnapshot | undefined {
    if (requireOnChain) {
      return undefined;
    }
    return this.consumeReadiness(gameAddress);
  }

  public consumeReadiness(gameAddress: string): GameReadinessSnapshot | undefined {
    const readiness = this.options.readinessCache.get(gameAddress);
    if (readiness) {
      this.options.readinessCache.delete(gameAddress);
    }
    return readiness;
  }

  public async getBlockchainTime(): Promise<number> {
    try {
      const connection = this.options.getConnection();
      const slot = await sendRpcRequest(connection.getSlot({ commitment: "confirmed" }));
      const blockTime = await sendRpcRequest(connection.getBlockTime(slot));
      return blockTime === null ? Math.floor(Date.now() / 1000) : Number(blockTime);
    } catch {
      return Math.floor(Date.now() / 1000);
    }
  }

  private async resolveGameContext(
    gameAddress: string,
    context: GameOnChainContext | null,
    requireOnChain: boolean,
  ): Promise<GameOnChainContext | null> {
    if (context) {
      return context;
    }

    const resolved = this.resolveStoredGame(gameAddress);

    if (!resolved && requireOnChain) {
      this.logMissingSecret(gameAddress, requireOnChain);
    }

    return resolved;
  }

  private async evaluateAndCacheReadiness(
    gamePda: Address,
    gameAddress: string,
    blockTime?: number,
  ): Promise<GameReadinessSnapshot> {
    const readiness = await this.evaluateGameReadiness(gamePda, blockTime);

    if (readiness.ready) {
      this.options.readinessCache.set(gameAddress, readiness);
    } else {
      this.options.readinessCache.delete(gameAddress);
    }

    return readiness;
  }

  public async evaluateGameReadiness(
    gamePda: PublicKeyLike,
    blockTime?: number,
  ): Promise<GameReadinessSnapshot> {
    const gameAccount = await this.fetchGameAccount(gamePda);
    if (!gameAccount) {
      return { ready: false, gameAccount: null };
    }

    const evaluatedAt = blockTime ?? (await this.getBlockchainTime());
    const expiresAt = Number(gameAccount.createdAt) + Number(gameAccount.timeout);
    const isExpired = evaluatedAt >= expiresAt;
    const ticketsCount = Number(gameAccount.ticketsCount);
    const hasTickets = ticketsCount > 0;
    const isFull = hasTickets && ticketsCount >= Number(gameAccount.maxTickets);
    const hasMinTickets = hasTickets && ticketsCount >= Number(gameAccount.minTickets);

    return {
      ready: hasTickets && (isFull || (isExpired && hasMinTickets)),
      gameAccount,
      evaluatedAt,
    };
  }

  public async fetchGameAccount(gamePda: PublicKeyLike): Promise<TimbaGameAccount | null> {
    try {
      const program = this.options.getProgram();
      const normalized = ensureAddress(gamePda);
      if (typeof program.fetchGame === "function") return await program.fetchGame(normalized);
      const legacyFetch = (
        program as unknown as {
          account?: { game?: { fetch?: (value: Address) => Promise<TimbaGameAccount> } };
        }
      ).account?.game?.fetch;
      if (!legacyFetch) throw new Error("Program client does not expose a game account fetcher");
      return await legacyFetch(normalized);
    } catch (error: unknown) {
      if (this.isAccountNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  public isAccountNotFoundError(error: unknown): error is { message?: string } {
    if (isSolanaError(error, SOLANA_ERROR__ACCOUNTS__ACCOUNT_NOT_FOUND)) return true;
    if (!error || typeof error !== "object") {
      return false;
    }

    if (!("message" in error)) {
      return false;
    }

    const { message } = error as { message?: unknown };
    return (
      typeof message === "string" &&
      /Account (?:does not exist|not found(?: at address)?)/i.test(message)
    );
  }

  public async executeGameCompletion(args: {
    gameAccount: TimbaGameAccount;
    winnerAddress: Address;
    randomHashBuffer: Buffer;
    secretKeyBuffer: Buffer;
    winnerIndex: number;
  }): Promise<string> {
    // Use GameCompletionTransactionBuilder
    const instruction = await this.transactionBuilder.buildCompletionInstruction(args);

    return this.transactionSubmitter.submitTransaction(async (latestBlockhash) => {
      const operator = ensureKeyPairSigner(this.options.operatorKeypair);
      const message = pipe(
        createTransactionMessage({ version: "legacy" }),
        (value) => setTransactionMessageFeePayerSigner(operator, value),
        (value) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, value),
        (value) => appendTransactionMessageInstruction(instruction, value),
      );
      const transaction = await signTransactionMessageWithSigners(message);
      return getBase64EncodedWireTransaction(transaction);
    });
  }

  public calculateWinnerIndex(secretKeyBuffer: Buffer, lastSlot: number, nPlayers: number): number {
    if (nPlayers <= 1) return 0;

    if (secretKeyBuffer.length < this.options.secretKeyLength) {
      throw new Error(`Secret key buffer must be at least ${this.options.secretKeyLength} bytes`);
    }

    const lastSlotBytes = Buffer.alloc(8);
    lastSlotBytes.writeBigUInt64LE(BigInt(lastSlot));

    const combinedData = Buffer.concat([
      secretKeyBuffer.subarray(0, this.options.secretKeyLength),
      lastSlotBytes,
    ]);

    // Use generateUnbiasedRandom from solana-utils
    return Number(generateUnbiasedRandom(combinedData, BigInt(nPlayers)));
  }

  private logMissingSecret(gameAddress: string, requireOnChain: boolean): void {
    if (!requireOnChain) {
      return;
    }
    logger.warning(`${this.options.noSecretKeyMessage} for game ${gameAddress}`);
  }

  public resolveStoredGame(gameAddress: string): GameOnChainContext | null {
    const secretData = this.options.db.getSecretKey(gameAddress);
    if (!secretData) {
      return null;
    }

    const randomHashBuffer = Buffer.from(secretData.randomHash, "hex");
    const gamePda = this.getGamePDA(randomHashBuffer);

    return { secretData, randomHashBuffer, gamePda };
  }

  public getGamePDA(randomHash: Buffer): Address {
    return derivePdaSync(ensureAddress(this.options.getProgram().programId), [
      GAME_SEED,
      randomHash,
    ]);
  }

  // Delegate resetRegistryPrefetchSchedule to RegistrySyncManager
  public resetRegistryPrefetchSchedule(gameAddress: string): void {
    this.registrySyncManager.resetRegistryPrefetchSchedule(gameAddress);
  }
}
