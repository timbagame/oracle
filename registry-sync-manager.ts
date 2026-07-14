import { logger } from "./logger.ts";
import { analyzeRegistryState } from "./player-registry-utils.ts";
import type {
  GameCompletionResult,
  GameOnChainContext,
  GameReadinessSnapshot,
} from "./oracle-service.types.ts";

export interface RegistrySyncManagerOptions {
  db: {
    getGamePlayers: (gameAddress: string) => string[];
    replaceGamePlayers: (gameAddress: string, players: string[]) => void;
  };
  recoverPlayerRegistry?: (options: {
    gameAddress: string;
    context: GameOnChainContext;
    readiness: GameReadinessSnapshot;
    expectedTickets: number;
    reason: string;
  }) => Promise<string[] | null>;
  markGameDesynced?: (gameAddress: string) => void;
  registryPrefetchCooldownMs?: number;
}

export class RegistrySyncManager {
  private readonly registryPrefetchCooldownMs: number;
  private readonly registryPrefetchSchedule = new Map<string, number>();
  private readonly prefetchingGames = new Map<string, Promise<void>>();
  private readonly attemptedRegistryRecovery = new Set<string>();

  // Cache for registry analysis results
  private readonly registryAnalysisCache = new Map<
    string,
    {
      count: number;
      expected: number;
      result: ReturnType<typeof analyzeRegistryState>;
      timestamp: number;
    }
  >();

  constructor(private readonly options: RegistrySyncManagerOptions) {
    const configured = options.registryPrefetchCooldownMs ?? 60_000;
    this.registryPrefetchCooldownMs = Math.max(1_000, configured);
  }

  public async ensurePlayersInSync(
    gameAddress: string,
    context: GameOnChainContext,
    readiness: GameReadinessSnapshot,
    expectedEntries: number,
    recordFatalFailure: (gameAddress: string, error: string) => GameCompletionResult,
  ): Promise<{ players: string[] } | { error: GameCompletionResult }> {
    if (expectedEntries <= 0) {
      logger.failure(
        `Ticket registry mismatch for ${gameAddress}: expected at least 1 entry, found ${expectedEntries}`,
      );
      if (this.options.markGameDesynced) {
        this.options.markGameDesynced(gameAddress);
      }
      return {
        error: recordFatalFailure(gameAddress, "No ticket entries available for completion"),
      };
    }

    let players = this.options.db.getGamePlayers(gameAddress);
    const hasPlayers = players.length > 0;

    // Use cached analysis if available and valid
    const initialAnalysis = this.getCachedOrAnalyze(gameAddress, players, expectedEntries);

    const hasDuplicatePlayers = players.length > 0 && new Set(players).size !== players.length;

    if (!initialAnalysis.needsReconciliation && hasPlayers && !hasDuplicatePlayers) {
      return { players };
    }

    const initialCount = players.length;
    const recovered = await this.tryRecoverPlayerRegistry(
      gameAddress,
      context,
      readiness,
      expectedEntries,
      initialCount,
    );

    if (recovered) {
      players = recovered;
    }

    // Re-analyze after potential recovery
    const postRecoveryAnalysis = analyzeRegistryState(
      {
        count: players.length,
        maxIndex: players.length === 0 ? null : players.length - 1,
        minIndex: players.length === 0 ? null : 0,
      },
      expectedEntries,
    );

    // Update cache with new state
    this.registryAnalysisCache.set(gameAddress, {
      count: players.length,
      expected: expectedEntries,
      result: postRecoveryAnalysis,
      timestamp: Date.now(),
    });

    const postRecoveryDuplicates = players.length > 0 && new Set(players).size !== players.length;

    if (
      postRecoveryAnalysis.needsReconciliation ||
      postRecoveryDuplicates ||
      players.length === 0
    ) {
      logger.failure(
        `Ticket registry mismatch for ${gameAddress}: expected ${expectedEntries}, found ${players.length}`,
      );

      if (this.options.markGameDesynced) {
        this.options.markGameDesynced(gameAddress);
      }

      this.resetRegistryPrefetchSchedule(gameAddress);

      return {
        error: recordFatalFailure(gameAddress, "Ticket registry out of sync"),
      };
    }

    return { players };
  }

