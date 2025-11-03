import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import {
  type AttemptGameCompletionOptions,
  type GameCompletionResult,
  type GameOnChainContext,
  type GameReadinessSnapshot,
} from "./oracle-service.types.ts";
import type { OracleDatabase } from "./database.ts";
import type { OracleMetrics } from "./metrics.ts";
import type { Timba } from "./idl/idlType.ts";
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

export interface GameCompletionManagerOptions {
  db: OracleDatabase;
  metrics: OracleMetrics;
  getConnection: () => anchor.web3.Connection;
  getProgram: () => anchor.Program<Timba>;
  adminKeypair: anchor.web3.Keypair;
  readinessCache: Map<string, GameReadinessSnapshot>;
  tokenProgramCache: Map<string, PublicKey>;
  secretKeyLength: number;
  noSecretKeyMessage: string;
  confirmTransaction: (signature: string) => Promise<void>;
}

export class GameCompletionManager {
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

    if (!skipReadinessCheck) {
      const ready = await this.isGameReadyForCompletion(resolvedPda);
      if (!ready) {
        const result: GameCompletionResult = { success: false, notReady: true };
        onResult?.(result);
        this.options.metrics.recordCompletion({
          gameAddress,
          outcome: "not-ready",
        });
        return result;
      }
    }

    const sharedContext = context ?? undefined;
    const completion = await (hooks.completeGame
      ? hooks.completeGame(gameAddress, readiness, sharedContext)
      : this.completeGame(gameAddress, readiness, sharedContext));

    onResult?.(completion);

    this.options.metrics.recordCompletion({
      gameAddress,
      outcome: completion.success
        ? "success"
        : completion.notReady
        ? "not-ready"
        : "error",
      error: completion.error,
    });

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

  public async completeGame(
    gameAddress: string,
    cachedReadiness?: GameReadinessSnapshot,
    sharedContext?: GameOnChainContext,
  ): Promise<GameCompletionResult> {
    try {
      const { context, readiness, notReady } = await this.resolveContextAndReadiness(
        gameAddress,
        {
          context: sharedContext ?? null,
          readiness: cachedReadiness,
        },
      );

      if (!context) {
        return this.recordFatalCompletionFailure(gameAddress, this.options.noSecretKeyMessage);
      }

      if (notReady || !readiness) {
        return { success: false, notReady: true };
      }

      const { secretData, randomHashBuffer } = context;
      const gameAccount = readiness.gameAccount;
      if (!gameAccount) {
        return this.recordFatalCompletionFailure(
          gameAddress,
          "On-chain game account unavailable",
        );
      }

      const players = this.options.db.getGamePlayers(gameAddress);
      const expectedEntries = Number(gameAccount.ticketsCount);
      const playerValidation = this.ensurePlayersInSync(
        gameAddress,
        players,
        expectedEntries,
      );
      if (playerValidation) {
        return playerValidation;
      }

      const secretKeyBuffer = Buffer.from(secretData.secretKey, "hex");
      const winnerIndex = this.calculateWinnerIndex(
        secretKeyBuffer,
        Number(gameAccount.lastSlot),
        players.length,
      );
      const winnerPlayerAddress = players[winnerIndex];

      if (!winnerPlayerAddress) {
        return this.recordFatalCompletionFailure(gameAddress, "Unable to determine winner");
      }

      const winnerAddress = new PublicKey(winnerPlayerAddress);

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

  private ensurePlayersInSync(
    gameAddress: string,
    players: string[],
    expectedEntries: number,
  ): GameCompletionResult | null {
    if (players.length === 0) {
      return this.recordFatalCompletionFailure(gameAddress, "No players found for game");
    }

    if (players.length !== expectedEntries) {
      console.error(
        `❌ Ticket registry mismatch for ${gameAddress}: expected ${expectedEntries}, found ${players.length}`,
      );
      return this.recordFatalCompletionFailure(gameAddress, "Ticket registry out of sync");
    }

    return null;
  }

  private finalizeSuccessfulCompletion(gameAddress: string): void {
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
      providedReadiness,
      providedContext?.readiness,
      requireOnChain,
      blockTime,
    );

    if (!readinessSnapshot) {
      return { context: null, readiness: undefined, notReady: false };
    }

    const contextWithReadiness =
      readinessSnapshot && resolvedContext.readiness !== readinessSnapshot
        ? { ...resolvedContext, readiness: readinessSnapshot }
        : resolvedContext;

    const notReady =
      !readinessSnapshot ||
      !readinessSnapshot.ready ||
      !readinessSnapshot.gameAccount;

    return {
      context: contextWithReadiness,
      readiness: readinessSnapshot,
      notReady,
    };
  }

  private async resolveReadinessSnapshot(
    gameAddress: string,
    resolvedContext: GameOnChainContext,
    providedReadiness: GameReadinessSnapshot | undefined,
    contextReadiness: GameReadinessSnapshot | undefined,
    requireOnChain: boolean,
    blockTime: number | undefined,
  ): Promise<GameReadinessSnapshot | null | undefined> {
    let readinessSnapshot = providedReadiness ?? contextReadiness;

    if (readinessSnapshot && requireOnChain && !readinessSnapshot.gameAccount) {
      readinessSnapshot = undefined;
    }

    if (!readinessSnapshot && !requireOnChain) {
      readinessSnapshot = this.consumeReadiness(gameAddress);
    }

    if (!requireOnChain && readinessSnapshot) {
      return readinessSnapshot;
    }

    if (requireOnChain || !readinessSnapshot) {
      const evaluation = await this.evaluateAndCacheReadiness(
        resolvedContext.gamePda,
        gameAddress,
        blockTime,
      );

      if (!evaluation.gameAccount && requireOnChain) {
        console.log(`⚠️  Game ${gameAddress} no longer exists on-chain`);
        return null;
      }

      return evaluation;
    }

    return readinessSnapshot;
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
  }  private async evaluateAndCacheReadiness(
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
      console.warn(
        `⚠️  Unable to resolve token program for mint ${tokenMint.toBase58()}:`,
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
    console.log(`⚠️  ${this.options.noSecretKeyMessage} for game ${gameAddress}`);
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
