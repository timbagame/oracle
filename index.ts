import "./logging";
import { OracleService } from "./oracle-service.ts";

// Constants
const DEFAULT_PORT = 3001;
const FALLBACK_SCAN_INTERVAL = 300000; // 5 minutes

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

const PORT = Number(process.env["ORACLE_PORT"]) || DEFAULT_PORT;

let server: ReturnType<typeof Bun.serve> | undefined;
let backgroundTask: ReturnType<typeof setInterval> | undefined;

// Response helpers
function createResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

function createHtmlResponse(html: string): Response {
  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

function createErrorResponse(error: string, status: number = 500): Response {
  return createResponse({ success: false, error }, status);
}

// Handlers factory for clean DI and testing
export type OracleApi = Pick<
  OracleService,
  | "generateGameSecrets"
  | "getStats"
  | "scanAndCompleteActiveGames"
  | "startEventListening"
  | "stopEventListening"
  | "cleanupOldRecords"
>;

export function buildHandlers(oracle: OracleApi) {
  return {
    async handleHealth(): Promise<Response> {
      return createResponse({
        status: "healthy",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        service: "oracle-api",
      });
    },

    async handleGenerateHash(): Promise<Response> {
      try {
        const secrets = oracle.generateGameSecrets();
        return createResponse({
          success: true,
          randomHash: secrets.randomHash,
          gameAddress: secrets.gameAddress,
        });
      } catch (error: any) {
        console.error("❌ Error generating hash:", error);
        return createErrorResponse("Failed to generate hash", 500);
      }
    },

    async handleStats(): Promise<Response> {
      const stats = oracle.getStats();
      return createResponse({
        success: true,
        timestamp: new Date().toISOString(),
        stats,
        service: {
          name: "oracle-api",
          version: "1.0.0",
          uptime: process.uptime(),
          environment: process.env.NODE_ENV || "development",
        },
      });
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
        return createErrorResponse("Internal server error", 500);
      }

      return await handler();
    } catch (error: any) {
      console.error("❌ Server error:", error);
      return createErrorResponse("Internal server error", 500);
    }
  };
}

// Main server
if (process.env.NODE_ENV !== "test") {
  const realOracle = OracleService.getInstance();
  const handlers = buildHandlers(realOracle);
  const fetchRouter = buildFetchRouter(handlers);
  server = Bun.serve({
    port: PORT,
    fetch: fetchRouter,
  });

  console.log(`🔮 Oracle API running on http://localhost:${PORT}`);

  const startBackgroundTasks = () => {
    backgroundTask = setInterval(async () => {
      try {
        await realOracle.scanAndCompleteActiveGames();

        // Clean up old records periodically (every scan cycle)
        const cleanupResult = realOracle.cleanupOldRecords(48);
        if (
          cleanupResult.deletedSecrets > 0 ||
          cleanupResult.deletedGames > 0
        ) {
          console.log("🧹 Background cleanup completed");
        }
      } catch (error) {
        console.error("❌ Background scan error:", error);
      }
    }, FALLBACK_SCAN_INTERVAL);
  };

  initialize(realOracle)
    .then(() => {
      startBackgroundTasks();
    })
    .catch(async (error) => {
      console.error("❌ Oracle initialization failed. Stopping server.", error);
      try {
        await realOracle.stopEventListening();
      } catch (listenerError) {
        console.error(
          "⚠️  Failed to stop event listeners after startup error:",
          listenerError
        );
      }
      if (backgroundTask) {
        clearInterval(backgroundTask);
        backgroundTask = undefined;
      }
      server?.stop();

      if (process.env.NODE_ENV !== "test") {
        process.exit(1);
      }
    });

  process.once("SIGINT", () => shutdown(realOracle, "SIGINT"));
  process.once("SIGTERM", () => shutdown(realOracle, "SIGTERM"));
}

// Initialize and start services
export async function initialize(oracle: OracleApi): Promise<void> {
  try {
    await oracle.startEventListening();
    console.log("✅ Oracle services initialized");
  } catch (error) {
    console.error("❌ Failed to start event listeners:", error);
    throw error;
  }
}

// Graceful shutdown
export async function shutdown(
  oracle: OracleApi,
  signal: string
): Promise<void> {
  console.log(`\n🛑 Shutting down (${signal})...`);
  try {
    await oracle.stopEventListening();
    if (backgroundTask) {
      clearInterval(backgroundTask);
      backgroundTask = undefined;
    }
    server?.stop();
    console.log("✅ Shutdown complete");
  } catch (error) {
    console.error("❌ Shutdown error:", error);
  }
  // Avoid killing test process
  if (process.env.NODE_ENV !== "test") {
    process.exit(0);
  }
}
