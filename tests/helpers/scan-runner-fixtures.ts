import type { OracleDatabase } from "../../database.ts";
import { ScanLoopRunner, type ScanLoopRunnerOptions } from "../../oracle-scan-runner.ts";
import type { OracleMetrics } from "../../metrics.ts";
import type { GameCompletionResult, AttemptGameCompletionOptions } from "../../oracle-service.types.ts";

export interface ScanRunnerFixtureOptions {
  pendingGames?: () => Array<{ game_address: string; completion_attempts: number }>;
  attemptGameCompletion?: (
    params: AttemptGameCompletionOptions,
  ) => Promise<GameCompletionResult | null>;
  resolveContextAndReadiness?: ScanLoopRunnerOptions["completion"]["resolveContextAndReadiness"];
  consumeReadiness?: ScanLoopRunnerOptions["completion"]["consumeReadiness"];
  getBlockchainTime?: ScanLoopRunnerOptions["completion"]["getBlockchainTime"];
  interGameDelayMs?: number;
  maxCompletionAttempts?: number;
  cleanupOldRecords?: ScanLoopRunnerOptions["cleanupOldRecords"];
}

export function createScanRunnerFixture(
  overrides: ScanRunnerFixtureOptions = {},
): {
  runner: ScanLoopRunner;
  touchCalls: string[];
  attemptCalls: string[];
  db: OracleDatabase;
} {
  const touchCalls: string[] = [];
  const attemptCalls: string[] = [];

  const db = {
    getPendingGames: overrides.pendingGames ?? (() => []),
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
    resolveContextAndReadiness:
      overrides.resolveContextAndReadiness ??
      (async () => ({
        status: "ready",
        context: {} as any,
        readiness: { ready: true, gameAccount: {} } as any,
        prefetchScheduled: false,
      })),
    attemptGameCompletion: async (params) => {
      attemptCalls.push(params.gameAddress);
      if (overrides.attemptGameCompletion) {
        return overrides.attemptGameCompletion(params);
      }
      return { success: true };
    },
    consumeReadiness: overrides.consumeReadiness ?? (() => undefined),
    getBlockchainTime: overrides.getBlockchainTime ?? (async () => Date.now()),
  };

  const runner = new ScanLoopRunner({
    db,
    metrics,
    completion,
    interGameDelayMs: overrides.interGameDelayMs ?? 0,
    maxCompletionAttempts: overrides.maxCompletionAttempts ?? 5,
    cleanupOldRecords: overrides.cleanupOldRecords ?? (() => {}),
  });

  return { runner, touchCalls, attemptCalls, db };
}
