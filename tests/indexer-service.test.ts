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

describe("PublicIndexer active-game reconciliation", () => {
  function reconcilingIndexer(activeKeys: string[]) {
    const removed: string[][] = [];
    const database = {
      getCursor: () => ({ signature: "cursor", slot: 1 }),
      apply: () => 0,
      flushCaches: () => false,
      msUntilCacheFlush: () => null,
      getActiveGames: () => activeKeys.map((game_key) => ({ game_key })),
      removeStaleActiveGames: (keys: string[]) => {
        removed.push(keys);
      },
    };
    const indexer = new PublicIndexer(
      database as never,
      {} as never,
      Keypair.generate().publicKey,
      60_000,
    );
    return { indexer, removed };
  }

  it("drops active games whose accounts no longer exist on chain", async () => {
    const solana = await import("../indexer/solana.ts");
    const events = spyOn(solana, "getEventsSince").mockResolvedValue({
      events: { initialized: [], membership: [], completed: [], closed: [] },
      cursor: null,
      transactions: 0,
    } as never);
    const stale = spyOn(solana, "findStaleActiveGames").mockResolvedValue(["gone"]);
    try {
      const { indexer, removed } = reconcilingIndexer(["live", "gone"]);

      await indexer.runOnce();

      expect(stale.mock.calls[0]?.[2]).toEqual(["live", "gone"]);
      expect(removed).toEqual([["gone"]]);
    } finally {
      events.mockRestore();
      stale.mockRestore();
    }
  });

  it("skips the chain lookup when no games are active", async () => {
    const solana = await import("../indexer/solana.ts");
    const events = spyOn(solana, "getEventsSince").mockResolvedValue({
      events: { initialized: [], membership: [], completed: [], closed: [] },
      cursor: null,
      transactions: 0,
    } as never);
    const stale = spyOn(solana, "findStaleActiveGames");
    try {
      const { indexer, removed } = reconcilingIndexer([]);

      await indexer.runOnce();

      expect(stale).not.toHaveBeenCalled();
      expect(removed).toEqual([]);
    } finally {
      events.mockRestore();
      stale.mockRestore();
    }
  });

  it("keeps indexing when reconciliation fails", async () => {
    const solana = await import("../indexer/solana.ts");
    const { logger } = await import("../logger.ts");
    const events = spyOn(solana, "getEventsSince").mockResolvedValue({
      events: { initialized: [], membership: [], completed: [], closed: [] },
      cursor: null,
      transactions: 2,
    } as never);
    const failure = new Error("rpc offline");
    const stale = spyOn(solana, "findStaleActiveGames").mockRejectedValue(failure);
    const warning = spyOn(logger, "warning").mockImplementation(() => {});
    try {
      const { indexer, removed } = reconcilingIndexer(["live"]);

      await expect(indexer.runOnce()).resolves.toMatchObject({ transactions: 2 });

      expect(removed).toEqual([]);
      expect(warning).toHaveBeenCalledWith(
        "Public indexer active-game reconciliation failed:",
        failure,
      );
    } finally {
      events.mockRestore();
      stale.mockRestore();
      warning.mockRestore();
    }
  });
});

describe("PublicIndexer event debounce", () => {
  it("coalesces live events for the debounce window before catching up", async () => {
    const indexer = createIndexer(60_000, 20);
    const controller = new AbortController();
    const scheduled: Array<{ callback: () => void; ms: number }> = [];
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
      ms: number,
    ) => {
      scheduled.push({ callback, ms });
      return scheduled.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const clears = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    let cycle = 0;
    const runOnce = spyOn(indexer, "runOnce").mockImplementation(async () => {
      cycle += 1;
      if (cycle === 2) controller.abort();
      return { indexed: 0, transactions: 0 };
    });

    try {
      const running = indexer.run(controller.signal);
      for (let spin = 0; spin < 10 && scheduled.length === 0; spin++) await Promise.resolve();
      expect(scheduled.map(({ ms }) => ms)).toEqual([60_000]);

      indexer.requestCatchUp();
      indexer.requestCatchUp();
      const debounces = scheduled.filter(({ ms }) => ms === 20);
      expect(debounces).toHaveLength(1);
      expect(runOnce).toHaveBeenCalledTimes(1);

      debounces[0]!.callback();
      await running;

      expect(runOnce).toHaveBeenCalledTimes(2);
      expect(runOnce.mock.calls[1]?.[0]).toEqual({ reconcileActiveGames: false });
    } finally {
      timers.mockRestore();
      clears.mockRestore();
    }
  });
});
