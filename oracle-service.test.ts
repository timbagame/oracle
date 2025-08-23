import { beforeAll, afterAll, describe, it, expect } from "bun:test";
import { unlinkSync } from "fs";

let OracleService: typeof import("./oracle-service.ts").OracleService;
let OracleDatabase: typeof import("./database.ts").OracleDatabase;

beforeAll(async () => {
  process.env["NODE_ENV"] = "test";
  process.env["SOLANA_NETWORK"] = "http://localhost";
  process.env["DATABASE_FILE"] = "oracle-service-test.sqlite";

  ({ OracleService } = await import("./oracle-service.ts"));
  ({ OracleDatabase } = await import("./database.ts"));
  (OracleService as any).instance = undefined;
  (OracleDatabase as any).instance = undefined;
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

describe("OracleService", () => {
  it("generates secrets and stores them", () => {
    const service = OracleService.getInstance();
    service.cleanupOldRecords(-1);
    const { randomHash, gameAddress } = service.generateGameSecrets();
    expect(typeof randomHash).toBe("string");
    expect(typeof gameAddress).toBe("string");

    const db = OracleDatabase.getInstance();
    const stored = db.getSecretKey(gameAddress);
    expect(stored?.randomHash).toBe(randomHash);
  });

  it("cleans up records and reports stats", () => {
    const service = OracleService.getInstance();
    service.cleanupOldRecords(-1);
    service.generateGameSecrets();
    const cleanup = service.cleanupOldRecords(-1);
    expect(cleanup.deletedSecrets).toBeGreaterThan(0);

    const stats = service.getStats();
    expect(stats.totalSecrets).toBe(0);
    expect(stats.eventListening).toBe(false);
    expect(stats.activeListeners).toBe(0);
  });
});

