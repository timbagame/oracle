import { describe, it, expect, spyOn } from "bun:test";
import { ScanLoopRunner, type ScanLoopRunnerOptions } from "../oracle-scan-runner.ts";
import type { OracleDatabase } from "../database.ts";
import type { OracleMetrics } from "../metrics.ts";
import * as delayModule from "../delay.ts";

const createStubbedRunner = () => {
  const touchCalls: string[] = [];
  const attemptCalls: string[] = [];

  const db = {
    getPendingGames: () => [
      { game_address: "game-1", completion_attempts: 0 },
      { game_address: "game-2", completion_attempts: 0 },
    ],
    markGameCompleted: () => {},
    touchGameCheck: (address: string) => {
      touchCalls.push(address);
    },
  } as unknown as OracleDatabase;

  const metrics: OracleMetrics = {
    recordCompletion: () => {},
    recordScanCycle: () => {},
    recordCleanupSweep: () => {},
  };

  const completion: ScanLoopRunnerOptions["completion"] = {
    resolveContextAndReadiness: async () => ({
      context: {} as any,
      readiness: { ready: true } as any,
      notReady: false,
    }),
    attemptGameCompletion: async (options: { gameAddress: string }) => {
      attemptCalls.push(options.gameAddress);
      if (attemptCalls.length === 1) {
        return { success: false, notReady: true } as const;
      }
      return { success: true } as const;
    },
    consumeReadiness: () => undefined,
    getBlockchainTime: async () => 123,
  };

  const runnerOptions: ScanLoopRunnerOptions = {
    db,
    metrics,
    completion,
    interGameDelayMs: 50,
    maxCompletionAttempts: 5,
    cleanupOldRecords: () => {},
  };

  const runner = new ScanLoopRunner(runnerOptions);

  return { runner, touchCalls, attemptCalls };
};

describe("ScanLoopRunner abort handling", () => {
  it("stops iteration when aborted during inter-game delay", async () => {
    const abortController = new AbortController();
  const { runner, touchCalls, attemptCalls } = createStubbedRunner();

    const delaySpy = spyOn(delayModule, "delay").mockImplementation(
      async (_ms, options) => {
        expect(options?.signal).toBe(abortController.signal);
        abortController.abort();
      },
    );

    try {
      const stats = await runner.scanAndCompleteActiveGames({ signal: abortController.signal });

      expect(stats).toEqual({ completed: 0, errors: 0, notReady: 1 });
      expect(attemptCalls).toEqual(["game-1"]);
      expect(touchCalls).toEqual(["game-1"]);
      expect(delaySpy).toHaveBeenCalledTimes(1);
    } finally {
      delaySpy.mockRestore();
    }
  });
});
