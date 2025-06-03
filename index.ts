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

      <div class="endpoint">
        <span class="method get">GET</span> <code>/health</code>
        <div class="description">Simple health check - returns basic service status</div>
      </div>

      <div class="endpoint">
        <span class="method post">POST</span> <code>/generate-hash</code>
        <div class="description">Generate new game secrets (random hash and game address)</div>
      </div>

      <div class="endpoint">
        <span class="method get">GET</span> <code>/stats</code>
        <div class="description">Detailed statistics and metrics about the oracle service</div>
      </div>

      <h2>Service Information</h2>
      <p>This Oracle API provides game completion services for Solana-based coinflip games.</p>
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
  return createResponse({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    service: 'oracle-api'
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
