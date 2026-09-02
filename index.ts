import { delay, DEFAULT_DELAY_MS } from "./delay.ts";
import {
  CreationPolicyValidationError,
  GameTransactionValidationError,
  OracleService,
  type RequeueGameFailureReason,
  type RequeueGameResult,
} from "./oracle-service.ts";
import { getEnvironmentMode, isTestEnvironment } from "./env.ts";
import { getConfig, DEFAULT_ORACLE_PORT } from "./config.ts";
import type { CompletionStats, GameCompletionResult } from "./oracle-service.types.ts";
import type { ToggleAutoCompleteResult } from "./database.ts";
import { logger } from "./logger.ts";
import {
  MAX_REQUEST_BODY_BYTES,
  createRouteRateLimiter,
  hasValidBearerToken,
  type RateLimitResult,
} from "./api-security.ts";
import { Transaction } from "@solana/web3.js";
import {
  CompleteGameNowRequestSchema,
  CompleteGameNowResponseSchema,
  GenerateHashRequestSchema,
  GenerateHashResponseSchema,
  OracleHealthResponseSchema,
  OracleStatsResponseSchema,
  SignGameTransactionRequestSchema,
  SignGameTransactionResponseSchema,
  CreationPolicyRejectionSchema,
  TokenPoliciesResponseSchema,
} from "@timbagame/protocol/oracle";

const FALLBACK_SCAN_INTERVAL = 300000; // 5 minutes
const IS_TEST_ENV = process.env["TIMBA_ORACLE_TEST_RUNNER"] === "true" || isTestEnvironment();
const BACKGROUND_LOOP_SHUTDOWN_TIMEOUT_MS = IS_TEST_ENV ? 50 : 5000;
const EVENT_LISTENER_SHUTDOWN_TIMEOUT_MS = IS_TEST_ENV ? 50 : 5000;
const PUBLIC_ERROR_MESSAGES = {
  autoCompleteAlreadySet: "Auto-complete is already set to the requested value",
  autoCompleteBooleanRequired: "autoCompleteDisabled must be a boolean",
  endpointNotFound: "Endpoint not found",
  failedToGenerateHash: "Failed to generate hash",
  gameAlreadyFinalized: "Game is already finalized",
  gameAlreadyQueued: "Game is already queued for completion",
  gameAddressRequired: "gameAddress is required",
  gameCompletionConflict: "Game could not be completed",
  gameMissingSecret: "Game is missing its secret key",
  gameNotTracked: "Game is not tracked",
  gameTransactionSigningUnavailable: "Game transaction signing is unavailable",
  internalServerError: "Internal server error",
  invalidGameTransaction: "Invalid game transaction",
  invalidGameType: "gameType is invalid",
  invalidJson: "Invalid JSON payload",
  requestBodyRequired: "Request body required",
  requestBodyTooLarge: "Request body too large",
  tokenPoliciesUnavailable: "Token policies are unavailable",
  tooManyRequests: "Too many requests",
  unauthorized: "Unauthorized",
} as const;
type PublicErrorCode = keyof typeof PUBLIC_ERROR_MESSAGES;

const JSON_HEADERS = {
  "Content-Type": "application/json",
};
const PROTECTED_ROUTES = new Set([
  "/generate-hash",
  "/sign-game-transaction",
  "/token-policies",
  "/stats",
  "/games/complete-now",
]);

export function summarizeGameTransaction(txBase64: string) {
  try {
    const transaction = Transaction.from(Buffer.from(txBase64, "base64"));
    return {
      instructionCount: transaction.instructions.length,
      signatureSlots: transaction.signatures.length,
      instructions: transaction.instructions.map((instruction, index) => ({
        index,
        programId: instruction.programId.toBase58(),
        accountCount: instruction.keys.length,
        signerCount: instruction.keys.filter((key) => key.isSigner).length,
        writableCount: instruction.keys.filter((key) => key.isWritable).length,
        accountFlags: instruction.keys.map((key) => ({
          signer: key.isSigner,
          writable: key.isWritable,
        })),
        dataLength: instruction.data.length,
        discriminator: Buffer.from(instruction.data.subarray(0, 8)).toString("hex"),
      })),
    };
  } catch (error) {
    return {
      parseError: error instanceof Error ? error.message : "Unable to decode transaction",
    };
  }
}

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
      "Background loop did not exit within the shutdown timeout; proceeding with shutdown.",
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

