import { delay, DEFAULT_DELAY_MS } from "./delay.ts";
import {
  OracleService,
  type RequeueGameFailureReason,
  type RequeueGameResult,
} from "./oracle-service.ts";
import { getEnvironmentMode, isTestEnvironment } from "./env.ts";
import { getConfig, DEFAULT_ORACLE_PORT } from "./config.ts";
import type { CompletionStats, GameCompletionResult } from "./oracle-service.types.ts";
import type { ToggleAutoCompleteResult } from "./database.ts";
import { logger } from "./logger.ts";
import { normalizeGameType } from "./game-type.ts";

const FALLBACK_SCAN_INTERVAL = 300000; // 5 minutes
const IS_TEST_ENV = isTestEnvironment();
const BACKGROUND_LOOP_SHUTDOWN_TIMEOUT_MS = IS_TEST_ENV ? 50 : 5000;
const EVENT_LISTENER_SHUTDOWN_TIMEOUT_MS = IS_TEST_ENV ? 50 : 5000;
const INTERNAL_SERVER_ERROR_MESSAGE = "Internal server error";
const GAME_TYPE_FIELD = "gameType";

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

let server: ReturnType<typeof Bun.serve> | undefined;
let backgroundLoop: Promise<void> | undefined;
let backgroundAbortController: AbortController | undefined;

async function abortBackgroundLoop(): Promise<void> {
  backgroundAbortController?.abort();

  if (!backgroundLoop) {
    return;
  }

  const loopPromise = backgroundLoop;
  backgroundLoop = undefined;

  const timeoutResult = await Promise.race<"completed" | "timeout">([
    loopPromise
      .then(() => "completed" as const)
      .catch((error) => {
        logger.warning("Background loop terminated with error:", error);
        return "completed" as const;
      }),
    delay(BACKGROUND_LOOP_SHUTDOWN_TIMEOUT_MS).then(() => "timeout" as const),
  ]);

  if (timeoutResult === "timeout") {
    logger.warning(
      "Background loop did not exit within the shutdown timeout; proceeding with shutdown."
    );
    loopPromise.catch((error) => {
      logger.warning("Background loop terminated with error:", error);
    });
  }

  backgroundAbortController = undefined;
}

async function closeOracle(oracle: OracleApi): Promise<void> {
  let closePromise: Promise<unknown>;
  try {
    closePromise = Promise.resolve(oracle.close());
  } catch (error) {
    logger.warning("Failed to close oracle:", error);
    return;
  }

  const timeoutResult = await Promise.race<"completed" | "timeout">([
    closePromise
      .then(() => "completed" as const)
      .catch((error) => {
        logger.warning("Failed to close oracle:", error);
        return "completed" as const;
      }),
    delay(EVENT_LISTENER_SHUTDOWN_TIMEOUT_MS).then(() => "timeout" as const),
  ]);

  if (timeoutResult === "timeout") {
    logger.warning(
      "Oracle close did not complete within the shutdown timeout; proceeding with shutdown.",
    );
  }
}

async function stopServer(
  oracle: OracleApi,
  exitCode?: number
): Promise<void> {
  server?.stop();
  await abortBackgroundLoop();
  await closeOracle(oracle);

  if (exitCode !== undefined && !IS_TEST_ENV) {
    process.exit(exitCode);
  }
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

function createServiceResponse({
  success,
  status = 200,
  payload = {},
}: {
  success: boolean;
  status?: number;
  payload?: Record<string, unknown>;
}): Response {
  return createResponse(buildServicePayload({ success, ...payload }), status);
}

function createHtmlResponse(html: string): Response {
  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

function sanitizeErrorMessage(error: string): string {
  const normalized = error.replace(/[\x00-\x1F\x7F]+/g, " ");
  const collapsed = normalized.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) {
    return "Unknown error";
  }

  const escapeMap: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
  };

  return collapsed.replace(/[&<>]/g, (char) => escapeMap[char] ?? char);
}

