import { describe, it, expect } from "bun:test";
import { ScanLoopRunner, type ScanLoopRunnerOptions } from "../oracle-scan-runner.ts";
import type { OracleDatabase } from "../database.ts";
import type { OracleMetrics } from "../metrics.ts";
import { createTestEnv } from "./helpers/create-test-env.ts";

describe("ScanLoopRunner error recovery", () => {
  it("touches games after failed completion attempts", async () => {
    const touched: string[] = [];

    const db = {
      getPendingGames: () => [
        { game_address: "error-game", completion_attempts: 0 },
      ],
      markGameCompleted: () => {},
      touchGameCheck: (address: string) => {
        touched.push(address);
      },
    } as unknown as OracleDatabase;

    const metrics: OracleMetrics = {
      recordCompletion: () => {},
      recordScanCycle: () => {},
      recordCleanupSweep: () => {},
    };

    const completion: ScanLoopRunnerOptions["completion"] = {
      resolveContextAndReadiness: async () => ({
        status: "ready",
        context: {} as any,
        readiness: { ready: true, gameAccount: {} } as any,
        prefetchScheduled: false,
      }),
      attemptGameCompletion: async () => {
        throw new Error("boom");
      },
      consumeReadiness: () => undefined,
      getBlockchainTime: async () => Date.now(),
    };

    const runner = new ScanLoopRunner({
      db,
      metrics,
      completion,
      interGameDelayMs: 0,
      maxCompletionAttempts: 5,
      cleanupOldRecords: () => {},
    });

    const stats = await runner.scanAndCompleteActiveGames();

    expect(stats).toEqual({ completed: 0, errors: 1, notReady: 0 });
    expect(touched).toEqual(["error-game"]);
  });

  it("reschedules games when completion is already in-flight elsewhere", async () => {
    const touched: string[] = [];

    const db = {
      getPendingGames: () => [
        { game_address: "inflight-game", completion_attempts: 0 },
      ],
      markGameCompleted: () => {},
      touchGameCheck: (address: string) => {
        touched.push(address);
      },
    } as unknown as OracleDatabase;

    const metrics: OracleMetrics = {
      recordCompletion: () => {},
      recordScanCycle: () => {},
      recordCleanupSweep: () => {},
    };

    const completion: ScanLoopRunnerOptions["completion"] = {
      resolveContextAndReadiness: async () => ({
        status: "ready",
        context: {} as any,
        readiness: { ready: true, gameAccount: {} } as any,
        prefetchScheduled: false,
      }),
      attemptGameCompletion: async () => null,
      consumeReadiness: () => undefined,
      getBlockchainTime: async () => Date.now(),
    };

    const runner = new ScanLoopRunner({
      db,
      metrics,
      completion,
      interGameDelayMs: 0,
      maxCompletionAttempts: 5,
      cleanupOldRecords: () => {},
    });

    const stats = await runner.scanAndCompleteActiveGames();

    expect(stats).toEqual({ completed: 0, errors: 0, notReady: 0 });
    expect(touched).toEqual(["inflight-game"]);
  });
});

describe("ScanLoopRunner completion attempt boundary", () => {
  it("skips games that already reached the max completion attempts", async () => {
    const env = await createTestEnv({
      prefix: "scan-runner-max",
      singletons: {
        OracleDatabase: async () => (await import("../database.ts")).OracleDatabase,
      },
    });

    try {
      const db = env.singletons.OracleDatabase.getInstance();
      db.cleanupOldRecords(-1);

      const gameAddress = "limit-game";
      db.trackGame(gameAddress);
      db.incrementCompletionAttempts(gameAddress);

      const completionCalls: string[] = [];
      const completion: ScanLoopRunnerOptions["completion"] = {
        resolveContextAndReadiness: async () => {
          throw new Error("should not resolve readiness for maxed game");
        },
        attemptGameCompletion: async () => {
          completionCalls.push("called");
          return { success: true };
        },
        consumeReadiness: () => undefined,
        getBlockchainTime: async () => Date.now(),
      };

      const metrics: OracleMetrics = {
        recordCompletion: () => {},
        recordScanCycle: () => {},
        recordCleanupSweep: () => {},
      };

      const runner = new ScanLoopRunner({
        db,
        metrics,
        completion,
        interGameDelayMs: 0,
        maxCompletionAttempts: 1,
        cleanupOldRecords: () => {},
      });

      const stats = await runner.scanAndCompleteActiveGames();

      expect(stats).toEqual({ completed: 0, errors: 0, notReady: 0 });
      expect(completionCalls).toHaveLength(0);

      const pending = db.getPendingGames();
      expect(pending.some((entry) => entry.game_address === gameAddress)).toBe(true);
      expect(pending.find((entry) => entry.game_address === gameAddress)?.completion_attempts).toBe(1);
    } finally {
      env.cleanup();
    }
  });
});
