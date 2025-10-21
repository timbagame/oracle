import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createBasicOracle } from "./helpers/fake-oracle.ts";

let initialize: typeof import("../index.ts").initialize;
let shutdown: typeof import("../index.ts").shutdown;

let exitBackup: any;

beforeAll(async () => {
  process.env["NODE_ENV"] = "test";
  ({ initialize, shutdown } = await import("../index.ts"));
  // stub exit to avoid terminating runner
  exitBackup = (process as any).exit;
  (process as any).exit = () => {};
});

afterAll(() => {
  (process as any).exit = exitBackup;
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
});
