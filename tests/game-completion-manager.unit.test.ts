import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as anchor from "@anchor-lang/core";
import { GameCompletionManager } from "../oracle-completion-manager.ts";
import type { GameCompletionManagerOptions } from "../oracle-completion-manager.ts";
import { Keypair, PublicKey, type BlockhashWithExpiryBlockHeight } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { OracleMetrics } from "../metrics.ts";
import type {
  GameCompletionResult,
  GameOnChainContext,
  GameReadinessSnapshot,
} from "../oracle-service.types.ts";
import { logger } from "../logger.ts";
import type { TimbaGameAccount } from "../types/timba.ts";

function createGameAccountStub(overrides: Partial<TimbaGameAccount> = {}): TimbaGameAccount {
  return {
    creator: overrides.creator ?? Keypair.generate().publicKey,
    tokenMint: overrides.tokenMint ?? Keypair.generate().publicKey,
    tokenProgram: overrides.tokenProgram ?? TOKEN_PROGRAM_ID,
    ticketsCount: overrides.ticketsCount ?? BigInt(1),
    maxTickets: overrides.maxTickets ?? BigInt(1),
    minTickets: overrides.minTickets ?? BigInt(1),
    lastSlot: overrides.lastSlot ?? BigInt(1),
    timeout: overrides.timeout ?? BigInt(1),
    createdAt: overrides.createdAt ?? BigInt(1),
    ...overrides,
  };
}

function createManager(
  overrides: {
    accountInfo?: (pubkey: PublicKey) => Promise<{ owner: PublicKey | null } | null>;
    programId?: PublicKey;
    secretKeyLength?: number;
    metrics?: Partial<OracleMetrics>;
    recoverPlayers?: GameCompletionManagerOptions["recoverPlayerRegistry"];
    registryPrefetchCooldownMs?: number;
  } = {},
) {
  const secretStore = new Map<string, { secretKey: string; randomHash: string }>();
  const players = new Map<string, string[]>();
  const desyncedGames = new Set<string>();

  const db = {
    incrementCompletionAttempts: () => {},
    finalizeCompletedGame: () => {},
    getGamePlayers: (address: string) => players.get(address) ?? [],
    getSecretKey: (address: string) => secretStore.get(address) ?? null,
    markGameCompleted: () => {},
    replaceGamePlayers: (address: string, recovered: string[]) => {
      players.set(address, [...recovered]);
    },
    markGameDesynced: (address: string) => {
      desyncedGames.add(address);
    },
  } as const;

  const metrics: OracleMetrics = {
    recordCompletion: overrides.metrics?.recordCompletion ?? (() => {}),
    recordScanCycle: overrides.metrics?.recordScanCycle ?? (() => {}),
    recordCleanupSweep: overrides.metrics?.recordCleanupSweep ?? (() => {}),
  };

  const connection = {
    getAccountInfo: overrides.accountInfo ?? (async () => ({ owner: TOKEN_PROGRAM_ID })),
    getSlot: async () => 100,
    getBlockTime: async () => 1_700_000_000,
    getLatestBlockhash: async () => ({ blockhash: "test-bh", lastValidBlockHeight: 999 }),
    sendRawTransaction: async () => "tx",
  } as const;

  const program = {
    account: { game: { fetch: async () => ({}) } },
    programId: overrides.programId ?? Keypair.generate().publicKey,
    provider: { opts: {} },
    methods: {
      completeGame: () => ({
        accountsPartial: () => ({
          signers: () => ({
            transaction: async () => new anchor.web3.Transaction(),
          }),
        }),
      }),
    },
  } as const;

  const readinessCache = new Map<string, any>();
  const tokenProgramCache = new Map<string, PublicKey>();

  const manager = new GameCompletionManager({
    db: db as any,
    metrics,
    getConnection: () => connection as any,
    getProgram: () => program as any,
    adminKeypair: anchor.web3.Keypair.generate(),
    readinessCache,
    tokenProgramCache,
    secretKeyLength: overrides.secretKeyLength ?? 32,
    noSecretKeyMessage: "missing",
    confirmTransaction: async (_sig?: string, _latest?: BlockhashWithExpiryBlockHeight) => {},
    recoverPlayerRegistry: overrides.recoverPlayers,
    markGameDesynced: (address: string) => {
      desyncedGames.add(address);
    },
    registryPrefetchCooldownMs: overrides.registryPrefetchCooldownMs,
  });

  return {
    manager,
    readinessCache,
    tokenProgramCache,
    secretStore,
    players,
    connection,
    metrics,
    desyncedGames,
  };
}

