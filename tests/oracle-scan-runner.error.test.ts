import { describe, it, expect } from "bun:test";
import { ScanLoopRunner, type ScanLoopRunnerOptions } from "../oracle-scan-runner.ts";
import type { OracleDatabase } from "../database.ts";
import type { OracleMetrics } from "../metrics.ts";

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
        context: {} as any,
        readiness: { ready: true } as any,
        notReady: false,
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
});
