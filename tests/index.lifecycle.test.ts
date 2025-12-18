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

  it("shutdown stops listeners and does not exit in tests", async () => {
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

  it("shutdown completes even when listener teardown hangs", async () => {
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
});
