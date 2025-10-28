import { beforeAll, afterAll, describe, it, expect } from "bun:test";
import { createTestEnv } from "./helpers/create-test-env.ts";
import { createBasicOracle } from "./helpers/fake-oracle.ts";

let buildHandlers: typeof import("../index.ts").buildHandlers;
let testEnv: Awaited<ReturnType<typeof createTestEnv>>;

beforeAll(async () => {
  testEnv = await createTestEnv({
    prefix: "index-test",
    singletons: {
      OracleService: async () => (await import("../oracle-service.ts")).OracleService,
    },
  });
  ({ buildHandlers } = await import("../index.ts"));
});

afterAll(() => {
  testEnv.cleanup();
});

describe("API handlers", () => {
  it("returns health status", async () => {
    const { handleHealth } = buildHandlers(createBasicOracle());
    const res = await handleHealth();
    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean; status: string };
    expect(data.success).toBe(true);
    expect(data.status).toBe("healthy");
  });

  it("generates game secrets", async () => {
    const { handleGenerateHash } = buildHandlers(createBasicOracle());
    const res = await handleGenerateHash();
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      success: boolean;
      randomHash: string;
      gameAddress: string;
    };
    expect(data.success).toBe(true);
    expect(typeof data.randomHash).toBe("string");
    expect(typeof data.gameAddress).toBe("string");
  });

  it("provides stats", async () => {
    const { handleStats } = buildHandlers(createBasicOracle());
    const res = await handleStats();
    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean; stats: unknown };
    expect(data.success).toBe(true);
    expect(data.stats).toBeDefined();
  });

  it("handles generate hash errors", async () => {
    const { handleGenerateHash } = buildHandlers(
      createBasicOracle({
        generateGameSecrets: () => {
          throw new Error("boom");
        },
      })
    );
    const res = await handleGenerateHash();
    expect(res.status).toBe(500);
    const data = (await res.json()) as { success: boolean };
    expect(data.success).toBe(false);
  });
});
