import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { setupOracleServiceEnv } from "./helpers/setup-oracle-service-env.ts";
import type { ActiveEndpointChange } from "../rpc-endpoints.ts";

class TestRpcEndpointManager {
  private readonly listeners = new Set<
    (change: ActiveEndpointChange) => void | Promise<void>
  >();

  public onActiveEndpointChange(
    listener: (change: ActiveEndpointChange) => void | Promise<void>,
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
  let OracleServiceClass: typeof import("../oracle-service.ts").OracleService;
  let cleanup: () => void;

  beforeAll(async () => {
    const env = await setupOracleServiceEnv("oracle-service-rpc-failover");
    OracleServiceClass = env.OracleService;
    cleanup = env.cleanup;
  });

  afterAll(() => {
    cleanup?.();
  });

  it("restarts event listeners after an RPC endpoint change", async () => {
    const service = OracleServiceClass.getInstance();
    const eventProcessor = {
      isListening: () => true,
      stopListening: async () => {},
      startListening: async () => {},
    };

    const stopSpy = spyOn(eventProcessor, "stopListening").mockResolvedValue(
      undefined,
    );
    const startSpy = spyOn(eventProcessor, "startListening").mockResolvedValue(
      undefined,
    );

    (service as any).eventProcessor = eventProcessor;

    const manager = new TestRpcEndpointManager();
    (service as any).rpcEndpointManager = manager;
    (service as any).registerRpcEndpointFailoverListener();

    await manager.trigger({
      endpoint: "https://rpc-b",
      previousEndpoint: "https://rpc-a",
      index: 1,
      previousIndex: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledTimes(1);

    stopSpy.mockRestore();
    startSpy.mockRestore();
  });
});