describe("GameCompletionManager registry prefetch cleanup", () => {
  it("resets the prefetched player schedule when a desync occurs", async () => {
    const { manager } = createManager();
    const spy = spyOn(manager.registrySyncManager, "resetRegistryPrefetchSchedule");

    const gamePda = Keypair.generate().publicKey;
    const context: GameOnChainContext = {
      gamePda,
      randomHashBuffer: Buffer.alloc(32),
      secretData: { secretKey: "", randomHash: "" },
    };

    const gameAccount = {
      creator: Keypair.generate().publicKey,
      tokenMint: Keypair.generate().publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      timeout: BigInt(60),
      createdAt: BigInt(0),
      lastSlot: BigInt(1),
      ticketsCount: BigInt(2),
      maxTickets: BigInt(2),
      minTickets: BigInt(2),
    } as TimbaGameAccount;

    const readiness: GameReadinessSnapshot = {
      ready: true,
      evaluatedAt: 0,
      gameAccount,
    };

    await expect(
      (manager.registrySyncManager as any).ensurePlayersInSync(
        "bad-game",
        context,
        readiness,
        2,
        () => ({ success: false, error: "desync" }),
      ),
    ).resolves.toMatchObject({ error: expect.anything() });

    expect(spy).toHaveBeenCalledWith("bad-game");
    spy.mockRestore();
  });

  it("enforces a minimum registry prefetch cooldown even when configured zero", async () => {
    const { manager } = createManager({
      registryPrefetchCooldownMs: 0,
      recoverPlayers: async () => [Keypair.generate().publicKey.toBase58()],
    });

    const context: GameOnChainContext = {
      gamePda: Keypair.generate().publicKey,
      secretData: { secretKey: "a".repeat(64), randomHash: "b".repeat(64) },
      randomHashBuffer: Buffer.from("b".repeat(64), "hex"),
    };
    const readiness: GameReadinessSnapshot = {
      ready: true,
      gameAccount: createGameAccountStub({
        ticketsCount: 1,
        maxTickets: 1,
        minTickets: 1,
        lastSlot: 1,
        tokenProgram: TOKEN_PROGRAM_ID,
      }),
    };

    const nowSpy = spyOn(Date, "now").mockReturnValue(1_000);
    try {
      await (manager.registrySyncManager as any).prefetchPlayerRegistry(
        "cooldown-game",
        context,
        readiness,
      );
      const schedule = (manager.registrySyncManager as any).registryPrefetchSchedule.get(
        "cooldown-game",
      );
      expect(schedule).toBe(2_000);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("GameCompletionManager readiness evaluation", () => {
  it("does not mark games with zero tickets as ready even if expired and minTickets is zero", async () => {
    const gameAccount = createGameAccountStub({
      ticketsCount: BigInt(0),
      maxTickets: BigInt(5),
      minTickets: BigInt(0),
      timeout: BigInt(10),
      createdAt: BigInt(0),
    });

    const { manager } = createManager({
      programId: Keypair.generate().publicKey,
    });

    const fetchSpy = spyOn(manager as any, "fetchGameAccount").mockResolvedValue(gameAccount);

    const gamePda = Keypair.generate().publicKey;
    const readiness = await manager.evaluateGameReadiness(gamePda);

    expect(readiness.ready).toBe(false);

    fetchSpy.mockRestore();
  });
});

describe("GameCompletionManager.evaluateGameReadiness", () => {
  it("treats block time equal to the timeout boundary as expired when minimum tickets are met", async () => {
    const { manager } = createManager();
    const gamePda = Keypair.generate().publicKey;

    const fetchSpy = spyOn(manager as any, "fetchGameAccount").mockResolvedValue({
      createdAt: BigInt(1_000),
      timeout: BigInt(60),
      ticketsCount: BigInt(3),
      maxTickets: BigInt(5),
      minTickets: BigInt(2),
    } satisfies Partial<TimbaGameAccount>);

    try {
      const readiness = await manager.evaluateGameReadiness(gamePda, 1_060);
      expect(readiness.ready).toBe(true);
      expect(readiness.evaluatedAt).toBe(1_060);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("GameCompletionManager.completeGame", () => {
  it("includes the raw game total amount in successful completion results", async () => {
    const { manager, players, secretStore } = createManager();
    const winner = Keypair.generate().publicKey;
    const gameAddress = "total-pot-game";
    const gameAccount = createGameAccountStub({
      ticketsCount: 1,
      lastSlot: 99,
      totalAmount: { toNumber: () => 12_345 },
    } as Partial<TimbaGameAccount>);
    const context: GameOnChainContext = {
      gamePda: Keypair.generate().publicKey,
      randomHashBuffer: Buffer.alloc(32),
      secretData: {
        secretKey: "11".repeat(32),
        randomHash: "22".repeat(32),
      },
    };

    players.set(gameAddress, [winner.toBase58()]);
    secretStore.set(gameAddress, context.secretData!);

    const resolveSpy = spyOn(manager as any, "resolveContextAndReadiness").mockResolvedValue({
      status: "ready",
      context,
      readiness: { ready: true, gameAccount },
      prefetchScheduled: false,
    });
    const executeSpy = spyOn(manager as any, "executeGameCompletion").mockResolvedValue("tx-ok");

    try {
      const result = await manager.completeGame(gameAddress);

      expect(result).toEqual({
        success: true,
        txHash: "tx-ok",
        winnerAddress: winner.toBase58(),
        totalPot: 12_345,
      });
    } finally {
      resolveSpy.mockRestore();
      executeSpy.mockRestore();
    }
  });
});

describe("GameCompletionManager.calculateWinnerIndex", () => {
  let manager: ReturnType<typeof createManager>["manager"];

  beforeEach(() => {
    ({ manager } = createManager());
  });

  it("is deterministic and stays within player bounds", () => {
    const baseSecret = Buffer.alloc(64);

    const results = new Map<number, Set<number>>();
    let seed = 1;

    const nextBuffer = () => {
      const buf = Buffer.alloc(64);
      for (let i = 0; i < buf.length; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        buf[i] = seed & 0xff;
      }
      return buf;
    };

    for (let players = 2; players <= 12; players++) {
      const seen = new Set<number>();
      for (let iteration = 0; iteration < 20; iteration++) {
        const secret = iteration === 0 ? baseSecret : nextBuffer();
        const slot = 10_000 + iteration;
        const first = manager.calculateWinnerIndex(secret, slot, players);
        const second = manager.calculateWinnerIndex(secret, slot, players);
        expect(first).toBe(second);
        expect(first).toBeGreaterThanOrEqual(0);
        expect(first).toBeLessThan(players);
        seen.add(first);
      }
      results.set(players, seen);
    }

    for (const [players, seen] of results) {
      expect(seen.size).toBeGreaterThan(1);
      expect([...seen].every((value) => value < players)).toBe(true);
    }
  });

  it("throws when the secret is shorter than the configured length", () => {
    expect(() => manager.calculateWinnerIndex(Buffer.alloc(16), 1, 2)).toThrow(
      "Secret key buffer must be at least 32 bytes",
    );
  });
});

describe("GameCompletionManager.attemptGameCompletion outcome handling", () => {
  it("records not ready outcomes via the shared helper", async () => {
    const records: Array<{ gameAddress: string; outcome: string; error?: string }> = [];
    const { manager } = createManager({
      metrics: {
        recordCompletion: (record) => {
          records.push(record);
        },
      },
    });

    const readinessSpy = spyOn(manager as any, "resolveContextAndReadiness").mockResolvedValue({
      status: "not-ready",
      context: {} as any,
      readiness: { ready: false, gameAccount: null },
      prefetchScheduled: false,
    });

    const onResults: GameCompletionResult[] = [];
    try {
      const result = await manager.attemptGameCompletion({
        gameAddress: "not-ready-game",
        gameKey: Keypair.generate().publicKey,
        onResult: (outcome) => {
          onResults.push(outcome);
        },
      });

      expect(result).toEqual({ success: false, notReady: true });
      expect(onResults).toHaveLength(1);
      expect(records).toEqual([
        { gameAddress: "not-ready-game", outcome: "not-ready", error: undefined },
      ]);
    } finally {
      readinessSpy.mockRestore();
    }
  });

  it("logs success and failure outcomes once completion resolves", async () => {
    const records: Array<{ gameAddress: string; outcome: string; error?: string }> = [];
    const { manager } = createManager({
      metrics: {
        recordCompletion: (record) => {
          records.push(record);
        },
      },
    });

    const readiness: GameReadinessSnapshot = { ready: true, gameAccount: {} as any };
    const context: GameOnChainContext = {
      gamePda: Keypair.generate().publicKey,
      secretData: { secretKey: "11".repeat(32), randomHash: "22".repeat(32) },
      randomHashBuffer: Buffer.alloc(32),
    };

    const resolveSpy = spyOn(manager as any, "resolveContextAndReadiness").mockResolvedValue({
      status: "ready",
      context,
      readiness,
      prefetchScheduled: false,
    });

    const infoSpy = spyOn(logger, "info").mockImplementation(() => {});
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {});

    const results: GameCompletionResult[] = [];

    const successLog = (address: string) => `success:${address}`;
    const failureLog = (address: string, error?: string) => `failure:${address}:${error ?? ""}`;

    try {
      const success = await manager.attemptGameCompletion(
        {
          gameAddress: "success-game",
          gameKey: Keypair.generate().publicKey,
          onResult: (outcome) => {
            results.push(outcome);
          },
          successLog,
          failureLog,
        },
        {
          completeGame: async () => ({ success: true, txHash: "tx-ok" }),
        },
      );

      expect(success).toEqual({ success: true, txHash: "tx-ok" });
      expect(infoSpy).toHaveBeenCalledWith("success:success-game");
      expect(errorSpy).not.toHaveBeenCalled();

      const failure = await manager.attemptGameCompletion(
        {
          gameAddress: "failure-game",
          gameKey: Keypair.generate().publicKey,
          onResult: (outcome) => {
            results.push(outcome);
          },
          successLog,
          failureLog,
        },
        {
          completeGame: async () => ({ success: false, error: "boom" }),
        },
      );

      expect(failure).toEqual({ success: false, error: "boom" });
      expect(errorSpy).toHaveBeenCalledWith("failure:failure-game:boom");
      // Verify success log was called exactly once for the success-game
      const successLogCalls = infoSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === "success:success-game",
      );
      expect(successLogCalls).toHaveLength(1);

      expect(records).toEqual([
        { gameAddress: "success-game", outcome: "success", error: undefined },
        { gameAddress: "failure-game", outcome: "error", error: "boom" },
      ]);
      expect(results).toHaveLength(2);
    } finally {
      resolveSpy.mockRestore();
      infoSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("prevents concurrent completions for the same game", async () => {
    const { manager } = createManager();
    const gameAddress = "lock-game";

    const context: GameOnChainContext = {
      gamePda: Keypair.generate().publicKey,
      randomHashBuffer: Buffer.alloc(32),
      secretData: {
        secretKey: "11".repeat(32),
        randomHash: "22".repeat(32),
      },
    };
    const readiness: GameReadinessSnapshot = {
      ready: true,
      gameAccount: {} as any,
    };

    const resolveSpy = spyOn(manager as any, "resolveContextAndReadiness").mockResolvedValue({
      status: "ready",
      context,
      readiness,
      prefetchScheduled: false,
    });

    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    let completionCalls = 0;

    const firstPromise = manager.attemptGameCompletion(
      {
        gameAddress,
        context,
        readiness,
        skipReadinessCheck: true,
      },
      {
        completeGame: async () => {
          completionCalls += 1;
          await barrier;
          return { success: true, txHash: "tx-1" };
        },
      },
    );

    await Promise.resolve();

    const secondResult = await manager.attemptGameCompletion(
      {
        gameAddress,
        context,
        readiness,
        skipReadinessCheck: true,
      },
      {
        completeGame: async () => {
          completionCalls += 1;
          return { success: true, txHash: "tx-2" };
        },
      },
    );

    expect(secondResult).toBeNull();

    release?.();
    const firstResult = await firstPromise;
    expect(firstResult).toEqual({ success: true, txHash: "tx-1" });
    expect(completionCalls).toBe(1);

    resolveSpy.mockRestore();
  });
});

describe("GameCompletionManager player registry recovery", () => {
  const secretHex = "aa".repeat(32);
  const randomHex = "bb".repeat(32);

  const readiness: GameReadinessSnapshot = {
    ready: true,
    gameAccount: {
      ticketsCount: 2,
      lastSlot: 99,
    } as unknown as TimbaGameAccount,
  };

  const context: GameOnChainContext = {
    gamePda: Keypair.generate().publicKey,
    randomHashBuffer: Buffer.alloc(32),
    secretData: {
      secretKey: secretHex,
      randomHash: randomHex,
    },
  };

  it("recovers from a partial registry mismatch using the recovery callback", async () => {
    const existingPlayer = Keypair.generate().publicKey.toBase58();
    const recoveredPlayers = [existingPlayer, Keypair.generate().publicKey.toBase58()];
    const recoverInvocations: any[] = [];

    const { manager, players, secretStore, desyncedGames } = createManager({
      recoverPlayers: async (opts) => {
        recoverInvocations.push(opts);
        return recoveredPlayers;
      },
    });

    const gameAddress = "partial-registry";
    secretStore.set(gameAddress, { secretKey: secretHex, randomHash: randomHex });
    players.set(gameAddress, [existingPlayer]);

    const result = await (manager as any).resolveWinnerDetails(gameAddress, readiness, context);

    expect("error" in result).toBe(false);
    expect(recoverInvocations[0]).toMatchObject({ expectedTickets: 2 });
    expect(players.get(gameAddress)).toEqual(recoveredPlayers);
    expect(desyncedGames.size).toBe(0);
  });

  it("attempts registry recovery when duplicates exist despite matching length", async () => {
    const duplicatePlayer = Keypair.generate().publicKey.toBase58();
    const recoveredPlayers = [duplicatePlayer, Keypair.generate().publicKey.toBase58()];
    let recoverCalls = 0;
    const { manager, players, secretStore } = createManager({
      recoverPlayers: async () => {
        recoverCalls++;
        return recoveredPlayers;
      },
    });

    const gameAddress = "duplicate-registry";
    secretStore.set(gameAddress, { secretKey: secretHex, randomHash: randomHex });
    players.set(gameAddress, [duplicatePlayer, duplicatePlayer]);

    const result = await (manager as any).resolveWinnerDetails(gameAddress, readiness, context);

    expect("error" in result).toBe(false);
    expect(recoverCalls).toBe(1);
    expect(players.get(gameAddress)).toEqual(recoveredPlayers);
  });

  it("marks the game as desynced when recovery fails", async () => {
    const existingPlayer = Keypair.generate().publicKey.toBase58();
    const { manager, players, secretStore, desyncedGames } = createManager({
      recoverPlayers: async () => null,
    });

    const gameAddress = "registry-failure";
    secretStore.set(gameAddress, { secretKey: secretHex, randomHash: randomHex });
    players.set(gameAddress, [existingPlayer]);

    const result = await (manager as any).resolveWinnerDetails(gameAddress, readiness, context);

    expect(result).toEqual({
      error: {
        success: false,
        error: "Ticket registry out of sync",
      },
    });
    expect(desyncedGames.has(gameAddress)).toBe(true);
  });

  it("allows registry recovery to retry after a failure", async () => {
    const recoveredPlayers = [
      Keypair.generate().publicKey.toBase58(),
      Keypair.generate().publicKey.toBase58(),
    ];
    let recoveryCalls = 0;
    const gameAddress = "retry-registry";
    const { manager, players } = createManager({
      recoverPlayers: async () => {
        recoveryCalls += 1;
        if (recoveryCalls === 1) {
          return null;
        }
        return recoveredPlayers;
      },
    });

    const firstAttempt = await (manager.registrySyncManager as any).tryRecoverPlayerRegistry(
      gameAddress,
      context,
      readiness,
      2,
      1,
    );

    const secondAttempt = await (manager.registrySyncManager as any).tryRecoverPlayerRegistry(
      gameAddress,
      context,
      readiness,
      2,
      1,
    );

    expect(firstAttempt).toBeNull();
    expect(secondAttempt).toEqual(recoveredPlayers);
    expect(players.get(gameAddress)).toEqual(recoveredPlayers);
    expect(recoveryCalls).toBe(2);
  });
});

describe("GameCompletionManager registry prefetch", () => {
  const secretHex = "aa".repeat(32);
  const randomHex = "bb".repeat(32);
  const readiness: GameReadinessSnapshot = {
    ready: true,
    gameAccount: {
      ticketsCount: 2,
      lastSlot: 99,
    } as unknown as TimbaGameAccount,
  };
  const context: GameOnChainContext = {
    gamePda: Keypair.generate().publicKey,
    randomHashBuffer: Buffer.alloc(32),
    secretData: {
      secretKey: secretHex,
      randomHash: randomHex,
    },
  };

  it("retries immediately after a failed registry prefetch", async () => {
    const recoveredPlayers = [
      Keypair.generate().publicKey.toBase58(),
      Keypair.generate().publicKey.toBase58(),
    ];
    let attempts = 0;
    const { manager, players } = createManager({
      recoverPlayers: async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error("boom");
        }
        return recoveredPlayers;
      },
    });

    const nowSpy = spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const gameAddress = "prefetch-retry";

    try {
      await (manager.registrySyncManager as any).prefetchPlayerRegistry(
        gameAddress,
        context,
        readiness,
      );
      expect(players.get(gameAddress)).toBeUndefined();

      await (manager.registrySyncManager as any).prefetchPlayerRegistry(
        gameAddress,
        context,
        readiness,
      );

      expect(attempts).toBe(2);
      expect(players.get(gameAddress)).toEqual(recoveredPlayers);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("allows a concurrent attempt when the first prefetch fails", async () => {
    const recoveredPlayers = [
      Keypair.generate().publicKey.toBase58(),
      Keypair.generate().publicKey.toBase58(),
    ];
    let attempts = 0;
    let release: (() => void) | undefined;

    const { manager, players } = createManager({
      recoverPlayers: async () => {
        attempts++;
        if (attempts === 1) {
          await new Promise((_, reject) => {
            release = () => reject(new Error("network"));
          });
        }
        return recoveredPlayers;
      },
    });

    const nowSpy = spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const gameAddress = "prefetch-concurrent";

    try {
      const firstAttempt = (manager.registrySyncManager as any).prefetchPlayerRegistry(
        gameAddress,
        context,
        readiness,
      );
      await Promise.resolve();
      const secondAttempt = (manager.registrySyncManager as any).prefetchPlayerRegistry(
        gameAddress,
        context,
        readiness,
      );

      release?.();

      await Promise.allSettled([firstAttempt, secondAttempt]);

      expect(attempts).toBe(1);
      // Since both fail (shared promise), players map should be empty or unchanged
      expect(players.has(gameAddress)).toBe(false);
    } finally {
      nowSpy.mockRestore();
    }
  });

  // prefetchPlayerRegistry prevents concurrent fetches
  it("prevents concurrent registry prefetches for the same game", async () => {
    let attempts = 0;
    let release: ((value?: unknown) => void) | undefined;
    const recoveredPlayers = [Keypair.generate().publicKey.toBase58()];

    const { manager } = createManager({
      recoverPlayers: async () => {
        attempts++;
        await new Promise((resolve) => {
          release = resolve;
        });
        return recoveredPlayers;
      },
      registryPrefetchCooldownMs: 1000,
    });

    const nowSpy = spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const gameAddress = "concurrent-prefetch-test";

    try {
      // Start two prefetches concurrently
      const p1 = (manager.registrySyncManager as any).prefetchPlayerRegistry(
        gameAddress,
        context,
        readiness,
      );
      const p2 = (manager.registrySyncManager as any).prefetchPlayerRegistry(
        gameAddress,
        context,
        readiness,
      );

      // Allow them to proceed
      release?.();
      await Promise.all([p1, p2]);

      // Expect only ONE attempt because the second should have been blocked
      // NOTE: This test is expected to FAIL until the bug is fixed.
      expect(attempts).toBe(1);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("GameCompletionManager.ensurePlayersInSync boundary cases", () => {
  // ensurePlayersInSync rejects 0 expected tickets
  it("returns a fatal error when expected tickets is zero", async () => {
    const { manager } = createManager();
    const gameAddress = "zero-tickets-game";

    const context: GameOnChainContext = {
      gamePda: Keypair.generate().publicKey,
      randomHashBuffer: Buffer.alloc(32),
      secretData: { secretKey: "", randomHash: "" },
    };

    const readiness: GameReadinessSnapshot = {
      ready: true,
      gameAccount: {
        ticketsCount: BigInt(0),
        maxTickets: BigInt(10),
      } as TimbaGameAccount,
    };

    let receivedError = "";
    const result = await (manager.registrySyncManager as any).ensurePlayersInSync(
      gameAddress,
      context,
      readiness,
      0,
      (_addr: string, err: string) => {
        receivedError = err;
        return { success: false, error: "fatal" };
      },
    );

    expect(result).toHaveProperty("error");
    expect(receivedError).toBe("No ticket entries available for completion");
  });
});
