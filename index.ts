import "./logging";
import { delay, DEFAULT_DELAY_MS } from "./delay.ts";
import { OracleService } from "./oracle-service.ts";
import { getEnvironmentMode, isTestEnvironment } from "./env.ts";
import { getConfig, DEFAULT_ORACLE_PORT } from "./config.ts";
import type { CompletionStats } from "./oracle-service.types.ts";

const FALLBACK_SCAN_INTERVAL = 300000; // 5 minutes
const BACKGROUND_LOOP_SHUTDOWN_TIMEOUT_MS = 5000;
const IS_TEST_ENV = isTestEnvironment();
const INTERNAL_SERVER_ERROR_MESSAGE = "Internal server error";

// CORS headers configuration
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

type HttpMethod = "GET" | "POST";

/**
 * Oracle API Server with enhanced features
 * Provides endpoints for requesting random hashes, monitoring, and managing games
 */

const CONFIG = getConfig();
const PORT = CONFIG.oraclePort ?? DEFAULT_ORACLE_PORT;

let server: ReturnType<typeof Bun.serve> | undefined;
let backgroundLoop: Promise<void> | undefined;
let backgroundAbortController: AbortController | undefined;

async function stopServer(
  oracle: OracleApi,
  exitCode?: number
): Promise<void> {
  await abortBackgroundLoop();
  await stopEventListeners(oracle);
  shutdownServer();

  if (exitCode !== undefined && !IS_TEST_ENV) {
    process.exit(exitCode);
  }
}

async function abortBackgroundLoop(): Promise<void> {
  if (backgroundAbortController) {
    backgroundAbortController.abort();
  }

  if (!backgroundLoop) {
    return;
  }

  const loopPromise = backgroundLoop;
  backgroundLoop = undefined;

  const timeoutResult = await waitForBackgroundLoopShutdown(loopPromise);

  if (timeoutResult === "timeout") {
    console.warn(
      "⚠️  Background loop did not exit within the shutdown timeout; proceeding with shutdown."
    );

    loopPromise.catch((loopError) => {
      logBackgroundLoopError(loopError);
    });
  }

  backgroundAbortController = undefined;
}

async function waitForBackgroundLoopShutdown(
  loopPromise: Promise<void>
): Promise<"completed" | "timeout"> {
  return Promise.race<"completed" | "timeout">([
    loopPromise
      .then(() => "completed" as const)
      .catch((loopError) => {
        logBackgroundLoopError(loopError);
        return "completed" as const;
      }),
    delay(BACKGROUND_LOOP_SHUTDOWN_TIMEOUT_MS).then(
      () => "timeout" as const
    ),
  ]);
}

async function stopEventListeners(oracle: OracleApi): Promise<void> {
  try {
    await oracle.stopEventListening();
  } catch (listenerError) {
    console.error("⚠️  Failed to stop event listeners:", listenerError);
  }
}

function shutdownServer(): void {
  server?.stop();
}

function logBackgroundLoopError(loopError: unknown): void {
  console.error("⚠️  Background loop terminated with error:", loopError);
}

// Response helpers
function createResponse(data: unknown, status: number = 200): Response {
  if (data === null || data === undefined) {
    return new Response(null, { status, headers: CORS_HEADERS });
  }

  const jsonInput = data as Parameters<typeof JSON.stringify>[0];
  const body = typeof data === "string" ? data : JSON.stringify(jsonInput);
  return new Response(body, { status, headers: CORS_HEADERS });
}

