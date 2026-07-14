import { describe, expect, it, spyOn } from "bun:test";
import { performance } from "perf_hooks";
import { delay } from "../delay.ts";
import { OracleMetricsRecorder } from "../metrics.ts";

describe("delay helper", () => {
  it("returns immediately for non-positive durations", async () => {
    const signal = new AbortController().signal;
    const start = performance.now();
    await delay(0, { signal });
    await delay(-10, { signal });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1);
  });

  it("cleans up abort listeners when signal fires", async () => {
    const listeners: Set<() => void> = new Set();
    const controller = {
      aborted: false,
      addEventListener: (_: string, listener: () => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_: string, listener: () => void) => {
        listeners.delete(listener);
      },
    };

    const abortSignal = controller as unknown as AbortSignal;

    const pending = delay(50, { signal: abortSignal });
    expect(listeners.size).toBe(1);

    for (const listener of listeners) {
      controller.aborted = true;
      listener();
    }

    await pending;
    expect(listeners.size).toBe(0);
  });

  it("returns immediately for already-aborted signals without scheduling a timer", async () => {
    const setTimeoutSpy = spyOn(globalThis, "setTimeout");
    const abortSignal = { aborted: true } as AbortSignal;

    try {
      const start = performance.now();
      await delay(100, { signal: abortSignal });
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(1);
      expect(setTimeoutSpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});

describe("OracleMetricsRecorder", () => {
  it("trims history buffers to configured size and exposes copies", () => {
    const metrics = new OracleMetricsRecorder({ maxHistory: 3 });

    for (let i = 0; i < 5; i++) {
      metrics.recordCompletion({ gameAddress: `game-${i}`, outcome: "success" });
    }

    const history = metrics.getCompletionRecords();
    expect(history).toHaveLength(3);
    expect(history.map((entry) => entry.gameAddress)).toEqual(["game-2", "game-3", "game-4"]);

    history.pop();
    expect(metrics.getCompletionRecords()).toHaveLength(3);
  });

  it("resets all metric streams", () => {
    const metrics = new OracleMetricsRecorder();
    metrics.recordCompletion({ gameAddress: "a", outcome: "success" });
    metrics.recordScanCycle({
      durationMs: 1,
      completed: 1,
      errors: 0,
      notReady: 0,
      pending: 0,
    });
    metrics.recordCleanupSweep({
      hoursOld: 1,
      deletedSecrets: 1,
      deletedGames: 1,
      deletedPlayers: 1,
    });

    metrics.reset();

    expect(metrics.getCompletionRecords()).toEqual([]);
    expect(metrics.getScanCycles()).toEqual([]);
    expect(metrics.getCleanupSweeps()).toEqual([]);
  });
});
