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
    let stopped = false;
    await context.shutdown(
      createBasicOracle({
        stopEventListening: async () => {
          stopped = true;
        },
      }),
      "SIGINT",
    );
    expect(stopped).toBe(true);
  });
});