function createErrorResponse(error: string, status: number = 500): Response {
  return createServiceResponse({
    success: false,
    status,
    payload: { error: sanitizeErrorMessage(error) },
  });
}

function createInternalServerErrorResponse(): Response {
  return createServiceResponse({
    success: false,
    status: 500,
    payload: { error: INTERNAL_SERVER_ERROR_MESSAGE },
  });
}

function createSuccessResponse(
  payload: Record<string, unknown> = {}
): Response {
  return createServiceResponse({ success: true, payload });
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
  close: () => ReturnType<OracleService["close"]>;
  cleanupOldRecords: OracleService["cleanupOldRecords"];
  requeueGame: (gameAddress: string) => RequeueGameResult;
  completeGameNow: (gameAddress: string) => Promise<GameCompletionResult | null>;
  setAutoCompleteDisabled: (
    gameAddress: string,
    disabled: boolean,
  ) => ToggleAutoCompleteResult;
}

interface JsonBodyResult {
  body: Record<string, unknown> | null;
  parseError?: string;
}

async function readJsonBody(
  request: Request | undefined
): Promise<JsonBodyResult> {
  if (!request || request.bodyUsed) {
    return { body: null };
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType && !contentType.toLowerCase().includes("application/json")) {
    return { body: null };
  }

  try {
    const rawBody = await request.text();
    if (!rawBody) {
      return { body: null };
    }
    const parsed = JSON.parse(rawBody);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { body: parsed as Record<string, unknown> };
    }
  } catch (error) {
    console.warn("⚠️  Failed to parse /generate-hash payload:", error);
    return { body: null, parseError: "Invalid JSON payload" };
  }

  return { body: null };
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
          const { body, parseError } = await readJsonBody(request);

          if (parseError) {
            return createErrorResponse(parseError, 400);
          }

          const provided = body ? body[GAME_TYPE_FIELD] : undefined;
          if (provided !== undefined) {
            if (typeof provided !== "string") {
              return createErrorResponse("gameType must be a string", 400);
            }

            const normalized = normalizeGameType(provided);
            if (normalized.error) {
              return createErrorResponse(normalized.error, 400);
            }

            if (normalized.value) {
              gameType = normalized.value;
            }
          }
        }

        const secrets = oracle.generateGameSecrets({ gameType });
        return createSuccessResponse({
          randomHash: secrets.randomHash,
          gameAddress: secrets.gameAddress,
        });
      } catch (error: unknown) {
        logger.failure("Error generating hash:", error);
        return createErrorResponse("Failed to generate hash", 500);
      }
    },

    async handleStats(_request?: Request): Promise<Response> {
      const stats = oracle.getStats();
      return createSuccessResponse({ stats });
    },

    async handleRequeueGame(request?: Request): Promise<Response> {
      try {
        if (!request) {
          return createErrorResponse("Request body required", 400);
        }

        const { body, parseError } = await readJsonBody(request);
        if (parseError) {
          return createErrorResponse(parseError, 400);
        }

        const providedValue = body ? body["gameAddress"] : undefined;
        const providedAddress =
          typeof providedValue === "string" ? providedValue.trim() : "";

        if (!providedAddress) {
          return createErrorResponse("gameAddress is required", 400);
        }

        const result = oracle.requeueGame(providedAddress);
        if (!result.success) {
          const outcome = mapRequeueFailureToResponse(providedAddress, result.reason);
          return createErrorResponse(outcome.message, outcome.status);
        }

        return createSuccessResponse({ gameAddress: providedAddress, status: "queued" });
      } catch (error: unknown) {
        logger.failure("Error requeuing game:", error);
        return createInternalServerErrorResponse();
      }
    },

    async handleCompleteGameNow(request?: Request): Promise<Response> {
      try {
        if (!request) {
          return createErrorResponse("Request body required", 400);
        }

        const { body, parseError } = await readJsonBody(request);
        if (parseError) {
          return createErrorResponse(parseError, 400);
        }

        const providedValue = body ? body["gameAddress"] : undefined;
        const providedAddress =
          typeof providedValue === "string" ? providedValue.trim() : "";

        if (!providedAddress) {
          return createErrorResponse("gameAddress is required", 400);
        }

        const result = await oracle.completeGameNow(providedAddress);
        if (result === null) {
          return createSuccessResponse({ gameAddress: providedAddress, status: "in-flight" });
        }

        if (result.success) {
          return createSuccessResponse({
            gameAddress: providedAddress,
            status: "completed",
            txHash: result.txHash,
            winnerAddress: result.winnerAddress,
            totalPot: result.totalPot,
          });
        }

        if (result.notReady) {
          return createSuccessResponse({ gameAddress: providedAddress, status: "not-ready" });
        }

        return createErrorResponse(
          result.error ?? `Game ${providedAddress} could not be completed`,
          409,
        );
      } catch (error: unknown) {
        logger.failure("Error completing game now:", error);
        return createInternalServerErrorResponse();
      }
    },

    async handleToggleAutoComplete(request?: Request): Promise<Response> {
      try {
        if (!request) {
          return createErrorResponse("Request body required", 400);
        }

        const { body, parseError } = await readJsonBody(request);
        if (parseError) {
          return createErrorResponse(parseError, 400);
        }

        const providedAddress =
          typeof body?.["gameAddress"] === "string" ? body["gameAddress"].trim() : "";
        const providedDisabled = body?.["autoCompleteDisabled"];

        if (!providedAddress) {
          return createErrorResponse("gameAddress is required", 400);
        }

        if (typeof providedDisabled !== "boolean") {
          return createErrorResponse("autoCompleteDisabled must be a boolean", 400);
        }

        const result = oracle.setAutoCompleteDisabled(providedAddress, providedDisabled);
        if (!result.success) {
          const outcome = mapToggleAutoCompleteFailure(providedAddress, result);
          return createErrorResponse(outcome.message, outcome.status);
        }

        return createSuccessResponse({
          gameAddress: providedAddress,
          autoCompleteDisabled: result.autoCompleteDisabled,
        });
      } catch (error: unknown) {
        logger.failure("Error toggling auto-complete:", error);
        return createInternalServerErrorResponse();
      }
    },
  };
}

