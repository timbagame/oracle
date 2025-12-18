import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { setupOracleServiceEnv } from "./helpers/setup-oracle-service-env.ts";
import type { ActiveEndpointChange } from "../rpc-endpoints.ts";


class TestRpcEndpointManager {
  private readonly listeners = new Set<
    (change: ActiveEndpointChange) => void | Promise<void>
  >();

  public onActiveEndpointChange(
    listener: (change: import("../rpc-endpoints.ts").ActiveEndpointChange) => void | Promise<void>,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public async trigger(change: ActiveEndpointChange): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const listener of this.listeners) {
      const result = listener(change);
      if (result && typeof (result as Promise<unknown>).then === "function") {
        pending.push(Promise.resolve(result).then(() => {}));
      }
    }
    await Promise.all(pending);
  }
}

describe("OracleService RPC failover listener", () => {
  let OracleDatabase: typeof import("../database.ts").OracleDatabase;
  let cleanup: () => void;

  beforeAll(async () => {
    const env = await setupOracleServiceEnv("oracle-service-rpc-failover");
    OracleDatabase = env.OracleDatabase;
    cleanup = env.cleanup;
  });

  afterAll(() => {
    cleanup?.();
  });

  it("restarts event listeners after an RPC endpoint change", async () => {
    const db = OracleDatabase.getInstance();
    const service = (import.meta.require("../oracle-service.ts").OracleService).createWith(db);

    // We don't call registerRpcEndpointFailoverListener here because it's called in constructor
    // But we need to replace the manager with our test one
    const manager = new TestRpcEndpointManager();
    (service as any).rpcEndpointManager = manager;
    (service as any).registerRpcEndpointFailoverListener(); // This will add a SECOND listener if we are not careful, but createWith creates a FRESH service.

    const eventProcessor = {
      isListening: () => true,
      stopListening: async () => {},
      startListening: async () => {},
    };

    const stopSpy = spyOn(eventProcessor, "stopListening").mockResolvedValue(undefined);
    const startSpy = spyOn(eventProcessor, "startListening").mockResolvedValue(undefined);

    (service as any).eventProcessor = eventProcessor;

    await manager.trigger({
      endpoint: "https://rpc-b",
      previousEndpoint: "https://rpc-a",
      index: 1,
      previousIndex: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledTimes(1);

    await service.close();
  });

  it("propagates restart failures and clears pending syncs on every retry", async () => {
    const db = OracleDatabase.getInstance();
    const service = (import.meta.require("../oracle-service.ts").OracleService).createWith(db);

    const eventProcessor = {
      isListening: () => true,
      stopListening: async () => {},
      startListening: async () => {
        throw new Error("boom");
      },
      clearRegistrySyncs: () => {},
    };

    const stopSpy = spyOn(eventProcessor, "stopListening").mockResolvedValue(undefined);
    const startSpy = spyOn(eventProcessor, "startListening").mockRejectedValue(new Error("boom"));
    const clearSpy = spyOn(eventProcessor, "clearRegistrySyncs").mockReturnValue(undefined);

    (service as any).eventProcessor = eventProcessor;

    const manager = new TestRpcEndpointManager();
    (service as any).rpcEndpointManager = manager;
    (service as any).registerRpcEndpointFailoverListener();

    await expect(
      manager.trigger({
        endpoint: "https://rpc-b",
        previousEndpoint: "https://rpc-a",
        index: 1,
        previousIndex: 0,
      }),
    ).rejects.toThrow("boom");

    expect(stopSpy).toHaveBeenCalledTimes(3);
    expect(startSpy).toHaveBeenCalledTimes(3);
    expect(clearSpy).toHaveBeenCalledTimes(3);

    await service.close();
  });
});
