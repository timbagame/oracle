import { describe, it, expect } from "bun:test";
import { createScanRunnerFixture } from "./helpers/scan-runner-fixtures.ts";
import { createTestEnv } from "./helpers/create-test-env.ts";
import { OracleDatabase } from "../database.ts";
import { ScanLoopRunner, type ScanLoopRunnerOptions } from "../oracle-scan-runner.ts";
import type { OracleMetrics } from "../metrics.ts";

describe("ScanLoopRunner error recovery", () => {
  it("touches games after failed completion attempts", async () => {
    const { runner, touchCalls } = createScanRunnerFixture({
      pendingGames: () => [{ game_address: "error-game", completion_attempts: 0 }],
      attemptGameCompletion: async () => {
        throw new Error("boom");
      },
    });

    const stats = await runner.scanAndCompleteActiveGames();

    expect(stats).toEqual({ completed: 0, errors: 1, notReady: 0 });
    expect(touchCalls).toEqual(["error-game"]);
  });

  it("reschedules games when completion is already in-flight elsewhere", async () => {
    const { runner, touchCalls } = createScanRunnerFixture({
      pendingGames: () => [{ game_address: "inflight-game", completion_attempts: 0 }],
      attemptGameCompletion: async () => null,
    });

    const stats = await runner.scanAndCompleteActiveGames();

    expect(stats).toEqual({ completed: 0, errors: 0, notReady: 0 });
    expect(touchCalls).toEqual(["inflight-game"]);
  });
});

describe("ScanLoopRunner completion attempt boundary", () => {
  it("skips games that already reached the max completion attempts", async () => {
    const env = await createTestEnv({
      prefix: "scan-runner-max",
      singletons: {
        OracleDatabase: async () => OracleDatabase,
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
      expect(pending.find((entry) => entry.game_address === gameAddress)?.completion_attempts).toBe(
        1,
      );
    } finally {
      env.cleanup();
    }
  });

  it("skips auto-completion for disabled games while keeping them tracked", async () => {
    const env = await createTestEnv({
      prefix: "scan-runner-disabled",
      singletons: {
        OracleDatabase: async () => OracleDatabase,
      },
    });

    try {
      const db = env.singletons.OracleDatabase.getInstance();
      db.cleanupOldRecords(-1);

      const activeGame = "enabled-game";
      const disabledGame = "disabled-game";
      db.trackGame(activeGame);
      db.trackGame(disabledGame);
      db.setAutoCompleteDisabled(disabledGame, true);

      const completionCalls: string[] = [];
      const completion: ScanLoopRunnerOptions["completion"] = {
        resolveContextAndReadiness: async () => ({
          status: "ready",
          context: {} as any,
          readiness: { ready: true, gameAccount: {} } as any,
          prefetchScheduled: false,
        }),
        attemptGameCompletion: async (options) => {
          completionCalls.push(options.gameAddress);
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
        maxCompletionAttempts: 5,
        cleanupOldRecords: () => {},
      });

      const stats = await runner.scanAndCompleteActiveGames();

      expect(stats).toEqual({ completed: 1, errors: 0, notReady: 0 });
      expect(completionCalls).toEqual([activeGame]);

      const pendingTracked = db.getPendingGames().map((entry) => entry.game_address);
      expect(pendingTracked).toEqual(expect.arrayContaining([disabledGame, activeGame]));
    } finally {
      env.cleanup();
    }
  });
});