async function stopServer(oracle: OracleApi, exitCode?: number): Promise<void> {
  await server?.stop();
  await abortBackgroundLoop();
  await closeOracle(oracle);

  if (exitCode !== undefined && !IS_TEST_ENV) {
    process.exit(exitCode);
  }
}

// Response helpers
function createResponse(data: unknown, status: number = 200): Response {
  if (data === null || data === undefined) {
    return new Response(null, { status, headers: JSON_HEADERS });
  }

  const body = typeof data === "string" ? data : JSON.stringify(data);
  return new Response(body, { status, headers: JSON_HEADERS });
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

function createErrorResponse(code: PublicErrorCode, status: number = 500): Response {
  return createServiceResponse({
    success: false,
    status,
    payload: { error: PUBLIC_ERROR_MESSAGES[code] },
  });
}

function createInternalServerErrorResponse(): Response {
  return createServiceResponse({
    success: false,
    status: 500,
    payload: { error: PUBLIC_ERROR_MESSAGES.internalServerError },
  });
}

function createSuccessResponse(payload: Record<string, unknown> = {}): Response {
  return createServiceResponse({ success: true, payload });
}

function createContractResponse(
  schema: { parse(value: unknown): unknown },
  payload: Record<string, unknown> = {},
): Response {
  return createResponse(schema.parse(buildServicePayload({ success: true, ...payload })));
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
  signGameTransaction?: OracleService["signGameTransaction"];
  getStats: () => ReturnType<OracleService["getStats"]>;
  scanAndCompleteActiveGames: () => Promise<CompletionStats>;
  startEventListening: () => ReturnType<OracleService["startEventListening"]>;
  stopEventListening: () => ReturnType<OracleService["stopEventListening"]>;
  close: () => ReturnType<OracleService["close"]>;
  cleanupOldRecords: OracleService["cleanupOldRecords"];
  requeueGame: (gameAddress: string) => RequeueGameResult;
  completeGameNow: (gameAddress: string) => Promise<GameCompletionResult | null>;
  setAutoCompleteDisabled: (gameAddress: string, disabled: boolean) => ToggleAutoCompleteResult;
  getTokenPolicies: OracleService["getTokenPolicies"];
}

interface JsonBodyResult {
  body: Record<string, unknown> | null;
  parseError?: PublicErrorCode;
}

async function readJsonBody(request: Request | undefined): Promise<JsonBodyResult> {
  if (!request || request.bodyUsed) {
    return { body: null };
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType && !contentType.toLowerCase().includes("application/json")) {
    return { body: null };
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES) {
    return { body: null, parseError: "requestBodyTooLarge" };
  }

  try {
    const rawBody = await request.text();
    if (!rawBody) {
      return { body: null };
    }
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { body: parsed as Record<string, unknown> };
    }
  } catch (error) {
    console.warn("⚠️  Failed to parse /generate-hash payload:", error);
    return { body: null, parseError: "invalidJson" };
  }

  return { body: null };
}

