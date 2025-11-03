import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createBasicStats } from "./helpers/fake-oracle.ts";
import {
  buildRequest,
  createIndexRouterTestContext,
  executeJsonRequest,
  executeTextRequest,
  type IndexRouterTestContext,
} from "./helpers/index-test-utils.ts";

let context: IndexRouterTestContext;

describe("index router", () => {
  beforeAll(async () => {
    context = await createIndexRouterTestContext("index-router", {
      generateGameSecrets: (_options) => ({ randomHash: "abc", gameAddress: "game123" }),
      getStats: () => ({
        ...createBasicStats(),
        recentCompletions: 0,
        errors: 0,
        uptimeSeconds: 0,
      }),
    });
  });

  afterAll(() => {
    context.testEnv.cleanup();
  });

  test("OPTIONS preflight returns CORS headers", async () => {
    const response = await context.router(buildRequest("/health", { method: "OPTIONS" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  test("GET /health returns JSON", async () => {
    const { response, json } = await executeJsonRequest(context.router, "/health", {
      method: "GET",
    });
    expect(response.status).toBe(200);
    expect((json as any).success).toBe(true);
    expect((json as any).status).toBe("healthy");
  });

  test("POST /generate-hash returns secrets", async () => {
    const { response, json } = await executeJsonRequest(context.router, "/generate-hash", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameType: "coinflip" }),
    });
    expect(response.status).toBe(200);
    expect((json as any).success).toBe(true);
    expect((json as any).randomHash).toBe("abc");
  });

  test("GET /stats returns stats", async () => {
    const { response, json } = await executeJsonRequest(context.router, "/stats", {
      method: "GET",
    });
    expect(response.status).toBe(200);
    expect((json as any).success).toBe(true);
    expect((json as any).stats).toBeDefined();
  });

  test("GET / returns HTML", async () => {
    const { response, text } = await executeTextRequest(context.router, "/", {
      method: "GET",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html");
    expect(text).toContain("Oracle API Documentation");
    for (const route of context.routeMetadata) {
      expect(text).toContain(route.path);
      expect(text).toContain(route.summary);
      if (route.requestExample) {
        expect(text).toContain(route.requestExample);
      }
    }
  });

  test("unknown route returns 404", async () => {
    const { response, json } = await executeJsonRequest(context.router, "/unknown", {
      method: "GET",
    });
    expect(response.status).toBe(404);
    expect((json as any).success).toBe(false);
    expect((json as any).service?.name).toBe("oracle-api");
  });

  test("router catches handler errors and returns 500", async () => {
    const failingContext = await createIndexRouterTestContext("index-router-error", {
      generateGameSecrets: () => {
        throw new Error("boom");
      },
    });

    try {
      const { response, json } = await executeJsonRequest(
        failingContext.router,
        "/generate-hash",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ gameType: "coinflip" }),
        },
      );
      expect(response.status).toBe(500);
      expect((json as any).success).toBe(false);
      expect((json as any).service?.name).toBe("oracle-api");
    } finally {
      failingContext.testEnv.cleanup();
    }
  });

  test("router logs unexpected errors and returns generic 500", async () => {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: any[]) => {
      errors.push(args.map(String).join(" "));
    };

    try {
      const router = context.module.buildFetchRouter({
        handleHealth: async (_request: Request) => {
          throw new Error("explode");
        },
        handleGenerateHash: async (_request: Request) => new Response("ok"),
        handleStats: async (_request: Request) => new Response("ok"),
      });

      const { response, json } = await executeJsonRequest(router, "/health", {
        method: "GET",
      });
      expect(response.status).toBe(500);
      expect((json as any).error).toBe("Internal server error");
      expect((json as any).success).toBe(false);
      expect(errors.some((entry) => entry.includes("Server error"))).toBe(true);
    } finally {
      console.error = originalError;
    }
  });

  test("router emits error when handler implementation is missing", async () => {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: any[]) => {
      errors.push(args.map(String).join(" "));
    };

    try {
      const incompleteHandlers = { ...context.handlers } as Partial<
        IndexRouterTestContext["handlers"]
      >;
      delete (incompleteHandlers as any).handleStats;
      const router = context.module.buildFetchRouter(incompleteHandlers as any);

      const { response, json } = await executeJsonRequest(router, "/stats", {
        method: "GET",
      });
      expect(response.status).toBe(500);
      expect((json as any).error).toBe("Internal server error");
      expect((json as any).success).toBe(false);
      expect(errors.some((entry) => entry.includes("Handler not implemented"))).toBe(true);
    } finally {
      console.error = originalError;
    }
  });
});
