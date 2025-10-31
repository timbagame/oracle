import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createBasicOracle } from "./helpers/fake-oracle.ts";
import { createTestEnv } from "./helpers/create-test-env.ts";

let initialize: typeof import("../index.ts").initialize;
let shutdown: typeof import("../index.ts").shutdown;
let internals: typeof import("../index.ts").__internal__;

let exitBackup: any;
let testEnv: Awaited<ReturnType<typeof createTestEnv>>;

beforeAll(async () => {
  testEnv = await createTestEnv({ prefix: "index-lifecycle" });
  ({ initialize, shutdown, __internal__: internals } = await import("../index.ts"));
  // stub exit to avoid terminating runner
  exitBackup = (process as any).exit;
  (process as any).exit = () => {};
});

afterAll(() => {
  (process as any).exit = exitBackup;
  testEnv.cleanup();
});

describe("lifecycle helpers", () => {
  it("initialize propagates listener failures", async () => {
    await expect(initialize(createBasicOracle())).resolves.toBeUndefined();

    await expect(
      initialize(
        createBasicOracle({
          startEventListening: async () => {
            throw new Error("boom");
          },
        })
      )
    ).rejects.toThrow("boom");
  });

  it("shutdown stops listeners and does not exit in tests", async () => {
    let stopped = false;
    await shutdown(
      createBasicOracle({
        stopEventListening: async () => {
          stopped = true;
        },
      }),
      "SIGINT"
    );
    expect(stopped).toBe(true);
  });

  it("applies explicit exit decision from stop result", () => {
    const exitCalls: Array<number | undefined> = [];
    const originalExit = (process as any).exit;
    (process as any).exit = (code?: number) => {
      exitCalls.push(code);
      return undefined as never;
    };

    try {
      internals.applyExitDecision({
        stopResult: { shouldExit: true, exitCode: 5 },
      });
      expect(exitCalls).toEqual([5]);
    } finally {
      (process as any).exit = originalExit;
    }
  });

  it("computes fallback exit decision in test mode", () => {
    const decision = internals.resolveExitDecision({ exitCode: 3 });
    expect(decision.shouldExit).toBe(false);
    expect(decision.exitCode).toBe(3);
  });
});
