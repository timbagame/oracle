import { beforeAll, afterAll, describe, it, expect, spyOn } from "bun:test";
import { resetPendingGames } from "./helpers/reset-pending-games.ts";
import { seedTrackedGame } from "./helpers/seed-tracked-game.ts";
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as crypto from "crypto";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { deriveGameAccounts, createEmptyCompletionStats } from "../oracle-service.ts";
import { OracleMetricsRecorder } from "../metrics.ts";
import { resetConfigForTesting } from "../config.ts";
import type { TimbaGameAccount } from "../types/timba.ts";
import type { GameReadinessSnapshot } from "../oracle-service.types.ts";
import * as delayModule from "../delay.ts";
import { setupOracleServiceEnv } from "./helpers/setup-oracle-service-env.ts";
import { createProgramStub } from "./helpers/program-stub.ts";

let OracleService: typeof import("../oracle-service.ts").OracleService;
let OracleDatabase: typeof import("../database.ts").OracleDatabase;
let cleanup: () => void;

beforeAll(async () => {
  ({ OracleService, OracleDatabase, cleanup } = await setupOracleServiceEnv(
    "oracle-service-extra-test",
  ));
});

afterAll(() => {
  cleanup();
});

function createGameAccountStub(
  overrides: Partial<TimbaGameAccount> = {}
): TimbaGameAccount {
  return {
    creator: overrides.creator ?? Keypair.generate().publicKey,
    tokenMint: overrides.tokenMint ?? Keypair.generate().publicKey,
    tokenProgram: overrides.tokenProgram ?? TOKEN_PROGRAM_ID,
    ticketsCount: overrides.ticketsCount ?? 1,
    maxTickets: overrides.maxTickets ?? 1,
    minTickets: overrides.minTickets ?? 0,
    lastSlot: overrides.lastSlot ?? 0,
    timeout: overrides.timeout ?? 1,
    createdAt: overrides.createdAt ?? 1,
    ...overrides,
  };
}

function createReadyContext(overrides: {
  gameAccount?: TimbaGameAccount;
  secretKey?: string;
  randomHash?: string;
} = {}) {
  const gameAccount = overrides.gameAccount ?? createGameAccountStub();
  const secretKey = overrides.secretKey ?? "aa".repeat(32);
  const randomHash = overrides.randomHash ?? "bb".repeat(32);

  return {
    context: {
      gamePda: Keypair.generate().publicKey,
      secretData: { secretKey, randomHash },
      randomHashBuffer: Buffer.from(randomHash, "hex"),
    },
    readiness: {
      ready: true,
      gameAccount,
    },
  } as const;
}

async function runExecuteGameCompletionScenario({
  tokenProgram,
  mintOwner,
  accountInfoImpl,
}: {
  tokenProgram?: PublicKey | string | null;
  mintOwner?: PublicKey;
  accountInfoImpl?: (pubkey: PublicKey) => Promise<{ owner: PublicKey | null } | null>;
} = {}) {
  const service = OracleService.createWith(OracleDatabase.getInstance());
  const originalProgram = (service as any).program;
  const originalConfirm = (service as any).confirmTransaction;
  const originalConnection = (service as any).connection;
  const adminKeypair = (service as any).adminKeypair;
  const winner = Keypair.generate().publicKey;
  const creator = Keypair.generate().publicKey;
  const programId = Keypair.generate().publicKey;
  const tokenMint = Keypair.generate().publicKey;
  const randomHashBuffer = Buffer.alloc(32, 1);
  const secretKeyBuffer = Buffer.alloc(32, 2);
  const calls: { accounts?: any; signers?: any[]; confirmed?: string } = {};
  let directProgram: PublicKey | null = null;

  if (tokenProgram instanceof PublicKey) {
    directProgram = tokenProgram;
  } else if (typeof tokenProgram === "string") {
    directProgram = new PublicKey(tokenProgram);
  } else if (tokenProgram) {
    directProgram = new PublicKey(tokenProgram);
  }

  if (directProgram?.equals(PublicKey.default)) {
    directProgram = null;
  }

  const inferredMintOwner = mintOwner ?? TOKEN_PROGRAM_ID;
  const tokenProgramId = directProgram ?? inferredMintOwner;

  const getAccountInfo = accountInfoImpl
    ? accountInfoImpl
    : async () => ({ owner: inferredMintOwner });

  (service as any).connection = {
    getAccountInfo,
  };

  const programStub = createProgramStub({
    programId,
    overrides: {
      methods: {
        completeGame: (_rand: number[], _secret: number[], winnerIndex: number) => {
          expect(winnerIndex).toBe(5);
          return {
            accountsPartial: (accs: any) => {
              calls.accounts = accs;
              return {
                signers: (signers: any[]) => {
                  calls.signers = signers;
                  return {
                    rpc: async () => "tx-abc",
                  };
                },
              };
            },
          };
        },
      },
    },
  });

  (service as any).program = programStub;

  (service as any).confirmTransaction = async (sig: string) => {
    calls.confirmed = sig;
  };

  let tx = "";

  try {
    const gameAccount: Record<string, unknown> = {
      creator: creator.toBase58(),
      tokenMint: tokenMint.toBase58(),
    };

    if (tokenProgram !== undefined) {
      gameAccount["tokenProgram"] = tokenProgram;
    }

    tx = await service.completionManager.executeGameCompletion({
      gameAccount,
      winnerAddress: winner,
      randomHashBuffer,
      secretKeyBuffer,
      winnerIndex: 5,
    });
  } finally {
    (service as any).program = originalProgram;
    (service as any).confirmTransaction = originalConfirm;
    (service as any).connection = originalConnection;
  }

  const derived = deriveGameAccounts({
    programId,
    randomHash: randomHashBuffer,
    tokenMint,
    winner,
    tokenProgramId,
  });

  return {
    tx,
    calls,
    expectedGamePda: derived.gamePda,
    expectedOraclePda: derived.oraclePda,
    expectedGameTokenPda: derived.gameTokenPda,
    expectedGameVaultPda: derived.gameVaultPda,
    expectedWinnerAta: derived.winnerTokenAccount,
    expectedGameAta: derived.gameTokenAccount,
    expectedTokenProgram: tokenProgramId,
    oracleOperator: adminKeypair.publicKey,
    winner,
    creator,
    tokenMint,
    adminKeypair,
  };
}

