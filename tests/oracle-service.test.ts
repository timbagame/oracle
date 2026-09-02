import { beforeAll, afterAll, describe, it, expect, spyOn } from "bun:test";
import { resetPendingGames } from "./helpers/reset-pending-games.ts";
import { seedTrackedGame } from "./helpers/seed-tracked-game.ts";
import { setupOracleServiceEnv } from "./helpers/setup-oracle-service-env.ts";
import * as anchor from "@anchor-lang/core";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  deriveAssociatedTokenAddress,
} from "../token-program.ts";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import * as delayModule from "../delay.ts";
import type { TimbaGameAccount } from "../types/timba.ts";
import { GAME_VAULT_SEED } from "../oracle-accounts.ts";

type OracleServiceClass = typeof import("../oracle-service.ts").OracleService;
type OracleDatabaseClass = typeof import("../database.ts").OracleDatabase;
type OracleServiceInstance = ReturnType<OracleServiceClass["getInstance"]>;

function createGameAccountStub(overrides: Partial<TimbaGameAccount> = {}): TimbaGameAccount {
  return {
    creator: overrides.creator ?? Keypair.generate().publicKey,
    tokenMint: overrides.tokenMint ?? Keypair.generate().publicKey,
    ticketsCount: overrides.ticketsCount ?? 1,
    maxTickets: overrides.maxTickets ?? 1,
    minTickets: overrides.minTickets ?? 0,
    lastSlot: overrides.lastSlot ?? 0,
    timeout: overrides.timeout ?? 1,
    createdAt: overrides.createdAt ?? 1,
    ...overrides,
  };
}

const makeFakeContext = () => ({
  gamePda: Keypair.generate().publicKey,
  secretData: { secretKey: "aa".repeat(32), randomHash: "bb".repeat(32) },
  randomHashBuffer: Buffer.from("bb".repeat(32), "hex"),
  readiness: { ready: true, gameAccount: createGameAccountStub() },
});

const makeReadyResolution = () => {
  const context = makeFakeContext();
  return {
    status: "ready" as const,
    context,
    readiness: context.readiness,
    prefetchScheduled: false,
  };
};

