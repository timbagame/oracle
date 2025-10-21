import { beforeAll, afterAll, describe, it, expect } from "bun:test";
import { setupTestEnvironment } from "./helpers/setup-env.ts";
import { Keypair } from "@solana/web3.js";

let OracleService: typeof import("../oracle-service.ts").OracleService;
let OracleDatabase: typeof import("../database.ts").OracleDatabase;
let testEnv: ReturnType<typeof setupTestEnvironment>;

beforeAll(async () => {
  testEnv = setupTestEnvironment({ prefix: "oracle-service-test" });
  ({ OracleService } = await import("../oracle-service.ts"));
  ({ OracleDatabase } = await import("../database.ts"));
  testEnv.registerSingleton(OracleService);
  testEnv.registerSingleton(OracleDatabase);
});

afterAll(() => {
  testEnv.cleanup();
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
    const { gameAddress } = service.generateGameSecrets();
    const db = OracleDatabase.getInstance();
    db.markSecretKeyUsed(gameAddress);
    db.markGameCompleted(gameAddress);
    const cleanup = service.cleanupOldRecords(-1);
    expect(cleanup.deletedSecrets).toBeGreaterThan(0);

    const stats = service.getStats();
    expect(stats.usedSecrets).toBe(0);
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

  it("computes deterministic winner index", () => {
    const service = OracleService.getInstance();
    const secret = Buffer.alloc(32, 1);
    const winner = (service as any).calculateWinnerIndex(secret, 123456, 100);
    expect(winner).toBe(2);
    const single = (service as any).calculateWinnerIndex(secret, 123456, 1);
    expect(single).toBe(0);
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
    const db = OracleDatabase.getInstance();
    for (const game of db.getPendingGames()) {
      db.markGameCompleted(game.game_address);
      db.markSecretKeyUsed(game.game_address);
    }
    service.cleanupOldRecords(-1);

    const stats = await service.scanAndCompleteActiveGames();
    expect(stats).toEqual({ completed: 0, errors: 0, notReady: 0 });
  });

  it("scans pending games and records outcomes", async () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();
    for (const game of db.getPendingGames()) {
      db.markGameCompleted(game.game_address);
      db.markSecretKeyUsed(game.game_address);
    }
    service.cleanupOldRecords(-1);

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

  it("skips games that exceed max completion attempts", async () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();
    for (const game of db.getPendingGames()) {
      db.markGameCompleted(game.game_address);
      db.markSecretKeyUsed(game.game_address);
    }
    service.cleanupOldRecords(-1);

    db.saveSecretKey("stubborn", "c".repeat(64), "d".repeat(64));
    db.trackGame("stubborn");
    for (let i = 0; i < 5; i++) {
      db.incrementCompletionAttempts("stubborn");
    }

    db.saveSecretKey("active", "e".repeat(64), "f".repeat(64));
    db.trackGame("active");

    const originalExists = (service as any).gameExistsOnChain;
    const originalComplete = (service as any).completeGame;
    const originalDelay = (service as any).delay;

    const processed: string[] = [];
    let delayCalls = 0;

    (service as any).gameExistsOnChain = async () => true;
    (service as any).completeGame = async (addr: string) => {
      processed.push(addr);
      return { success: true };
    };
    (service as any).delay = async () => {
      delayCalls++;
    };

    try {
      const stats = await service.scanAndCompleteActiveGames();
      expect(processed).toEqual(["active"]);
      expect(stats).toEqual({ completed: 1, errors: 0, notReady: 0 });
      expect(delayCalls).toBe(1);

      const stubbornEntry = db
        .getPendingGames()
        .find((g) => g.game_address === "stubborn");
      expect(stubbornEntry?.completion_attempts).toBeGreaterThanOrEqual(5);
    } finally {
      (service as any).gameExistsOnChain = originalExists;
      (service as any).completeGame = originalComplete;
      (service as any).delay = originalDelay;
    }
  });
});
