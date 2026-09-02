import * as anchor from "@anchor-lang/core";
import { ComputeBudgetProgram, PublicKey, SystemInstruction, SystemProgram } from "@solana/web3.js";
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

const PHANTOM_LIGHTHOUSE_PROGRAM_ID = new PublicKey("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
const PHANTOM_ASSERT_OWNER_PROGRAM_ID = new PublicKey(
  "DeJBGdMFa1uynnnKiwrVioatTuHmNLpyFKnmB5kaFdzQ",
);
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
import { coercePublicKey, confirmTransaction } from "./solana-utils.ts";
import { PlayerRegistrySync } from "./player-registry-sync.ts";
import type { Timba } from "./idl/idlType.ts";
import { contractIdl, contractVersion } from "./contract-idl.ts";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  deriveAssociatedTokenAddress,
} from "./token-program.ts";
import { GAME_VAULT_SEED } from "./oracle-accounts.ts";
import {
  toApiTokenPolicy,
  type CreationPolicyRejectionCode,
  type TokenPolicy,
} from "./token-policy.ts";
import { createRestClient } from "@timbagame/protocol/common";
import { botContract } from "@timbagame/protocol/bot";

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
  private readonly connection: anchor.web3.Connection;
  private readonly rpcEndpointManager: RpcEndpointManager;
  private readonly operatorKeypair: anchor.web3.Keypair;
  private readonly program: anchor.Program<Timba>;
  private readonly interGameDelayMs: number;
  private readonly eventProcessor: OracleEventProcessor;
  private readonly completion: GameCompletionManager;
  private readonly scanner: ScanLoopRunner;
  private readonly registrySync: PlayerRegistrySync;
  public readonly readinessCache: Map<string, GameReadinessSnapshot>;

  private constructor(db?: OracleDatabase, metrics?: OracleMetrics) {
    this.config = getConfig();
    this.db = db ?? OracleDatabase.getInstance();
    this.metrics = metrics ?? getOracleMetrics();
    this.rpcEndpointManager = this.initRpcEndpointManager();
    this.connection = this.rpcEndpointManager.getConnection();
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
    options: { metrics?: OracleMetrics } = {},
  ): OracleService {
    return new OracleService(db, options.metrics);
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

  private loadOperatorKeypair(): anchor.web3.Keypair {
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
    keypair?: anchor.web3.Keypair;
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

      const keypair = anchor.web3.Keypair.fromSecretKey(new Uint8Array(numbers));
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

  private createEphemeralOperatorKeypair(source: string, reason?: string): anchor.web3.Keypair {
    const keypair = anchor.web3.Keypair.generate();
    logger.warning(
      `Using ephemeral operator keypair ${keypair.publicKey.toBase58()} because ${reason ?? `${source} was not found.`}`,
    );
    return keypair;
  }

  private logOperatorKeypairLoaded(keypair: anchor.web3.Keypair): void {
    logger.success(`Loaded operator keypair: ${keypair.publicKey.toBase58()}`);
  }

  private logOperatorKeypairFailure(path: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    logger.failure(`Failed to load operator keypair from ${path}:`, message);
  }

  private initProgram(): anchor.Program<Timba> {
    const operatorWallet = new anchor.Wallet(this.operatorKeypair);
    const provider = new anchor.AnchorProvider(this.connection, operatorWallet, {
      commitment: "confirmed",
    });
    anchor.setProvider(provider);
    logger.info(`Using Timba contract ABI ${contractVersion}`);
    return new anchor.Program(contractIdl as Timba, provider) as anchor.Program<Timba>;
  }

  private initPlayerRegistrySync(): PlayerRegistrySync {
    return new PlayerRegistrySync({
      connection: this.connection,
      program: this.program,
      disableBatchTransactions: this.config.disableBatchTransactions,
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

  public async close(): Promise<void> {
    await this.stopEventListening();
    this.scanner.stop();
    this.db.close();
  }

  public generateGameSecrets(options: GenerateGameSecretsOptions = {}): GameSecrets {
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
      oracleOperator: this.operatorKeypair.publicKey.toBase58(),
    };
  }

  public signGameTransaction(txBase64: string): string {
    if (!txBase64 || txBase64.length > 4_000) {
      throw new GameTransactionValidationError("Invalid transaction payload");
    }

    let transaction: anchor.web3.Transaction;
    try {
      transaction = anchor.web3.Transaction.from(Buffer.from(txBase64, "base64"));
    } catch (error) {
      throw new GameTransactionValidationError("Invalid transaction payload", { cause: error });
    }
    const feePayer = transaction.feePayer;
    if (!feePayer || !transaction.recentBlockhash) {
      throw new GameTransactionValidationError(
        "Transaction must include a fee payer and recent blockhash",
      );
    }

    const firstInstruction = transaction.instructions[0];
    if (firstInstruction?.programId.equals(SystemProgram.programId)) {
      let instructionType: ReturnType<typeof SystemInstruction.decodeInstructionType>;
      try {
        instructionType = SystemInstruction.decodeInstructionType(firstInstruction);
      } catch (error) {
        throw new GameTransactionValidationError("Invalid system setup instruction", {
          cause: error,
        });
      }
      if (instructionType === "AdvanceNonceAccount") {
        throw new GameTransactionValidationError("Durable nonce transactions are not supported");
      }
    }

    const programInstructions = transaction.instructions.filter((instruction) =>
      instruction.programId.equals(this.program.programId),
    );
    if (programInstructions.length < 1 || programInstructions.length > 2) {
      throw new GameTransactionValidationError(
        "Transaction must contain initialization and an optional creator join",
      );
    }

    const initialize = programInstructions[0]!;
    let decoded: ReturnType<anchor.BorshInstructionCoder["decode"]>;
    try {
      decoded = new anchor.BorshInstructionCoder(this.program.idl).decode(initialize.data);
    } catch (error) {
      throw new GameTransactionValidationError("Invalid game instruction data", { cause: error });
    }
    if (!decoded || decoded.name !== "initializeGame") {
      throw new GameTransactionValidationError(
        "Oracle only signs game initialization transactions",
      );
    }
    if (initialize.keys.length !== 11) {
      throw new GameTransactionValidationError("Invalid initialize-game account list");
    }

    const game = initialize.keys[0]!;
    const creator = initialize.keys[1]!;
    const oracle = initialize.keys[2]!;
    const oracleOperator = initialize.keys[3]!;
    const tokenMint = initialize.keys[4]!;
    const gameVault = initialize.keys[5]!;
    const gameVaultTokenAccount = initialize.keys[6]!;
    const tokenProgram = initialize.keys[7]!;
    const associatedTokenProgram = initialize.keys[8]!;
    const creatorTokenAccount = initialize.keys[9]!;
    const systemProgram = initialize.keys[10]!;
    if (game.isSigner || !game.isWritable) {
      throw new GameTransactionValidationError("Invalid game account flags");
    }
    if (!creator.pubkey.equals(feePayer) || !creator.isSigner || !creator.isWritable) {
      throw new GameTransactionValidationError(
        "Creator must be the transaction fee payer and signer",
      );
    }
    if (!oracleOperator.isSigner || oracleOperator.isWritable) {
      throw new GameTransactionValidationError("Invalid oracle operator account");
    }
    const userSignedFirst = oracleOperator.pubkey.equals(this.operatorKeypair.publicKey);
    const oracleOperatorPlaceholder = userSignedFirst ? null : oracleOperator.pubkey;
    if (!userSignedFirst) oracleOperator.pubkey = this.operatorKeypair.publicKey;

    const expectedOracle = PublicKey.findProgramAddressSync(
      [Buffer.from("oracle")],
      this.program.programId,
    )[0];
    if (!oracle.pubkey.equals(expectedOracle) || oracle.isSigner || oracle.isWritable) {
      throw new GameTransactionValidationError("Invalid oracle account");
    }

    if (tokenMint.isSigner || tokenMint.isWritable) {
      throw new GameTransactionValidationError("Invalid token mint account flags");
    }
    const expectedGameVault = PublicKey.findProgramAddressSync(
      [GAME_VAULT_SEED, tokenMint.pubkey.toBuffer()],
      this.program.programId,
    )[0];
    if (!gameVault.pubkey.equals(expectedGameVault) || gameVault.isSigner || gameVault.isWritable) {
      throw new GameTransactionValidationError("Invalid game vault account");
    }
    const expectedGameVaultTokenAccount = deriveAssociatedTokenAddress(
      tokenMint.pubkey,
      expectedGameVault,
      true,
      TOKEN_PROGRAM_ID,
    );
    if (
      !gameVaultTokenAccount.pubkey.equals(expectedGameVaultTokenAccount) ||
      gameVaultTokenAccount.isSigner ||
      !gameVaultTokenAccount.isWritable
    ) {
      throw new GameTransactionValidationError("Invalid game vault token account");
    }
    if (
      !tokenProgram.pubkey.equals(TOKEN_PROGRAM_ID) ||
      tokenProgram.isSigner ||
      tokenProgram.isWritable
    ) {
      throw new GameTransactionValidationError("Invalid token program account");
    }
    if (
      !associatedTokenProgram.pubkey.equals(ASSOCIATED_TOKEN_PROGRAM_ID) ||
      associatedTokenProgram.isSigner ||
      associatedTokenProgram.isWritable
    ) {
      throw new GameTransactionValidationError("Invalid associated token program account");
    }
    const expectedCreatorTokenAccount = deriveAssociatedTokenAddress(
      tokenMint.pubkey,
      creator.pubkey,
      false,
      TOKEN_PROGRAM_ID,
    );
    if (
      !creatorTokenAccount.pubkey.equals(expectedCreatorTokenAccount) ||
      creatorTokenAccount.isSigner ||
      !creatorTokenAccount.isWritable
    ) {
      throw new GameTransactionValidationError("Invalid creator token account");
    }
    if (
      !systemProgram.pubkey.equals(SystemProgram.programId) ||
      systemProgram.isSigner ||
      systemProgram.isWritable
    ) {
      throw new GameTransactionValidationError("Invalid system program account");
    }

    const instructionData = decoded.data as Record<string, unknown>;
    const config = instructionData["config"] as { isPrivate?: boolean } | undefined;
    const isPrivate = config?.isPrivate === true;
    const randomHashValue = instructionData["randomHash"] ?? instructionData["_randomHash"];
    let randomHash: Buffer;
    try {
      if (!(randomHashValue instanceof Uint8Array) && !Array.isArray(randomHashValue)) {
        throw new TypeError("Random hash must be a byte array");
      }
      randomHash = Buffer.from(randomHashValue);
    } catch (error) {
      throw new GameTransactionValidationError("Invalid random hash", { cause: error });
    }
    if (randomHash.length !== 32) {
      throw new GameTransactionValidationError("Invalid random hash");
    }

    const expectedGame = this.completion.getGamePDA(randomHash);
    if (!game.pubkey.equals(expectedGame) || !game.isWritable) {
      throw new GameTransactionValidationError(
        "Game account does not match the committed random hash",
      );
    }

    const secret = this.db.getSecretKeyInfo(expectedGame.toBase58());
    if (!secret || secret.used || secret.randomHash !== randomHash.toString("hex")) {
      throw new GameTransactionValidationError("Random hash is not an unused oracle commitment");
    }

    const amountValue = instructionData["config"];
    const rawAmount = (amountValue as { amount?: unknown } | undefined)?.amount;
    let amount: bigint;
    try {
      if (rawAmount === undefined || rawAmount === null) throw new TypeError("Missing amount");
      amount = BigInt(String(rawAmount));
    } catch (error) {
      throw new GameTransactionValidationError("Invalid game amount", { cause: error });
    }
    this.assertCreationPolicy(tokenMint.pubkey, amount);

    const join = programInstructions[1];
    if (join) {
      if (!userSignedFirst)
        throw new GameTransactionValidationError(
          "Atomic creator join requires the creator to sign first",
        );
      let decodedJoin: ReturnType<anchor.BorshInstructionCoder["decode"]>;
      try {
        decodedJoin = new anchor.BorshInstructionCoder(this.program.idl).decode(join.data);
      } catch (error) {
        throw new GameTransactionValidationError("Invalid creator join instruction", {
          cause: error,
        });
      }
      if (!decodedJoin || decodedJoin.name !== "joinGame" || join.keys.length !== 10) {
        throw new GameTransactionValidationError("Invalid creator join instruction");
      }
      const joinGame = join.keys[0]!;
      const joinPlayer = join.keys[1]!;
      const optionalOperator = join.keys[2]!;
      const joinTokenMint = join.keys[3]!;
      const joinGameVault = join.keys[4]!;
      const joinGameVaultTokenAccount = join.keys[5]!;
      const joinTokenProgram = join.keys[6]!;
      const joinAssociatedTokenProgram = join.keys[7]!;
      const joinPlayerTokenAccount = join.keys[8]!;
      const joinOracle = join.keys[9]!;
      const hasExpectedOperator = isPrivate
        ? optionalOperator.pubkey.equals(this.operatorKeypair.publicKey) &&
          optionalOperator.isSigner &&
          !optionalOperator.isWritable
        : optionalOperator.pubkey.equals(this.program.programId) &&
          !optionalOperator.isSigner &&
          !optionalOperator.isWritable;
      if (!joinGame.pubkey.equals(game.pubkey) || !joinGame.isWritable)
        throw new GameTransactionValidationError("Creator join uses an invalid game account");
      if (
        !joinPlayer.pubkey.equals(creator.pubkey) ||
        !joinPlayer.isSigner ||
        !joinPlayer.isWritable
      )
        throw new GameTransactionValidationError("Creator join uses an invalid creator account");
      if (!hasExpectedOperator)
        throw new GameTransactionValidationError(
          "Creator join uses an invalid optional oracle operator",
        );
      if (
        !joinTokenMint.pubkey.equals(tokenMint.pubkey) ||
        joinTokenMint.isSigner ||
        joinTokenMint.isWritable
      )
        throw new GameTransactionValidationError(
          "Creator join token mint does not match initialization",
        );
      if (
        !joinGameVault.pubkey.equals(expectedGameVault) ||
        joinGameVault.isSigner ||
        joinGameVault.isWritable
      )
        throw new GameTransactionValidationError("Creator join uses an invalid game vault");
      if (
        !joinGameVaultTokenAccount.pubkey.equals(expectedGameVaultTokenAccount) ||
        joinGameVaultTokenAccount.isSigner ||
        !joinGameVaultTokenAccount.isWritable
      )
        throw new GameTransactionValidationError(
          "Creator join uses an invalid game vault token account",
        );
      if (
        !joinTokenProgram.pubkey.equals(TOKEN_PROGRAM_ID) ||
        joinTokenProgram.isSigner ||
        joinTokenProgram.isWritable
      )
        throw new GameTransactionValidationError("Creator join uses an invalid token program");
      if (
        !joinAssociatedTokenProgram.pubkey.equals(ASSOCIATED_TOKEN_PROGRAM_ID) ||
        joinAssociatedTokenProgram.isSigner ||
        joinAssociatedTokenProgram.isWritable
      )
        throw new GameTransactionValidationError(
          "Creator join uses an invalid associated token program",
        );
      if (
        !joinPlayerTokenAccount.pubkey.equals(expectedCreatorTokenAccount) ||
        joinPlayerTokenAccount.isSigner ||
        !joinPlayerTokenAccount.isWritable
      )
        throw new GameTransactionValidationError(
          "Creator join uses an invalid player token account",
        );
      if (!joinOracle.pubkey.equals(expectedOracle) || joinOracle.isSigner || joinOracle.isWritable)
        throw new GameTransactionValidationError("Creator join uses an invalid oracle account");
    }

    for (const instruction of transaction.instructions) {
      if (instruction === initialize || instruction === join) continue;
      if (
        !instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) &&
        !instruction.programId.equals(SystemProgram.programId) &&
        !instruction.programId.equals(TOKEN_PROGRAM_ID) &&
        !instruction.programId.equals(ComputeBudgetProgram.programId) &&
        !instruction.programId.equals(PHANTOM_LIGHTHOUSE_PROGRAM_ID) &&
        !instruction.programId.equals(PHANTOM_ASSERT_OWNER_PROGRAM_ID)
      ) {
        throw new GameTransactionValidationError(
          `Unsupported setup instruction in game transaction: ${instruction.programId.toBase58()}`,
        );
      }
      if (instruction.keys.some(({ pubkey }) => pubkey.equals(this.operatorKeypair.publicKey))) {
        throw new GameTransactionValidationError(
          "Oracle operator cannot be referenced by setup instructions",
        );
      }
    }

    // Transaction.from() retains an empty signature entry for the placeholder.
    // Once its account meta is replaced, that stale entry is an unknown signer
    // and must be removed before web3.js recompiles and signs the message.
    if (userSignedFirst) {
      const creatorSignature = transaction.signatures.find(({ publicKey }) =>
        publicKey.equals(creator.pubkey),
      )?.signature;
      if (!creatorSignature || !transaction.verifySignatures(false)) {
        throw new GameTransactionValidationError("Creator signature is missing or invalid");
      }
    } else if (oracleOperatorPlaceholder) {
      transaction.signatures = transaction.signatures.filter(
        ({ publicKey }) => !publicKey.equals(oracleOperatorPlaceholder),
      );
    }
    let serialized: string;
    try {
      transaction.partialSign(this.operatorKeypair);
      serialized = transaction.serialize({ requireAllSignatures: false }).toString("base64");
    } catch (error) {
      throw new GameTransactionValidationError("Transaction could not be signed", { cause: error });
    }
    this.db.markSecretKeySigned(expectedGame.toBase58());
    return serialized;
  }

  private assertCreationPolicy(tokenMint: PublicKey, amount: bigint): void {
    const mint = tokenMint.toBase58();
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
        minimumAmountRaw: policy.minimumAmountRaw,
        revision: policy.revision,
      });
    }
    if (amount < BigInt(policy.minimumAmountRaw)) {
      throw new CreationPolicyValidationError(
        "amount_below_minimum",
        "Game amount is below the token minimum",
        {
          mint,
          minimumAmountRaw: policy.minimumAmountRaw,
          revision: policy.revision,
        },
      );
    }
  }

  public getTokenPolicies(): TokenPolicy[] {
    return this.db.getTokenPolicies().map(toApiTokenPolicy);
  }

  public setTokenPolicy(mint: string, enabled: boolean, minimumAmountRaw: string): TokenPolicy {
    return toApiTokenPolicy(this.db.setTokenPolicy(mint, enabled, minimumAmountRaw));
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
    return new PublicKey(gameAddress);
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
