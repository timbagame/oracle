import { beforeAll, afterAll, describe, it, expect } from "bun:test";
import { unlinkSync } from "fs";
import { buildHandlers, type OracleApi } from "./index.ts";
let OracleDatabase: typeof import("./database.ts").OracleDatabase;
let OracleService: typeof import("./oracle-service.ts").OracleService;

beforeAll(async () => {
  process.env["NODE_ENV"] = "test";
  process.env["SOLANA_NETWORK"] = "http://localhost";
  process.env["DATABASE_FILE"] = "test.sqlite";

  ({ OracleDatabase } = await import("./database.ts"));
  ({ OracleService } = await import("./oracle-service.ts"));
});

afterAll(() => {
  const db = OracleDatabase.getInstance();
  db.close();
  try {
    unlinkSync(process.env["DATABASE_FILE"]!);
  } catch {
    // ignore
  }
  (OracleService as any).instance = undefined;
  (OracleDatabase as any).instance = undefined;
});

describe("API handlers", () => {
  it("returns health status", async () => {
    const { handleHealth } = buildHandlers(newFakeOracle());
    const res = await handleHealth();
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe("healthy");
  });

  it("generates game secrets", async () => {
    const { handleGenerateHash } = buildHandlers(newFakeOracle());
    const res = await handleGenerateHash();
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      success: boolean;
      randomHash: string;
      gameAddress: string;
    };
    expect(data.success).toBe(true);
    expect(typeof data.randomHash).toBe("string");
    expect(typeof data.gameAddress).toBe("string");
  });

  it("provides stats", async () => {
    const { handleStats } = buildHandlers(newFakeOracle());
    const res = await handleStats();
    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean; stats: unknown };
    expect(data.success).toBe(true);
    expect(data.stats).toBeDefined();
  });

  it("handles generate hash errors", async () => {
    const { handleGenerateHash } = buildHandlers({
      ...newFakeOracle(),
      generateGameSecrets: () => {
        throw new Error("boom");
      },
    });
    const res = await handleGenerateHash();
    expect(res.status).toBe(500);
    const data = (await res.json()) as { success: boolean };
    expect(data.success).toBe(false);
  });
});

function newFakeOracle(): OracleApi {
  return {
    generateGameSecrets: () => ({ randomHash: "abcd", gameAddress: "game-1" }),
    getStats: () => ({
      totalSecrets: 0,
      usedSecrets: 0,
      pendingGames: 0,
      completedGames: 0,
      cancelledGames: 0,
      eventListening: false,
      activeListeners: 0,
    }),
    scanAndCompleteActiveGames: async () => ({ completed: 0, errors: 0, notReady: 0 }),
    startEventListening: async () => {},
    stopEventListening: async () => {},
    cleanupOldRecords: () => ({ deletedSecrets: 0, deletedGames: 0 }),
  } as any;
}

describe("OracleDatabase", () => {
  it("stores and retrieves secret keys", () => {
    const db = OracleDatabase.getInstance();
    db.saveSecretKey("game1", "secret1", "hash1");
    const stored = db.getSecretKey("game1");
    expect(stored?.secretKey).toBe("secret1");
    expect(stored?.randomHash).toBe("hash1");
  });

  it("tracks pending games", () => {
    const db = OracleDatabase.getInstance();
    db.trackGame("game2", "coinflip");
    const pending = db.getPendingGames();
    expect(pending.some((g) => g.game_address === "game2")).toBe(true);
  });

  it("marks secret keys used and updates stats", () => {
    const db = OracleDatabase.getInstance();
    db.saveSecretKey("game3", "secret3", "hash3");
    expect(db.getStats().usedSecrets).toBe(0);
    db.markSecretKeyUsed("game3");
    expect(db.getStats().usedSecrets).toBe(1);
  });

  it("updates game status and cleans up old records", () => {
    const db = OracleDatabase.getInstance();
    db.saveSecretKey("game4", "secret4", "hash4");
    db.trackGame("game4");
    db.markGameCompleted("game4");

    db.saveSecretKey("game5", "secret5", "hash5");
    db.trackGame("game5");
    db.markGameClosed("game5");

    const cleanup = db.cleanupOldRecords(-1);
    expect(cleanup.deletedSecrets).toBeGreaterThanOrEqual(1);
    expect(cleanup.deletedGames).toBeGreaterThanOrEqual(1);
  });

  it("retrieves game type and tracks completion attempts", () => {
    const db = OracleDatabase.getInstance();
    db.trackGame("game6", "giveaway");
    expect(db.getGameType("game6")).toBe("giveaway");

    db.incrementCompletionAttempts("game6");
    db.incrementCompletionAttempts("game6");

    const pending = db
      .getPendingGames()
      .find((g) => g.game_address === "game6");
    expect(pending?.completion_attempts).toBe(2);
  });

  it("manages game players list", () => {
    const db = OracleDatabase.getInstance();
    db.addPlayerToGame("game7", "player1");
    db.addPlayerToGame("game7", "player2");
    expect(db.getGamePlayers("game7")).toEqual(["player1", "player2"]);

    db.removePlayerFromGame("game7", "player1");
    expect(db.getGamePlayers("game7")).toEqual(["player2"]);

    db.clearStalePlayersForGame("game7");
    expect(db.getGamePlayers("game7")).toEqual([]);
  });

  it("reports database connection info", () => {
    const db = OracleDatabase.getInstance();
    const info = db.getConnectionInfo();
    expect(info.file).toBe(process.env["DATABASE_FILE"]!);
    expect(info.isOpen).toBe(true);
  });
});
