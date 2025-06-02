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

// API documentation template
const API_DOCUMENTATION = `
  <html>
    <head>
      <title>Oracle API</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
        h1 { color: #333; }
        h2 { color: #666; }
        ul { margin: 10px 0; }
        li { margin: 5px 0; }
        code { background: #f5f5f5; padding: 2px 4px; }
      </style>
    </head>
    <body>
      <h1>🔮 Oracle API</h1>
      <h2>Endpoints:</h2>
      <ul>
        <li><code>GET /health</code> - Health check with event listening status</li>
        <li><code>POST /generate-hash</code> - Generate game secrets</li>
        <li><code>GET /stats</code> - Basic statistics</li>
        <li><code>GET /</code> - This documentation</li>
      </ul>
      <h2>Features:</h2>
      <ul>
        <li>🎧 Event-driven game completion</li>
        <li>🔄 Fallback periodic scanning</li>
        <li>📊 Real-time game tracking</li>
        <li>🔒 Secure secret management</li>
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

// Response helper functions
function createResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS
  });
}

function createHtmlResponse(html: string): Response {
  return new Response(html, {
    headers: { 'Content-Type': 'text/html' }
  });
}

function createErrorResponse(error: string, status: number = 500): Response {
  return createResponse({
    success: false,
    error
  }, status);
}

// Route handlers
async function handleHealth(): Promise<Response> {
  const stats = oracle.getStats();
  return createResponse({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    pendingGames: stats.pendingGames,
    completedGames: stats.completedGames,
    eventListening: stats.eventListening,
    activeListeners: stats.activeListeners
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
  const stats = oracle.getStats();
  return createResponse({
    success: true,
    stats
  });
}

async function handleDocumentation(): Promise<Response> {
  return createHtmlResponse(API_DOCUMENTATION);
}

// Main server setup
const server = Bun.serve({
  port: PORT,
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return createResponse(null, 200);
    }

    try {
      // Route handling
      switch (true) {
        case path === '/health' && method === 'GET':
          return await handleHealth();

        case path === '/generate-hash' && method === 'POST':
          return await handleGenerateHash();

        case path === '/stats' && method === 'GET':
          return await handleStats();

        case path === '/' && method === 'GET':
          return await handleDocumentation();

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

// Initialize event listeners with error handling
async function initializeEventListeners(): Promise<void> {
  try {
    await oracle.startEventListening();
    console.log('✅ Event listeners initialized successfully');
  } catch (error) {
    console.error('❌ Failed to start event listeners:', error);
    console.log('⚠️ Continuing with periodic scanning only');
  }
}

// Start background processes
initializeEventListeners();

// Periodic scanning as fallback
setInterval(async () => {
  try {
    await oracle.scanAndCompleteActiveGames();
  } catch (error) {
    console.error('❌ Error in background scan:', error);
  }
}, FALLBACK_SCAN_INTERVAL);

// Graceful shutdown handlers
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);

  try {
    await oracle.stopEventListening();
    server.stop();
    console.log('✅ Oracle API shutdown complete');
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
  }

  process.exit(0);
}

process.once("SIGINT", () => gracefulShutdown("SIGINT"));
process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));

console.log('✅ Oracle API is running with event-driven game completion!');
