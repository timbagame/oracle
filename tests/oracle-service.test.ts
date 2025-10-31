import { beforeAll, afterAll, describe, it, expect, spyOn } from "bun:test";
import { resetPendingGames } from "./helpers/reset-pending-games.ts";
import { seedTrackedGame } from "./helpers/seed-tracked-game.ts";
import { setupOracleServiceEnv } from "./helpers/setup-oracle-service-env.ts";
import { Keypair } from "@solana/web3.js";
import * as delayModule from "../delay.ts";

const makeFakeContext = () => ({
  gamePda: Keypair.generate().publicKey,
  secretData: { secretKey: "aa".repeat(32), randomHash: "bb".repeat(32) },
  randomHashBuffer: Buffer.from("bb".repeat(32), "hex"),
  readiness: { ready: true, gameAccount: {} },
});

const makeReadyResolution = () => {
  const context = makeFakeContext();
  return { context, readiness: context.readiness, notReady: false };
};

let OracleService: typeof import("../oracle-service.ts").OracleService;
let OracleDatabase: typeof import("../database.ts").OracleDatabase;
let cleanup: () => void;

beforeAll(async () => {
  const env = await setupOracleServiceEnv("oracle-service-test");
  ({ OracleService, OracleDatabase } = env);
  cleanup = env.cleanup;
});

afterAll(() => {
  cleanup?.();
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

  it("resolves stored games from secrets", () => {
    const service = OracleService.getInstance();
    service.cleanupOldRecords(-1);
    const { gameAddress } = service.generateGameSecrets();

    const resolved: any = (service as any).resolveStoredGame(gameAddress);
    expect(resolved?.gamePda.toBase58()).toBe(gameAddress);
    expect(resolved?.randomHashBuffer).toBeInstanceOf(Buffer);

    const fakeAddress = Keypair.generate().publicKey.toBase58();
    expect((service as any).resolveStoredGame(fakeAddress)).toBeNull();
    expect(() => (service as any).resolveStoredGame(fakeAddress, { throwIfMissing: true })).toThrow();
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
    expect(() =>
      (service as any).calculateWinnerIndex(Buffer.alloc(16, 1), 123456, 2)
    ).toThrow("Secret key buffer must be at least 32 bytes");
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
    resetPendingGames(db, { service });

    const stats = await service.scanAndCompleteActiveGames();
    expect(stats).toEqual({ completed: 0, errors: 0, notReady: 0 });
  });

  it("scans pending games and records outcomes", async () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();
    resetPendingGames(db, { service });

    // success case
    seedTrackedGame(db, {
      address: "gameSuccess",
      secret: "secret",
      randomHash: "hash",
    });

    // not ready case
    seedTrackedGame(db, {
      address: "gamePending",
      secret: "secret",
      randomHash: "hash",
    });

    // game removed from chain
    seedTrackedGame(db, {
      address: "gameGone",
      secret: "secret",
      randomHash: "hash",
    });

    // error during completion
    seedTrackedGame(db, {
      address: "gameError",
      secret: "secret",
      randomHash: "hash",
    });

    const originalResolve = (service as any).resolveContextAndReadiness;
    const originalComplete = (service as any).completeGame;

    (service as any).resolveContextAndReadiness = async (addr: string) => {
      if (addr === "gameGone") {
        return { context: null, readiness: undefined, notReady: false };
      }
      return makeReadyResolution();
    };

    (service as any).completeGame = async (addr: string) => {
      if (addr === "gameSuccess") {
        db.finalizeCompletedGame(addr);
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

    (service as any).resolveContextAndReadiness = originalResolve;
    (service as any).completeGame = originalComplete;
  });

  it("skips games that exceed max completion attempts", async () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();
    resetPendingGames(db, { service });

    seedTrackedGame(db, {
      address: "stubborn",
      secret: "c".repeat(64),
      randomHash: "d".repeat(64),
    });
    for (let i = 0; i < 5; i++) {
      db.incrementCompletionAttempts("stubborn");
    }

    seedTrackedGame(db, {
      address: "active",
      secret: "e".repeat(64),
      randomHash: "f".repeat(64),
    });

    const originalResolve = (service as any).resolveContextAndReadiness;
    const originalComplete = (service as any).completeGame;

    const processed: string[] = [];
    let delayCalls = 0;

    (service as any).resolveContextAndReadiness = async () => makeReadyResolution();
    (service as any).completeGame = async (addr: string) => {
      processed.push(addr);
      return { success: true };
    };
    const delaySpy = spyOn(delayModule, "delay").mockImplementation(async () => {
      delayCalls++;
    });

    try {
      const stats = await service.scanAndCompleteActiveGames();
      expect(processed).toEqual(["active"]);
      expect(stats).toEqual({ completed: 1, errors: 0, notReady: 0 });
      expect(delayCalls).toBe(1);

      const stubbornEntry = db
        .getPendingGames()
        .find((g) => g.game_address === "stubborn");
      expect(stubbornEntry?.completion_attempts).toBeGreaterThanOrEqual(5);
      expect(
        db
          .getPendingGames(5)
          .some((entry) => entry.game_address === "stubborn")
      ).toBe(false);
    } finally {
      (service as any).resolveContextAndReadiness = originalResolve;
      (service as any).completeGame = originalComplete;
      delaySpy.mockRestore();
    }
  });
});
