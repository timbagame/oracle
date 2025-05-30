import { OracleService } from "./oracle-service.ts";
import { PublicKey } from "@solana/web3.js";

/**
 * Oracle API Server with enhanced features
 * Provides endpoints for requesting random hashes, monitoring, and managing games
 */

const PORT = process.env["ORACLE_PORT"] || 3001;
const oracle = OracleService.getInstance();

// Simple response helper
function createResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json'
    }
  });
}

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
      // Health check
      if (path === '/health' && method === 'GET') {
        const stats = oracle.getStats();
        return createResponse({
          status: 'healthy',
          timestamp: new Date().toISOString(),
          pendingGames: stats.pendingGames,
          completedGames: stats.completedGames
        });
      }

      // Generate random hash
      if (path === '/generate-hash' && method === 'POST') {
        const secrets = oracle.generateGameSecrets();
        return createResponse({
          success: true,
          randomHash: secrets.randomHash,
          gameAddress: secrets.gameAddress
        });
      }

      // Complete game manually
      if (path === '/complete-game' && method === 'POST') {
        const body = await request.json();
        const { gameAddress } = body;

        if (!gameAddress) {
          return createResponse({
            success: false,
            error: 'gameAddress is required'
          }, 400);
        }

        try {
          new PublicKey(gameAddress);
        } catch (error) {
          return createResponse({
            success: false,
            error: 'Invalid gameAddress'
          }, 400);
        }

        const result = await oracle.completeGame(gameAddress);
        return createResponse(result);
      }

      // Basic stats
      if (path === '/stats' && method === 'GET') {
        const stats = oracle.getStats();
        return createResponse({
          success: true,
          stats
        });
      }

      // API documentation
      if (path === '/' && method === 'GET') {
        const documentation = `
          <html>
            <head><title>Oracle API</title></head>
            <body>
              <h1>Oracle API</h1>
              <h2>Endpoints:</h2>
              <ul>
                <li>GET /health - Health check</li>
                <li>POST /generate-hash - Generate game secrets</li>
                <li>POST /complete-game - Complete a game</li>
                <li>GET /stats - Basic statistics</li>
              </ul>
            </body>
          </html>
        `;
        return new Response(documentation, {
          headers: { 'Content-Type': 'text/html' }
        });
      }

      // 404
      return createResponse({
        success: false,
        error: 'Endpoint not found'
      }, 404);

    } catch (error: any) {
      console.error('Server error:', error);
      return createResponse({
        success: false,
        error: 'Internal server error'
      }, 500);
    }
  },
});

console.log(`🔮 Oracle API running on http://localhost:${PORT}`);

// Simple background scanning every 30 seconds
setInterval(async () => {
  try {
    await oracle.scanAndCompleteActiveGames();
  } catch (error) {
    console.error('Error in background scan:', error);
  }
}, 30000);

// Graceful shutdown
process.once("SIGINT", () => {
  console.log('Shutting down...');
  server.stop();
  process.exit(0);
});

console.log('✅ Oracle API is running!');
