import { beforeAll, afterAll, describe, it, expect } from "bun:test";
import { unlinkSync } from "fs";

let handleHealth: () => Promise<Response>;
let handleGenerateHash: () => Promise<Response>;
let handleStats: () => Promise<Response>;
let OracleDatabase: typeof import("./database.ts").OracleDatabase;

beforeAll(async () => {
  process.env["NODE_ENV"] = "test";
  process.env["SOLANA_NETWORK"] = "http://localhost";
  process.env["DATABASE_FILE"] = "test.sqlite";

  ({ handleHealth, handleGenerateHash, handleStats } = await import("./index.ts"));
  ({ OracleDatabase } = await import("./database.ts"));
});

afterAll(() => {
  const db = OracleDatabase.getInstance();
  db.close();
  try {
    unlinkSync(process.env["DATABASE_FILE"]!);
  } catch {
    // ignore
  }
});

describe("API handlers", () => {
  it("returns health status", async () => {
    const res = await handleHealth();
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe("healthy");
  });

  it("generates game secrets", async () => {
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
    const res = await handleStats();
    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean; stats: unknown };
    expect(data.success).toBe(true);
    expect(data.stats).toBeDefined();
  });
});

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
});