describe("OracleService internals", () => {
  it("caches blockchain time within a scan sweep", async () => {
    const db = OracleDatabase.getInstance();
    const service = OracleService.createWith(db);

    resetPendingGames(db, { service });

    seedTrackedGame(db, {
      address: "cache-game-1",
      secret: "aa".repeat(64),
      randomHash: "bb".repeat(64),
      service,
    });
    seedTrackedGame(db, {
      address: "cache-game-2",
      secret: "cc".repeat(64),
      randomHash: "dd".repeat(64),
      service,
    });

    const blockTimes: number[] = [];
    const blockSpy = spyOn(service.completionManager, "getBlockchainTime").mockImplementation(
      async () => {
        const value = 1_000 + blockTimes.length;
        blockTimes.push(value);
        return value;
      }
    );

    const observedBlockTimes: Array<number | undefined> = [];
    const resolveSpy = spyOn(
      service.completionManager,
      "resolveContextAndReadiness"
    ).mockImplementation(async (_address: string, options: any) => {
      observedBlockTimes.push(options?.blockTime);
      return {
        context: {
          gamePda: Keypair.generate().publicKey,
          secretData: { secretKey: "ee".repeat(64), randomHash: "ff".repeat(64) },
          randomHashBuffer: Buffer.alloc(32, 0),
        },
        readiness: { ready: true, gameAccount: createGameAccountStub() },
        notReady: false,
      };
    });

    const attemptSpy = spyOn(service as any, "attemptGameCompletion").mockImplementation(
      async ({ gameAddress }: { gameAddress: string }) => ({
        success: true,
        txHash: `${gameAddress}-tx`,
      })
    );

    try {
      const stats = await service.scanRunner.scanAndCompleteActiveGames();
      expect(stats).toEqual({ completed: 2, errors: 0, notReady: 0 });
      expect(blockTimes).toHaveLength(1);
      expect(new Set(observedBlockTimes)).toEqual(new Set([blockTimes[0]]));
      expect(attemptSpy).toHaveBeenCalledTimes(2);
    } finally {
      blockSpy.mockRestore();
      resolveSpy.mockRestore();
      attemptSpy.mockRestore();
    }
  });

  it("honors configurable throttle only for non-successful results", async () => {
    process.env["ORACLE_SCAN_THROTTLE_MS"] = "25";
    resetConfigForTesting();
    const db = OracleDatabase.getInstance();
    const service = OracleService.createWith(db);

    resetPendingGames(db, { service });

    seedTrackedGame(db, {
      address: "throttle-1",
      secret: "11".repeat(32),
      randomHash: "22".repeat(32),
      service,
    });
    seedTrackedGame(db, {
      address: "throttle-2",
      secret: "33".repeat(32),
      randomHash: "44".repeat(32),
      service,
    });
    seedTrackedGame(db, {
      address: "throttle-3",
      secret: "55".repeat(32),
      randomHash: "66".repeat(32),
      service,
    });

    const delayCalls: number[] = [];
    const delaySpy = spyOn(delayModule, "delay").mockImplementation(async (ms: number) => {
      delayCalls.push(ms);
    });

    const blockSpy = spyOn(service.completionManager, "getBlockchainTime").mockResolvedValue(5_000);

    let completionIndex = 0;
    const outcomes = [
      { success: true },
      { success: false, error: "rate limit" },
      { success: true },
    ];

    const resolveSpy = spyOn(
      service.completionManager,
      "resolveContextAndReadiness"
    ).mockImplementation(async () => ({
      context: {
        gamePda: Keypair.generate().publicKey,
        secretData: { secretKey: "aa".repeat(64), randomHash: "bb".repeat(64) },
        randomHashBuffer: Buffer.alloc(32, 0),
      },
      readiness: { ready: true, gameAccount: createGameAccountStub() },
      notReady: false,
    }));

    const attemptSpy = spyOn(service as any, "attemptGameCompletion").mockImplementation(
      async () => outcomes[completionIndex++] ?? { success: true }
    );

    try {
      const stats = await service.scanRunner.scanAndCompleteActiveGames();
      expect(stats).toEqual({ completed: 2, errors: 1, notReady: 0 });
      expect(delayCalls).toEqual([25]);
      expect(attemptSpy).toHaveBeenCalledTimes(3);
    } finally {
      delete process.env["ORACLE_SCAN_THROTTLE_MS"];
      resetConfigForTesting();
      delaySpy.mockRestore();
      blockSpy.mockRestore();
      resolveSpy.mockRestore();
      attemptSpy.mockRestore();
    }
  });

  it("memoizes token program resolution and supports cache reset", async () => {
    const service = OracleService.createWith(OracleDatabase.getInstance());
    const originalConnection = (service as any).connection;
    const tokenMint = Keypair.generate().publicKey;
    const callLog: string[] = [];

    (service as any).connection = {
      getAccountInfo: async (mint: PublicKey) => {
        callLog.push(mint.toBase58());
        return { owner: TOKEN_PROGRAM_ID };
      },
    };

    try {
      service.completionManager.clearTokenProgramCache();
      const first = await service.completionManager.resolveTokenProgram(null, tokenMint);
      const second = await service.completionManager.resolveTokenProgram(null, tokenMint);
      expect(first.equals(TOKEN_PROGRAM_ID)).toBe(true);
      expect(second.equals(TOKEN_PROGRAM_ID)).toBe(true);
      expect(callLog).toHaveLength(1);

      service.completionManager.clearTokenProgramCache();
      await service.completionManager.resolveTokenProgram(null, tokenMint);
      expect(callLog).toHaveLength(2);
    } finally {
      (service as any).connection = originalConnection;
      service.completionManager.clearTokenProgramCache();
    }
  });

  it("removes previously registered listeners when setup fails", async () => {
    const service = OracleService.createWith(OracleDatabase.getInstance());
    const originalProgram = (service as any).program;
    const removed: number[] = [];
    let callIndex = 0;

    (service as any).program = {
      addEventListener: async () => {
        if (callIndex === 1) {
          throw new Error("listener boom");
        }
        const id = 100 + callIndex;
        callIndex += 1;
        return id;
      },
      removeEventListener: async (id: number) => {
        removed.push(id);
      },
    };

    try {
      await expect(service.events.setupEventListeners()).rejects.toThrow("listener boom");
      expect(removed).toEqual([100]);
    } finally {
      (service as any).program = originalProgram;
    }
  });

  it("retries token program resolution after transient failures without caching", async () => {
    const service = OracleService.createWith(OracleDatabase.getInstance());
    const originalConnection = (service as any).connection;
    const tokenMint = Keypair.generate().publicKey;
    const callLog: string[] = [];
    let shouldFail = true;

    (service as any).connection = {
      getAccountInfo: async (mint: PublicKey) => {
        callLog.push(mint.toBase58());
        if (shouldFail) {
          shouldFail = false;
          throw new Error("rpc unavailable");
        }

        return { owner: TOKEN_2022_PROGRAM_ID };
      },
    };

    try {
      service.completionManager.clearTokenProgramCache();

      await expect(
        service.completionManager.resolveTokenProgram(null, tokenMint)
      ).rejects.toThrow("Unable to resolve token program");
      expect(callLog).toHaveLength(1);

      const second = await service.completionManager.resolveTokenProgram(null, tokenMint);
      expect(second.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
      expect(callLog).toHaveLength(2);

      const third = await service.completionManager.resolveTokenProgram(null, tokenMint);
      expect(third.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
      expect(callLog).toHaveLength(2);
    } finally {
      (service as any).connection = originalConnection;
      service.completionManager.clearTokenProgramCache();
    }
  });

  it("isGameReadyForCompletion returns false and marks completed if account missing", async () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();
    const addr = Keypair.generate().publicKey.toBase58();
    db.trackGame(addr);
    (service as any).program = createProgramStub({
      fetchImpl: async () => {
        const e: any = new Error("Account does not exist");
        e.message = "Account does not exist";
        throw e;
      },
    });
    const res = await service.completionManager.isGameReadyForCompletion(new PublicKey(addr));
    expect(res).toBe(false);
    // now pending list should not contain addr since marked completed
    const pending = db.getPendingGames().map((g) => g.game_address);
    expect(pending.includes(addr)).toBe(false);
  });

  it("isGameReadyForCompletion reports readiness for full and expired lobbies", async () => {
    const service = OracleService.getInstance();
    const originalProgram = (service as any).program;
    const originalConnection = (service as any).connection;

    const now = Math.floor(Date.now() / 1000);
    (service as any).connection = {
      getSlot: async () => 123,
      getBlockTime: async () => now,
    };

    try {
      (service as any).program = createProgramStub({
        fetchImpl: async () => ({
          ticketsCount: 4,
          maxTickets: 4,
          minTickets: 1,
          timeout: 60,
          createdAt: now - 30,
        }),
      });

      const fullReady = await service.completionManager.isGameReadyForCompletion(
        new PublicKey(Keypair.generate().publicKey.toBytes()),
      );
      expect(fullReady).toBe(true);

      (service as any).program = createProgramStub({
        fetchImpl: async () => ({
          ticketsCount: 2,
          maxTickets: 10,
          minTickets: 2,
          timeout: 60,
          createdAt: now - 120,
        }),
      });

      const expiredReady = await service.completionManager.isGameReadyForCompletion(
        new PublicKey(Keypair.generate().publicKey.toBytes()),
      );
      expect(expiredReady).toBe(true);
    } finally {
      (service as any).program = originalProgram;
      (service as any).connection = originalConnection;
    }
  });

  it("runScanLoop respects abort signals, cleanup retention, and callbacks", async () => {
    const db = OracleDatabase.getInstance();
    const service = OracleService.createWith(db);

    const scanner = (service as any).scanner;
    const originalScan = scanner.scanAndCompleteActiveGames;
    const originalCleanup = (service as any).cleanupOldRecords;

    const statsSequence = [
      { completed: 0, errors: 0, notReady: 1 },
      createEmptyCompletionStats(),
    ];

    const scanCalls: Array<{ completed: number; errors: number; notReady: number }> = [];
    const cleanupCalls: number[] = [];
    const cycleStarts: number[] = [];
    const cycleCompletions: Array<{ cycle: number; stats: { completed: number; errors: number; notReady: number } }> = [];

    scanner.scanAndCompleteActiveGames = async () => {
      const next =
        statsSequence[scanCalls.length] ?? createEmptyCompletionStats();
      scanCalls.push(next);
      return next;
    };

    (service as any).cleanupOldRecords = (hours: number) => {
      cleanupCalls.push(hours);
      return { deletedSecrets: 0, deletedGames: 0, deletedPlayers: 0 };
    };

    const abortController = new AbortController();

    try {
      const summaryPromise = service.scanRunner.runScanLoop({
        waitBetweenCyclesMs: 50,
        cleanupAfterCycleHours: 6,
        shouldContinue: (_stats, cycle) => cycle < 3,
        signal: abortController.signal,
        onCycleStart: (cycle) => {
          cycleStarts.push(cycle);
        },
        onCycleComplete: (cycle, stats) => {
          cycleCompletions.push({ cycle, stats });
          if (cycle === 2) {
            setTimeout(() => abortController.abort(), 10);
          }
        },
      });

      const summary = await summaryPromise;
      const finalStats = statsSequence[1]!;

      expect(scanCalls).toHaveLength(2);
      expect(cycleStarts).toEqual([1, 2]);
      expect(cycleCompletions.map((item) => item.cycle)).toEqual([1, 2]);
      expect(cleanupCalls).toEqual([6, 6]);
      expect(summary).toEqual({
        cycles: 2,
        totalCompleted: 0,
        totalErrors: 0,
        totalNotReady: 1,
        lastStats: finalStats,
      });
    } finally {
      scanner.scanAndCompleteActiveGames = originalScan;
      (service as any).cleanupOldRecords = originalCleanup;
    }
  });

  it("runScanLoop continues when only errors occur by default", async () => {
    const service = OracleService.createWith(OracleDatabase.getInstance());

    const scanner = (service as any).scanner;
    const originalScan = scanner.scanAndCompleteActiveGames;

    const firstStats = { completed: 0, errors: 1, notReady: 0 };
    const secondStats = createEmptyCompletionStats();
    let callCount = 0;

    scanner.scanAndCompleteActiveGames = async () => {
      const next = callCount === 0 ? firstStats : secondStats;
      callCount += 1;
      return next;
    };

    try {
      const summary = await service.scanRunner.runScanLoop({ waitBetweenCyclesMs: 0 });

      expect(callCount).toBe(2);
      expect(summary).toEqual({
        cycles: 2,
        totalCompleted: 0,
        totalErrors: 1,
        totalNotReady: 0,
        lastStats: secondStats,
      });
    } finally {
      scanner.scanAndCompleteActiveGames = originalScan;
    }
  });

  it("runScanLoop waits between cycles when pending-only mode sees only errors", async () => {
    const service = OracleService.createWith(OracleDatabase.getInstance());

    const scanner = (service as any).scanner;
    const originalScan = scanner.scanAndCompleteActiveGames;

    const delaySpy = spyOn(delayModule, "delay").mockImplementation(async () => {});

    const firstStats = { completed: 0, errors: 2, notReady: 0 };
    const secondStats = createEmptyCompletionStats();
    let callCount = 0;

    scanner.scanAndCompleteActiveGames = async () => {
      const next = callCount === 0 ? firstStats : secondStats;
      callCount += 1;
      return next;
    };

    try {
      const summary = await service.scanRunner.runScanLoop({
        waitBetweenCyclesMs: 50,
        waitForPendingOnly: true,
      });

      expect(callCount).toBe(2);
      expect(delaySpy).toHaveBeenCalledTimes(1);
      expect(delaySpy).toHaveBeenCalledWith(50, { signal: undefined });
      expect(summary).toEqual({
        cycles: 2,
        totalCompleted: 0,
        totalErrors: 2,
        totalNotReady: 0,
        lastStats: secondStats,
      });
    } finally {
      delaySpy.mockRestore();
      scanner.scanAndCompleteActiveGames = originalScan;
    }
  });

  it("resolveContextAndReadiness consumes cached readiness when on-chain lookups are optional", async () => {
    const db = OracleDatabase.getInstance();
    const service = OracleService.createWith(db);

    resetPendingGames(db, { service });

    const gameAddress = Keypair.generate().publicKey.toBase58();
    seedTrackedGame(db, {
      address: gameAddress,
      secret: "aa".repeat(32),
      randomHash: "bb".repeat(32),
      service,
    });

    const completion = service.completionManager;
    const originalProgram = (service as any).program;
    const originalConnection = (service as any).connection;
    const originalGetBlockchainTime = service.completionManager.getBlockchainTime;

    const cachedSnapshot: GameReadinessSnapshot = {
      ready: true,
      gameAccount: createGameAccountStub({ ticketsCount: 4 }),
    };

    (service as any).readinessCache.set(gameAddress, cachedSnapshot);

    const now = Math.floor(Date.now() / 1000);

    (service as any).program = createProgramStub({
      fetchImpl: async () => ({
        ticketsCount: 4,
        maxTickets: 4,
        minTickets: 1,
        timeout: 60,
        createdAt: now - 30,
      }),
    });

    (service as any).connection = {
      getSlot: async () => 12345,
      getBlockTime: async () => now,
    };

    service.completionManager.getBlockchainTime = async () => now;

    const evaluateSpy = spyOn(completion as any, "evaluateAndCacheReadiness");

    try {
      const first = await service.completionManager.resolveContextAndReadiness(gameAddress, {
        requireOnChain: false,
      });

      expect(first.readiness).toBe(cachedSnapshot);
      expect(first.context?.readiness).toBe(cachedSnapshot);
      expect(first.notReady).toBe(false);
      expect(evaluateSpy).not.toHaveBeenCalled();
      expect((service as any).readinessCache.has(gameAddress)).toBe(false);

      const second = await service.completionManager.resolveContextAndReadiness(gameAddress, {
        requireOnChain: false,
      });

      expect(evaluateSpy).toHaveBeenCalledTimes(1);
      expect(second.readiness?.ready).toBe(true);
      expect(second.notReady).toBe(false);
      expect(second.context?.readiness).toBe(second.readiness);
    } finally {
      evaluateSpy.mockRestore();
      (service as any).program = originalProgram;
      (service as any).connection = originalConnection;
      service.completionManager.getBlockchainTime = originalGetBlockchainTime;
      (service as any).readinessCache.clear();
      resetPendingGames(db, { service });
    }
  });

  it("fails game completion when unbiased winner selection is impossible", async () => {
    const db = OracleDatabase.getInstance();
    const service = OracleService.createWith(db);
    const completion = service.completionManager;

    const createHashSpy = spyOn(crypto, "createHash").mockImplementation(() => {
      return {
        update() {
          return {
            digest() {
              return Buffer.alloc(64, 0xff);
            },
          };
        },
      } as unknown as crypto.Hash;
    });

    const secretBuffer = Buffer.alloc(32, 1);
    const gameAddr = "failing-game";

    seedTrackedGame(db, {
      service,
      address: gameAddr,
      secret: "aa".repeat(32),
      randomHash: "bb".repeat(32),
      players: [
        { address: Keypair.generate().publicKey.toBase58(), ticketIndex: 0 },
        { address: Keypair.generate().publicKey.toBase58(), ticketIndex: 1 },
        { address: Keypair.generate().publicKey.toBase58(), ticketIndex: 2 },
      ],
    });

    try {
      expect(() => service.completionManager.calculateWinnerIndex(secretBuffer, 42, 3)).toThrow(
        "Unable to generate unbiased random number - game must be cancelled",
      );

      const incrementSpy = spyOn(db, "incrementCompletionAttempts");
      const finalizeSpy = spyOn(db, "finalizeCompletedGame");
      const ready = createReadyContext({
        gameAccount: createGameAccountStub({
          ticketsCount: 3,
          lastSlot: 99,
        }),
      });

      const originalResolve = completion.resolveContextAndReadiness;
      completion.resolveContextAndReadiness = async () => ({
        ...ready,
        notReady: false,
      });

      const result = await service.completeGame(gameAddr);

      expect(result).toEqual({
        success: false,
        error: "Unable to generate unbiased random number - game must be cancelled",
      });
      expect(incrementSpy).toHaveBeenCalledWith(gameAddr);
      expect(finalizeSpy).not.toHaveBeenCalled();

      completion.resolveContextAndReadiness = originalResolve;
      incrementSpy.mockRestore();
      finalizeSpy.mockRestore();
    } finally {
      createHashSpy.mockRestore();
    }
  });

  it("completeGame error cases: missing secret, not ready, no players", async () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();
    service.cleanupOldRecords(-1);

    // missing secret
    let res = await service.completeGame("no-secret");
    expect(res.success).toBe(false);

    // not ready
    db.saveSecretKey("not-ready", "deadbeef", "bead");
    // ensure programId exists for PDA derivation inside completeGame
    (service as any).program = createProgramStub({
      programId: Keypair.generate().publicKey,
      fetchImpl: async () => ({
        ticketsCount: 1,
        maxTickets: 10,
        minTickets: 1,
        lastSlot: 1,
        createdAt: 0n,
        timeout: 10_000n,
      }),
    });
    const completion = service.completionManager;
    const originalEvaluateReadiness = completion.evaluateGameReadiness;
    completion.evaluateGameReadiness = async () => ({
      ready: false,
      gameAccount: createGameAccountStub(),
    });
    res = await service.completeGame("not-ready");
    expect(res.notReady).toBe(true);
    completion.evaluateGameReadiness = originalEvaluateReadiness;

    // no players
    db.saveSecretKey("no-players", "deadbeef", "bead");
    // stub fetch to provide meta for winner calc
    (service as any).program = createProgramStub({
      programId: Keypair.generate().publicKey,
      fetchImpl: async () => ({
        ticketsCount: 1,
        maxTickets: 1,
        minTickets: 1,
        lastSlot: 1,
        createdAt: 0n,
        timeout: 0n,
      }),
    });
    res = await service.completeGame("no-players");
    expect(res.success).toBe(false);
    expect(String(res.error || "")).toContain("No players");
  });

  it("completeGame success path marks DB and returns tx hash", async () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();
    const gameAddr = "ok-game";
    const players = [
      { address: Keypair.generate().publicKey.toBase58(), ticketIndex: 0 },
      { address: Keypair.generate().publicKey.toBase58(), ticketIndex: 1 },
    ];
    seedTrackedGame(db, {
      service,
      address: gameAddr,
      secret: "a".repeat(64),
      randomHash: "b".repeat(64),
      players,
    });
    const completion = service.completionManager;
    const originalResolve = completion.resolveContextAndReadiness;
    const originalExecute = completion.executeGameCompletion;

    completion.resolveContextAndReadiness = async () => ({
      context: {
        gamePda: Keypair.generate().publicKey,
        secretData: { secretKey: "a".repeat(64), randomHash: "b".repeat(64) },
        randomHashBuffer: Buffer.from("b".repeat(64), "hex"),
      },
      readiness: {
        ready: true,
        gameAccount: createGameAccountStub({
          ticketsCount: BigInt(2) as unknown as number,
          lastSlot: 123,
        }) as any,
      },
      notReady: false,
    });

    (service as any).program = createProgramStub({
      programId: Keypair.generate().publicKey,
      fetchImpl: async () => ({
        ticketsCount: 2,
        maxTickets: 2,
        minTickets: 1,
        lastSlot: 123,
      }),
    });

    completion.executeGameCompletion = async () => "tx123";

    try {
      const res = await service.completeGame(gameAddr);
      expect(res.success).toBe(true);
      expect(res.txHash).toBe("tx123");
      // secret should be marked used
      expect(db.getSecretKey(gameAddr)).toBeNull();
    } finally {
      completion.resolveContextAndReadiness = originalResolve;
      completion.executeGameCompletion = originalExecute;
    }
  });

  it("completeGame aborts when ticket registry is out of sync", async () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();
    const gameAddr = "mismatch-game";
    seedTrackedGame(db, {
      service,
      address: gameAddr,
      secret: "a".repeat(64),
      randomHash: "c".repeat(64),
      players: [
        { address: Keypair.generate().publicKey.toBase58(), ticketIndex: 0 },
      ],
    });

    const completion = service.completionManager;
    const originalResolve = completion.resolveContextAndReadiness;

    completion.resolveContextAndReadiness = async () => ({
      context: {
        gamePda: Keypair.generate().publicKey,
        secretData: { secretKey: "a".repeat(64), randomHash: "c".repeat(64) },
        randomHashBuffer: Buffer.from("c".repeat(64), "hex"),
      },
      readiness: {
        ready: true,
        gameAccount: createGameAccountStub({ ticketsCount: 2, lastSlot: 456 }) as any,
      },
      notReady: false,
    });

    (service as any).program = createProgramStub({
      programId: Keypair.generate().publicKey,
      fetchImpl: async () => ({
        ticketsCount: 2,
        maxTickets: 2,
        minTickets: 1,
        lastSlot: 456,
      }),
    });

    try {
      const res = await service.completeGame(gameAddr);
      expect(res.success).toBe(false);
      expect(String(res.error || "")).toContain("Ticket registry out of sync");
    } finally {
      completion.resolveContextAndReadiness = originalResolve;
    }
  });

  it("scanAndCompleteActiveGames clears tracked games lacking secrets", async () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();

    resetPendingGames(db, { service });

    const orphanGame = "orphaned-game";
    db.trackGame(orphanGame);

    const originalMarkCompleted = db.markGameCompleted.bind(db);
    const marked: string[] = [];
    (db as any).markGameCompleted = (address: string) => {
      marked.push(address);
      originalMarkCompleted(address);
    };

    try {
      const stats = await service.scanRunner.scanAndCompleteActiveGames();
      expect(stats).toEqual(createEmptyCompletionStats());
      expect(marked).toContain(orphanGame);
      const remaining = db.getPendingGames().map((entry) => entry.game_address);
      expect(remaining).not.toContain(orphanGame);
    } finally {
      (db as any).markGameCompleted = originalMarkCompleted;
    }
  });

  it("getBlockchainTime uses network and falls back to wall clock", async () => {
    const service = OracleService.getInstance();
    // happy path
    (service as any).connection = {
      getSlot: async () => 1,
      getBlockTime: async (_slot: number) => 1000,
    };
    expect(await service.completionManager.getBlockchainTime()).toBe(1000);

    // error path -> fallback to Date.now
    (service as any).connection = {
      getSlot: async () => {
        throw new Error("boom");
      },
      getBlockTime: async () => null,
    };
    const approx = await service.completionManager.getBlockchainTime();
    expect(Math.abs(approx - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(1);
  });

  it("tryAutoComplete triggers completion and logs failures", async () => {
    const service = OracleService.createWith(OracleDatabase.getInstance());
    const completion = service.completionManager;
    const originalReady = completion.isGameReadyForCompletion;
    const originalComplete = (service as any).completeGame;
    const originalError = console.error;

    completion.isGameReadyForCompletion = async () => true;

    let invocation = 0;
    const errors: string[] = [];
    console.error = (...args: any[]) => {
      errors.push(args.join(" "));
    };

    try {
      (service as any).completeGame = async () => {
        invocation++;
        if (invocation === 1) {
          return { success: false, error: "nope" };
        }
        if (invocation === 2) {
          return { success: false, notReady: true };
        }
        return { success: true };
      };

      const gamePda = new PublicKey(Keypair.generate().publicKey.toBytes());
      await (service as any).tryAutoComplete(gamePda, "auto-game", "joined");
      await (service as any).tryAutoComplete(gamePda, "auto-game", "joined");
      await (service as any).tryAutoComplete(gamePda, "auto-game", "joined");

      expect(invocation).toBe(3);
      expect(errors.some((entry) => entry.includes("Auto-completion failed"))).toBe(true);
    } finally {
      completion.isGameReadyForCompletion = originalReady;
      (service as any).completeGame = originalComplete;
      console.error = originalError;
    }
  });

  it("tryAutoComplete skips completion when readiness checks fail", async () => {
    const service = OracleService.createWith(OracleDatabase.getInstance());
    const completion = service.completionManager;
    const originalReady = completion.isGameReadyForCompletion;
    const originalComplete = (service as any).completeGame;

    let completions = 0;
    completion.isGameReadyForCompletion = async () => false;
    (service as any).completeGame = async () => {
      completions++;
      return { success: true };
    };

    const gamePda = new PublicKey(Keypair.generate().publicKey.toBytes());

    try {
      await (service as any).tryAutoComplete(gamePda, "guarded-game", "joined");
      expect(completions).toBe(0);

      completion.isGameReadyForCompletion = async () => true;
      await (service as any).tryAutoComplete(gamePda, "guarded-game", "joined");
      expect(completions).toBe(1);
    } finally {
      completion.isGameReadyForCompletion = originalReady;
      (service as any).completeGame = originalComplete;
    }
  });

  it("completeGame increments attempts for validation failures", async () => {
    const service = OracleService.createWith(OracleDatabase.getInstance());
    const db = OracleDatabase.getInstance();
    const gameAddr = "validation-failure-game";
    seedTrackedGame(db, {
      service,
      address: gameAddr,
      secret: "a".repeat(64),
      randomHash: "b".repeat(64),
    });

    const completion = service.completionManager;
    const originalResolve = completion.resolveContextAndReadiness;
    const originalProgram = (service as any).program;

    const ready = createReadyContext({
      gameAccount: createGameAccountStub({
        ticketsCount: 2,
        maxTickets: 2,
        minTickets: 1,
        lastSlot: 99,
      }),
    });

    completion.resolveContextAndReadiness = async () => ({
      ...ready,
      notReady: false,
    });
    (service as any).program = createProgramStub({
      programId: Keypair.generate().publicKey,
      fetchImpl: async () => ready.readiness.gameAccount,
    });

    try {
      const result = await service.completeGame(gameAddr);
      expect(result.success).toBe(false);
      expect(String(result.error ?? "")).toContain("No players");
      const pending = db.getPendingGames().find((g) => g.game_address === gameAddr);
      expect(pending?.completion_attempts).toBe(1);
    } finally {
      completion.resolveContextAndReadiness = originalResolve;
      (service as any).program = originalProgram;
      db.markGameCompleted(gameAddr);
      db.markSecretKeyUsed(gameAddr);
      service.cleanupOldRecords(-1);
    }
  });

  it("completeGame increments attempts when execution fails", async () => {
    const service = OracleService.createWith(OracleDatabase.getInstance());
    const db = OracleDatabase.getInstance();
    const gameAddr = "failing-game";
    seedTrackedGame(db, {
      service,
      address: gameAddr,
      secret: "a".repeat(64),
      randomHash: "b".repeat(64),
      players: [
        { address: Keypair.generate().publicKey.toBase58(), ticketIndex: 0 },
      ],
    });

    const completion = service.completionManager;
    const originalResolve = completion.resolveContextAndReadiness;
    const originalExecute = completion.executeGameCompletion;
    const originalProgram = (service as any).program;

    const ready = createReadyContext({
      gameAccount: createGameAccountStub({
        ticketsCount: 1,
        maxTickets: 1,
        minTickets: 1,
        lastSlot: 1,
      }),
    });

    completion.resolveContextAndReadiness = async () => ({
      ...ready,
      notReady: false,
    });
    (service as any).program = createProgramStub({
      programId: Keypair.generate().publicKey,
      fetchImpl: async () => ready.readiness.gameAccount,
    });
    completion.executeGameCompletion = async () => {
      throw new Error("rpc fail");
    };

    try {
      const result = await service.completeGame(gameAddr);
      expect(result.success).toBe(false);
      expect(String(result.error || "")).toContain("rpc fail");
      const pending = db.getPendingGames().find((g) => g.game_address === gameAddr);
      expect(pending?.completion_attempts).toBe(1);
    } finally {
      completion.resolveContextAndReadiness = originalResolve;
      completion.executeGameCompletion = originalExecute;
      (service as any).program = originalProgram;
    }
  });

  it("scanAndCompleteActiveGames counts unexpected completion errors", async () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();

    resetPendingGames(db, { service });

    const failingGame = "error-prone-game";
    seedTrackedGame(db, {
      address: failingGame,
      secret: "a".repeat(64),
      randomHash: "b".repeat(64),
    });

    const originalExists = (service as any).gameExistsOnChain;
    const originalComplete = (service as any).completeGame;

    let attempts = 0;
    (service as any).gameExistsOnChain = async () => ({
      gamePda: Keypair.generate().publicKey,
      secretData: { secretKey: "aa".repeat(32), randomHash: "bb".repeat(32) },
      readiness: { ready: true, gameAccount: createGameAccountStub() },
    });
    (service as any).completeGame = async () => {
      attempts++;
      throw new Error("forced failure");
    };

    try {
      const stats = await service.scanRunner.scanAndCompleteActiveGames();
      expect(stats).toEqual({ completed: 0, errors: 1, notReady: 0 });
      expect(attempts).toBe(1);
    } finally {
      (service as any).gameExistsOnChain = originalExists;
      (service as any).completeGame = originalComplete;
      db.markGameCompleted(failingGame);
      db.markSecretKeyUsed(failingGame);
      service.cleanupOldRecords(-1);
    }
  });

  it("records completion outcomes with metrics instrumentation", async () => {
    const metrics = new OracleMetricsRecorder();
    const db = OracleDatabase.getInstance();
    const service = OracleService.createWith(db, { metrics });

    const baseAccount: TimbaGameAccount = {
      creator: Keypair.generate().publicKey,
      tokenMint: Keypair.generate().publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      ticketsCount: 1,
      maxTickets: 1,
      minTickets: 1,
      lastSlot: 1,
      timeout: 1,
      createdAt: 1,
    };

    const context = {
      gamePda: Keypair.generate().publicKey,
      secretData: { secretKey: "11".repeat(64), randomHash: "22".repeat(64) },
      randomHashBuffer: Buffer.alloc(32, 3),
    };

    const completionSpy = spyOn(service as any, "completeGame")
      .mockResolvedValueOnce({ success: true, txHash: "tx-ok" })
      .mockResolvedValueOnce({ success: false, notReady: true })
      .mockResolvedValueOnce({ success: false, error: "boom" });

    await (service as any).attemptGameCompletion({
      gameAddress: "metrics-success",
      context,
      readiness: { ready: true, gameAccount: baseAccount },
      skipReadinessCheck: true,
    });

    await (service as any).attemptGameCompletion({
      gameAddress: "metrics-not-ready",
      context,
      readiness: { ready: true, gameAccount: baseAccount },
      skipReadinessCheck: true,
    });

    await (service as any).attemptGameCompletion({
      gameAddress: "metrics-error",
      context,
      readiness: { ready: true, gameAccount: baseAccount },
      skipReadinessCheck: true,
    });

    const records = metrics.getCompletionRecords();
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      gameAddress: "metrics-success",
      outcome: "success",
    });
    expect(records[1]).toMatchObject({ outcome: "not-ready" });
    expect(records[2]).toMatchObject({ outcome: "error", error: "boom" });

    completionSpy.mockRestore();
  });

  it("completeGame clears readiness cache after successful completion", async () => {
    const db = OracleDatabase.getInstance();
    const service = OracleService.createWith(db);

    const gameAddress = Keypair.generate().publicKey.toBase58();
    const randomHash = "ab".repeat(32);
    const secretKey = "cd".repeat(32);
    const readiness = {
      ready: true,
      gameAccount: createGameAccountStub({
        ticketsCount: 1,
        maxTickets: 1,
        minTickets: 1,
        lastSlot: 42,
      }),
    };
    const context = {
      gamePda: Keypair.generate().publicKey,
      secretData: { secretKey, randomHash },
      randomHashBuffer: Buffer.from(randomHash, "hex"),
      readiness,
    };

    (service as any).readinessCache.set(gameAddress, readiness);

    const completion = service.completionManager;
    const dbInstance = OracleDatabase.getInstance();
    const originalResolve = completion.resolveContextAndReadiness;
    const originalExecute = completion.executeGameCompletion;
    const winnerIndexSpy = spyOn(completion as any, "calculateWinnerIndex").mockReturnValue(0);
    const executeSpy = spyOn(completion, "executeGameCompletion").mockResolvedValue("tx-123");
    const finalizeSpy = spyOn(dbInstance, "finalizeCompletedGame").mockImplementation(() => undefined);
    const playersSpy = spyOn(dbInstance, "getGamePlayers").mockReturnValue([
      Keypair.generate().publicKey.toBase58(),
    ]);
    const attemptsSpy = spyOn(dbInstance, "incrementCompletionAttempts").mockImplementation(
      () => undefined,
    );

    completion.resolveContextAndReadiness = async () => ({
      context,
      readiness,
      notReady: false,
    });

    try {
      const result = await service.completeGame(gameAddress);

      expect(result).toEqual({ success: true, txHash: "tx-123" });
      expect((service as any).readinessCache.has(gameAddress)).toBe(false);
      expect(playersSpy).toHaveBeenCalledWith(gameAddress);
      expect(finalizeSpy).toHaveBeenCalledWith(gameAddress);
      expect(attemptsSpy).not.toHaveBeenCalled();
    } finally {
      completion.resolveContextAndReadiness = originalResolve;
      completion.executeGameCompletion = originalExecute;
      winnerIndexSpy.mockRestore();
      executeSpy.mockRestore();
      finalizeSpy.mockRestore();
      playersSpy.mockRestore();
      attemptsSpy.mockRestore();
      (service as any).readinessCache.clear();
    }
  });

  it("completeGame clears readiness cache when a fatal error occurs", async () => {
    const db = OracleDatabase.getInstance();
    const service = OracleService.createWith(db);

    const gameAddress = Keypair.generate().publicKey.toBase58();
    const readiness = {
      ready: true,
      gameAccount: createGameAccountStub({
        ticketsCount: 2,
        maxTickets: 2,
        minTickets: 1,
        lastSlot: 99,
      }),
    };
    const context = {
      gamePda: Keypair.generate().publicKey,
      secretData: { secretKey: "ef".repeat(32), randomHash: "01".repeat(32) },
      randomHashBuffer: Buffer.from("01".repeat(32), "hex"),
      readiness,
    };

    (service as any).readinessCache.set(gameAddress, readiness);

    const completion = service.completionManager;
    const dbInstance = OracleDatabase.getInstance();
    const originalResolve = completion.resolveContextAndReadiness;
    const winnerIndexSpy = spyOn(completion as any, "calculateWinnerIndex").mockReturnValue(0);
    const executeSpy = spyOn(completion, "executeGameCompletion");
    const finalizeSpy = spyOn(dbInstance, "finalizeCompletedGame").mockImplementation(() => undefined);
    const playersSpy = spyOn(dbInstance, "getGamePlayers").mockReturnValue([]);
    const attemptsSpy = spyOn(dbInstance, "incrementCompletionAttempts").mockImplementation(
      () => undefined,
    );

    completion.resolveContextAndReadiness = async () => ({
      context,
      readiness,
      notReady: false,
    });

    try {
      const result = await service.completeGame(gameAddress);

      expect(result.success).toBe(false);
      expect(result.notReady).toBeUndefined();
      expect(result.error).toBe("No players found for game");
      expect((service as any).readinessCache.has(gameAddress)).toBe(false);
      expect(attemptsSpy).toHaveBeenCalledWith(gameAddress);
      expect(executeSpy).not.toHaveBeenCalled();
      expect(finalizeSpy).not.toHaveBeenCalled();
    } finally {
      completion.resolveContextAndReadiness = originalResolve;
      winnerIndexSpy.mockRestore();
      executeSpy.mockRestore();
      finalizeSpy.mockRestore();
      playersSpy.mockRestore();
      attemptsSpy.mockRestore();
      (service as any).readinessCache.clear();
    }
  });

  it("completeGame retains readiness cache on transient errors", async () => {
    const db = OracleDatabase.getInstance();
    const service = OracleService.createWith(db);

    const gameAddress = Keypair.generate().publicKey.toBase58();
    const randomHash = "12".repeat(32);
    const secretKey = "34".repeat(32);
    const readiness = {
      ready: true,
      gameAccount: createGameAccountStub({
        ticketsCount: 1,
        maxTickets: 1,
        minTickets: 1,
        lastSlot: 111,
      }),
    };
    const context = {
      gamePda: Keypair.generate().publicKey,
      secretData: { secretKey, randomHash },
      randomHashBuffer: Buffer.from(randomHash, "hex"),
      readiness,
    };

    (service as any).readinessCache.set(gameAddress, readiness);

    const completion = service.completionManager;
    const dbInstance = OracleDatabase.getInstance();
    const originalResolve = completion.resolveContextAndReadiness;
    const originalExecute = completion.executeGameCompletion;
    const winnerIndexSpy = spyOn(completion as any, "calculateWinnerIndex").mockReturnValue(0);
    const executeSpy = spyOn(completion, "executeGameCompletion").mockRejectedValue(
      new Error("rpc down"),
    );
    const finalizeSpy = spyOn(dbInstance, "finalizeCompletedGame").mockImplementation(() => undefined);
    const playersSpy = spyOn(dbInstance, "getGamePlayers").mockReturnValue([
      Keypair.generate().publicKey.toBase58(),
    ]);
    const attemptsSpy = spyOn(dbInstance, "incrementCompletionAttempts").mockImplementation(
      () => undefined,
    );

    completion.resolveContextAndReadiness = async () => ({
      context,
      readiness,
      notReady: false,
    });

    try {
      const result = await service.completeGame(gameAddress);

      expect(result.success).toBe(false);
      expect(result.error).toBe("rpc down");
      expect((service as any).readinessCache.has(gameAddress)).toBe(true);
      expect(attemptsSpy).toHaveBeenCalledWith(gameAddress);
      expect(executeSpy).toHaveBeenCalled();
      expect(finalizeSpy).not.toHaveBeenCalled();
    } finally {
      completion.resolveContextAndReadiness = originalResolve;
      completion.executeGameCompletion = originalExecute;
      winnerIndexSpy.mockRestore();
      executeSpy.mockRestore();
      finalizeSpy.mockRestore();
      playersSpy.mockRestore();
      attemptsSpy.mockRestore();
      (service as any).readinessCache.clear();
    }
  });

  it("captures scan cycles and cleanup sweeps in metrics", async () => {
    const metrics = new OracleMetricsRecorder();
    const db = OracleDatabase.getInstance();
    resetPendingGames(db);
    const service = OracleService.createWith(db, { metrics });

    await service.scanRunner.scanAndCompleteActiveGames();
    const initialCycles = metrics.getScanCycles();
    expect(initialCycles).toHaveLength(1);
    expect(initialCycles[0]?.pending).toBe(0);

    const trackedGame = "metrics-cycle";
    seedTrackedGame(db, {
      address: trackedGame,
      secret: "33".repeat(32),
      randomHash: "44".repeat(32),
    });

    const gameAccount: TimbaGameAccount = {
      creator: Keypair.generate().publicKey,
      tokenMint: Keypair.generate().publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      ticketsCount: 1,
      maxTickets: 1,
      minTickets: 1,
      lastSlot: 1,
      timeout: 1,
      createdAt: 1,
    };

    const resolveSpy = spyOn(
      service.completionManager,
      "resolveContextAndReadiness"
    ).mockImplementation(async () => ({
      context: {
        gamePda: Keypair.generate().publicKey,
        secretData: { secretKey: "55".repeat(32), randomHash: "66".repeat(32) },
        randomHashBuffer: Buffer.alloc(32, 9),
      },
      readiness: { ready: true, gameAccount },
      notReady: false,
    }));

    const completionSpy = spyOn(service as any, "completeGame").mockImplementation(
      async (address: string) => {
        db.finalizeCompletedGame(address);
        return { success: true, txHash: "tx-metrics" };
      }
    );

    const stats = await service.scanRunner.scanAndCompleteActiveGames();
    expect(stats.completed).toBe(1);

    const cycles = metrics.getScanCycles();
    expect(cycles).toHaveLength(2);
    expect(cycles[1]).toMatchObject({ pending: 1, completed: 1 });

    const cleanupResult = service.cleanupOldRecords(1);
    expect(cleanupResult).toBeDefined();
    const sweeps = metrics.getCleanupSweeps();
    expect(sweeps.length).toBeGreaterThan(0);
    expect(sweeps[sweeps.length - 1]).toMatchObject({ hoursOld: 1 });

    resolveSpy.mockRestore();
    completionSpy.mockRestore();
  });

  it("executeGameCompletion invokes RPC and confirms transaction", async () => {
    const result = await runExecuteGameCompletionScenario();

    expect(result.tx).toBe("tx-abc");
    const accounts = result.calls.accounts;
    const tokenCtx = accounts?.gameTokenCtx;

    expect(accounts?.winner.toBase58()).toBe(result.winner.toBase58());
    expect(accounts?.creator.toBase58()).toBe(result.creator.toBase58());
    expect(accounts?.oracleOperator.toBase58()).toBe(result.oracleOperator.toBase58());
    expect(accounts?.game.toBase58()).toBe(result.expectedGamePda.toBase58());
    expect(accounts?.oracle.toBase58()).toBe(result.expectedOraclePda.toBase58());
    expect(tokenCtx?.tokenMint?.toBase58()).toBe(result.tokenMint.toBase58());
    expect(tokenCtx?.gameToken?.toBase58()).toBe(result.expectedGameTokenPda.toBase58());
    expect(tokenCtx?.gameVault?.toBase58()).toBe(result.expectedGameVaultPda.toBase58());
    expect(tokenCtx?.tokenProgram?.toBase58()).toBe(result.expectedTokenProgram.toBase58());
    expect(tokenCtx?.associatedTokenProgram?.toBase58()).toBe(
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
    );
    expect(accounts?.winnerTokenAccount.toBase58()).toBe(result.expectedWinnerAta.toBase58());
    expect(tokenCtx?.gameTokenAccount?.toBase58()).toBe(result.expectedGameAta.toBase58());
    expect(result.calls.accounts?.systemProgram.toBase58()).toBe(
      anchor.web3.SystemProgram.programId.toBase58(),
    );
    expect(result.calls.signers).toEqual([result.adminKeypair]);
    expect(result.calls.confirmed).toBe("tx-abc");
  });

  it("executeGameCompletion derives Token-2022 accounts when provided", async () => {
    const result = await runExecuteGameCompletionScenario({ tokenProgram: TOKEN_2022_PROGRAM_ID });

    expect(result.tx).toBe("tx-abc");
    expect(result.expectedTokenProgram.toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    const tokenCtx = result.calls.accounts?.gameTokenCtx;
    expect(tokenCtx?.tokenProgram?.toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(result.calls.accounts?.winnerTokenAccount.toBase58()).toBe(
      result.expectedWinnerAta.toBase58(),
    );
    expect(tokenCtx?.gameTokenAccount?.toBase58()).toBe(result.expectedGameAta.toBase58());
  });

  it("executeGameCompletion infers Token-2022 accounts from mint owner", async () => {
    const result = await runExecuteGameCompletionScenario({ mintOwner: TOKEN_2022_PROGRAM_ID });

    expect(result.tx).toBe("tx-abc");
    expect(result.expectedTokenProgram.toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    const tokenCtx = result.calls.accounts?.gameTokenCtx;
    expect(tokenCtx?.tokenProgram?.toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(result.calls.accounts?.winnerTokenAccount.toBase58()).toBe(
      result.expectedWinnerAta.toBase58(),
    );
    expect(tokenCtx?.gameTokenAccount?.toBase58()).toBe(result.expectedGameAta.toBase58());
  });

  it("executeGameCompletion treats zeroed token program as SPL default", async () => {
    const result = await runExecuteGameCompletionScenario({ tokenProgram: PublicKey.default });

    expect(result.expectedTokenProgram.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
    const tokenCtx = result.calls.accounts?.gameTokenCtx;
    expect(tokenCtx?.tokenProgram?.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
    expect(result.calls.accounts?.winnerTokenAccount.toBase58()).toBe(
      result.expectedWinnerAta.toBase58(),
    );
    expect(tokenCtx?.gameTokenAccount?.toBase58()).toBe(result.expectedGameAta.toBase58());
  });

  it("executeGameCompletion surfaces token program resolution errors", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(
        runExecuteGameCompletionScenario({
          accountInfoImpl: async () => {
            throw new Error("account missing");
          },
        })
      ).rejects.toThrow("Unable to resolve token program");

      const warningMessages = warnSpy.mock.calls.map((args) => args.join(" "));
      expect(warningMessages.some((message) => message.includes("Unable to resolve token program"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("rejects unknown token program owners during resolution", async () => {
    const service = OracleService.createWith(OracleDatabase.getInstance());
    const originalConnection = (service as any).connection;
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const unsupportedOwner = Keypair.generate().publicKey;

    (service as any).connection = {
      getAccountInfo: async () => ({ owner: unsupportedOwner }),
    };

    try {
      await expect(
        service.completionManager.resolveTokenProgram(null, Keypair.generate().publicKey)
      ).rejects.toThrow("Unsupported token program owner");
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      (service as any).connection = originalConnection;
      warnSpy.mockRestore();
    }
  });

  it("confirmTransaction forwards latest blockhash params", async () => {
    const service = OracleService.createWith(OracleDatabase.getInstance());
    const originalConnection = (service as any).connection;
    const calls: any[] = [];

    (service as any).connection = {
      getLatestBlockhash: async () => ({ blockhash: "bh", lastValidBlockHeight: 42 }),
      confirmTransaction: async (params: any) => {
        calls.push(params);
      },
    };

    try {
      await (service as any).confirmTransaction("sig-1");
      expect(calls[0]).toEqual({ signature: "sig-1", blockhash: "bh", lastValidBlockHeight: 42 });
    } finally {
      (service as any).connection = originalConnection;
    }
  });
});