function createHtmlResponse(html: string): Response {
  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

function createErrorResponse(error: string, status: number = 500): Response {
  return createResponse(
    buildServicePayload({
      success: false,
      error,
    }),
    status
  );
}

function createInternalServerErrorResponse(): Response {
  return createErrorResponse(INTERNAL_SERVER_ERROR_MESSAGE, 500);
}

function createSuccessResponse(
  payload: Record<string, unknown> = {}
): Response {
  return createResponse(buildServicePayload({ success: true, ...payload }));
}

function buildServicePayload(extra: Record<string, unknown> = {}) {
  const uptime = process.uptime();
  const timestamp = new Date().toISOString();
  const environment = getEnvironmentMode();

  return {
    ...extra,
    timestamp,
    service: {
      name: "oracle-api",
      version: "1.0.0",
      environment,
      uptime,
    },
  };
}

// Handlers factory for clean DI and testing
export interface OracleApi {
  generateGameSecrets: OracleService["generateGameSecrets"];
  getStats: () => ReturnType<OracleService["getStats"]>;
  scanAndCompleteActiveGames: () => Promise<CompletionStats>;
  startEventListening: () => ReturnType<OracleService["startEventListening"]>;
  stopEventListening: () => ReturnType<OracleService["stopEventListening"]>;
  cleanupOldRecords: OracleService["cleanupOldRecords"];
}

async function readJsonBody(
  request: Request | undefined
): Promise<Record<string, unknown> | null> {
  if (!request || request.bodyUsed) {
    return null;
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType && !contentType.toLowerCase().includes("application/json")) {
    return null;
  }

  try {
    const rawBody = await request.text();
    if (!rawBody) {
      return null;
    }
    const parsed = JSON.parse(rawBody);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (error) {
    console.warn("⚠️  Failed to parse /generate-hash payload:", error);
  }

  return null;
}

export function buildHandlers(oracle: OracleApi) {
  return {
    async handleHealth(_request?: Request): Promise<Response> {
      return createSuccessResponse({ status: "healthy" });
    },

    async handleGenerateHash(request?: Request): Promise<Response> {
      try {
        let gameType: string | undefined;
        if (request) {
          const body = await readJsonBody(request);
          const provided = body ? body["gameType"] : undefined;
          if (typeof provided === "string") {
            const trimmed = provided.trim();
            if (trimmed.length > 0) {
              gameType = trimmed;
            }
          }
        }

        const secrets = oracle.generateGameSecrets({ gameType });
        return createSuccessResponse({
          randomHash: secrets.randomHash,
          gameAddress: secrets.gameAddress,
        });
      } catch (error: unknown) {
        console.error("❌ Error generating hash:", error);
        return createErrorResponse("Failed to generate hash", 500);
      }
    },

    async handleStats(_request?: Request): Promise<Response> {
      const stats = oracle.getStats();
      return createSuccessResponse({ stats });
    },
  };
}

type HandlerName = keyof ReturnType<typeof buildHandlers>;

type RouteDocumentation = {
  path: string;
  method: HttpMethod;
  handler: HandlerName;
  summary: string;
  requestExample?: string;
};

export const ROUTE_METADATA: ReadonlyArray<RouteDocumentation> = [
  {
    path: "/health",
    method: "GET",
    handler: "handleHealth",
    summary: "Simple health check - returns basic service status",
  },
  {
    path: "/generate-hash",
    method: "POST",
    handler: "handleGenerateHash",
    summary: "Generate new game secrets (random hash and game address)",
    requestExample: '{ "gameType": "coinflip" | "giveaway" }',
  },
  {
    path: "/stats",
    method: "GET",
    handler: "handleStats",
    summary: "Detailed statistics and metrics about the oracle service",
  },
];

function generateDocumentationHtml(routes: ReadonlyArray<RouteDocumentation>): string {
  const endpointSections = routes
    .map((route) => {
      const requestExample = route.requestExample
        ? `<br><strong>Body:</strong> <code>${route.requestExample}</code>`
        : "";
      return `
      <div class="endpoint">
        <span class="method ${route.method.toLowerCase()}">${route.method}</span> <code>${route.path}</code>
        <div class="description">${route.summary}${requestExample}</div>
      </div>`;
    })
    .join("\n");

  return `
  <!DOCTYPE html>
  <html>
    <head>
      <title>Oracle API Documentation</title>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          max-width: 800px;
          margin: 50px auto;
          padding: 20px;
          line-height: 1.6;
          color: #333;
        }
        h1 {
          color: #2c3e50;
          border-bottom: 3px solid #3498db;
          padding-bottom: 10px;
        }
        h2 {
          color: #34495e;
          margin-top: 30px;
        }
        code {
          background: #f8f9fa;
          padding: 4px 8px;
          border-radius: 4px;
          font-family: 'Monaco', 'Consolas', monospace;
          border: 1px solid #e9ecef;
        }
        .endpoint {
          background: #ffffff;
          border: 1px solid #dee2e6;
          border-radius: 8px;
          padding: 15px;
          margin: 10px 0;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .method {
          font-weight: bold;
          padding: 2px 6px;
          border-radius: 3px;
          color: white;
          font-size: 12px;
        }
        .get { background-color: #28a745; }
        .post { background-color: #007bff; }
        .description {
          margin-top: 8px;
          color: #6c757d;
        }
      </style>
    </head>
    <body>
      <h1>🔮 Oracle API Documentation</h1>

      <h2>Available Endpoints</h2>
      ${endpointSections}

      <h2>Service Information</h2>
      <p>This Oracle API provides game completion services for Solana-based coinflip games.</p>
    </body>
  </html>
`;
}

const API_DOCUMENTATION = generateDocumentationHtml(ROUTE_METADATA);

// Build a reusable fetch router for easier testing
export function buildFetchRouter(handlers: ReturnType<typeof buildHandlers>) {
  return async function fetchRouter(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    // CORS preflight
    if (method === "OPTIONS") return createResponse(null, 200);

    if (path === "/" && method === "GET") {
      return createHtmlResponse(API_DOCUMENTATION);
    }

    try {
      const route = ROUTE_METADATA.find(
        (entry) => entry.path === path && entry.method === method
      );

      if (!route) {
        return createErrorResponse("Endpoint not found", 404);
      }

      const handler = handlers[route.handler];

      if (!handler) {
        console.error(
          `❌ Handler not implemented for route: ${method} ${path} (${route.handler})`
        );
        return createInternalServerErrorResponse();
      }

      return await handler(request);
    } catch (error: unknown) {
      console.error("❌ Server error:", error);
      return createInternalServerErrorResponse();
    }
  };
}

// Main server
if (!IS_TEST_ENV) {
  const realOracle = OracleService.getInstance();
  const oracleApi: OracleApi = {
    generateGameSecrets: (options) => realOracle.generateGameSecrets(options),
    getStats: () => realOracle.getStats(),
    scanAndCompleteActiveGames: () => realOracle.scanRunner.scanAndCompleteActiveGames(),
    startEventListening: () => realOracle.startEventListening(),
    stopEventListening: () => realOracle.stopEventListening(),
    cleanupOldRecords: (hoursOld) => realOracle.cleanupOldRecords(hoursOld),
  };
  const handlers = buildHandlers(oracleApi);
  const fetchRouter = buildFetchRouter(handlers);
  server = Bun.serve({
    port: PORT,
    fetch: fetchRouter,
  });

  console.log(`🔮 Oracle API running on http://localhost:${PORT}`);

  const startBackgroundTasks = () => {
    if (backgroundAbortController) {
      return;
    }

    backgroundAbortController = new AbortController();
    const { signal } = backgroundAbortController;

    const runBackgroundLoop = async () => {
      while (!signal.aborted) {
        let retryDelayMs: number | undefined;

        try {
          await realOracle.scanRunner.runScanLoop({
            waitBetweenCyclesMs: FALLBACK_SCAN_INTERVAL,
            waitForPendingOnly: false,
            cleanupAfterCycleHours: 48,
            shouldContinue: () => true,
            signal,
          });

          if (!signal.aborted) {
            console.warn(
              "⚠️  Background scan loop exited unexpectedly; restarting..."
            );
            retryDelayMs = DEFAULT_DELAY_MS;
          }
        } catch (error) {
          if (signal.aborted) {
            break;
          }

          console.error("❌ Background scan loop failed:", error);
          retryDelayMs = DEFAULT_DELAY_MS;
        }

        if (signal.aborted) {
          break;
        }

        if (
          retryDelayMs !== undefined &&
          Number.isFinite(retryDelayMs) &&
          retryDelayMs > 0
        ) {
          await delay(retryDelayMs, { signal });
        }
      }
    };

    backgroundLoop = runBackgroundLoop()
      .catch((error) => {
        if (!signal.aborted) {
          console.error(
            "❌ Unhandled error in background scan supervisor:",
            error
          );
        }
      })
      .finally(() => {
        backgroundAbortController = undefined;
      });
  };

  initialize(oracleApi)
    .then(() => {
      startBackgroundTasks();
    })
    .catch(async (error) => {
      console.error("❌ Oracle initialization failed. Stopping server.", error);
      const exitCode = !IS_TEST_ENV ? 1 : undefined;

      try {
        await stopServer(oracleApi, exitCode);
      } catch (shutdownError) {
        console.error("❌ Failed to stop server after init error:", shutdownError);
        if (exitCode !== undefined && !IS_TEST_ENV) {
          process.exit(exitCode);
        }
      }
    });

  process.once("SIGINT", () => shutdown(oracleApi, "SIGINT"));
  process.once("SIGTERM", () => shutdown(oracleApi, "SIGTERM"));
}

// Initialize and start services
export async function initialize(oracle: OracleApi): Promise<void> {
  try {
    await oracle.startEventListening();
    console.log("✅ Oracle services initialized");
  } catch (error) {
    throw error;
  }
}

// Graceful shutdown
export async function shutdown(
  oracle: OracleApi,
  signal: string
): Promise<void> {
  console.log(`\n🛑 Shutting down (${signal})...`);
  const exitCode = !IS_TEST_ENV ? 0 : undefined;

  try {
    await stopServer(oracle, exitCode);
    console.log("✅ Shutdown complete");
  } catch (error) {
    console.error("❌ Shutdown error:", error);
    if (exitCode !== undefined && !IS_TEST_ENV) {
      process.exit(exitCode);
    }
  }
}
