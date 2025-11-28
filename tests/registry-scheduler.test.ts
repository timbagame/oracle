import { describe, expect, it } from "bun:test";
import { RegistrySyncScheduler } from "../oracle-event-processor.ts";

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeout = 2000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`${label} timed out`);
};

describe("RegistrySyncScheduler", () => {
  it("keeps queued requests when a retry timer is pending", async () => {
    const timerCallbacks: Array<() => void> = [];
    const syncCalls: string[] = [];

    const syncFn = async (options: any) => {
      syncCalls.push(options.trigger);
      return syncCalls.length !== 1;
    };

    const scheduler = new RegistrySyncScheduler(
      syncFn,
      10,
      (callback) => {
        timerCallbacks.push(callback);
        return callback as unknown as ReturnType<typeof setTimeout>;
      },
      (timer) => {
        const index = timerCallbacks.indexOf(timer as unknown as () => void);
        if (index !== -1) {
          timerCallbacks.splice(index, 1);
        }
      },
      0, // Disable sync timeout
    );

    scheduler.schedule({ gameAddress: "race-game", trigger: "first" });
    scheduler.schedule({ gameAddress: "race-game", trigger: "second" });

    // Wait for processQueue to start
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(syncCalls).toEqual(["first"]);

    // Since syncTimeoutMs is 0, there's no timeout timer.
    // Just wait for the retry timer (scheduled after syncFn returns false).
    await waitFor(() => timerCallbacks.length > 0, "retry timer callback");
    const retryTimer = timerCallbacks.shift();
    expect(retryTimer).toBeDefined();

    // Execute retry timer
    retryTimer?.();
    await waitFor(() => syncCalls.length >= 2, "syncCalls"); // Expect 2 calls (first + retry)

    // Coalescing behavior:
    // 1. "first" runs -> fails.
    // 2. "second" queued (while "first" running).
    // 3. "first" retried.
    // 4. "second" runs.
    // So syncCalls: ["first", "first", "second"]
    expect(syncCalls).toEqual(["first", "first", "second"]);
  });

  it("processes new events even while a retry timer is pending", async () => {
    const timerCallbacks: Array<() => void> = [];
    const syncCalls: string[] = [];
    let firstResolver: ((value: boolean | PromiseLike<boolean>) => void) | undefined;

    const scheduler = new RegistrySyncScheduler(
      async (options) => {
        syncCalls.push(options.trigger);
        if (syncCalls.length === 1) {
          return new Promise((resolve) => {
            firstResolver = resolve;
          });
        }
        return true;
      },
      10,
      (callback) => {
        timerCallbacks.push(callback);
        return callback as unknown as ReturnType<typeof setTimeout>;
      },
      (timer) => {
        const index = timerCallbacks.indexOf(timer as unknown as () => void);
        if (index !== -1) {
          timerCallbacks.splice(index, 1);
        }
      },
      0, // Disable sync timeout
    );

    scheduler.schedule({ gameAddress: "race", trigger: "first" });
    scheduler.schedule({ gameAddress: "race", trigger: "second" });

    // Wait for processQueue to start
    await new Promise((resolve) => setTimeout(resolve, 0));

    await Promise.resolve();
    if (firstResolver) {
      firstResolver(false);
    }
    // Wait for processQueue to handle failure and schedule retry
    await new Promise((resolve) => setTimeout(resolve, 0));

    scheduler.schedule({ gameAddress: "race", trigger: "third" });

    // Since syncTimeoutMs is 0, there's no timeout timer.
    // Just wait for the retry timer.
    await waitFor(() => timerCallbacks.length > 0, "retry timer callback");
    const retryTimer = timerCallbacks.shift();
    expect(retryTimer).toBeDefined();

    retryTimer?.();

    await waitFor(() => syncCalls.length >= 3, "syncCalls");

    // Coalescing behavior:
    // 1. "first" -> syncFn (pending)
    // 2. "second" -> queued
    // 3. "first" resolves false -> retry scheduled with "first"
    // 4. "third" -> merged into retry ("first" -> "third")
    // 5. Retry runs "third"
    // 6. "second" runs (from queue)
    // So syncCalls: ["first", "third", "second"]
    expect(syncCalls).toEqual(["first", "third", "second"]);
  });
});
