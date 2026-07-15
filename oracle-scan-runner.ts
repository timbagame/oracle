import { performance } from "perf_hooks";
import {
  type AttemptGameCompletionOptions,
  type CompletionStats,
  type GameCompletionResult,
  type GameOnChainContext,
  type GameReadinessSnapshot,
  type ReadinessResolution,
  type ScanLoopOptions,
  type ScanLoopSummary,
  createEmptyCompletionStats,
} from "./oracle-service.types.ts";
import type { OracleDatabase } from "./database.ts";
import type { OracleMetrics } from "./metrics.ts";
import { DEFAULT_DELAY_MS, delay as delayHelper } from "./delay.ts";
import { formatCompletionStats } from "./stats-formatter.ts";
import { logger } from "./logger.ts";
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
        getBlockTime?: () => Promise<number>;
      },
    ) => Promise<ReadinessResolution>;
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
  private running = false;

  constructor(private readonly options: ScanLoopRunnerOptions) {}

  public async scanAndCompleteActiveGames(
    runOptions: { signal?: AbortSignal } = {},
  ): Promise<CompletionStats> {
    const { signal } = runOptions;
    const stats: CompletionStats = createEmptyCompletionStats();
    const pendingGames = this.options.db.getActivePendingGames(this.options.maxCompletionAttempts);
    const pendingCount = pendingGames.length;
    const scanStart = performance.now();

    const recordCycle = () => {
      this.options.metrics.recordScanCycle({
        durationMs: performance.now() - scanStart,
        completed: stats.completed,
        errors: stats.errors,
        notReady: stats.notReady,
        pending: pendingCount,
      });
    };

    if (pendingCount === 0 || signal?.aborted) {
      recordCycle();
      return stats;
    }

    logger.info(`🔍 Scanning ${pendingCount} pending games...`);

    let cachedBlockTime: number | undefined;

    const ensureBlockTime = async () => {
      if (cachedBlockTime === undefined) {
        cachedBlockTime = await this.options.completion.getBlockchainTime();
      }
      return cachedBlockTime;
    };

    for (let index = 0; index < pendingGames.length; index++) {
      if (signal?.aborted) {
        break;
      }
      const game = pendingGames[index]!;
      try {
        if (signal?.aborted) {
          break;
        }

        const readinessResolution = await this.options.completion.resolveContextAndReadiness(
          game.game_address,
          {
            requireOnChain: true,
            blockTime: cachedBlockTime,
            getBlockTime: cachedBlockTime === undefined ? ensureBlockTime : undefined,
          },
        );

        if (signal?.aborted) {
          break;
        }

        if (readinessResolution.status === "missing-context") {
          const secret = this.options.db.getSecretKey(game.game_address);
          const hasSecret = Boolean(secret);
          const attempts = (game.completion_attempts ?? 0) + 1;
          const maxReached = attempts >= this.options.maxCompletionAttempts;

          if (hasSecret && !maxReached) {
            // Be patient if we have the secret; it might be RPC flakiness
            stats.notReady += 1;
            logger.warning(
              `⚠️  Game ${game.game_address} account not found on-chain (attempt ${attempts}/${this.options.maxCompletionAttempts}); retrying later.`,
            );
            this.options.db.incrementCompletionAttempts(game.game_address);
            this.options.db.touchGameCheck(game.game_address);
            continue;
          }

          stats.errors += 1;
          const errorReason = hasSecret ? "missing-game-account" : "missing-secret";
          const logMessage = hasSecret
            ? `⚠️  Game ${game.game_address} lost its on-chain account after ${attempts} attempts; marking as desynced.`
            : `❌ Game ${game.game_address} is missing its secret key; marking as desynced.`;

          if (hasSecret) {
            logger.failure(logMessage);
          } else {
            logger.failure(logMessage);
          }

          this.options.db.markGameDesynced(game.game_address);
          this.options.metrics.recordCompletion({
            gameAddress: game.game_address,
            outcome: "error",
            error: errorReason,
          });
          continue;
        }

        // Event subscriptions can miss GameInitialized across RPC disconnects or
        // restarts. A successfully decoded on-chain game is authoritative proof
        // that its commitment must survive abandoned-commitment cleanup.
        this.options.db.markSecretKeyCommitted(game.game_address);

        const onChainContext = readinessResolution.context;
        const readiness = readinessResolution.readiness;

        const result = await this.options.completion.attemptGameCompletion({
          gameAddress: game.game_address,
          context: onChainContext,
          readiness,
          skipReadinessCheck: true,
        });

        if (signal?.aborted) {
          break;
        }
        if (result) {
          this.updateScanStats(stats, result);
          if (result.notReady) {
            this.options.db.touchGameCheck(game.game_address);
          }
        } else {
          this.options.db.touchGameCheck(game.game_address);
        }

        if (!readiness.ready) {
          cachedBlockTime = undefined;
        }

        if (this.shouldThrottleBetweenGames(result ?? null, index, pendingGames.length)) {
          await delayHelper(this.options.interGameDelayMs, { signal });
        }
      } catch (error) {
        stats.errors++;
        logger.error(`❌ Error completing game ${game.game_address}:`, error);
        this.options.metrics.recordCompletion({
          gameAddress: game.game_address,
          outcome: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        this.options.db.touchGameCheck(game.game_address); // push failing games back so we do not spin on stale timestamps
        cachedBlockTime = undefined;
        if (signal?.aborted) {
          break;
        }

        if (this.options.interGameDelayMs > 0) {
          await delayHelper(this.options.interGameDelayMs, { signal });
        }
      }
    }

    this.logScanResults(stats);
    recordCycle();
    return stats;
  }

  public stop(): void {
    this.running = false;
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

    if (this.running) {
      throw new Error("Scan loop is already running");
    }
    this.running = true;

    const totals: CompletionStats = createEmptyCompletionStats();
    let lastStats: CompletionStats | null = null;
    let cycle = 0;

    const shouldAbort = () => Boolean(signal?.aborted) || !this.running;

    try {
      while (!shouldAbort()) {
        cycle++;
        onCycleStart?.(cycle);

        lastStats = await this.scanAndCompleteActiveGames({ signal });

        totals.completed += lastStats.completed;
        totals.errors += lastStats.errors;
        totals.notReady += lastStats.notReady;

        if (cleanupAfterCycleHours !== undefined) {
          try {
            this.options.cleanupOldRecords(cleanupAfterCycleHours);
          } catch (error) {
            logger.failure("Cleanup after scan cycle failed:", error);
          }
        }

        onCycleComplete?.(cycle, lastStats);

        if (shouldAbort()) break;

        const continueLoop = shouldContinue
          ? shouldContinue(lastStats, cycle)
          : lastStats.completed > 0 || lastStats.notReady > 0 || lastStats.errors > 0;

        if (!continueLoop) {
          break;
        }

        const onlyErrorsThisCycle =
          lastStats.errors > 0 && lastStats.completed === 0 && lastStats.notReady === 0;

        const effectiveDelay =
          waitForPendingOnly && !onlyErrorsThisCycle && lastStats.notReady === 0
            ? 0
            : waitBetweenCyclesMs;

        if (effectiveDelay > 0) {
          await delayHelper(effectiveDelay, { signal });
        } else if (waitForPendingOnly && !shouldContinue) {
          break;
        }
      }
    } finally {
      this.running = false;
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
    const formatted = formatCompletionStats(stats);
    if (formatted) {
      logger.info(`📊 Scan: ${formatted}`);
    }
  }
}