export function buildHandlers(oracle: OracleApi) {
  return {
    async handleHealth(_request?: Request): Promise<Response> {
      return createContractResponse(OracleHealthResponseSchema, { status: "healthy" });
    },

    async handleGenerateHash(request?: Request): Promise<Response> {
      try {
        let gameType: string | undefined;
        if (request) {
          const { body, parseError } = await readJsonBody(request);

          if (parseError) {
            return createErrorResponse(parseError, 400);
          }

          const parsed = GenerateHashRequestSchema.safeParse(body ?? {});
          if (!parsed.success) return createErrorResponse("invalidGameType", 400);
          gameType = parsed.data.gameType;
        }

        const secrets = oracle.generateGameSecrets({ gameType });
        return createContractResponse(GenerateHashResponseSchema, {
          randomHash: secrets.randomHash,
          gameAddress: secrets.gameAddress,
          oracleOperator: secrets.oracleOperator,
        });
      } catch (error: unknown) {
        logger.failure("Error generating hash:", error);
        return createErrorResponse("failedToGenerateHash", 500);
      }
    },

    async handleSignGameTransaction(request?: Request): Promise<Response> {
      let txForDiagnostics = "";
      try {
        if (!request || !oracle.signGameTransaction) {
          return createErrorResponse("gameTransactionSigningUnavailable", 503);
        }
        const { body, parseError } = await readJsonBody(request);
        if (parseError) return createErrorResponse(parseError, 400);
        const parsed = SignGameTransactionRequestSchema.safeParse(body);
        if (!parsed.success) return createErrorResponse("invalidGameTransaction", 400);
        const { txBase64 } = parsed.data;
        txForDiagnostics = txBase64;
        return createContractResponse(SignGameTransactionResponseSchema, {
          txBase64: await oracle.signGameTransaction(txBase64),
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Invalid transaction";
        logger.failure(
          "Game transaction signing rejected:",
          JSON.stringify({
            error: message,
            transaction: txForDiagnostics
              ? summarizeGameTransaction(txForDiagnostics)
              : { parseError: "Missing transaction payload" },
          }),
        );
        if (error instanceof CreationPolicyValidationError) {
          return createResponse(
            CreationPolicyRejectionSchema.parse(
              buildServicePayload({
                success: false,
                error: error.message,
                code: error.code,
                ...error.details,
              }),
            ),
            422,
          );
        }
        return error instanceof GameTransactionValidationError
          ? createErrorResponse("invalidGameTransaction", 400)
          : createInternalServerErrorResponse();
      }
    },

    async handleTokenPolicies(_request?: Request): Promise<Response> {
      try {
        return createContractResponse(TokenPoliciesResponseSchema, {
          policies: await oracle.getTokenPolicies(),
        });
      } catch (error: unknown) {
        logger.failure("Error loading token policies:", error);
        return createErrorResponse("tokenPoliciesUnavailable", 503);
      }
    },

    async handleStats(_request?: Request): Promise<Response> {
      const stats = oracle.getStats();
      return createContractResponse(OracleStatsResponseSchema, { stats });
    },

    async handleRequeueGame(request?: Request): Promise<Response> {
      try {
        if (!request) {
          return createErrorResponse("requestBodyRequired", 400);
        }

        const { body, parseError } = await readJsonBody(request);
        if (parseError) {
          return createErrorResponse(parseError, 400);
        }

        const providedValue = body ? body["gameAddress"] : undefined;
        const providedAddress = typeof providedValue === "string" ? providedValue.trim() : "";

        if (!providedAddress) {
          return createErrorResponse("gameAddressRequired", 400);
        }

        const result = oracle.requeueGame(providedAddress);
        if (!result.success) {
          const outcome = mapRequeueFailureToResponse(providedAddress, result.reason);
          return createErrorResponse(outcome.code, outcome.status);
        }

        return createSuccessResponse({
          gameAddress: providedAddress,
          status: "queued",
        });
      } catch (error: unknown) {
        logger.failure("Error requeuing game:", error);
        return createInternalServerErrorResponse();
      }
    },

    async handleCompleteGameNow(request?: Request): Promise<Response> {
      try {
        if (!request) {
          return createErrorResponse("requestBodyRequired", 400);
        }

        const { body, parseError } = await readJsonBody(request);
        if (parseError) {
          return createErrorResponse(parseError, 400);
        }

        const parsed = CompleteGameNowRequestSchema.safeParse(body);
        if (!parsed.success) return createErrorResponse("gameAddressRequired", 400);
        const providedAddress = parsed.data.gameAddress;

        const result = await oracle.completeGameNow(providedAddress);
        if (result === null) {
          return createContractResponse(CompleteGameNowResponseSchema, {
            gameAddress: providedAddress,
            status: "in-flight",
          });
        }

        if (result.success) {
          return createContractResponse(CompleteGameNowResponseSchema, {
            gameAddress: providedAddress,
            status: "completed",
            txHash: result.txHash,
            winnerAddress: result.winnerAddress,
            totalPot: result.totalPot,
          });
        }

        if (result.notReady) {
          return createContractResponse(CompleteGameNowResponseSchema, {
            gameAddress: providedAddress,
            status: "not-ready",
          });
        }

        logger.warning("Immediate game completion was rejected:", {
          gameAddress: providedAddress,
          error: result.error,
        });
        return createErrorResponse("gameCompletionConflict", 409);
      } catch (error: unknown) {
        logger.failure("Error completing game now:", error);
        return createInternalServerErrorResponse();
      }
    },

    async handleToggleAutoComplete(request?: Request): Promise<Response> {
      try {
        if (!request) {
          return createErrorResponse("requestBodyRequired", 400);
        }

        const { body, parseError } = await readJsonBody(request);
        if (parseError) {
          return createErrorResponse(parseError, 400);
        }

        const providedAddress =
          typeof body?.["gameAddress"] === "string" ? body["gameAddress"].trim() : "";
        const providedDisabled = body?.["autoCompleteDisabled"];

        if (!providedAddress) {
          return createErrorResponse("gameAddressRequired", 400);
        }

        if (typeof providedDisabled !== "boolean") {
          return createErrorResponse("autoCompleteBooleanRequired", 400);
        }

        const result = oracle.setAutoCompleteDisabled(providedAddress, providedDisabled);
        if (!result.success) {
          const outcome = mapToggleAutoCompleteFailure(providedAddress, result);
          return createErrorResponse(outcome.code, outcome.status);
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
  _gameAddress: string,
  reason: RequeueGameFailureReason,
): { status: number; code: PublicErrorCode } {
  switch (reason) {
    case "invalid-address":
      return { status: 400, code: "gameAddressRequired" };
    case "not-found":
      return { status: 404, code: "gameNotTracked" };
    case "finalized":
      return {
        status: 409,
        code: "gameAlreadyFinalized",
      };
    case "missing-secret":
      return {
        status: 409,
        code: "gameMissingSecret",
      };
    case "unchanged":
    default:
      return {
        status: 409,
        code: "gameAlreadyQueued",
      };
  }
}

function mapToggleAutoCompleteFailure(
  _gameAddress: string,
  result: Extract<ToggleAutoCompleteResult, { success: false }>,
): { status: number; code: PublicErrorCode } {
  switch (result.reason) {
    case "invalid-address":
      return { status: 400, code: "gameAddressRequired" };
    case "not-found":
      return { status: 404, code: "gameNotTracked" };
    case "finalized":
      return {
        status: 409,
        code: "gameAlreadyFinalized",
      };
    case "unchanged":
    default:
      return {
        status: 409,
        code: "autoCompleteAlreadySet",
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
    path: "/sign-game-transaction",
    method: "POST",
    handler: "handleSignGameTransaction",
    summary: "Validate and oracle-sign a game initialization transaction",
    requestExample: '{ "txBase64": "..." }',
  },
  {
    path: "/token-policies",
    method: "GET",
    handler: "handleTokenPolicies",
    summary: "List the current token creation policies",
  },
  {
    path: "/stats",
    method: "GET",
    handler: "handleStats",
    summary: "Detailed statistics and metrics about the oracle service",
  },
  {
    path: "/games/complete-now",
    method: "POST",
    handler: "handleCompleteGameNow",
    summary: "Attempt immediate completion for one tracked game",
    requestExample: '{ "gameAddress": "Ht8Kup..." }',
  },
];

const ADMIN_ROUTE_METADATA: ReadonlyArray<RouteDocumentation> = [
  {
    path: "/games/requeue",
    method: "POST",
    handler: "handleRequeueGame",
    summary: "CLI-only requeue operation",
  },
  {
    path: "/games/auto-complete",
    method: "POST",
    handler: "handleToggleAutoComplete",
    summary: "CLI-only auto-complete operation",
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
export interface RouterSecurityOptions {
  apiToken?: string | null;
  checkRateLimit?: (path: string) => RateLimitResult;
  enableAdminRoutesForTesting?: boolean;
}

export function buildFetchRouter(
  handlers: ReturnType<typeof buildHandlers>,
  security: RouterSecurityOptions = {},
) {
  const checkRateLimit = security.checkRateLimit ?? createRouteRateLimiter();

  return async function fetchRouter(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (path === "/" && method === "GET") {
      return createHtmlResponse(API_DOCUMENTATION);
    }

    if (PROTECTED_ROUTES.has(path) && security.apiToken !== undefined) {
      if (
        !security.apiToken ||
        !hasValidBearerToken(request.headers.get("authorization"), security.apiToken)
      ) {
        return createErrorResponse("unauthorized", 401);
      }

      const rateLimit = checkRateLimit(path);
      if (!rateLimit.allowed) {
        const response = createErrorResponse("tooManyRequests", 429);
        response.headers.set("Retry-After", String(rateLimit.retryAfterSeconds ?? 1));
        return response;
      }
    }

    try {
      const route =
        ROUTE_METADATA.find((entry) => entry.path === path && entry.method === method) ??
        (security.enableAdminRoutesForTesting
          ? ADMIN_ROUTE_METADATA.find((entry) => entry.path === path && entry.method === method)
          : undefined);

      if (!route) {
        return createErrorResponse("endpointNotFound", 404);
      }

      const handler = handlers[route.handler];

      if (!handler) {
        logger.failure(`Handler not implemented for route: ${method} ${path} (${route.handler})`);
        return createInternalServerErrorResponse();
      }

      return await handler(request);
    } catch (error: unknown) {
      logger.failure("Server error:", error);
      return createInternalServerErrorResponse();
    }
  };
}

export function buildProductionOracleApi(realOracle: OracleService): OracleApi {
  return {
    generateGameSecrets: (options) => realOracle.generateGameSecrets(options),
    signGameTransaction: (txBase64) => realOracle.signGameTransaction(txBase64),
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
    getTokenPolicies: () => realOracle.getTokenPolicies(),
  };
}

// Main server
if (!IS_TEST_ENV) {
  const config = getConfig();
  const port = config.oraclePort ?? DEFAULT_ORACLE_PORT;
  if (!config.apiToken) {
    throw new Error("ORACLE_API_TOKEN is required to start the oracle API");
  }

  const realOracle = OracleService.getInstance();
  const oracleApi = buildProductionOracleApi(realOracle);
  const handlers = buildHandlers(oracleApi);
  const fetchRouter = buildFetchRouter(handlers, { apiToken: config.apiToken });
  server = Bun.serve({
    port,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
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
            logger.warning("Background scan loop exited unexpectedly; restarting...");
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

        if (retryDelayMs !== undefined && Number.isFinite(retryDelayMs) && retryDelayMs > 0) {
          await delay(retryDelayMs, { signal });
        }
      }
    };

    backgroundLoop = runBackgroundLoop()
      .catch((error) => {
        if (!signal.aborted) {
          logger.failure("Unhandled error in background scan supervisor:", error);
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
  await oracle.startEventListening();
  logger.success("Oracle services initialized");
}

// Graceful shutdown
export async function shutdown(oracle: OracleApi, signal: string): Promise<void> {
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
