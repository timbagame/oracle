import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestEnv } from "./helpers/create-test-env.ts";
import { createBasicOracle, createBasicStats } from "./helpers/fake-oracle.ts";

type BuildHandlers = typeof import("../index.ts").buildHandlers;
type BuildFetchRouter = typeof import("../index.ts").buildFetchRouter;
type RouteMetadata = typeof import("../index.ts").ROUTE_METADATA;

let buildHandlers: BuildHandlers;
let buildFetchRouter: BuildFetchRouter;
let handlers: ReturnType<BuildHandlers>;
let router: ReturnType<BuildFetchRouter>;
let testEnv: Awaited<ReturnType<typeof createTestEnv>>;
let routeMetadata: RouteMetadata = [] as RouteMetadata;

describe("index router", () => {
  beforeAll(async () => {
    testEnv = await createTestEnv({ prefix: "index-router" });
    const indexModule = await import("../index.ts");
    ({ buildHandlers, buildFetchRouter } = indexModule);
    routeMetadata = indexModule.ROUTE_METADATA;
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
    expect(json.success).toBe(true);
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
    expect(res.headers.get("Content-Type")).toBe("text/html");
    const text = await res.text();
    expect(text).toContain("Oracle API Documentation");
    for (const route of routeMetadata) {
      expect(text).toContain(route.path);
      expect(text).toContain(route.summary);
      if (route.requestExample) {
        expect(text).toContain(route.requestExample);
      }
    }
  });

  test("unknown route returns 404", async () => {
    const res = await router(new Request("http://localhost:3001/unknown", { method: "GET" }));
    expect(res.status).toBe(404);
    const json: any = await res.json();
    expect(json.success).toBe(false);
    expect(json.service?.name).toBe("oracle-api");
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
    const json: any = await res.json();
    expect(json.success).toBe(false);
    expect(json.service?.name).toBe("oracle-api");
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
      expect(json.success).toBe(false);
      expect(errors.some((entry) => entry.includes("Server error"))).toBe(true);
    } finally {
      console.error = originalError;
    }
  });

  test("router emits error when handler implementation is missing", async () => {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: any[]) => {
      errors.push(args.join(" "));
    };

    try {
      const incompleteHandlers = { ...handlers } as any;
      delete incompleteHandlers.handleStats;
      const failingRouter = buildFetchRouter(incompleteHandlers);

      const res = await failingRouter(
        new Request("http://localhost:3001/stats", { method: "GET" })
      );

      expect(res.status).toBe(500);
      const body: any = await res.json();
      expect(body.error).toBe("Internal server error");
      expect(body.success).toBe(false);
      expect(errors.some((entry) => entry.includes("Handler not implemented"))).toBe(true);
    } finally {
      console.error = originalError;
    }
  });
});
