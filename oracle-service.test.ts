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

  it("returns zero stats when no games are pending", async () => {
    const service = OracleService.getInstance();
    service.cleanupOldRecords(-1);

    const stats = await service.scanAndCompleteActiveGames();
    expect(stats).toEqual({ completed: 0, errors: 0, notReady: 0 });
  });

  it("scans pending games and records outcomes", async () => {
    const service = OracleService.getInstance();
    service.cleanupOldRecords(-1);
    const db = OracleDatabase.getInstance();

    // success case
    db.saveSecretKey("gameSuccess", "secret", "hash");
    db.trackGame("gameSuccess");

    // not ready case
    db.saveSecretKey("gamePending", "secret", "hash");
    db.trackGame("gamePending");

    // game removed from chain
    db.saveSecretKey("gameGone", "secret", "hash");
    db.trackGame("gameGone");

    // error during completion
    db.saveSecretKey("gameError", "secret", "hash");
    db.trackGame("gameError");

    const originalExists = (service as any).gameExistsOnChain;
    const originalComplete = (service as any).completeGame;

    (service as any).gameExistsOnChain = async (addr: string) => {
      if (addr === "gameGone") return false;
      return true;
    };

    (service as any).completeGame = async (addr: string) => {
      if (addr === "gameSuccess") {
        db.markGameCompleted(addr);
        return { success: true };
      }
      if (addr === "gamePending") {
        return { success: false, notReady: true };
      }
      if (addr === "gameError") {
        throw new Error("boom");
      }
      throw new Error("unexpected game");
    };

    const stats = await service.scanAndCompleteActiveGames();
    expect(stats).toEqual({ completed: 1, errors: 1, notReady: 1 });

    // gameGone should be marked completed due to missing on-chain account
    const pending = db.getPendingGames().map((g) => g.game_address);
    expect(pending).not.toContain("gameGone");

    (service as any).gameExistsOnChain = originalExists;
    (service as any).completeGame = originalComplete;
  });
});