function mapRequeueFailureToResponse(
  gameAddress: string,
  reason: RequeueGameFailureReason,
): { status: number; message: string } {
  switch (reason) {
    case "invalid-address":
      return { status: 400, message: "gameAddress is required" };
    case "not-found":
      return { status: 404, message: `Game ${gameAddress} is not tracked` };
    case "finalized":
      return { status: 409, message: `Game ${gameAddress} is already finalized` };
    case "missing-secret":
      return { status: 409, message: `Game ${gameAddress} is missing its secret key` };
    case "unchanged":
    default:
      return {
        status: 409,
        message: `Game ${gameAddress} is already queued for completion`,
      };
  }
}

function mapToggleAutoCompleteFailure(
  gameAddress: string,
  result: Extract<ToggleAutoCompleteResult, { success: false }>,
): { status: number; message: string } {
  switch (result.reason) {
    case "invalid-address":
      return { status: 400, message: "gameAddress is required" };
    case "not-found":
      return { status: 404, message: `Game ${gameAddress} is not tracked` };
    case "finalized":
      return { status: 409, message: `Game ${gameAddress} is already finalized` };
    case "unchanged":
    default:
      return {
        status: 409,
        message: `Auto-complete state for ${gameAddress} is already set to the requested value`,
      };
  }
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
  {
    path: "/games/requeue",
    method: "POST",
    handler: "handleRequeueGame",
    summary: "Reset completion attempts so a pending game can be scanned again",
    requestExample: '{ "gameAddress": "Ht8Kup..." }',
  },
  {
    path: "/games/complete-now",
    method: "POST",
    handler: "handleCompleteGameNow",
    summary: "Attempt immediate completion for one tracked game",
    requestExample: '{ "gameAddress": "Ht8Kup..." }',
  },
  {
    path: "/games/auto-complete",
    method: "POST",
    handler: "handleToggleAutoComplete",
    summary: "Enable or disable automatic completion for a tracked game",
    requestExample: '{ "gameAddress": "Ht8Kup...", "autoCompleteDisabled": true | false }',
  },
];

