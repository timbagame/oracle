import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupTestEnvironment } from "./helpers/setup-env.ts";
import { createBasicOracle, createBasicStats } from "./helpers/fake-oracle.ts";

type BuildHandlers = typeof import("../index.ts").buildHandlers;
type BuildFetchRouter = typeof import("../index.ts").buildFetchRouter;

let buildHandlers: BuildHandlers;
let buildFetchRouter: BuildFetchRouter;
let handlers: ReturnType<BuildHandlers>;
let router: ReturnType<BuildFetchRouter>;
let testEnv: ReturnType<typeof setupTestEnvironment>;

describe("index router", () => {
  beforeAll(async () => {
    testEnv = setupTestEnvironment({ prefix: "index-router" });
    ({ buildHandlers, buildFetchRouter } = await import("../index.ts"));
    handlers = buildHandlers(
      createBasicOracle({
        generateGameSecrets: () => ({ randomHash: "abc", gameAddress: "game123" }),
        getStats: () => ({
          ...createBasicStats(),
          recentCompletions: 0,
          errors: 0,
          uptimeSeconds: 0,
        }),
      })
    );
    router = buildFetchRouter(handlers);
  });

  afterAll(() => {
    testEnv.cleanup();
  });

  test("OPTIONS preflight returns CORS headers", async () => {
    const res = await router(new Request("http://localhost:3001/health", { method: "OPTIONS" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  test("GET /health returns JSON", async () => {
    const res = await router(new Request("http://localhost:3001/health", { method: "GET" }));
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.status).toBe("healthy");
  });

  test("POST /generate-hash returns secrets", async () => {
    const res = await router(new Request("http://localhost:3001/generate-hash", { method: "POST" }));
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.success).toBe(true);
    expect(json.randomHash).toBe("abc");
  });

  test("GET /stats returns stats", async () => {
    const res = await router(new Request("http://localhost:3001/stats", { method: "GET" }));
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.success).toBe(true);
    expect(json.stats).toBeDefined();
  });

  test("GET / returns HTML", async () => {
    const res = await router(new Request("http://localhost:3001/", { method: "GET" }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Oracle API Documentation");
  });

  test("unknown route returns 404", async () => {
    const res = await router(new Request("http://localhost:3001/unknown", { method: "GET" }));
    expect(res.status).toBe(404);
  });

  test("router catches handler errors and returns 500", async () => {
    const badHandlers = buildHandlers(
      createBasicOracle({
        generateGameSecrets: () => {
          throw new Error("boom");
        },
      })
    );
    const badRouter = buildFetchRouter(badHandlers);
    const res = await badRouter(new Request("http://localhost:3001/generate-hash", { method: "POST" }));
    expect(res.status).toBe(500);
  });

  test("router logs unexpected errors and returns generic 500", async () => {
    const originalError = console.error;
    const errors: any[] = [];
    console.error = (...args: any[]) => {
      errors.push(args.join(" "));
    };

    try {
      const failingRouter = buildFetchRouter({
        handleHealth: async () => {
          throw new Error("explode");
        },
        handleGenerateHash: async () => new Response("ok"),
        handleStats: async () => new Response("ok"),
      });

      const res = await failingRouter(new Request("http://localhost:3001/health", { method: "GET" }));
      expect(res.status).toBe(500);
      const json: any = await res.json();
      expect(json.error).toBe("Internal server error");
      expect(errors.some((entry) => entry.includes("Server error"))).toBe(true);
    } finally {
      console.error = originalError;
    }
  });
});
