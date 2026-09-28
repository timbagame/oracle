import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as delayModule from "../delay.ts";
import * as webApi from "../web-api/api.ts";
import { OracleService } from "../oracle-service.ts";
import { IndexerDatabase } from "../indexer/database.ts";
import { PublicIndexer } from "../indexer/service.ts";
import { logger } from "../logger.ts";
import { start } from "../index.ts";
import { setupTestEnvironment } from "./helpers/setup-env.ts";
import { tick, until } from "./helpers/cli.ts";

const PROGRAM_ID = "11111111111111111111111111111111";

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

function track<T extends { mockRestore: () => void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return signal.aborted
    ? Promise.resolve()
    : new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

type ScanOutcome = "throw" | "return";

/** Replaces the chain, HTTP listener, signals and timers that start() wires together. */
function startHarness(
  options: {
    apiToken?: string;
    startFails?: boolean;
    stopFails?: boolean;
    scans?: ScanOutcome[];
    env?: Record<string, string | undefined>;
  } = {},
) {
  const env = setupTestEnvironment({
    prefix: "index-start",
    env: {
      ORACLE_API_TOKEN: options.apiToken ?? "start-token",
      ORACLE_API_TOKEN_FILE: undefined,
      INDEXER_DATABASE_FILE: ":memory:",
      ...options.env,
    },
  });
  restores.push(() => env.cleanup());

  const logs: string[] = [];
  for (const method of ["info", "success", "warning", "failure"] as const) {
    track(
      spyOn(logger, method).mockImplementation(((message: string) => {
        logs.push(String(message));
      }) as never),
    );
  }
  const exit = track(
    spyOn(process, "exit").mockImplementation((() => {
      throw new Error("start() must not exit the test process");
    }) as never),
  );
  const signals = new Map<string, () => unknown>();
  track(
    spyOn(process, "once").mockImplementation(((event: string, handler: () => unknown) => {
      signals.set(event, handler);
      return process;
    }) as never),
  );
  // Waits yield one macrotask so the background loops interleave with the test.
  const delay = track(
    spyOn(delayModule, "delay").mockImplementation((_ms, { signal } = {}) =>
      signal?.aborted ? Promise.resolve() : tick(),
    ),
  );

  let fetchHandler: ((request: Request) => Promise<Response>) | undefined;
  let serverStops = 0;
  const serve = track(
    spyOn(Bun, "serve").mockImplementation(((config: {
      fetch: (request: Request) => Promise<Response>;
    }) => {
      fetchHandler = config.fetch;
      return {
        stop: async () => {
          serverStops += 1;
          // Only the first stop fails, so a later signal can still shut the harness down.
          if (options.stopFails && serverStops === 1) throw new Error("listener stuck");
        },
      };
    }) as never),
  );

  const scanSignals: AbortSignal[] = [];
  const scans = [...(options.scans ?? ["throw", "return"])];
  const catchUps: number[] = [];
  let observer: (() => void) | undefined;
  let observerRemoved = 0;
  let closed = 0;
  let listenStarts = 0;
  const oracle = {
    getConnection: () => ({}),
    getProgramId: () => PROGRAM_ID,
    addProgramEventObserver: (callback: () => void) => {
      observer = callback;
      return () => {
        observerRemoved += 1;
      };
    },
    getStats: () => ({}),
    startEventListening: async () => {
      listenStarts += 1;
      if (options.startFails) throw new Error("listener refused");
    },
    close: async () => {
      closed += 1;
    },
    scanRunner: {
      runScanLoop: async ({ signal }: { signal: AbortSignal }) => {
        scanSignals.push(signal);
        const outcome = scans.shift();
        if (outcome === "throw") throw new Error("rpc unavailable");
        if (outcome === "return") return;
        await waitForAbort(signal);
      },
    },
  };
  const getInstance = track(spyOn(OracleService, "getInstance").mockResolvedValue(oracle as never));
  const indexerRun = track(spyOn(PublicIndexer.prototype, "run").mockImplementation(waitForAbort));
  track(
    spyOn(PublicIndexer.prototype, "requestCatchUp").mockImplementation(() => {
      catchUps.push(Date.now());
    }),
  );

  const jobs = [
    { signature: "sig-fails", attempts: 2 },
    { signature: "sig-ok", attempts: 0 },
  ];
  const finished: string[] = [];
  const retried: Array<[string, number]> = [];
  track(
    spyOn(IndexerDatabase.prototype, "nextVerificationJob").mockImplementation(
      () => jobs.shift() ?? null,
    ),
  );
  track(
    spyOn(IndexerDatabase.prototype, "finishVerificationJob").mockImplementation((signature) => {
      finished.push(signature);
    }),
  );
  track(
    spyOn(IndexerDatabase.prototype, "retryVerificationJob").mockImplementation(
      (signature, attempts) => {
        retried.push([signature, attempts]);
      },
    ),
  );
  const closeIndexer = track(spyOn(IndexerDatabase.prototype, "close"));
  const realCreateWebGameApi = webApi.createWebGameApi;
  track(
    spyOn(webApi, "createWebGameApi").mockImplementation(((
      ...args: Parameters<typeof realCreateWebGameApi>
    ) =>
      Object.assign(realCreateWebGameApi(...args), {
        verify: async (signature: string) => {
          if (signature === "sig-fails") throw new Error("not confirmed yet");
          return {};
        },
      })) as never),
  );

  return {
    logs,
    exit,
    delay,
    indexerRun,
    signals,
    serve,
    getInstance,
    scanSignals,
    catchUps,
    finished,
    retried,
    closeIndexer,
    wake: () => observer?.(),
    get closed() {
      return closed;
    },
    get listenStarts() {
      return listenStarts;
    },
    get serverStops() {
      return serverStops;
    },
    get observerRemoved() {
      return observerRemoved;
    },
    fetch: (path: string, init?: RequestInit) =>
      fetchHandler!(new Request(`http://oracle${path}`, init)),
  };
}

/** Makes the verification worker crash outside its per-job error handling. */
function crashVerificationWorker() {
  track(
    spyOn(IndexerDatabase.prototype, "nextVerificationJob").mockImplementation(() => {
      throw new Error("database is locked");
    }),
  );
}

describe("oracle start", () => {
  test("serves the API, runs background work and shuts down on SIGTERM", async () => {
    const harness = startHarness();

    await start();

    expect(harness.serve).toHaveBeenCalledWith(
      expect.objectContaining({ port: 3001, maxRequestBodySize: expect.any(Number) }),
    );
    expect(harness.logs).toContain("🔮 Oracle API running on http://localhost:3001");
    expect((await harness.fetch("/health")).status).toBe(200);
    expect((await harness.fetch("/stats")).status).toBe(401);
    const stats = await harness.fetch("/indexer/health", {
      headers: { authorization: "Bearer start-token" },
    });
    expect(stats.status).toBe(200);
    expect([...harness.signals.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);

    harness.wake();
    expect(harness.catchUps).toHaveLength(1);

    await until(() => harness.scanSignals.length >= 3 && harness.finished.length === 1);
    expect(harness.logs).toContain("Background scan loop failed:");
    expect(harness.logs).toContain("Background scan loop exited unexpectedly; restarting...");
    expect(harness.retried).toEqual([["sig-fails", 2]]);
    expect(harness.finished).toEqual(["sig-ok"]);

    await harness.signals.get("SIGTERM")!();

    expect(harness.scanSignals.every((signal) => signal.aborted)).toBe(true);
    expect(harness.serverStops).toBe(1);
    expect(harness.observerRemoved).toBe(1);
    expect(harness.closed).toBe(1);
    expect(harness.closeIndexer).toHaveBeenCalledTimes(1);
    expect(harness.logs).toContain("Shutdown complete");
    expect(harness.exit).not.toHaveBeenCalled();
  });

  test("proceeds with shutdown when the background loop does not stop in time", async () => {
    const harness = startHarness({ scans: [] });
    harness.indexerRun.mockImplementation(() => new Promise<void>(() => {}));
    // The shutdown race resolves its timeout immediately while the indexer keeps running.
    harness.delay.mockImplementation((ms, { signal } = {}) =>
      ms === 50 || signal?.aborted ? Promise.resolve() : tick(),
    );

    await start();
    await until(() => harness.scanSignals.length === 1);
    await harness.signals.get("SIGINT")!();

    expect(harness.logs).toContain(
      "Background loop did not exit within the shutdown timeout; proceeding with shutdown.",
    );
    expect(harness.closed).toBe(1);
  });

  test("stops the server when initialization fails", async () => {
    const harness = startHarness({ startFails: true });

    await start();
    await until(() => harness.closed === 1);

    expect(harness.logs).toContain("Oracle initialization failed. Stopping server.");
    expect(harness.scanSignals).toEqual([]);
    expect(harness.serverStops).toBe(1);
    expect(harness.exit).not.toHaveBeenCalled();
  });

  test("refuses to start without an API token", async () => {
    const harness = startHarness({ apiToken: "" });

    await expect(start()).rejects.toThrow("ORACLE_API_TOKEN is required to start the oracle API");

    expect(harness.getInstance).not.toHaveBeenCalled();
    expect(harness.serve).not.toHaveBeenCalled();
  });
});

describe("oracle background supervision", () => {
  test("a crashed worker stops its siblings before the oracle shuts down", async () => {
    const harness = startHarness({ scans: [] });
    let closedWhenIndexerStopped: number | undefined;
    harness.indexerRun.mockImplementation(async (signal: AbortSignal) => {
      await waitForAbort(signal);
      // Stopping takes a moment; shutdown must not close the oracle underneath it.
      await tick();
      closedWhenIndexerStopped = harness.closed;
    });
    crashVerificationWorker();

    await start();
    await until(() => harness.closed === 1);

    const indexerSignal = harness.indexerRun.mock.calls[0]![0] as AbortSignal;
    expect(indexerSignal.aborted).toBe(true);
    expect(harness.scanSignals.every((signal) => signal.aborted)).toBe(true);
    expect(closedWhenIndexerStopped).toBe(0);
    expect(harness.logs).toContain(
      "Background worker crashed; stopping the oracle so it restarts cleanly:",
    );
    expect(harness.serverStops).toBe(1);
    expect(harness.closeIndexer).toHaveBeenCalledTimes(1);
    expect(harness.exit).not.toHaveBeenCalled();
  });

  test("errors raised while workers stop for shutdown are not treated as crashes", async () => {
    const harness = startHarness({ scans: [] });
    harness.indexerRun.mockImplementation(async (signal: AbortSignal) => {
      await waitForAbort(signal);
      throw new DOMException("The operation was aborted.", "AbortError");
    });

    await start();
    await until(() => harness.scanSignals.length === 1);
    await harness.signals.get("SIGTERM")!();

    expect(harness.logs).toContain("Shutdown complete");
    expect(harness.logs).not.toContain(
      "Background worker crashed; stopping the oracle so it restarts cleanly:",
    );
    expect(harness.serverStops).toBe(1);
    expect(harness.closed).toBe(1);
  });

  test("does not launch a second set of background workers when started again", async () => {
    const harness = startHarness({ scans: [] });

    await start();
    await until(() => harness.scanSignals.length === 1);
    await start();
    await until(() => harness.listenStarts === 2);
    for (let index = 0; index < 5; index++) await tick();

    expect(harness.serve).toHaveBeenCalledTimes(2);
    expect(harness.indexerRun).toHaveBeenCalledTimes(1);
    expect(harness.scanSignals).toHaveLength(1);

    await harness.signals.get("SIGTERM")!();
    expect(harness.scanSignals[0]!.aborted).toBe(true);
  });
});

describe("oracle process exits outside the test runner", () => {
  const production = {
    NODE_ENV: "production",
    BUN_ENV: undefined,
    TIMBA_ORACLE_TEST_RUNNER: undefined,
  };

  function productionHarness(options: Parameters<typeof startHarness>[0] = {}) {
    const harness = startHarness({ ...options, env: production });
    harness.exit.mockImplementation((() => undefined) as never);
    return harness;
  }

  test("exits with code 0 after a graceful shutdown", async () => {
    const harness = productionHarness({ scans: [] });

    await start();
    expect(harness.serve).toHaveBeenCalledTimes(1);
    await until(() => harness.scanSignals.length === 1);
    await harness.signals.get("SIGTERM")!();

    expect(harness.scanSignals[0]!.aborted).toBe(true);
    expect(harness.closed).toBe(1);
    expect(harness.logs).toContain("Shutdown complete");
    expect(harness.exit.mock.calls).toEqual([[0]]);
  });

  test("exits with code 0 even when stopping the server fails", async () => {
    const harness = productionHarness({ scans: [], stopFails: true });

    await start();
    await until(() => harness.scanSignals.length === 1);
    await harness.signals.get("SIGINT")!();

    expect(harness.logs).toContain("Shutdown error:");
    expect(harness.logs).not.toContain("Shutdown complete");
    expect(harness.closed).toBe(0);
    expect(harness.exit.mock.calls).toEqual([[0]]);

    await harness.signals.get("SIGTERM")!();
    expect(harness.closed).toBe(1);
    expect(harness.scanSignals[0]!.aborted).toBe(true);
  });

  test("exits with code 1 when initialization fails", async () => {
    const harness = productionHarness({ startFails: true });

    await start();
    await until(() => harness.exit.mock.calls.length > 0);

    expect(harness.logs).toContain("Oracle initialization failed. Stopping server.");
    expect(harness.closed).toBe(1);
    expect(harness.scanSignals).toEqual([]);
    expect(harness.exit.mock.calls).toEqual([[1]]);
  });

  test("exits with code 1 when the server cannot be stopped after initialization fails", async () => {
    const harness = productionHarness({ startFails: true, stopFails: true });

    await start();
    await until(() => harness.exit.mock.calls.length > 0);

    expect(harness.logs).toContain("Failed to stop server after init error:");
    expect(harness.closed).toBe(0);
    expect(harness.exit.mock.calls).toEqual([[1]]);
  });

  test("exits with code 1 after a background worker crashes", async () => {
    const harness = productionHarness({ scans: [] });
    crashVerificationWorker();

    await start();
    await until(() => harness.exit.mock.calls.length > 0);

    expect(harness.scanSignals.every((signal) => signal.aborted)).toBe(true);
    expect(harness.closed).toBe(1);
    expect(harness.exit.mock.calls).toEqual([[1]]);
  });

  test("exits with code 1 when the server cannot be stopped after a worker crash", async () => {
    const harness = productionHarness({ scans: [], stopFails: true });
    crashVerificationWorker();

    await start();
    await until(() => harness.exit.mock.calls.length > 0);

    expect(harness.logs).toContain("Failed to stop server after background worker failure:");
    expect(harness.closed).toBe(0);
    expect(harness.exit.mock.calls).toEqual([[1]]);
  });
});