function buildInitializeTransaction(
  service: OracleServiceInstance,
  options: { amount?: number; tokenMint?: PublicKey } = {},
) {
  const { randomHash, gameAddress } = service.generateGameSecrets({ gameType: "coinflip" });
  const program = (service as any).program as anchor.Program;
  const creator = Keypair.generate();
  const tokenMint = options.tokenMint ?? Keypair.generate().publicKey;
  const oracle = PublicKey.findProgramAddressSync([Buffer.from("oracle")], program.programId)[0];
  const gameVault = PublicKey.findProgramAddressSync(
    [GAME_VAULT_SEED, tokenMint.toBuffer()],
    program.programId,
  )[0];
  const gameVaultTokenAccount = deriveAssociatedTokenAddress(
    tokenMint,
    gameVault,
    true,
    TOKEN_PROGRAM_ID,
  );
  const creatorTokenAccount = deriveAssociatedTokenAddress(tokenMint, creator.publicKey);
  const instruction = new TransactionInstruction({
    programId: program.programId,
    data: new anchor.BorshInstructionCoder(program.idl).encode("initializeGame", {
      config: {
        gameType: { coinflip: {} },
        amount: new anchor.BN(options.amount ?? 1),
        maxTickets: 2,
        minTickets: 2,
        timeout: new anchor.BN(60),
        isPrivate: false,
      },
      randomHash: Array.from(Buffer.from(randomHash, "hex")),
    }),
    keys: [
      { pubkey: new PublicKey(gameAddress), isSigner: false, isWritable: true },
      { pubkey: creator.publicKey, isSigner: true, isWritable: true },
      { pubkey: oracle, isSigner: false, isWritable: false },
      { pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: false },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      { pubkey: gameVault, isSigner: false, isWritable: false },
      { pubkey: gameVaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: creatorTokenAccount, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });

  return {
    tokenMint,
    transaction: new Transaction({
      feePayer: creator.publicKey,
      recentBlockhash: PublicKey.default.toBase58(),
    }).add(instruction),
  };
}

function serializeUnsigned(transaction: Transaction): string {
  return transaction
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
}

async function captureError(
  operation: () => unknown | Promise<unknown>,
): Promise<Error & { code?: string }> {
  try {
    await operation();
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("Expected operation to throw");
}

let OracleService: OracleServiceClass;
let OracleDatabase: OracleDatabaseClass;
let testService: OracleServiceInstance;
let cleanup: () => void;

beforeAll(async () => {
  const env = await setupOracleServiceEnv("oracle-service-test");
  ({ OracleService, OracleDatabase } = env);
  testService = OracleService.createWith(OracleDatabase.getInstance(), {
    tokenPriceResolver: {
      getTokenUsdPrices: async (mints) => new Map(mints.map((mint) => [mint, 1])),
    },
  });
  cleanup = env.cleanup;
});

afterAll(() => {
  cleanup?.();
});

describe("OracleService", () => {
  it("enforces the current dynamic token policy with a five-percent grace band", async () => {
    const service = testService;
    service.cleanupOldRecords(-1);
    const db = OracleDatabase.getInstance();
    const { tokenMint, transaction } = buildInitializeTransaction(service);

    expect(
      await captureError(() => service.signGameTransaction(serializeUnsigned(transaction))),
    ).toMatchObject({ code: "unsupported_mint", message: "Token mint is not supported" });

    db.setTokenPolicy(tokenMint.toBase58(), false, "0");
    expect(
      await captureError(() => service.signGameTransaction(serializeUnsigned(transaction))),
    ).toMatchObject({ code: "token_disabled", message: "Token mint is disabled" });

    db.setTokenPolicy(tokenMint.toBase58(), true, "3");
    await expect(service.getTokenPolicies()).resolves.toContainEqual(
      expect.objectContaining({
        mint: tokenMint.toBase58(),
        minimumAmountRaw: "100",
        acceptedMinimumAmountRaw: "95",
      }),
    );
    expect(
      await captureError(() => service.signGameTransaction(serializeUnsigned(transaction))),
    ).toMatchObject({
      code: "amount_below_minimum",
      message: "Game amount is below the token minimum",
      details: { minimumAmountRaw: "100", acceptedMinimumAmountRaw: "95" },
    });

    const graceAmount = buildInitializeTransaction(service, { tokenMint, amount: 95 });
    await expect(
      service.signGameTransaction(serializeUnsigned(graceAmount.transaction)),
    ).resolves.toEqual(expect.any(String));

    const unavailable = buildInitializeTransaction(service, { tokenMint });
    const policyLookup = spyOn(db, "getTokenPolicy").mockImplementation(() => {
      throw new Error("database unavailable");
    });
    try {
      expect(
        await captureError(() =>
          service.signGameTransaction(serializeUnsigned(unavailable.transaction)),
        ),
      ).toMatchObject({
        code: "policy_unavailable",
        message: "Token creation policy is unavailable",
      });
    } finally {
      policyLookup.mockRestore();
    }
  });

  it("does not persist an enabled policy when its live price is unavailable", async () => {
    const db = OracleDatabase.getInstance();
    const mint = Keypair.generate().publicKey.toBase58();
    const service = OracleService.createWith(db, {
      tokenPriceResolver: {
        getTokenUsdPrices: async () => {
          throw new Error("price unavailable");
        },
      },
    });

    await expect(service.setTokenPolicy(mint, true, 6)).rejects.toThrow("price unavailable");
    expect(db.getTokenPolicy(mint)).toBeNull();
  });

  it("rejects durable-nonce initialization transactions", async () => {
    const service = testService;
    service.cleanupOldRecords(-1);
    const db = OracleDatabase.getInstance();
    const { tokenMint, transaction } = buildInitializeTransaction(service);
    const creator = transaction.feePayer!;
    db.setTokenPolicy(tokenMint.toBase58(), true, "0");
    transaction.instructions.unshift(
      SystemProgram.nonceAdvance({
        noncePubkey: Keypair.generate().publicKey,
        authorizedPubkey: creator,
      }),
    );

    await expect(service.signGameTransaction(serializeUnsigned(transaction))).rejects.toThrow(
      "Durable nonce transactions are not supported",
    );
  });

  it("continues to allow ordinary System Program setup instructions", async () => {
    const service = testService;
    service.cleanupOldRecords(-1);
    const db = OracleDatabase.getInstance();
    const { tokenMint, transaction } = buildInitializeTransaction(service);
    db.setTokenPolicy(tokenMint.toBase58(), true, "0");
    transaction.instructions.unshift(
      SystemProgram.transfer({
        fromPubkey: transaction.feePayer!,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    );

    await expect(service.signGameTransaction(serializeUnsigned(transaction))).resolves.toEqual(
      expect.any(String),
    );
  });

  it("rejects a v0.3 initialization with a substituted vault account", async () => {
    const service = testService;
    service.cleanupOldRecords(-1);
    const db = OracleDatabase.getInstance();
    const { tokenMint, transaction } = buildInitializeTransaction(service);
    db.setTokenPolicy(tokenMint.toBase58(), true, "0");
    transaction.instructions[0]!.keys[5]!.pubkey = Keypair.generate().publicKey;

    await expect(service.signGameTransaction(serializeUnsigned(transaction))).rejects.toThrow(
      "Invalid game vault account",
    );
  });

  it("replaces and signs a distinct initialize-game operator placeholder", async () => {
    const service = testService;
    service.cleanupOldRecords(-1);
    const { randomHash, gameAddress } = service.generateGameSecrets({ gameType: "coinflip" });
    const program = (service as any).program as anchor.Program;
    const operatorKeypair = (service as any).operatorKeypair as Keypair;
    const creator = Keypair.generate();
    const placeholder = Keypair.generate().publicKey;
    const oracle = PublicKey.findProgramAddressSync([Buffer.from("oracle")], program.programId)[0];
    const tokenMint = Keypair.generate().publicKey;
    const gameVault = PublicKey.findProgramAddressSync(
      [GAME_VAULT_SEED, tokenMint.toBuffer()],
      program.programId,
    )[0];
    const gameVaultTokenAccount = deriveAssociatedTokenAddress(
      tokenMint,
      gameVault,
      true,
      TOKEN_PROGRAM_ID,
    );
    const creatorTokenAccount = deriveAssociatedTokenAddress(tokenMint, creator.publicKey);
    OracleDatabase.getInstance().setTokenPolicy(tokenMint.toBase58(), true, "0");
    const data = new anchor.BorshInstructionCoder(program.idl).encode("initializeGame", {
      config: {
        gameType: { coinflip: {} },
        amount: new anchor.BN(1),
        maxTickets: 2,
        minTickets: 2,
        timeout: new anchor.BN(60),
        isPrivate: false,
      },
      randomHash: Array.from(Buffer.from(randomHash, "hex")),
    });
    const instruction = new TransactionInstruction({
      programId: program.programId,
      data,
      keys: [
        { pubkey: new PublicKey(gameAddress), isSigner: false, isWritable: true },
        { pubkey: creator.publicKey, isSigner: true, isWritable: true },
        { pubkey: oracle, isSigner: false, isWritable: false },
        { pubkey: placeholder, isSigner: true, isWritable: false },
        { pubkey: tokenMint, isSigner: false, isWritable: false },
        { pubkey: gameVault, isSigner: false, isWritable: false },
        { pubkey: gameVaultTokenAccount, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: creatorTokenAccount, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    });
    const transaction = new Transaction({
      feePayer: creator.publicKey,
      recentBlockhash: PublicKey.default.toBase58(),
    }).add(instruction);

    const signedBase64 = await service.signGameTransaction(
      transaction
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString("base64"),
    );
    const signed = Transaction.from(Buffer.from(signedBase64, "base64"));
    const signedInitialize = signed.instructions[0]!;

    expect(signedInitialize.keys[3]!.pubkey.equals(operatorKeypair.publicKey)).toBe(true);
    expect(signed.signatures.some(({ publicKey }) => publicKey.equals(placeholder))).toBe(false);
    expect(
      signed.signatures.find(({ publicKey }) => publicKey.equals(operatorKeypair.publicKey))
        ?.signature,
    ).not.toBeNull();
  });

  it("signs an atomic private-game creator join", async () => {
    const service = testService;
    service.cleanupOldRecords(-1);
    const { randomHash, gameAddress } = service.generateGameSecrets({ gameType: "coinflip" });
    const program = (service as any).program as anchor.Program;
    const operatorKeypair = (service as any).operatorKeypair as Keypair;
    const creator = Keypair.generate();
    const oracle = PublicKey.findProgramAddressSync([Buffer.from("oracle")], program.programId)[0];
    const tokenMint = Keypair.generate().publicKey;
    const gameVault = PublicKey.findProgramAddressSync(
      [GAME_VAULT_SEED, tokenMint.toBuffer()],
      program.programId,
    )[0];
    const gameVaultTokenAccount = deriveAssociatedTokenAddress(
      tokenMint,
      gameVault,
      true,
      TOKEN_PROGRAM_ID,
    );
    const creatorTokenAccount = deriveAssociatedTokenAddress(tokenMint, creator.publicKey);
    OracleDatabase.getInstance().setTokenPolicy(tokenMint.toBase58(), true, "0");
    const initialize = new TransactionInstruction({
      programId: program.programId,
      data: new anchor.BorshInstructionCoder(program.idl).encode("initializeGame", {
        config: {
          gameType: { coinflip: {} },
          amount: new anchor.BN(1),
          maxTickets: 2,
          minTickets: 2,
          timeout: new anchor.BN(60),
          isPrivate: true,
        },
        randomHash: Array.from(Buffer.from(randomHash, "hex")),
      }),
      keys: [
        { pubkey: new PublicKey(gameAddress), isSigner: false, isWritable: true },
        { pubkey: creator.publicKey, isSigner: true, isWritable: true },
        { pubkey: oracle, isSigner: false, isWritable: false },
        { pubkey: operatorKeypair.publicKey, isSigner: true, isWritable: false },
        { pubkey: tokenMint, isSigner: false, isWritable: false },
        { pubkey: gameVault, isSigner: false, isWritable: false },
        { pubkey: gameVaultTokenAccount, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: creatorTokenAccount, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    });
    const join = new TransactionInstruction({
      programId: program.programId,
      data: new anchor.BorshInstructionCoder(program.idl).encode("joinGame", {}),
      keys: [
        { pubkey: new PublicKey(gameAddress), isSigner: false, isWritable: true },
        { pubkey: creator.publicKey, isSigner: true, isWritable: true },
        { pubkey: operatorKeypair.publicKey, isSigner: true, isWritable: false },
        { pubkey: tokenMint, isSigner: false, isWritable: false },
        { pubkey: gameVault, isSigner: false, isWritable: false },
        { pubkey: gameVaultTokenAccount, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: creatorTokenAccount, isSigner: false, isWritable: true },
        { pubkey: oracle, isSigner: false, isWritable: false },
      ],
    });
    const transaction = new Transaction({
      feePayer: creator.publicKey,
      recentBlockhash: PublicKey.default.toBase58(),
    }).add(
      new TransactionInstruction({
        programId: new PublicKey("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95"),
        keys: [],
        data: Buffer.alloc(0),
      }),
      new TransactionInstruction({
        programId: new PublicKey("DeJBGdMFa1uynnnKiwrVioatTuHmNLpyFKnmB5kaFdzQ"),
        keys: [],
        data: Buffer.alloc(0),
      }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
      initialize,
      join,
    );
    transaction.partialSign(creator);
    const creatorSignature = transaction.signatures.find(({ publicKey }) =>
      publicKey.equals(creator.publicKey),
    )!.signature;

    const signed = Transaction.from(
      Buffer.from(
        await service.signGameTransaction(
          transaction
            .serialize({ requireAllSignatures: false, verifySignatures: false })
            .toString("base64"),
        ),
        "base64",
      ),
    );

    expect(
      signed.signatures.find(({ publicKey }) => publicKey.equals(creator.publicKey))?.signature,
    ).toEqual(creatorSignature);
    expect(
      signed.signatures.find(({ publicKey }) => publicKey.equals(operatorKeypair.publicKey))
        ?.signature,
    ).not.toBeNull();
  });

  it("generates secrets and stores them", () => {
    const service = OracleService.getInstance();
    service.cleanupOldRecords(-1);
    const { randomHash, gameAddress } = service.generateGameSecrets();
    expect(typeof randomHash).toBe("string");
    expect(typeof gameAddress).toBe("string");

    const db = OracleDatabase.getInstance();
    const stored = db.getSecretKey(gameAddress);
    expect(stored?.randomHash).toBe(randomHash);
  });

  it("persists provided game type when tracking new games", () => {
    const service = OracleService.getInstance();
    service.cleanupOldRecords(-1);
    const { gameAddress } = service.generateGameSecrets({ gameType: "coinflip" });

    const db = OracleDatabase.getInstance();
    expect(db.getGameType(gameAddress)).toBe("coinflip");
  });

  it("removes stored secrets when game tracking fails", () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();
    service.cleanupOldRecords(-1);

    const deleteSpy = spyOn(db, "deleteSecretKey");
    const trackSpy = spyOn(db, "trackGame").mockImplementation(() => {
      throw new Error("tracking failed");
    });

    try {
      expect(() => service.generateGameSecrets()).toThrow("tracking failed");
      expect(deleteSpy).toHaveBeenCalledTimes(1);
    } finally {
      trackSpy.mockRestore();
      deleteSpy.mockRestore();
      service.cleanupOldRecords(-1);
    }
  });

  it("cleans up records and reports stats", () => {
    const service = OracleService.getInstance();
    service.cleanupOldRecords(-1);
    const { gameAddress } = service.generateGameSecrets();
    const db = OracleDatabase.getInstance();
    db.markSecretKeyUsed(gameAddress);
    db.markGameCompleted(gameAddress);
    const cleanup = service.cleanupOldRecords(-1);
    expect(cleanup.deletedSecrets).toBeGreaterThan(0);

    const stats = service.getStats();
    expect(stats.usedSecrets).toBe(0);
    expect(stats.eventListening).toBe(false);
    expect(stats.activeListeners).toBe(0);
  });

  it("resolves stored games from secrets", () => {
    const service = OracleService.getInstance();
    service.cleanupOldRecords(-1);
    const { gameAddress } = service.generateGameSecrets();

    const resolved: any = service.completionManager.resolveStoredGame(gameAddress);
    expect(resolved?.gamePda.toBase58()).toBe(gameAddress);
    expect(resolved?.randomHashBuffer).toBeInstanceOf(Buffer);

    const fakeAddress = Keypair.generate().publicKey.toBase58();
    expect(service.completionManager.resolveStoredGame(fakeAddress)).toBeNull();
  });

  it("identifies account not found errors", () => {
    const service = OracleService.getInstance();
    const check = service.completionManager.isAccountNotFoundError.bind(service.completionManager);
    expect(check({ message: "Account does not exist" })).toBe(true);
    expect(check({ message: "Something else" })).toBe(false);
  });

  it("computes deterministic winner index", () => {
    const service = OracleService.getInstance();
    const secret = Buffer.alloc(32, 1);
    const winner = service.completionManager.calculateWinnerIndex(secret, 123456, 100);
    expect(winner).toBe(2);
    const single = service.completionManager.calculateWinnerIndex(secret, 123456, 1);
    expect(single).toBe(0);
    expect(() =>
      service.completionManager.calculateWinnerIndex(Buffer.alloc(16, 1), 123456, 2),
    ).toThrow("Secret key buffer must be at least 32 bytes");
  });

  it("updates scan statistics correctly", () => {
    const service = OracleService.getInstance();
    const stats = { completed: 0, errors: 0, notReady: 0 };
    service.scanRunner.updateScanStats(stats, { success: true });
    service.scanRunner.updateScanStats(stats, { success: false, notReady: true });
    service.scanRunner.updateScanStats(stats, { success: false });
    expect(stats).toEqual({ completed: 1, errors: 1, notReady: 1 });
  });

  it("returns zero stats when no games are pending", async () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();
    resetPendingGames(db, { service });

    const stats = await service.scanRunner.scanAndCompleteActiveGames();
    expect(stats).toEqual({ completed: 0, errors: 0, notReady: 0 });
  });

  it("scans pending games and records outcomes", async () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();
    resetPendingGames(db, { service });

    // success case
    seedTrackedGame(db, {
      address: "gameSuccess",
      secret: "secret",
      randomHash: "hash",
    });

    // not ready case
    seedTrackedGame(db, {
      address: "gamePending",
      secret: "secret",
      randomHash: "hash",
    });

    // game removed from chain
    seedTrackedGame(db, {
      address: "gameGone",
      secret: "secret",
      randomHash: "hash",
    });

    // error during completion
    seedTrackedGame(db, {
      address: "gameError",
      secret: "secret",
      randomHash: "hash",
    });

    const originalResolve = service.completionManager.resolveContextAndReadiness;
    const originalComplete = (service as any).completeGame;

    service.completionManager.resolveContextAndReadiness = async (addr: string) => {
      if (addr === "gameGone") {
        return { status: "missing-context" as const };
      }
      return makeReadyResolution();
    };

    (service as any).completeGame = async (addr: string) => {
      if (addr === "gameSuccess") {
        db.finalizeCompletedGame(addr);
        return { success: true };
      }
      if (addr === "gamePending") {
        return { success: false, notReady: true };
      }
      if (addr === "gameError") {
        throw new Error("boom");
      }
      throw new Error("unexpected game");
    };

    const stats = await service.scanRunner.scanAndCompleteActiveGames();
    expect(stats).toEqual({ completed: 1, errors: 1, notReady: 2 });

    // gameGone should STILL be pending due to retry logic
    const pending = db.getPendingGames().map((g) => g.game_address);
    expect(pending).toContain("gameGone");

    service.completionManager.resolveContextAndReadiness = originalResolve;
    (service as any).completeGame = originalComplete;
  });

  it("refreshes last_checked when a game remains not ready", async () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();
    resetPendingGames(db, { service });

    const gameAddress = "stubborn-game";
    seedTrackedGame(db, {
      address: gameAddress,
      secret: "secret",
      randomHash: "hash",
    });

    const sqlite = (db as any).db as {
      prepare: (sql: string) => {
        run: (...args: unknown[]) => void;
        get: (...args: unknown[]) => any;
      };
    };
    sqlite
      .prepare("UPDATE game_tracking SET last_checked = ? WHERE game_address = ?")
      .run(1, gameAddress);

    const getLastChecked = () => {
      const row = sqlite
        .prepare("SELECT last_checked FROM game_tracking WHERE game_address = ?")
        .get(gameAddress) as { last_checked: number } | undefined;
      return row?.last_checked ?? 0;
    };

    const lastCheckedBefore = getLastChecked();

    const context = makeFakeContext();
    const resolveSpy = spyOn(
      service.completionManager,
      "resolveContextAndReadiness",
    ).mockResolvedValue({
      status: "not-ready",
      context,
      readiness: context.readiness,
      prefetchScheduled: false,
    });
    const attemptSpy = spyOn(service as any, "attemptGameCompletion").mockResolvedValue({
      success: false,
      notReady: true,
    });

    try {
      const stats = await service.scanRunner.scanAndCompleteActiveGames();
      const lastCheckedAfter = getLastChecked();

      expect(stats.notReady).toBeGreaterThan(0);
      expect(lastCheckedAfter).toBeGreaterThan(lastCheckedBefore);
    } finally {
      resolveSpy.mockRestore();
      attemptSpy.mockRestore();
    }
  });

  it("backs off when completion attempt returns null", async () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();
    resetPendingGames(db, { service });

    const gameAddress = "in-flight";
    seedTrackedGame(db, {
      address: gameAddress,
      secret: "secret",
      randomHash: "hash",
    });

    const sqlite = (db as any).db as {
      prepare: (sql: string) => {
        run: (...args: unknown[]) => void;
        get: (...args: unknown[]) => any;
      };
    };
    sqlite
      .prepare("UPDATE game_tracking SET last_checked = ? WHERE game_address = ?")
      .run(1, gameAddress);

    const getLastChecked = () => {
      const row = sqlite
        .prepare("SELECT last_checked FROM game_tracking WHERE game_address = ?")
        .get(gameAddress) as { last_checked: number } | undefined;
      return row?.last_checked ?? 0;
    };

    const lastCheckedBefore = getLastChecked();

    const context = makeFakeContext();
    const resolveSpy = spyOn(
      service.completionManager,
      "resolveContextAndReadiness",
    ).mockResolvedValue({
      status: "ready",
      context,
      readiness: context.readiness,
      prefetchScheduled: false,
    });
    const attemptSpy = spyOn(service as any, "attemptGameCompletion").mockResolvedValue(null);

    try {
      const stats = await service.scanRunner.scanAndCompleteActiveGames();
      const lastCheckedAfter = getLastChecked();

      expect(stats).toEqual({ completed: 0, errors: 0, notReady: 0 });
      expect(lastCheckedAfter).toBeGreaterThan(lastCheckedBefore);
    } finally {
      resolveSpy.mockRestore();
      attemptSpy.mockRestore();
    }
  });

  it("skips games that exceed max completion attempts", async () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();
    resetPendingGames(db, { service });

    seedTrackedGame(db, {
      address: "stubborn",
      secret: "c".repeat(64),
      randomHash: "d".repeat(64),
    });
    for (let i = 0; i < 5; i++) {
      db.incrementCompletionAttempts("stubborn");
    }

    seedTrackedGame(db, {
      address: "active",
      secret: "e".repeat(64),
      randomHash: "f".repeat(64),
    });

    const originalResolve = service.completionManager.resolveContextAndReadiness;
    const originalComplete = (service as any).completeGame;

    const processed: string[] = [];
    let delayCalls = 0;

    service.completionManager.resolveContextAndReadiness = async () => makeReadyResolution();
    (service as any).completeGame = async (addr: string) => {
      processed.push(addr);
      return { success: true };
    };
    const delaySpy = spyOn(delayModule, "delay").mockImplementation(async () => {
      delayCalls++;
    });

    try {
      const stats = await service.scanRunner.scanAndCompleteActiveGames();
      expect(processed).toEqual(["active"]);
      expect(stats).toEqual({ completed: 1, errors: 0, notReady: 0 });
      expect(delayCalls).toBe(0);

      const stubbornEntry = db.getPendingGames().find((g) => g.game_address === "stubborn");
      expect(stubbornEntry?.completion_attempts).toBeGreaterThanOrEqual(5);
      expect(db.getPendingGames(5).some((entry) => entry.game_address === "stubborn")).toBe(false);
    } finally {
      service.completionManager.resolveContextAndReadiness = originalResolve;
      (service as any).completeGame = originalComplete;
      delaySpy.mockRestore();
    }
  });

  // loadOperatorKeypair rejects world-readable file
  it("rejects operator keypair file with insecure permissions", () => {
    const service = OracleService.getInstance();
    // Create a temporary keypair file
    const tempFile = `/tmp/insecure-keypair-${Date.now()}.json`;
    const fs = require("fs");
    fs.writeFileSync(tempFile, JSON.stringify(Array.from(Keypair.generate().secretKey)));

    try {
      // Set permissions to 777 (rwxrwxrwx)
      fs.chmodSync(tempFile, 0o777);

      // Attempt to read it using the private method
      // Note: readOperatorKeypairFromFile returns { keypair, error }.
      // It catches errors. So we check if it returns an error about permissions.

      const result = (service as any).readOperatorKeypairFromFile(tempFile);

      // We expect an error because of insecure permissions
      expect(result.error).toBeDefined();
      expect(String(result.error)).toMatch(/insecure permissions/i);
    } finally {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    }
  });
});

describe("OracleService shutdown", () => {
  it("close() stops event listeners, scanner, and closes database", async () => {
    const db = OracleDatabase.getInstance();
    const service = OracleService.createWith(db);

    // Track initial state
    const dbCloseSpy = spyOn(db, "close");
    const scannerStopSpy = spyOn(service.scanRunner, "stop");

    // Close the service
    await service.close();

    // Verify all components were properly shutdown
    expect(scannerStopSpy).toHaveBeenCalledTimes(1);
    expect(dbCloseSpy).toHaveBeenCalledTimes(1);
  });

  it("close() closes database even after stopping event listeners", async () => {
    const db = OracleDatabase.getInstance();
    const service = OracleService.createWith(db);

    const closeOrder: string[] = [];
    const dbCloseSpy = spyOn(db, "close").mockImplementation(() => {
      closeOrder.push("db.close");
    });
    const scannerStopSpy = spyOn(service.scanRunner, "stop").mockImplementation(() => {
      closeOrder.push("scanner.stop");
    });
    const stopEventSpy = spyOn(service, "stopEventListening").mockImplementation(async () => {
      closeOrder.push("stopEventListening");
    });

    await service.close();

    // Verify order: event listeners first, then scanner, then database
    expect(closeOrder).toEqual(["stopEventListening", "scanner.stop", "db.close"]);

    dbCloseSpy.mockRestore();
    scannerStopSpy.mockRestore();
    stopEventSpy.mockRestore();
  });

  it("close() ensures database flush after game secrets generation", async () => {
    const db = OracleDatabase.getInstance();
    const service = OracleService.createWith(db);
    service.cleanupOldRecords(-1);

    // Generate a game (writes to database)
    const { gameAddress } = service.generateGameSecrets({ gameType: "coinflip" });

    // Verify game is tracked before close
    expect(db.getGameStatus(gameAddress)).toBe("pending");
    expect(db.getSecretKey(gameAddress)).not.toBeNull();

    // Close should flush all pending writes
    await service.close();

    // Verify db is closed
    expect(db.getConnectionInfo().isOpen).toBe(false);
  });
});
