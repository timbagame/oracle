import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import {
  type AttemptGameCompletionOptions,
  type CoreOracleDependencies,
  type GameCompletionResult,
  type GameOnChainContext,
  type GameReadinessSnapshot,
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

export interface GameCompletionManagerOptions extends CoreOracleDependencies {
  readinessCache: Map<string, GameReadinessSnapshot>;
  tokenProgramCache: Map<string, PublicKey>;
  secretKeyLength: number;
  noSecretKeyMessage: string;
  confirmTransaction: (signature: string) => Promise<void>;
  recoverPlayerRegistry?: (options: {
    gameAddress: string;
    context: GameOnChainContext;
    readiness: GameReadinessSnapshot;
    expectedTickets: number;
    reason: string;
  }) => Promise<string[] | null>;
  markGameDesynced?: (gameAddress: string) => void;
}

type CompletionCallbacks = {
  onResult?: (result: GameCompletionResult) => void;
  successLog?: (gameAddress: string) => string | void;
  failureLog?: (gameAddress: string, error?: string) => string | void;
};

export class GameCompletionManager {
  private readonly attemptedRegistryRecovery = new Set<string>();
  private readonly registryPrefetchCooldownMs = 60_000;
  private readonly registryPrefetchSchedule = new Map<string, number>();

  constructor(private readonly options: GameCompletionManagerOptions) {}

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

    const readinessState = await this.resolveContextAndReadiness(gameAddress, {
      context,
      readiness,
      requireOnChain: !skipReadinessCheck,
    });

    const completionContext = readinessState.context ?? undefined;
    const completionReadiness = readinessState.readiness;
    const notReady = skipReadinessCheck ? false : readinessState.notReady;

    if (notReady) {
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
    state: {
      context: GameOnChainContext | null;
      readiness?: GameReadinessSnapshot;
      notReady: boolean;
    },
  ):
    | { context: GameOnChainContext; readiness: GameReadinessSnapshot }
    | { error: GameCompletionResult } {
    const missingContext = this.guardFatalCompletionRequirement(
      gameAddress,
      state.context,
      this.options.noSecretKeyMessage,
    );
    if (missingContext) {
      return { error: missingContext };
    }

    if (state.notReady || !state.readiness) {
      return { error: { success: false, notReady: true } };
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
      context: state.context!,
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

    if (players.length === expectedEntries && players.length > 0) {
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

    const mismatch = players.length !== expectedEntries || players.length === 0;

    if (mismatch) {
      logger.failure(
        `Ticket registry mismatch for ${gameAddress}: expected ${expectedEntries}, found ${players.length}`,
      );

      if (this.options.markGameDesynced) {
        this.options.markGameDesynced(gameAddress);
      }

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
        this.attemptedRegistryRecovery.delete(gameAddress);
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

    this.registryPrefetchSchedule.set(gameAddress, now + this.registryPrefetchCooldownMs);

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
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warning(
        `Unable to prefetch player registry for ${gameAddress}: ${message}`,
      );
    }
  }

  public async resolveContextAndReadiness(
    gameAddress: string,
    options: {
      context?: GameOnChainContext | null;
      readiness?: GameReadinessSnapshot;
      requireOnChain?: boolean;
      blockTime?: number;
    } = {},
  ): Promise<{
    context: GameOnChainContext | null;
    readiness?: GameReadinessSnapshot;
    notReady: boolean;
  }> {
    const {
      context: providedContext = null,
      readiness: providedReadiness,
      requireOnChain = false,
      blockTime,
    } = options;

    const resolvedContext = await this.resolveGameContext(
      gameAddress,
      providedContext,
      requireOnChain,
    );

    if (!resolvedContext) {
      return { context: null, readiness: undefined, notReady: false };
    }

    const readinessSnapshot = await this.resolveReadinessSnapshot(
      gameAddress,
      resolvedContext,
      {
        providedReadiness,
        providedContext,
        requireOnChain,
        blockTime,
      },
    );

    if (!readinessSnapshot) {
      return { context: null, readiness: undefined, notReady: false };
    }

    const contextWithReadiness = resolvedContext.readiness !== readinessSnapshot
      ? { ...resolvedContext, readiness: readinessSnapshot }
      : resolvedContext;

    const notReady = !readinessSnapshot.ready || !readinessSnapshot.gameAccount;

    return {
      context: contextWithReadiness,
      readiness: readinessSnapshot,
      notReady,
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
    },
  ): Promise<GameReadinessSnapshot | null> {
    const { providedReadiness, providedContext, requireOnChain, blockTime } = options;

    const providedCandidate = this.getProvidedReadinessCandidate(
      providedReadiness,
      providedContext,
      requireOnChain,
    );
    if (providedCandidate) {
      return providedCandidate;
    }

    const cachedCandidate = this.consumeCachedReadiness(gameAddress, requireOnChain);
    if (cachedCandidate) {
      return cachedCandidate;
    }

    const evaluation = await this.evaluateAndCacheReadiness(
      context.gamePda,
      gameAddress,
      blockTime,
    );

    if (!evaluation.gameAccount && requireOnChain) {
      logger.warning(`Game ${gameAddress} no longer exists on-chain`);
      return null;
    }

    if (evaluation.gameAccount) {
      await this.prefetchPlayerRegistry(gameAddress, context, evaluation);
    }

    return evaluation;
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
    const isExpired = evaluatedAt > expiresAt;
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
    const txHash = await program.methods
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
      .signers([this.options.adminKeypair])
      .rpc();

    await this.options.confirmTransaction(txHash);
    return txHash;
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
