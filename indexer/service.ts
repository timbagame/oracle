import type { Address } from "@solana/kit";
import { logger } from "../logger.ts";
import type { OracleRpc } from "../solana-kit.ts";
import { ensureAddress, type PublicKeyLike } from "../solana-utils.ts";
import { IndexerDatabase } from "./database.ts";
import { findStaleActiveGames, getEventsSince, getProgramHead } from "./solana.ts";

/** Waits until the next reconciliation, or sooner when a cache flush is pending. */
export function nextWaitMs(untilReconcileMs: number, cacheFlushInMs: number | null): number {
  const reconcile = Math.max(0, untilReconcileMs);
  return cacheFlushInMs == null ? reconcile : Math.min(reconcile, Math.max(0, cacheFlushInMs));
}

export class PublicIndexer {
  private running = false;
  private wakeRequested = false;
  private wakeResolver: ((reason: "event" | "interval" | "abort") => void) | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly programId: Address;

  constructor(
    readonly database: IndexerDatabase,
    private readonly connection: OracleRpc,
    programId: PublicKeyLike,
    private readonly pollIntervalMs: number,
    private readonly eventDebounceMs = 1_000,
    private readonly now: () => number = Date.now,
  ) {
    this.programId = ensureAddress(programId);
  }

  async runOnce(
    options: { reconcileActiveGames?: boolean } = {},
  ): Promise<{ indexed: number; transactions: number; cacheFlushInMs?: number | null }> {
    const shouldReconcile = options.reconcileActiveGames ?? true;
    const cursor = this.database.getCursor();
    if (!cursor) {
      const head = await getProgramHead(this.connection, this.programId);
      if (head) this.database.setCursor(head);
      logger.warning(
        "Indexer cursor initialized at the current program head; import the D1 export before cutover to retain history.",
      );
      if (shouldReconcile) await this.safelyReconcileActiveGames();
      return { indexed: 0, transactions: 0 };
    }

    const result = await getEventsSince(this.connection, this.programId, cursor);
    const indexed = result.cursor ? this.database.apply(result.events, result.cursor) : 0;
    if (shouldReconcile) await this.safelyReconcileActiveGames();
    // Cache rebuilds are throttled; flush any rebuild that became due while idle
    // so stats never lag the indexed data by more than the throttle window.
    this.database.flushCaches();
    return {
      indexed,
      transactions: result.transactions,
      cacheFlushInMs: this.database.msUntilCacheFlush(),
    };
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.running) return;
    this.running = true;
    let nextReconciliationAt = 0;
    try {
      while (!signal.aborted) {
        const shouldReconcile = this.now() >= nextReconciliationAt;
        let cycleCompleted = false;
        let cacheFlushInMs: number | null = null;
        try {
          const result = await this.runOnce({ reconcileActiveGames: shouldReconcile });
          cycleCompleted = true;
          cacheFlushInMs = result.cacheFlushInMs ?? null;
          if (shouldReconcile) nextReconciliationAt = this.now() + this.pollIntervalMs;
          if (result.transactions > 0) {
            logger.info(
              `Public indexer processed ${result.transactions} transactions and ${result.indexed} game changes.`,
            );
          }
        } catch (error) {
          logger.failure("Public indexer cycle failed; cursor was not advanced:", error);
        }
        const waitMs = cycleCompleted
          ? nextWaitMs(nextReconciliationAt - this.now(), cacheFlushInMs)
          : this.pollIntervalMs;
        await this.waitForNextCycle(signal, waitMs);
      }
    } finally {
      this.running = false;
    }
  }

  requestCatchUp(): void {
    this.wakeRequested = true;
    this.scheduleEventWake();
  }

  private async waitForNextCycle(
    signal: AbortSignal,
    intervalMs: number,
  ): Promise<"event" | "interval" | "abort"> {
    if (signal.aborted) return "abort";

    return new Promise((resolve) => {
      let finished = false;
      const finish = (reason: "event" | "interval" | "abort") => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (this.wakeTimer) clearTimeout(this.wakeTimer);
        this.wakeTimer = null;
        signal.removeEventListener("abort", handleAbort);
        if (this.wakeResolver === finish) this.wakeResolver = null;
        this.wakeRequested = false;
        resolve(reason);
      };
      const handleAbort = () => finish("abort");
      const timeout = setTimeout(() => finish("interval"), intervalMs);
      this.wakeResolver = finish;
      signal.addEventListener("abort", handleAbort, { once: true });
      this.scheduleEventWake();
    });
  }

  private scheduleEventWake(): void {
    if (!this.wakeRequested || !this.wakeResolver || this.wakeTimer) return;
    if (this.eventDebounceMs <= 0) {
      this.wakeResolver("event");
      return;
    }
    this.wakeTimer = setTimeout(() => this.wakeResolver?.("event"), this.eventDebounceMs);
  }

  private async reconcileActiveGames(): Promise<void> {
    const games = this.database.getActiveGames();
    if (games.length === 0) return;
    const stale = await findStaleActiveGames(
      this.connection,
      this.programId,
      games.map((game) => game.game_key),
    );
    this.database.removeStaleActiveGames(stale);
  }

  private async safelyReconcileActiveGames(): Promise<void> {
    try {
      await this.reconcileActiveGames();
    } catch (error) {
      logger.warning("Public indexer active-game reconciliation failed:", error);
    }
  }
}
