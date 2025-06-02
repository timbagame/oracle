import { OracleService } from "./oracle-service.ts";

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

// Simplified API documentation
const API_DOCUMENTATION = `
  <html>
    <head>
      <title>🔮 Oracle API</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
        h1 { color: #333; }
        code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; }
        ul { line-height: 1.6; }
      </style>
    </head>
    <body>
      <h1>🔮 Oracle API</h1>
      <h2>Endpoints:</h2>
      <ul>
        <li><code>GET /health</code> - Health check</li>
        <li><code>POST /generate-hash</code> - Generate game secrets</li>
        <li><code>GET /stats</code> - Statistics</li>
      </ul>
    </body>
  </html>
`;

/**
 * Oracle API Server with enhanced features
 * Provides endpoints for requesting random hashes, monitoring, and managing games
 */

const PORT = Number(process.env["ORACLE_PORT"]) || DEFAULT_PORT;
const oracle = OracleService.getInstance();

// Response helpers
function createResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

function createHtmlResponse(html: string): Response {
  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
}

function createErrorResponse(error: string, status: number = 500): Response {
  return createResponse({ success: false, error }, status);
}

// Route handlers
async function handleHealth(): Promise<Response> {
  const stats = oracle.getStats();
  return createResponse({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    ...stats
  });
}

async function handleGenerateHash(): Promise<Response> {
  const secrets = oracle.generateGameSecrets();
  return createResponse({
    success: true,
    randomHash: secrets.randomHash,
    gameAddress: secrets.gameAddress
  });
}

async function handleStats(): Promise<Response> {
  return createResponse({ success: true, stats: oracle.getStats() });
}

// Main server
const server = Bun.serve({
  port: PORT,
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname: path, method } = { pathname: url.pathname, method: request.method };

    // CORS preflight
    if (method === 'OPTIONS') return createResponse(null, 200);

    try {
      switch (true) {
        case path === '/health' && method === 'GET':
          return await handleHealth();
        case path === '/generate-hash' && method === 'POST':
          return await handleGenerateHash();
        case path === '/stats' && method === 'GET':
          return await handleStats();
        case path === '/' && method === 'GET':
          return createHtmlResponse(API_DOCUMENTATION);
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

// Initialize and start services
async function initialize(): Promise<void> {
  try {
    await oracle.startEventListening();
    console.log('✅ Oracle services initialized');
  } catch (error) {
    console.error('❌ Failed to start event listeners:', error);
  }
}

// Background scanning
setInterval(async () => {
  try {
    await oracle.scanAndCompleteActiveGames();
  } catch (error) {
    console.error('❌ Background scan error:', error);
  }
}, FALLBACK_SCAN_INTERVAL);

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  console.log(`\n🛑 Shutting down (${signal})...`);
  try {
    await oracle.stopEventListening();
    server.stop();
    console.log('✅ Shutdown complete');
  } catch (error) {
    console.error('❌ Shutdown error:', error);
  }
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

initialize();
