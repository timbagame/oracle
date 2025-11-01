import { performance } from "perf_hooks";
import {
  type AttemptGameCompletionOptions,
  type CompletionStats,
  type GameCompletionResult,
  type GameOnChainContext,
  type GameReadinessSnapshot,
  type ScanLoopOptions,
  type ScanLoopSummary,
  createEmptyCompletionStats,
} from "./oracle-service.types.ts";
import type { OracleDatabase } from "./database.ts";
import type { OracleMetrics } from "./metrics.ts";
import { DEFAULT_DELAY_MS, delay as delayHelper } from "./delay.ts";
export interface ScanLoopRunnerOptions {
  db: OracleDatabase;
  metrics: OracleMetrics;
  completion: {
    resolveContextAndReadiness: (
      gameAddress: string,
      options?: {
        context?: GameOnChainContext | null;
        readiness?: GameReadinessSnapshot;
        requireOnChain?: boolean;
        blockTime?: number;
      },
    ) => Promise<{
      context: GameOnChainContext | null;
      readiness?: GameReadinessSnapshot;
      notReady: boolean;
    }>;
    attemptGameCompletion: (
      options: AttemptGameCompletionOptions,
    ) => Promise<GameCompletionResult | null>;
    consumeReadiness: (gameAddress: string) => GameReadinessSnapshot | undefined;
    getBlockchainTime: () => Promise<number>;
  };
  interGameDelayMs: number;
  maxCompletionAttempts: number;
  cleanupOldRecords: (hours: number) => void;
}

export class ScanLoopRunner {
  constructor(private readonly options: ScanLoopRunnerOptions) {}

  public async scanAndCompleteActiveGames(): Promise<CompletionStats> {
    const stats: CompletionStats = createEmptyCompletionStats();
    const pendingGames = this.options.db.getPendingGames(
      this.options.maxCompletionAttempts,
    );
    const pendingCount = pendingGames.length;
    const scanStart = performance.now();

    if (pendingCount === 0) {
      this.options.metrics.recordScanCycle({
        durationMs: performance.now() - scanStart,
        completed: stats.completed,
        errors: stats.errors,
        notReady: stats.notReady,
        pending: pendingCount,
      });
      return stats;
    }

    console.log(`🔍 Scanning ${pendingCount} pending games...`);

    let cachedBlockTime: number | undefined;

    for (let index = 0; index < pendingGames.length; index++) {
      const game = pendingGames[index]!;
      try {
        cachedBlockTime ??= await this.options.completion.getBlockchainTime();

        const { context: onChainContext, readiness } =
          await this.options.completion.resolveContextAndReadiness(
            game.game_address,
            {
              requireOnChain: true,
              blockTime: cachedBlockTime,
            },
          );
        if (!onChainContext) {
          this.options.db.markGameCompleted(game.game_address);
          continue;
        }

        const result = await this.options.completion.attemptGameCompletion({
          gameAddress: game.game_address,
          context: onChainContext,
          readiness,
          skipReadinessCheck: true,
        });

        if (result) {
          this.updateScanStats(stats, result);
          if (result.notReady) {
            this.options.db.touchGameCheck(game.game_address);
          }
        }

        if (readiness && !readiness.ready) {
          cachedBlockTime = undefined;
        }

        if (
          this.shouldThrottleBetweenGames(result ?? null, index, pendingGames.length)
        ) {
          await delayHelper(this.options.interGameDelayMs);
        }
      } catch (error) {
        stats.errors++;
        console.error(`❌ Error completing game ${game.game_address}:`, error);
        this.options.metrics.recordCompletion({
          gameAddress: game.game_address,
          outcome: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        cachedBlockTime = undefined;
        if (this.options.interGameDelayMs > 0) {
          await delayHelper(this.options.interGameDelayMs);
        }
      }
    }

    this.logScanResults(stats);
    this.options.metrics.recordScanCycle({
      durationMs: performance.now() - scanStart,
      completed: stats.completed,
      errors: stats.errors,
      notReady: stats.notReady,
      pending: pendingCount,
    });
    return stats;
  }

  public async runScanLoop(options: ScanLoopOptions = {}): Promise<ScanLoopSummary> {
    const {
      waitBetweenCyclesMs = DEFAULT_DELAY_MS,
      waitForPendingOnly = false,
      cleanupAfterCycleHours,
      shouldContinue,
      signal,
      onCycleStart,
      onCycleComplete,
    } = options;

    const totals: CompletionStats = createEmptyCompletionStats();
    let lastStats: CompletionStats | null = null;
    let cycle = 0;

    const shouldAbort = () => Boolean(signal?.aborted);

    const waitForNextCycle = async () => {
      if (waitBetweenCyclesMs <= 0) {
        return;
      }

      await delayHelper(waitBetweenCyclesMs, { signal });
    };

    while (!shouldAbort()) {
      cycle += 1;
      onCycleStart?.(cycle);

      const stats = await this.scanAndCompleteActiveGames();
      lastStats = stats;

      totals.completed += stats.completed;
      totals.errors += stats.errors;
      totals.notReady += stats.notReady;

      if (cleanupAfterCycleHours !== undefined) {
        this.options.cleanupOldRecords(cleanupAfterCycleHours);
      }

      onCycleComplete?.(cycle, stats);

      if (shouldAbort()) {
        break;
      }

      const continueLoop = shouldContinue
        ? shouldContinue(stats, cycle)
        : stats.completed > 0 || stats.notReady > 0 || stats.errors > 0;

      const onlyErrorsThisCycle =
        stats.errors > 0 && stats.completed === 0 && stats.notReady === 0;

      if (!continueLoop) {
        break;
      }

      if (
        waitBetweenCyclesMs > 0 &&
        (!waitForPendingOnly || stats.notReady > 0 || onlyErrorsThisCycle)
      ) {
        await waitForNextCycle();
      }
    }

    return {
      cycles: cycle,
      totalCompleted: totals.completed,
      totalErrors: totals.errors,
      totalNotReady: totals.notReady,
      lastStats,
    };
  }

  public shouldThrottleBetweenGames(
    result: GameCompletionResult | null,
    index: number,
    total: number,
  ): boolean {
    if (this.options.interGameDelayMs <= 0) {
      return false;
    }

    if (index >= total - 1) {
      return false;
    }

    if (!result) {
      return true;
    }

    return !result.success;
  }

  public updateScanStats(stats: CompletionStats, result: GameCompletionResult): void {
    if (result.success) {
      stats.completed++;
    } else if (result.notReady) {
      stats.notReady++;
    } else {
      stats.errors++;
    }
  }

  public logScanResults(stats: CompletionStats): void {
    if (stats.completed > 0 || stats.errors > 0 || stats.notReady > 0) {
      const parts = [] as string[];
      if (stats.completed > 0) parts.push(`${stats.completed} completed`);
      if (stats.errors > 0) parts.push(`${stats.errors} errors`);
      if (stats.notReady > 0) parts.push(`${stats.notReady} not ready`);

      console.log(`📊 Scan: ${parts.join(', ')}`);
    }
  }
}
