import { describe, expect, it } from "bun:test";
import { RegistrySyncScheduler } from "../oracle-event-processor.ts";

const waitFor = async (predicate: () => boolean, label: string, limit = 1000) => {
  for (let i = 0; i < limit; i++) {
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

    const scheduler = new RegistrySyncScheduler(
      async (options) => {
        syncCalls.push(options.trigger);
        return syncCalls.length !== 1;
      },
      10,
      (callback) => {
        timerCallbacks.push(callback);
        return {} as ReturnType<typeof setTimeout>;
      },
      () => {},
    );

    scheduler.schedule({ gameAddress: "race-game", trigger: "first" });
    scheduler.schedule({ gameAddress: "race-game", trigger: "second" });

    expect(syncCalls).toEqual(["first"]);

    await waitFor(() => timerCallbacks.length > 0, "timer callback");
    const timer = timerCallbacks.shift();
    expect(timer).toBeDefined();
    timer?.();
    await waitFor(() => syncCalls.length >= 3, "syncCalls");

    expect(syncCalls).toContain("second");
    expect(syncCalls.filter((value) => value === "first").length).toBeGreaterThanOrEqual(2);
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
        return {} as ReturnType<typeof setTimeout>;
      },
      () => {},
    );

    scheduler.schedule({ gameAddress: "race", trigger: "first" });
    scheduler.schedule({ gameAddress: "race", trigger: "second" });
    await Promise.resolve();
    if (firstResolver) {
      firstResolver(false);
    }
    await Promise.resolve();

    scheduler.schedule({ gameAddress: "race", trigger: "third" });
    await waitFor(() => timerCallbacks.length > 0, "timer callback");
    const timer = timerCallbacks.shift();
    timer?.();

    await waitFor(() => syncCalls.length >= 3, "syncCalls");

    expect(syncCalls).toEqual(["first", "first", "third"]);
  });
});
