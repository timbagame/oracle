import { beforeAll, afterAll, describe, it, expect } from "bun:test";
import { unlinkSync } from "fs";
import { Keypair } from "@solana/web3.js";

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
  (OracleService as any).instance = undefined;
  (OracleDatabase as any).instance = undefined;
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

  it("derives game PDA from stored secrets", () => {
    const service = OracleService.getInstance();
    service.cleanupOldRecords(-1);
    const { gameAddress } = service.generateGameSecrets();

    const pda: any = (service as any).getGamePDAFromAddress(gameAddress);
    expect(pda.toBase58()).toBe(gameAddress);

    const fakeAddress = Keypair.generate().publicKey.toBase58();
    expect(() => (service as any).getGamePDAFromAddress(fakeAddress)).toThrow();
  });

  it("identifies account not found errors", () => {
    const service = OracleService.getInstance();
    const check = (service as any).isAccountNotFoundError.bind(service);
    expect(check({ message: "Account does not exist" })).toBe(true);
    expect(check({ message: "Something else" })).toBe(false);
  });

  it("updates scan statistics correctly", () => {
    const service = OracleService.getInstance();
    const stats = { completed: 0, errors: 0, notReady: 0 };
    (service as any).updateScanStats(stats, { success: true });
    (service as any).updateScanStats(stats, { success: false, notReady: true });
    (service as any).updateScanStats(stats, { success: false });
    expect(stats).toEqual({ completed: 1, errors: 1, notReady: 1 });
  });
});

