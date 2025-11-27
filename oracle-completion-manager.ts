import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  type BlockhashWithExpiryBlockHeight,
  Connection,
} from "@solana/web3.js";
import {
  type AttemptGameCompletionOptions,
  type CoreOracleDependencies,
  type GameCompletionResult,
  type GameOnChainContext,
  type GameReadinessSnapshot,
  type ReadinessResolution,
} from "./oracle-service.types.ts";
import type { TimbaGameAccount } from "./types/timba.ts";
import { coercePublicKey, ensurePublicKey, generateUnbiasedRandom } from "./solana-utils.ts";
import type { PublicKeyLike } from "./solana-utils.ts";
import { GAME_SEED } from "./oracle-accounts.ts";
import { logger } from "./logger.ts";
import { GameCompletionTransactionBuilder } from "./game-completion-transaction-builder.ts";
import { RegistrySyncManager } from "./registry-sync-manager.ts";
import { TransactionSubmitter } from "./transaction-submitter.ts";

export interface GameCompletionManagerOptions extends CoreOracleDependencies {
  readinessCache: Map<string, GameReadinessSnapshot>;
  tokenProgramCache: Map<string, PublicKey>;
  secretKeyLength: number;
  noSecretKeyMessage: string;
  confirmTransaction: (
    signature: string,
    latestBlockhash?: BlockhashWithExpiryBlockHeight,
  ) => Promise<void>;
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
      program: options.getProgram(),
      adminKeypair: options.adminKeypair,
      tokenProgramCache: options.tokenProgramCache,
    });

    this.registrySyncManager = new RegistrySyncManager({
      db: options.db,
      recoverPlayerRegistry: options.recoverPlayerRegistry,
      markGameDesynced: options.markGameDesynced,
      registryPrefetchCooldownMs: options.registryPrefetchCooldownMs,
    });

    this.transactionSubmitter = new TransactionSubmitter({
      connection: options.getConnection() as unknown as Connection,
      confirmTransaction: options.confirmTransaction,
      confirmOpts: (options.getProgram().provider as anchor.AnchorProvider).opts,
    });
  }

  public async isGameReadyForCompletion(gamePda: PublicKey): Promise<boolean> {
    const normalized = ensurePublicKey(gamePda);
    const gameAddress = normalized.toBase58();
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
        context?.gamePda ?? (gameKey ? coercePublicKey(gameKey) : this.safeCoercePublicKey(gameAddress));

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

      return this.finalizeCompletionOutcome(
        gameAddress,
        completion,
        { onResult, successLog, failureLog },
      );
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
      outcome: result.success
        ? "success"
        : result.notReady
        ? "not-ready"
        : "error",
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

  private safeCoercePublicKey(value: PublicKeyLike | null | undefined): PublicKey | null {
    try {
      return value ? coercePublicKey(value) : null;
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

      return { success: true, txHash };
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
        error: this.recordFatalCompletionFailure(
          gameAddress,
          this.options.noSecretKeyMessage,
        ),
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
        winnerAddress: PublicKey;
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
      (addr, err) => this.recordFatalCompletionFailure(addr, err)
    );

    if ("error" in ensuredPlayers) {
      return { error: ensuredPlayers.error };
    }

    const players = ensuredPlayers.players;

    const secretKeyBuffer = Buffer.from(secretData.secretKey, "hex");

    // Use new calculateWinnerIndex logic (which uses generateUnbiasedRandom)
    // Wait, I should probably keep calculateWinnerIndex here but make it use generateUnbiasedRandom
    // or just inline the logic using generateUnbiasedRandom.
    // The original calculateWinnerIndex had some specific buffer concatenation logic.
    // Let's implement calculateWinnerIndex using generateUnbiasedRandom.

    const winnerIndex = this.calculateWinnerIndex(
      secretKeyBuffer,
      Number(resolvedGameAccount.lastSlot),
      players.length,
    );
    const winnerPlayerAddress = players[winnerIndex];

    if (!winnerPlayerAddress) {
      return {
        error: this.recordFatalCompletionFailure(
          gameAddress,
          "Unable to determine winner",
        ),
      };
    }

    const winnerAddress = new PublicKey(winnerPlayerAddress!);

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

  private recordFatalCompletionFailure(
    gameAddress: string,
    error: string,
  ): GameCompletionResult {
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

    const contextWithReadiness = resolvedContext.readiness === snapshot
      ? resolvedContext
      : { ...resolvedContext, readiness: snapshot };

    if (shouldPrefetch) {
      await this.registrySyncManager.prefetchPlayerRegistry(gameAddress, contextWithReadiness, snapshot);
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
    const {
      providedReadiness,
      providedContext,
      requireOnChain,
      blockTime,
      getBlockTime,
    } = options;

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

    const evaluationBlockTime =
      blockTime ?? (getBlockTime ? await getBlockTime() : undefined);

    const evaluation = await this.evaluateAndCacheReadiness(
      context.gamePda,
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

  public clearTokenProgramCache(): void {
    this.options.tokenProgramCache.clear();
  }

  public async getBlockchainTime(): Promise<number> {
    try {
      const connection = this.options.getConnection();
      const slot = await connection.getSlot();
      const blockTime = await connection.getBlockTime(slot);
      return blockTime || Math.floor(Date.now() / 1000);
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
    gamePda: PublicKey,
    gameAddress: string,
    blockTime?: number,
  ): Promise<GameReadinessSnapshot> {
    const readiness = await this.evaluateGameReadiness(gamePda, gameAddress, blockTime);

    if (readiness.ready) {
      this.options.readinessCache.set(gameAddress, readiness);
    } else {
      this.options.readinessCache.delete(gameAddress);
    }

    return readiness;
  }

  public async evaluateGameReadiness(
    gamePda: PublicKey,
    gameAddress: string,
    blockTime?: number,
  ): Promise<GameReadinessSnapshot> {
    const gameAccount = await this.fetchGameAccount(gamePda, gameAddress);
    if (!gameAccount) {
      return { ready: false, gameAccount: null };
    }

  const evaluatedAt = blockTime ?? (await this.getBlockchainTime());
  const expiresAt = Number(gameAccount.createdAt) + Number(gameAccount.timeout);
  const isExpired = evaluatedAt >= expiresAt;
    const ticketsCount = Number(gameAccount.ticketsCount);
    const isFull = ticketsCount >= Number(gameAccount.maxTickets);
    const hasMinTickets = ticketsCount >= Number(gameAccount.minTickets);

    return {
      ready: isFull || (isExpired && hasMinTickets),
      gameAccount,
      evaluatedAt,
    };
  }

  public async fetchGameAccount(
    gamePda: PublicKey,
    gameAddress: string,
  ): Promise<TimbaGameAccount | null> {
    try {
      const program = this.options.getProgram();
      return (await program.account.game.fetch(gamePda)) as TimbaGameAccount;
    } catch (error: unknown) {
      if (this.isAccountNotFoundError(error)) {
        this.options.db.markGameCompleted(gameAddress);
        return null;
      }
      throw error;
    }
  }

  public isAccountNotFoundError(error: unknown): error is { message?: string } {
    if (!error || typeof error !== "object") {
      return false;
    }

    if (!("message" in error)) {
      return false;
    }

    const { message } = error as { message?: unknown };
    return typeof message === "string" && message.includes("Account does not exist");
  }

  public async executeGameCompletion(args: {
    gameAccount: TimbaGameAccount;
    winnerAddress: PublicKey;
    randomHashBuffer: Buffer;
    secretKeyBuffer: Buffer;
    winnerIndex: number;
  }): Promise<string> {
    // Use GameCompletionTransactionBuilder
    const { builder, signers } = await this.transactionBuilder.buildCompletionTransaction(args);

    // Use TransactionSubmitter
    return this.transactionSubmitter.submitTransaction(
      async (latestBlockhash) => {
        const tx = await builder.transaction();
        if (tx instanceof anchor.web3.VersionedTransaction) {
          tx.message.recentBlockhash = latestBlockhash.blockhash;
          tx.sign(signers);
          return tx.serialize();
        }

        tx.feePayer = tx.feePayer ?? signers[0]!.publicKey;
        tx.recentBlockhash = latestBlockhash.blockhash;
        // We assume adminKeypair is the signer
        tx.partialSign(...signers);
        return tx.serialize();
      },
      () => {
        // Invalidate token program cache on error (B-005)
        // We can't access tokenMint easily here without passing it or parsing it.
        // But we can clear the whole cache or just rely on the fact that we might not need to be so granular.
        // Or we can pass a callback.
        // The original code invalidated specific token mint.
        // "this.options.tokenProgramCache.delete(tokenMint.toBase58());"
        // I should probably expose this capability or just clear the cache.
        // For now, let's clear the cache if we can't identify the mint, or just accept that we might not invalidate it perfectly.
        // Actually, args.gameAccount.tokenMint is available here.
        const tokenMint = ensurePublicKey(args.gameAccount.tokenMint);
        this.options.tokenProgramCache.delete(tokenMint.toBase58());
      }
    );
  }

  public calculateWinnerIndex(
    secretKeyBuffer: Buffer,
    lastSlot: number,
    nPlayers: number,
  ): number {
    if (nPlayers <= 1) return 0;

    if (secretKeyBuffer.length < this.options.secretKeyLength) {
      throw new Error(
        `Secret key buffer must be at least ${this.options.secretKeyLength} bytes`,
      );
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

  public resolveStoredGame(
    gameAddress: string,
  ): GameOnChainContext | null {
    const secretData = this.options.db.getSecretKey(gameAddress);
    if (!secretData) {
      return null;
    }

    const randomHashBuffer = Buffer.from(secretData.randomHash, "hex");
    const gamePda = this.getGamePDA(randomHashBuffer);

    return { secretData, randomHashBuffer, gamePda };
  }

  public getGamePDA(randomHash: Buffer): PublicKey {
    const programId = ensurePublicKey(this.options.getProgram().programId);
    const [pda] = PublicKey.findProgramAddressSync([GAME_SEED, randomHash], programId);
    return pda;
  }

  // F-001: Expose resetRegistryPrefetchSchedule for external use if needed,
  // but it's now handled by RegistrySyncManager.
  // We can delegate if we want to keep the API compatible.
  public resetRegistryPrefetchSchedule(gameAddress: string): void {
    this.registrySyncManager.resetRegistryPrefetchSchedule(gameAddress);
  }
}
