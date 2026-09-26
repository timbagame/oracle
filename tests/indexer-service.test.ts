import { describe, expect, it, spyOn } from "bun:test";
import { Keypair } from "./helpers/solana-fixtures.ts";
import { nextWaitMs, PublicIndexer } from "../indexer/service.ts";

function createIndexer(pollIntervalMs: number, eventDebounceMs = 0, now: () => number = Date.now) {
  return new PublicIndexer(
    {} as never,
    {} as never,
    Keypair.generate().publicKey,
    pollIntervalMs,
    eventDebounceMs,
    now,
  );
}

describe("PublicIndexer scheduling", () => {
  it("runs one coalesced catch-up when live events wake it", async () => {
    const indexer = createIndexer(60_000);
    const controller = new AbortController();
    let cycle = 0;
    let firstCycleComplete!: () => void;
    const firstCycle = new Promise<void>((resolve) => {
      firstCycleComplete = resolve;
    });
    const runOnce = spyOn(indexer, "runOnce").mockImplementation(async () => {
      cycle += 1;
      if (cycle === 1) firstCycleComplete();
      if (cycle === 2) controller.abort();
      return { indexed: 0, transactions: 0 };
    });

    const running = indexer.run(controller.signal);
    await firstCycle;
    indexer.requestCatchUp();
    indexer.requestCatchUp();
    await running;

    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(runOnce.mock.calls[0]?.[0]).toEqual({ reconcileActiveGames: true });
    expect(runOnce.mock.calls[1]?.[0]).toEqual({ reconcileActiveGames: false });
  });

  it("retains periodic catch-up as a recovery path", async () => {
    const indexer = createIndexer(5);
    const controller = new AbortController();
    let cycle = 0;
    const runOnce = spyOn(indexer, "runOnce").mockImplementation(async () => {
      cycle += 1;
      if (cycle === 2) controller.abort();
      return { indexed: 0, transactions: 0 };
    });

    await indexer.run(controller.signal);

    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(runOnce.mock.calls[1]?.[0]).toEqual({ reconcileActiveGames: true });
  });

  it("reconciles on schedule even while events keep waking the indexer", async () => {
    let now = 0;
    const indexer = createIndexer(30, 0, () => now);
    const controller = new AbortController();
    let cycle = 0;
    let firstCycleComplete!: () => void;
    const firstCycle = new Promise<void>((resolve) => {
      firstCycleComplete = resolve;
    });
    const runOnce = spyOn(indexer, "runOnce").mockImplementation(async () => {
      cycle += 1;
      if (cycle === 1) firstCycleComplete();
      if (cycle === 2) {
        now = 30;
        indexer.requestCatchUp();
      }
      if (cycle === 3) controller.abort();
      return { indexed: 0, transactions: 0 };
    });

    const running = indexer.run(controller.signal);
    await firstCycle;
    now = 5;
    indexer.requestCatchUp();
    await running;

    expect(runOnce.mock.calls.map(([options]) => options)).toEqual([
      { reconcileActiveGames: true },
      { reconcileActiveGames: false },
      { reconcileActiveGames: true },
    ]);
  });
});

describe("PublicIndexer cache flushing", () => {
  it("waits for the sooner of reconciliation and a pending cache flush", () => {
    expect(nextWaitMs(60_000, null)).toBe(60_000);
    expect(nextWaitMs(60_000, 5_000)).toBe(5_000);
    expect(nextWaitMs(1_000, 5_000)).toBe(1_000);
    expect(nextWaitMs(-10, null)).toBe(0);
    expect(nextWaitMs(1_000, -5)).toBe(0);
  });

  it("flushes due caches after each cycle and reports the next flush", async () => {
    const calls: string[] = [];
    const database = {
      getCursor: () => ({ signature: "cursor", slot: 1 }),
      apply: () => {
        calls.push("apply");
        return 1;
      },
      flushCaches: () => {
        calls.push("flush");
        return false;
      },
      msUntilCacheFlush: () => 12_000,
    };
    const solana = await import("../indexer/solana.ts");
    const events = spyOn(solana, "getEventsSince").mockResolvedValue({
      events: { initialized: [], membership: [], completed: [], closed: [] },
      cursor: { signature: "next", slot: 2 },
      transactions: 1,
    } as never);
    try {
      const indexer = new PublicIndexer(
        database as never,
        {} as never,
        Keypair.generate().publicKey,
        60_000,
      );
      const result = await indexer.runOnce({ reconcileActiveGames: false });
      expect(result).toEqual({ indexed: 1, transactions: 1, cacheFlushInMs: 12_000 });
      expect(calls).toEqual(["apply", "flush"]);
    } finally {
      events.mockRestore();
    }
  });

  it("wakes early to flush pending caches", async () => {
    const indexer = createIndexer(60_000);
    const controller = new AbortController();
    let cycle = 0;
    const started = Date.now();
    const runOnce = spyOn(indexer, "runOnce").mockImplementation(async () => {
      cycle += 1;
      if (cycle === 2) controller.abort();
      return { indexed: 1, transactions: 1, cacheFlushInMs: cycle === 1 ? 5 : null };
    });

    await indexer.run(controller.signal);

    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
