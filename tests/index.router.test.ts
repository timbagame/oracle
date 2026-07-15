import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { OracleService, RequeueGameFailureReason } from "../oracle-service.ts";
import { buildProductionOracleApi } from "../index.ts";
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
      generateGameSecrets: (_options) => ({
        randomHash: "abc",
        gameAddress: "game123",
      }),
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

  test("does not expose CORS preflight handling", async () => {
    const response = await context.router(buildRequest("/health", { method: "OPTIONS" }));
    expect(response.status).toBe(404);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("does not emit permissive CORS headers", async () => {
    const response = await context.router(buildRequest("/generate-hash", { method: "OPTIONS" }));

    expect(response.status).toBe(404);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Methods")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Headers")).toBeNull();
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("GET /health returns JSON", async () => {
    const { response, json } = await executeJsonRequest(context.router, "/health", {
      method: "GET",
    });
    expect(response.status).toBe(200);
    expect((json as any).success).toBe(true);
    expect((json as any).status).toBe("healthy");
  });

  test("requires authentication for service routes", async () => {
    const securedRouter = context.module.buildFetchRouter(context.handlers, {
      apiToken: "service-secret",
    });

    const unauthorized = await securedRouter(buildRequest("/generate-hash", { method: "POST" }));
    expect(unauthorized.status).toBe(401);

    const authorized = await securedRouter(
      buildRequest("/generate-hash", {
        method: "POST",
        headers: { authorization: "Bearer service-secret" },
      }),
    );
    expect(authorized.status).toBe(200);
  });

  test("does not expose administrative HTTP routes", async () => {
    const productionRouter = context.module.buildFetchRouter(context.handlers, {
      apiToken: "service-secret",
    });
    const response = await productionRouter(
      buildRequest("/games/auto-complete", {
        method: "POST",
        headers: { authorization: "Bearer service-secret" },
      }),
    );
    expect(response.status).toBe(404);
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

  test("POST /sign-game-transaction returns the oracle-signed transaction", async () => {
    const signingContext = await createIndexRouterTestContext("index-router-sign", {
      signGameTransaction: (txBase64) => `signed:${txBase64}`,
    });
    try {
      const { response, json } = await executeJsonRequest(
        signingContext.router,
        "/sign-game-transaction",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ txBase64: "unsigned" }),
        },
      );
      expect(response.status).toBe(200);
      expect((json as any).txBase64).toBe("signed:unsigned");
    } finally {
      signingContext.testEnv.cleanup();
    }
  });

  test("production API exposes game transaction signing", () => {
    const api = buildProductionOracleApi({
      signGameTransaction: (txBase64: string) => `signed:${txBase64}`,
    } as OracleService);

    expect(api.signGameTransaction?.("unsigned")).toBe("signed:unsigned");
  });

  test("POST /sign-game-transaction requires a transaction", async () => {
    const { response, json } = await executeJsonRequest(context.router, "/sign-game-transaction", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(503);
    expect((json as any).success).toBe(false);
  });

  test("POST /generate-hash rejects overly large game type payloads", async () => {
    const calls: string[] = [];
    const rejectingContext = await createIndexRouterTestContext("index-router-large", {
      generateGameSecrets: (options) => {
        if (options?.gameType) {
          calls.push(options.gameType);
        }
        return { randomHash: "abc", gameAddress: "game123" };
      },
    });

    try {
      const payload = "x".repeat(512);
      const { response, json } = await executeJsonRequest(
        rejectingContext.router,
        "/generate-hash",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ gameType: payload }),
        },
      );

      expect(response.status).toBe(400);
      expect((json as any).success).toBe(false);
      expect((json as any).error).toContain("gameType");
      expect(calls).toHaveLength(0);
    } finally {
      rejectingContext.testEnv.cleanup();
    }
  });

  test("POST /generate-hash rejects invalid JSON payloads", async () => {
    const calls: string[] = [];
    const rejectingContext = await createIndexRouterTestContext("index-router-invalid-json", {
      generateGameSecrets: (options) => {
        if (options?.gameType) {
          calls.push(options.gameType);
        }
        return { randomHash: "abc", gameAddress: "game123" };
      },
    });

    try {
      const { response, json } = await executeJsonRequest(
        rejectingContext.router,
        "/generate-hash",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{ invalid",
        },
      );

      expect(response.status).toBe(400);
      expect((json as any).success).toBe(false);
      expect((json as any).error).toContain("Invalid JSON payload");
      expect(calls).toHaveLength(0);
    } finally {
      rejectingContext.testEnv.cleanup();
    }
  });

  test("POST /generate-hash rejects non-string game types", async () => {
    const rejectingContext = await createIndexRouterTestContext("index-router-type-check", {
      generateGameSecrets: () => ({
        randomHash: "abc",
        gameAddress: "game123",
      }),
    });

    try {
      const { response, json } = await executeJsonRequest(
        rejectingContext.router,
        "/generate-hash",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ gameType: 42 }),
        },
      );

      expect(response.status).toBe(400);
      expect((json as any).success).toBe(false);
      expect((json as any).error).toContain("gameType");
    } finally {
      rejectingContext.testEnv.cleanup();
    }
  });

  test("POST /generate-hash accepts max-length game type", async () => {
    const calls: string[] = [];
    const acceptingContext = await createIndexRouterTestContext("index-router-max-length", {
      generateGameSecrets: (options) => {
        if (options?.gameType) {
          calls.push(options.gameType);
        }
        return { randomHash: "abc", gameAddress: "game123" };
      },
    });

    const maxType = "z".repeat(128);

    try {
      const { response, json } = await executeJsonRequest(
        acceptingContext.router,
        "/generate-hash",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ gameType: maxType }),
        },
      );

      expect(response.status).toBe(200);
      expect((json as any).success).toBe(true);
      expect(calls).toEqual([maxType]);
    } finally {
      acceptingContext.testEnv.cleanup();
    }
  });

  test("GET /stats returns stats", async () => {
    const { response, json } = await executeJsonRequest(context.router, "/stats", {
      method: "GET",
    });
    expect(response.status).toBe(200);
    expect((json as any).success).toBe(true);
    expect((json as any).stats).toBeDefined();
  });

  test("POST /games/requeue queues the game", async () => {
    const requeueCalls: string[] = [];
    const requeueContext = await createIndexRouterTestContext("index-router-requeue", {
      requeueGame: (gameAddress) => {
        requeueCalls.push(gameAddress);
        return { success: true };
      },
    });

    try {
      const { response, json } = await executeJsonRequest(requeueContext.router, "/games/requeue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameAddress: "game123" }),
      });

      expect(response.status).toBe(200);
      expect((json as any).success).toBe(true);
      expect((json as any).status).toBe("queued");
      expect(requeueCalls).toEqual(["game123"]);
    } finally {
      requeueContext.testEnv.cleanup();
    }
  });

  test("POST /games/requeue validates payload and propagates failures", async () => {
    const failingContext = await createIndexRouterTestContext("index-router-requeue-fail", {
      requeueGame: () => ({ success: false, reason: "not-found" }),
    });

    try {
      const missingBody = await executeJsonRequest(failingContext.router, "/games/requeue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(missingBody.response.status).toBe(400);
      expect((missingBody.json as any).error).toContain("gameAddress");

      const failure = await executeJsonRequest(failingContext.router, "/games/requeue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameAddress: "unknown" }),
      });

      expect(failure.response.status).toBe(404);
      expect((failure.json as any).success).toBe(false);
      expect((failure.json as any).error).toContain("not tracked");
    } finally {
      failingContext.testEnv.cleanup();
    }
  });

  test("POST /games/complete-now attempts immediate completion", async () => {
    const completeCalls: string[] = [];
    const completeContext = await createIndexRouterTestContext("index-router-complete-now", {
      completeGameNow: async (gameAddress) => {
        completeCalls.push(gameAddress);
        return {
          success: true,
          txHash: "tx123",
          winnerAddress: "winner123",
          totalPot: 42,
        };
      },
    });

    try {
      const { response, json } = await executeJsonRequest(
        completeContext.router,
        "/games/complete-now",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ gameAddress: "game123" }),
        },
      );

      expect(response.status).toBe(200);
      expect((json as any).success).toBe(true);
      expect((json as any).status).toBe("completed");
      expect((json as any).txHash).toBe("tx123");
      expect(completeCalls).toEqual(["game123"]);
    } finally {
      completeContext.testEnv.cleanup();
    }
  });

  test("POST /games/complete-now reports non-terminal outcomes", async () => {
    const notReadyContext = await createIndexRouterTestContext("index-router-complete-not-ready", {
      completeGameNow: async () => ({ success: false, notReady: true }),
    });
    const inFlightContext = await createIndexRouterTestContext("index-router-complete-in-flight", {
      completeGameNow: async () => null,
    });

    try {
      const notReady = await executeJsonRequest(notReadyContext.router, "/games/complete-now", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameAddress: "game123" }),
      });
      expect(notReady.response.status).toBe(200);
      expect((notReady.json as any).status).toBe("not-ready");

      const inFlight = await executeJsonRequest(inFlightContext.router, "/games/complete-now", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameAddress: "game123" }),
      });
      expect(inFlight.response.status).toBe(200);
      expect((inFlight.json as any).status).toBe("in-flight");
    } finally {
      notReadyContext.testEnv.cleanup();
      inFlightContext.testEnv.cleanup();
    }
  });

  test("POST /games/complete-now validates payload and propagates failures", async () => {
    const calls: string[] = [];
    const failingContext = await createIndexRouterTestContext("index-router-complete-fail", {
      completeGameNow: async (address) => {
        calls.push(address);
        return { success: false, error: "missing secret" };
      },
    });

    try {
      const missingBody = await executeJsonRequest(failingContext.router, "/games/complete-now", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(missingBody.response.status).toBe(400);
      expect((missingBody.json as any).error).toContain("gameAddress");

      const failure = await executeJsonRequest(failingContext.router, "/games/complete-now", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameAddress: "game123" }),
      });
      expect(failure.response.status).toBe(409);
      expect((failure.json as any).error).toBe("missing secret");
      expect(calls).toEqual(["game123"]);
    } finally {
      failingContext.testEnv.cleanup();
    }
  });

  test("POST /games/auto-complete toggles auto-complete state", async () => {
    const toggleCalls: Array<{ address: string; disabled: boolean }> = [];
    const toggleContext = await createIndexRouterTestContext("index-router-toggle", {
      setAutoCompleteDisabled: (address, disabled) => {
        toggleCalls.push({ address, disabled });
        return { success: true, autoCompleteDisabled: disabled };
      },
    });

    try {
      const { response, json } = await executeJsonRequest(
        toggleContext.router,
        "/games/auto-complete",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            gameAddress: "game123",
            autoCompleteDisabled: true,
          }),
        },
      );

      expect(response.status).toBe(200);
      expect((json as any).success).toBe(true);
      expect((json as any).autoCompleteDisabled).toBe(true);
      expect(toggleCalls).toEqual([{ address: "game123", disabled: true }]);
    } finally {
      toggleContext.testEnv.cleanup();
    }
  });

  test("POST /games/auto-complete validates payload and propagates failures", async () => {
    const failingContext = await createIndexRouterTestContext("index-router-toggle-fail", {
      setAutoCompleteDisabled: () => ({
        success: false,
        reason: "not-found",
      }),
    });

    try {
      const missingBody = await executeJsonRequest(failingContext.router, "/games/auto-complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(missingBody.response.status).toBe(400);
      expect((missingBody.json as any).error).toContain("gameAddress");

      const badBoolean = await executeJsonRequest(failingContext.router, "/games/auto-complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          gameAddress: "game123",
          autoCompleteDisabled: "yes",
        }),
      });
      expect(badBoolean.response.status).toBe(400);
      expect((badBoolean.json as any).error).toContain("autoCompleteDisabled");

      const failure = await executeJsonRequest(failingContext.router, "/games/auto-complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          gameAddress: "unknown",
          autoCompleteDisabled: true,
        }),
      });

      expect(failure.response.status).toBe(404);
      expect((failure.json as any).success).toBe(false);
      expect((failure.json as any).error).toContain("not tracked");
    } finally {
      failingContext.testEnv.cleanup();
    }
  });

  test("POST /games/requeue rejects whitespace-only addresses", async () => {
    const calls: string[] = [];
    const rejectingContext = await createIndexRouterTestContext("index-router-requeue-whitespace", {
      requeueGame: (address) => {
        calls.push(address);
        return { success: true };
      },
    });

    try {
      const { response, json } = await executeJsonRequest(
        rejectingContext.router,
        "/games/requeue",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ gameAddress: "   " }),
        },
      );

      expect(response.status).toBe(400);
      expect((json as any).error).toContain("gameAddress");
      expect(calls).toHaveLength(0);
    } finally {
      rejectingContext.testEnv.cleanup();
    }
  });

  test("POST /games/requeue maps failure reasons to correct responses", async () => {
    const scenarios: Array<{
      reason: RequeueGameFailureReason;
      status: number;
      messageFragment: string;
    }> = [
      {
        reason: "missing-secret",
        status: 409,
        messageFragment: "missing its secret key",
      },
      {
        reason: "finalized",
        status: 409,
        messageFragment: "already finalized",
      },
      { reason: "unchanged", status: 409, messageFragment: "already queued" },
    ];

    for (const scenario of scenarios) {
      const failingContext = await createIndexRouterTestContext(
        `index-router-requeue-${scenario.reason}`,
        {
          requeueGame: () => ({ success: false, reason: scenario.reason }),
        },
      );

      try {
        const { response, json } = await executeJsonRequest(
          failingContext.router,
          "/games/requeue",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ gameAddress: "game-123" }),
          },
        );

        expect(response.status).toBe(scenario.status);
        expect((json as any).success).toBe(false);
        expect((json as any).error).toContain(scenario.messageFragment);
      } finally {
        failingContext.testEnv.cleanup();
      }
    }
  });

  test("POST /games/requeue sanitizes error messages", async () => {
    const failingContext = await createIndexRouterTestContext("index-router-requeue-sanitize", {
      requeueGame: () => ({ success: false, reason: "not-found" }),
    });

    try {
      const maliciousAddress = "<script>alert('xss')</script>";
      const { response, json } = await executeJsonRequest(failingContext.router, "/games/requeue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameAddress: maliciousAddress }),
      });

      expect(response.status).toBe(404);
      const errorMessage = String((json as any).error ?? "");
      expect(errorMessage).toContain("&lt;script&gt;");
      expect(errorMessage).not.toContain("<script>");
    } finally {
      failingContext.testEnv.cleanup();
    }
  });

  test("POST /games/requeue strips control characters from error payloads", async () => {
    const failingContext = await createIndexRouterTestContext("index-router-requeue-crlf", {
      requeueGame: () => ({ success: false, reason: "not-found" }),
    });

    try {
      const maliciousAddress = "evil\r\nSet-Cookie: attack";
      const { response, json } = await executeJsonRequest(failingContext.router, "/games/requeue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameAddress: maliciousAddress }),
      });

      expect(response.status).toBe(404);
      const errorMessage = String((json as any).error ?? "");
      expect(errorMessage).not.toMatch(/[\r\n]/);
      expect(errorMessage).toContain("Set-Cookie: attack");
    } finally {
      failingContext.testEnv.cleanup();
    }
  });

  test("GET / returns HTML", async () => {
    const { response, text } = await executeTextRequest(context.router, "/", {
      method: "GET",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html");
    expect(text).toContain("Oracle API Documentation");
    const escapeHtml = (value: string): string =>
      value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    for (const route of context.routeMetadata) {
      expect(text).toContain(route.path);
      expect(text).toContain(route.summary);
      if (route.requestExample) {
        expect(text).toContain(escapeHtml(route.requestExample));
      }
    }
  });

  test("documentation escapes route metadata", () => {
    const maliciousSummary = "Hello <script>alert('xss')</script>";
    const maliciousExample = '<img src=x onerror="hack" />';

    const html = context.module.generateDocumentationHtml([
      {
        path: "/<b>danger</b>",
        method:
          'POST" onclick="alert(1)' as unknown as (typeof context.routeMetadata)[number]["method"],
        handler: "handleHealth",
        summary: maliciousSummary,
        requestExample: maliciousExample,
      },
    ]);

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;danger&lt;/b&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;hack&quot; /&gt;");
    expect(html).toContain("POST&quot; onclick=&quot;alert(1)");
    expect(html).toContain("method postonclickalert1");
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
      const { response, json } = await executeJsonRequest(failingContext.router, "/generate-hash", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameType: "coinflip" }),
      });
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
        handleSignGameTransaction: async (_request: Request) => new Response("ok"),
        handleStats: async (_request: Request) => new Response("ok"),
        handleRequeueGame: async (_request: Request) => new Response("ok"),
        handleCompleteGameNow: async (_request: Request) => new Response("ok"),
        handleToggleAutoComplete: async (_request: Request) => new Response("ok"),
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
      incompleteHandlers.handleRequeueGame = async () => new Response("ok");
      incompleteHandlers.handleToggleAutoComplete = async () => new Response("ok");
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
