import { beforeAll, afterAll, describe, it, expect } from "bun:test";
import { createTestEnv } from "./helpers/create-test-env.ts";
import { createBasicOracle } from "./helpers/fake-oracle.ts";
import { OracleService } from "../oracle-service.ts";
import { buildHandlers } from "../index.ts";

const TEST_ADDRESS = "32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5";
const TEST_OPERATOR = "11111111111111111111111111111111";

let testEnv: Awaited<ReturnType<typeof createTestEnv>>;

beforeAll(async () => {
  testEnv = await createTestEnv({
    prefix: "index-test",
    singletons: {
      OracleService: async () => OracleService,
    },
  });
});

afterAll(() => {
  testEnv.cleanup();
});

describe("API handlers", () => {
  it("returns health status", async () => {
    const { handleHealth } = buildHandlers(createBasicOracle());
    const res = await handleHealth(new Request("http://localhost/health", { method: "GET" }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean; status: string };
    expect(data.success).toBe(true);
    expect(data.status).toBe("healthy");
  });

  it("generates game secrets", async () => {
    const { handleGenerateHash } = buildHandlers(createBasicOracle());
    const res = await handleGenerateHash(
      new Request("http://localhost/generate-hash", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameType: "coinflip" }),
      }),
    );
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

  it("forwards game type from request body to the oracle", async () => {
    let receivedGameType: string | undefined;
    const { handleGenerateHash } = buildHandlers(
      createBasicOracle({
        generateGameSecrets: async (options) => {
          receivedGameType = options?.gameType;
          return {
            randomHash: "ab".repeat(32),
            gameAddress: TEST_ADDRESS,
            oracleOperator: TEST_OPERATOR,
          };
        },
      }),
    );

    const res = await handleGenerateHash(
      new Request("http://localhost/generate-hash", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameType: "  giveaway  " }),
      }),
    );

    expect(res.status).toBe(200);
    expect(receivedGameType).toBe("giveaway");
  });

  it("rejects non-string gameType inputs", async () => {
    let generateCalled = false;
    const { handleGenerateHash } = buildHandlers(
      createBasicOracle({
        generateGameSecrets: async () => {
          generateCalled = true;
          return { randomHash: "ignored", gameAddress: "ignored" };
        },
      }),
    );

    const res = await handleGenerateHash(
      new Request("http://localhost/generate-hash", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameType: 123 }),
      }),
    );

    expect(res.status).toBe(400);
    const data = (await res.json()) as { success: boolean; error?: string };
    expect(data.success).toBe(false);
    expect(data.error).toContain("gameType");
    expect(generateCalled).toBe(false);
  });

  it("provides stats", async () => {
    const { handleStats } = buildHandlers(createBasicOracle());
    const res = await handleStats(new Request("http://localhost/stats", { method: "GET" }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean; stats: unknown };
    expect(data.success).toBe(true);
    expect(data.stats).toBeDefined();
  });

  it("handles generate hash errors", async () => {
    const { handleGenerateHash } = buildHandlers(
      createBasicOracle({
        generateGameSecrets: async (_options) => {
          throw new Error("boom");
        },
      }),
    );
    const res = await handleGenerateHash(
      new Request("http://localhost/generate-hash", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameType: "coinflip" }),
      }),
    );
    expect(res.status).toBe(500);
    const data = (await res.json()) as {
      success: boolean;
      service: { name: string };
      timestamp: string;
    };
    expect(data.success).toBe(false);
    expect(data.service.name).toBe("oracle-api");
    expect(new Date(data.timestamp).toString()).not.toBe("Invalid Date");
  });
});