  private getCachedOrAnalyze(
    gameAddress: string,
    players: string[],
    expectedEntries: number,
  ): ReturnType<typeof analyzeRegistryState> {
    const cached = this.registryAnalysisCache.get(gameAddress);

    // Cache is valid if:
    // 1. Entry exists
    // 2. Player count matches (DB hasn't changed)
    // 3. Expected entries matches (On-chain state hasn't changed drastically)
    // 4. Cache is relatively fresh (e.g., < 5 seconds) - optional, but good for safety
    if (cached && cached.count === players.length && cached.expected === expectedEntries) {
      return cached.result;
    }

    const analysis = analyzeRegistryState(
      {
        count: players.length,
        maxIndex: players.length === 0 ? null : players.length - 1,
        minIndex: players.length === 0 ? null : 0,
      },
      expectedEntries,
    );

    this.registryAnalysisCache.set(gameAddress, {
      count: players.length,
      expected: expectedEntries,
      result: analysis,
      timestamp: Date.now(),
    });

    return analysis;
  }

  public async tryRecoverPlayerRegistry(
    gameAddress: string,
    context: GameOnChainContext,
    readiness: GameReadinessSnapshot,
    expectedEntries: number,
    previousCount: number,
  ): Promise<string[] | null> {
    const recoverFn = this.options.recoverPlayerRegistry;

    if (!recoverFn) {
      logger.failure(
        `Ticket registry mismatch for ${gameAddress}: expected ${expectedEntries}, found ${previousCount}`,
      );
      return null;
    }

    if (this.attemptedRegistryRecovery.has(gameAddress)) {
      return null;
    }

    this.attemptedRegistryRecovery.add(gameAddress);

    try {
      const recovered = await recoverFn({
        gameAddress,
        context,
        readiness,
        expectedTickets: expectedEntries,
        reason: "completion",
      });

      if (recovered && recovered.length === expectedEntries) {
        this.options.db.replaceGamePlayers(gameAddress, recovered);

        // Invalidate cache since DB changed
        this.registryAnalysisCache.delete(gameAddress);

        logger.info(
          `♻️  Recovered ${recovered.length} player entries for ${gameAddress} before completion`,
        );
        return recovered;
      }

      logger.failure(
        `Unable to recover player registry for ${gameAddress}; recovered ${recovered?.length ?? 0} of ${expectedEntries} entries`,
      );
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.failure(`Player registry recovery failed for ${gameAddress}: ${message}`);
      return null;
    } finally {
      this.attemptedRegistryRecovery.delete(gameAddress);
    }
  }

  public async prefetchPlayerRegistry(
    gameAddress: string,
    context: GameOnChainContext,
    readiness: GameReadinessSnapshot,
  ): Promise<void> {
    const recoverFn = this.options.recoverPlayerRegistry;
    const gameAccount = readiness.gameAccount;

    if (!recoverFn || !gameAccount) {
      return;
    }

    const expectedTickets = Number(gameAccount.ticketsCount);
    if (!Number.isFinite(expectedTickets) || expectedTickets <= 0) {
      return;
    }

    const players = this.options.db.getGamePlayers(gameAddress);
    if (players.length >= expectedTickets) {
      return;
    }

    const now = Date.now();
    const nextAllowed = this.registryPrefetchSchedule.get(gameAddress) ?? 0;
    if (now < nextAllowed) {
      return;
    }

    if (this.prefetchingGames.has(gameAddress)) {
      return this.prefetchingGames.get(gameAddress)!;
    }

    const promise = (async () => {
      try {
        const recovered = await recoverFn({
          gameAddress,
          context,
          readiness,
          expectedTickets,
          reason: "readiness-check",
        });

        if (recovered && recovered.length === expectedTickets) {
          this.options.db.replaceGamePlayers(gameAddress, recovered);
          this.registryAnalysisCache.delete(gameAddress); // Invalidate cache

          logger.info(
            `♻️  Prefetched ${recovered.length} players for ${gameAddress} during readiness evaluation`,
          );
          const nextWindow = now + this.registryPrefetchCooldownMs;
          this.registryPrefetchSchedule.set(gameAddress, nextWindow);
        }
      } catch (error) {
        this.resetRegistryPrefetchSchedule(gameAddress);
        const message = error instanceof Error ? error.message : String(error);
        logger.warning(`Unable to prefetch player registry for ${gameAddress}: ${message}`);
      } finally {
        this.prefetchingGames.delete(gameAddress);
      }
    })();

    this.prefetchingGames.set(gameAddress, promise);
    return promise;
  }

  public resetRegistryPrefetchSchedule(gameAddress: string): void {
    this.registryPrefetchSchedule.delete(gameAddress);
  }
}
