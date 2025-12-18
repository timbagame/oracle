import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createBasicOracle } from "./helpers/fake-oracle.ts";
import { createIndexLifecycleContext, type IndexLifecycleContext } from "./helpers/index-test-utils.ts";

let context: IndexLifecycleContext;
let exitBackup: any;

beforeAll(async () => {
  context = await createIndexLifecycleContext("index-lifecycle");
  exitBackup = (process as any).exit;
  (process as any).exit = () => {};
});

afterAll(() => {
  (process as any).exit = exitBackup;
  context.testEnv.cleanup();
});

describe("lifecycle helpers", () => {
  it("initialize propagates listener failures", async () => {
    await expect(context.initialize(createBasicOracle())).resolves.toBeUndefined();

    await expect(
      context.initialize(
        createBasicOracle({
          startEventListening: async () => {
            throw new Error("boom");
          },
        }),
      ),
    ).rejects.toThrow("boom");
  });

  it("shutdown calls close() on the oracle", async () => {
    let closed = false;
    await context.shutdown(
      createBasicOracle({
        close: async () => {
          closed = true;
        },
      }),
      "SIGINT",
    );
    expect(closed).toBe(true);
  });

  it("shutdown completes even when close() hangs", async () => {
    const oracle = createBasicOracle({
      close: async () => {
        await new Promise<void>(() => {});
      },
    });

    const result = await Promise.race([
      context.shutdown(oracle, "SIGTERM").then(() => "completed" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 250)),
    ]);

    expect(result).toBe("completed");
  });

  it("shutdown completes when close() throws an error", async () => {
    const oracle = createBasicOracle({
      close: async () => {
        throw new Error("close failed");
      },
    });

    // Shutdown should complete without throwing
    await expect(context.shutdown(oracle, "SIGTERM")).resolves.toBeUndefined();
  });

  it("shutdown calls close() not stopEventListening() directly", async () => {
    let closeCalled = false;
    let stopCalled = false;

    const oracle = createBasicOracle({
      close: async () => {
        closeCalled = true;
      },
      stopEventListening: async () => {
        stopCalled = true;
      },
    });

    await context.shutdown(oracle, "SIGINT");

    // close() should be called (which internally calls stopEventListening)
    expect(closeCalled).toBe(true);
    // stopEventListening should NOT be called directly by shutdown
    expect(stopCalled).toBe(false);
  });
});