export function generateDocumentationHtml(routes: ReadonlyArray<RouteDocumentation>): string {
  const escapeHtml = (value: string): string =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const endpointSections = routes
    .map((route) => {
      const path = escapeHtml(route.path);
      const summary = escapeHtml(route.summary);
      const method = escapeHtml(route.method);
      const methodClassCandidate = route.method.toLowerCase().replace(/[^a-z0-9-]/g, "");
      const methodClass = methodClassCandidate.length > 0 ? methodClassCandidate : "custom";
      const requestExample = route.requestExample
        ? `<br><strong>Body:</strong> <code>${escapeHtml(route.requestExample)}</code>`
        : "";
      return `
      <div class="endpoint">
        <span class="method ${methodClass}">${method}</span> <code>${path}</code>
        <div class="description">${summary}${requestExample}</div>
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
        logger.failure(
          `Handler not implemented for route: ${method} ${path} (${route.handler})`
        );
        return createInternalServerErrorResponse();
      }

      return await handler(request);
    } catch (error: unknown) {
      logger.failure("Server error:", error);
      return createInternalServerErrorResponse();
    }
  };
}

// Main server
if (!IS_TEST_ENV) {
  const config = getConfig();
  const port = config.oraclePort ?? DEFAULT_ORACLE_PORT;

  const realOracle = OracleService.getInstance();
  const oracleApi: OracleApi = {
    generateGameSecrets: (options) => realOracle.generateGameSecrets(options),
    getStats: () => realOracle.getStats(),
    scanAndCompleteActiveGames: () => realOracle.scanRunner.scanAndCompleteActiveGames(),
    startEventListening: () => realOracle.startEventListening(),
    stopEventListening: () => realOracle.stopEventListening(),
    close: () => realOracle.close(),
    cleanupOldRecords: (hoursOld) => realOracle.cleanupOldRecords(hoursOld),
    requeueGame: (gameAddress) => realOracle.requeueGame(gameAddress),
    completeGameNow: (gameAddress) => realOracle.completeGameNow(gameAddress),
    setAutoCompleteDisabled: (gameAddress, disabled) =>
      realOracle.setAutoCompleteDisabled(gameAddress, disabled),
  };
  const handlers = buildHandlers(oracleApi);
  const fetchRouter = buildFetchRouter(handlers);
  server = Bun.serve({
    port,
    fetch: fetchRouter,
  });

  logger.info(`🔮 Oracle API running on http://localhost:${port}`);

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
            logger.warning(
              "Background scan loop exited unexpectedly; restarting..."
            );
            retryDelayMs = DEFAULT_DELAY_MS;
          }
        } catch (error) {
          if (signal.aborted) {
            break;
          }

          logger.failure("Background scan loop failed:", error);
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
          logger.failure(
            "Unhandled error in background scan supervisor:",
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
      logger.failure("Oracle initialization failed. Stopping server.", error);
      const exitCode = !IS_TEST_ENV ? 1 : undefined;

      try {
        await stopServer(oracleApi, exitCode);
      } catch (shutdownError) {
        logger.failure("Failed to stop server after init error:", shutdownError);
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
    logger.success("Oracle services initialized");
  } catch (error) {
    throw error;
  }
}

// Graceful shutdown
export async function shutdown(
  oracle: OracleApi,
  signal: string
): Promise<void> {
  logger.info(`\n🛑 Shutting down (${signal})...`);
  const exitCode = !IS_TEST_ENV ? 0 : undefined;

  try {
    await stopServer(oracle, exitCode);
    logger.success("Shutdown complete");
  } catch (error) {
    logger.failure("Shutdown error:", error);
    if (exitCode !== undefined && !IS_TEST_ENV) {
      process.exit(exitCode);
    }
  }
}
