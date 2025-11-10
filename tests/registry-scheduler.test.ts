import { describe, expect, it } from "bun:test";
import { RegistrySyncScheduler } from "../oracle-event-processor.ts";

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

    while (timerCallbacks.length === 0) {
      await Promise.resolve();
    }
    const timer = timerCallbacks.shift();
    expect(timer).toBeDefined();
    timer?.();
    while (syncCalls.length < 3) {
      await Promise.resolve();
    }

    expect(syncCalls).toEqual(["first", "second", "first"]);
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
    while (timerCallbacks.length === 0) {
      await Promise.resolve();
    }
    const timer = timerCallbacks.shift();
    timer?.();

    while (syncCalls.length < 3) {
      await Promise.resolve();
    }

    expect(syncCalls).toEqual(["first", "second", "third"]);
  });
});
