import { OracleService } from "./oracle-service.ts";
import * as fs from 'fs';
import * as path from 'path';

// Constants
const DEFAULT_PORT = 3001;
const FALLBACK_SCAN_INTERVAL = 300000; // 5 minutes

// CORS headers configuration
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

/**
 * Oracle API Server with enhanced features
 * Provides endpoints for requesting random hashes, monitoring, and managing games
 */

const PORT = Number(process.env["ORACLE_PORT"]) || DEFAULT_PORT;
const oracle = OracleService.getInstance();

// Response helpers

/**
 * Creates a JSON response with appropriate CORS headers.
 * @param data - The data to be stringified and sent as JSON.
 * @param status - The HTTP status code for the response (default is 200).
 * @returns A Response object.
 */
function createResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

/**
 * Creates an HTML response with appropriate CORS headers.
 * @param html - The HTML string to be sent.
 * @returns A Response object with Content-Type set to text/html.
 */
function createHtmlResponse(html: string): Response {
  return new Response(html, {
    headers: {
      ...CORS_HEADERS, // Spread existing CORS headers
      'Content-Type': 'text/html' // Ensure HTML content type
    }
  });
}

/**
 * Creates a JSON error response.
 * @param error - The error message string.
 * @param status - The HTTP status code for the error response (default is 500).
 * @returns A Response object.
 */
function createErrorResponse(error: string, status: number = 500): Response {
  return createResponse({ success: false, error }, status);
}

// Route handlers

/**
 * Handles health check requests.
 * @returns A Promise resolving to a Response object indicating service health.
 */
async function handleHealth(): Promise<Response> {
  return createResponse({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    service: 'oracle-api'
  });
}

/**
 * Handles requests to generate game secrets (random hash and game address).
 * Optionally takes a gameType from the request body to include the secret key for specific game types.
 * @param request - The incoming Request object.
 * @returns A Promise resolving to a Response object with the generated secrets or an error.
 */
async function handleGenerateHash(request: Request): Promise<Response> {
  try {
    // Parse request body to get game type if provided
    let gameType: string | undefined;
    try {
      const body = await request.json() as { gameType?: string };
      gameType = body?.gameType?.toLowerCase();
    } catch {
      // No body or invalid JSON, use default behavior (gameType remains undefined)
    }

    const secrets = oracle.generateGameSecrets(gameType);
    // The structure of 'response' is intentionally flexible here as 'secretKey' is conditional.
    const response: any = {
      success: true,
      randomHash: secrets.randomHash,
      gameAddress: secrets.gameAddress
    };

    // Include secret key for dumbflip and snowball games
    if (secrets.secretKey) {
      response.secretKey = secrets.secretKey;
    }

    return createResponse(response);
  } catch (error: any) {
    console.error('❌ Error generating hash:', error);
    return createErrorResponse('Failed to generate hash', 500);
  }
}

/**
 * Handles requests for service statistics.
 * @returns A Promise resolving to a Response object with detailed service stats.
 */
async function handleStats(): Promise<Response> {
  const stats = oracle.getStats();
  return createResponse({
    success: true,
    timestamp: new Date().toISOString(),
    stats,
    service: {
      name: 'oracle-api',
      version: '1.0.0',
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development'
    }
  });
}

// Main server
const server = Bun.serve({
  port: PORT,
  /**
   * Main fetch handler for the Bun server.
   * Routes requests to appropriate handlers based on path and method.
   * @param request - The incoming Request object.
   * @returns A Promise resolving to a Response object.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Renamed 'path' to 'routePath' to avoid collision with the imported 'path' module
    const { pathname: routePath, method } = { pathname: url.pathname, method: request.method };

    // CORS preflight
    if (method === 'OPTIONS') return createResponse(null, 200);

    try {
      switch (true) {
        case routePath === '/health' && method === 'GET':
          return await handleHealth();
        case routePath === '/generate-hash' && method === 'POST':
          return await handleGenerateHash(request);
        case routePath === '/stats' && method === 'GET':
          return await handleStats();
        case routePath === '/' && method === 'GET': { // Use 'routePath' here
          // 'path.join' now correctly refers to the imported 'path' module
          const docPath = path.join(process.cwd(), 'api-documentation.html');
          const apiDocHtml = fs.readFileSync(docPath, 'utf-8');
          return createHtmlResponse(apiDocHtml);
        }
        default:
          return createErrorResponse('Endpoint not found', 404);
      }
    } catch (error: any) {
      console.error('❌ Server error:', error);
      return createErrorResponse('Internal server error', 500);
    }
  },
});

console.log(`🔮 Oracle API running on http://localhost:${PORT}`);

/**
 * Initializes and starts the Oracle services, including event listening.
 * Logs success or failure of service initialization.
 */
async function initialize(): Promise<void> {
  try {
    await oracle.startEventListening();
    console.log('✅ Oracle services initialized');
  } catch (error: any) {
    console.error('❌ Failed to start event listeners:', error.message);
  }
}

// Background scanning
setInterval(async () => {
  try {
    await oracle.scanAndCompleteActiveGames();

    // Clean up old records periodically (every scan cycle)
    const cleanupResult = oracle.cleanupOldRecords(48);
    if (cleanupResult.deletedSecrets > 0 || cleanupResult.deletedGames > 0) {
      console.log('🧹 Background cleanup completed');
    }
  } catch (error: any) {
    console.error('❌ Background scan error:', error.message);
  }
}, FALLBACK_SCAN_INTERVAL);

/**
 * Handles graceful shutdown of the server and Oracle services.
 * Stops event listening, stops the HTTP server, and exits the process.
 * @param signal - The shutdown signal received (e.g., "SIGINT", "SIGTERM").
 */
async function shutdown(signal: string): Promise<void> {
  console.log(`\n🛑 Shutting down (${signal})...`);
  try {
    await oracle.stopEventListening();
    server.stop(); // Attempt to stop the server
    console.log('✅ Shutdown complete');
  } catch (error: any) {
    console.error('❌ Shutdown error:', error.message);
  }
  process.exit(0); // Ensure the process exits
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

initialize();
