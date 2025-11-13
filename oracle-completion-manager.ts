import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  SendTransactionError,
  TransactionExpiredBlockheightExceededError,
  TransactionExpiredTimeoutError,
  type BlockhashWithExpiryBlockHeight,
} from "@solana/web3.js";
import { createHash } from "crypto";
import {
  type AttemptGameCompletionOptions,
  type CoreOracleDependencies,
  type GameCompletionResult,
  type GameOnChainContext,
  type GameReadinessSnapshot,
  type ReadinessResolution,
} from "./oracle-service.types.ts";
import type { TimbaGameAccount } from "./types/timba.ts";
import { coercePublicKey, ensurePublicKey } from "./solana-utils.ts";
import type { PublicKeyLike } from "./solana-utils.ts";
import {
  deriveGameAccounts,
  GAME_SEED,
} from "./oracle-accounts.ts";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { logger } from "./logger.ts";
import { analyzeRegistryState } from "./player-registry-utils.ts";

export interface GameCompletionManagerOptions extends CoreOracleDependencies {
  readinessCache: Map<string, GameReadinessSnapshot>;
  tokenProgramCache: Map<string, PublicKey>;
  secretKeyLength: number;
  noSecretKeyMessage: string;
  confirmTransaction: (
    signature: string,
    latestBlockhash?: anchor.web3.BlockhashWithExpiryBlockHeight,
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
  private readonly attemptedRegistryRecovery = new Set<string>();
  private readonly registryPrefetchCooldownMs: number;
  private readonly registryPrefetchSchedule = new Map<string, number>();
  private readonly inFlightCompletions = new Set<string>();

  constructor(private readonly options: GameCompletionManagerOptions) {
    const configured = options.registryPrefetchCooldownMs ?? 60_000;
    this.registryPrefetchCooldownMs = Math.max(1_000, configured);
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
    const ensuredPlayers = await this.ensurePlayersInSync(
      gameAddress,
      context,
      readiness,
      expectedEntries,
    );
    if ("error" in ensuredPlayers) {
      return { error: ensuredPlayers.error };
    }

    const players = ensuredPlayers.players;

    const secretKeyBuffer = Buffer.from(secretData.secretKey, "hex");
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

    const winnerAddress = new PublicKey(winnerPlayerAddress);

    return {
      gameAccount: resolvedGameAccount,
      winnerAddress,
      winnerIndex,
      randomHashBuffer,
      secretKeyBuffer,
    };
  }

  private async ensurePlayersInSync(
    gameAddress: string,
    context: GameOnChainContext,
    readiness: GameReadinessSnapshot,
    expectedEntries: number,
  ): Promise<{ players: string[] } | { error: GameCompletionResult }> {
    let players = this.options.db.getGamePlayers(gameAddress);

    const hasPlayers = players.length > 0;
    const initialAnalysis = analyzeRegistryState(
      {
        count: players.length,
        maxIndex: players.length === 0 ? null : players.length - 1,
        minIndex: players.length === 0 ? null : 0,
      },
      expectedEntries,
    );
    const hasDuplicatePlayers = players.length > 0 && new Set(players).size !== players.length;

    if (!initialAnalysis.needsReconciliation && hasPlayers && !hasDuplicatePlayers) {
      return { players };
    }

    const initialCount = players.length;
    const recovered = await this.tryRecoverPlayerRegistry(
      gameAddress,
      context,
      readiness,
      expectedEntries,
      initialCount,
    );

    if (recovered) {
      players = recovered;
    }

    const postRecoveryAnalysis = analyzeRegistryState(
      {
        count: players.length,
        maxIndex: players.length === 0 ? null : players.length - 1,
        minIndex: players.length === 0 ? null : 0,
      },
      expectedEntries,
    );
    const postRecoveryDuplicates = players.length > 0 && new Set(players).size !== players.length;

    if (postRecoveryAnalysis.needsReconciliation || postRecoveryDuplicates || players.length === 0) {
      logger.failure(
        `Ticket registry mismatch for ${gameAddress}: expected ${expectedEntries}, found ${players.length}`,
      );

      if (this.options.markGameDesynced) {
        this.options.markGameDesynced(gameAddress);
      }

      this.resetRegistryPrefetchSchedule(gameAddress);

      return {
        error: this.recordFatalCompletionFailure(
          gameAddress,
          "Ticket registry out of sync",
        ),
      };
    }

    return { players };
  }

  private async tryRecoverPlayerRegistry(
    gameAddress: string,
    context: GameOnChainContext,
    readiness: GameReadinessSnapshot,
    expectedEntries: number,
    previousCount: number,
  ): Promise<string[] | null> {
    const recoverFn = this.options.recoverPlayerRegistry;

    if (!recoverFn) {
      logger.failure(
        `Ticket registry mismatch for ${gameAddress}: expected ${expectedEntries}, found ${previousCount}`,
      );
      return null;
    }

    if (this.attemptedRegistryRecovery.has(gameAddress)) {
      return null;
    }

    this.attemptedRegistryRecovery.add(gameAddress);

    try {
      const recovered = await recoverFn({
        gameAddress,
        context,
        readiness,
        expectedTickets: expectedEntries,
        reason: "completion",
      });

      if (recovered && recovered.length === expectedEntries) {
        this.options.db.replaceGamePlayers(gameAddress, recovered);
        logger.info(
          `♻️  Recovered ${recovered.length} player entries for ${gameAddress} before completion`,
        );
        return recovered;
      }

      logger.failure(
        `Unable to recover player registry for ${gameAddress}; recovered ${recovered?.length ?? 0} of ${expectedEntries} entries`,
      );
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.failure(
        `Player registry recovery failed for ${gameAddress}: ${message}`,
      );
      return null;
    } finally {
      this.attemptedRegistryRecovery.delete(gameAddress);
    }
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
    this.deletePrefetchSchedule(gameAddress);
    this.options.db.finalizeCompletedGame(gameAddress);
    this.options.readinessCache.delete(gameAddress);
  }

  private async prefetchPlayerRegistry(
    gameAddress: string,
    context: GameOnChainContext,
    readiness: GameReadinessSnapshot,
  ): Promise<void> {
    const recoverFn = this.options.recoverPlayerRegistry;
    const gameAccount = readiness.gameAccount;

    if (!recoverFn || !gameAccount) {
      return;
    }

    const expectedTickets = Number(gameAccount.ticketsCount);
    if (!Number.isFinite(expectedTickets) || expectedTickets <= 0) {
      return;
    }

    const players = this.options.db.getGamePlayers(gameAddress);
    if (players.length >= expectedTickets) {
      return;
    }

    const now = Date.now();
    const nextAllowed = this.registryPrefetchSchedule.get(gameAddress) ?? 0;
    if (now < nextAllowed) {
      return;
    }

    const nextWindow = now + this.registryPrefetchCooldownMs;
    try {
      const recovered = await recoverFn({
        gameAddress,
        context,
        readiness,
        expectedTickets,
        reason: "readiness-check",
      });

      if (recovered && recovered.length === expectedTickets) {
        this.options.db.replaceGamePlayers(gameAddress, recovered);
        logger.info(
          `♻️  Prefetched ${recovered.length} players for ${gameAddress} during readiness evaluation`,
        );
        this.registryPrefetchSchedule.set(gameAddress, nextWindow);
      }
    } catch (error) {
      this.resetRegistryPrefetchSchedule(gameAddress);
      const message = error instanceof Error ? error.message : String(error);
      logger.warning(
        `Unable to prefetch player registry for ${gameAddress}: ${message}`,
      );
    }

  }

  private deletePrefetchSchedule(gameAddress: string): void {
    this.registryPrefetchSchedule.delete(gameAddress);
  }

  public resetRegistryPrefetchSchedule(gameAddress: string): void {
    this.deletePrefetchSchedule(gameAddress);
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
      await this.prefetchPlayerRegistry(gameAddress, contextWithReadiness, snapshot);
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
    const { gameAccount, winnerAddress, randomHashBuffer, secretKeyBuffer, winnerIndex } = args;

    const creatorPublicKey = ensurePublicKey(gameAccount.creator);
    const tokenMint = ensurePublicKey(gameAccount.tokenMint);
    const tokenProgramId = await this.resolveTokenProgram(
      gameAccount.tokenProgram,
      tokenMint,
    );
    const programId = ensurePublicKey(this.options.getProgram().programId);
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

    const program = this.options.getProgram();
    const provider = program.provider as anchor.AnchorProvider | undefined;
    const confirmOpts = provider?.opts ?? {};
    const blockhashCommitment =
      confirmOpts.preflightCommitment ?? confirmOpts.commitment ?? "confirmed";

    const completionBuilder = program.methods
      .completeGame([...randomHashBuffer], [...secretKeyBuffer], winnerIndex)
      .accountsPartial({
        game: gamePda,
        oracle: oraclePda,
        oracleOperator: this.options.adminKeypair.publicKey,
        winner: winnerAddress,
        creator: creatorPublicKey,
        gameTokenCtx,
        systemProgram: anchor.web3.SystemProgram.programId,
        winnerTokenAccount,
      })
      .signers([this.options.adminKeypair]);

    const connection = this.options.getConnection();

    const sendOptions: anchor.web3.SendOptions = {};
    if (confirmOpts.skipPreflight !== undefined) {
      sendOptions.skipPreflight = confirmOpts.skipPreflight;
    }
    if (confirmOpts.preflightCommitment ?? confirmOpts.commitment) {
      sendOptions.preflightCommitment = confirmOpts.preflightCommitment ?? confirmOpts.commitment;
    }
    if (confirmOpts.maxRetries !== undefined) {
      sendOptions.maxRetries = confirmOpts.maxRetries;
    }
    if (confirmOpts.minContextSlot !== undefined) {
      sendOptions.minContextSlot = confirmOpts.minContextSlot;
    }

    const signTransaction = async (
      latestBlockhash: BlockhashWithExpiryBlockHeight,
    ): Promise<Buffer> => {
      const tx = await completionBuilder.transaction();
      if (tx instanceof anchor.web3.VersionedTransaction) {
        tx.message.recentBlockhash = latestBlockhash.blockhash;
        tx.sign([this.options.adminKeypair]);
        return tx.serialize();
      }

      tx.feePayer = tx.feePayer ?? this.options.adminKeypair.publicKey;
      tx.recentBlockhash = latestBlockhash.blockhash;
      tx.partialSign(this.options.adminKeypair);
      return tx.serialize();
    };

    const sendWithBlockhash = async (
      latestBlockhash: BlockhashWithExpiryBlockHeight,
    ): Promise<string> => {
      const rawTransaction = await signTransaction(latestBlockhash);
      const signature = await connection.sendRawTransaction(rawTransaction, sendOptions);
      await this.options.confirmTransaction(signature, latestBlockhash);
      return signature;
    };

    const blockhashNotFoundPattern = /blockhash not found/i;

    const isBlockhashExpirySendError = (error: unknown): boolean => {
      if (!(error instanceof SendTransactionError)) {
        return false;
      }

      const transactionError = error.transactionError;
      const segments = [
        error.message,
        transactionError?.message,
        ...(error.logs ?? []),
        ...(transactionError?.logs ?? []),
      ].filter((segment): segment is string => typeof segment === "string" && segment.length > 0);

      return segments.some((segment) => blockhashNotFoundPattern.test(segment));
    };

    const shouldRetryAfterExpiry = (error: unknown): boolean => {
      if (error instanceof TransactionExpiredBlockheightExceededError) {
        return true;
      }
      if (error instanceof TransactionExpiredTimeoutError) {
        return true;
      }
      return isBlockhashExpirySendError(error);
    };

    let latestBlockhash = await connection.getLatestBlockhash(blockhashCommitment);
    try {
      return await sendWithBlockhash(latestBlockhash);
    } catch (error) {
      if (!shouldRetryAfterExpiry(error)) {
        throw error;
      }

      latestBlockhash = await connection.getLatestBlockhash(blockhashCommitment);
      return await sendWithBlockhash(latestBlockhash);
    }
  }

  public async resolveTokenProgram(
    tokenProgram: PublicKeyLike,
    tokenMint: PublicKey,
  ): Promise<PublicKey> {
    const cacheKey = tokenMint.toBase58();

    // Try direct program ID first
    const directProgram = coercePublicKey(tokenProgram);
    if (directProgram && !directProgram.equals(PublicKey.default)) {
      this.options.tokenProgramCache.set(cacheKey, directProgram);
      return directProgram;
    }

    // Check cache
    const cached = this.options.tokenProgramCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Fetch from chain
    try {
      const connection = this.options.getConnection();
      const mintAccount = await connection.getAccountInfo(tokenMint);
      const owner = mintAccount?.owner;

      const resolved = this.matchTokenProgramOwner(owner, tokenMint);
      this.options.tokenProgramCache.set(cacheKey, resolved);
      return resolved;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warning(
        `Unable to resolve token program for mint ${tokenMint.toBase58()}:`,
        message,
      );
      throw new Error(
        `Unable to resolve token program for mint ${tokenMint.toBase58()}: ${message}`,
        {
          cause: error instanceof Error ? error : undefined,
        },
      );
    }
  }

  private matchTokenProgramOwner(
    owner: PublicKey | undefined,
    tokenMint: PublicKey,
  ): PublicKey {
    if (owner?.equals(TOKEN_2022_PROGRAM_ID)) {
      return TOKEN_2022_PROGRAM_ID;
    }

    if (owner?.equals(TOKEN_PROGRAM_ID)) {
      return TOKEN_PROGRAM_ID;
    }

    throw new Error(
      owner
        ? `Unsupported token program owner ${owner.toBase58()}`
        : `Mint ${tokenMint.toBase58()} is missing an owner`,
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
      "Unable to generate unbiased random number - game must be cancelled",
    );
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
}
