import { beforeAll, afterAll, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "fs";
import { setupTestEnvironment } from "./helpers/setup-env.ts";

type OracleDatabaseInstance = import("../database.ts").OracleDatabase;

let OracleDatabase: typeof import("../database.ts").OracleDatabase;
let testEnv: ReturnType<typeof setupTestEnvironment>;

const resetDatabase = () => {
  if (!testEnv || !OracleDatabase) {
    return;
  }

  testEnv.resetSingletons();

  try {
    rmSync(testEnv.tempDb.path, { force: true });
  } catch {
    // ignore missing file during cleanup
  }
};

beforeAll(async () => {
  testEnv = setupTestEnvironment({ prefix: "oracle-database-test" });
  ({ OracleDatabase } = await import("../database.ts"));
  testEnv.registerSingleton(OracleDatabase);
  resetDatabase();
});

beforeEach(() => {
  resetDatabase();
});

afterAll(() => {
  resetDatabase();
  testEnv.cleanup();
});

describe("OracleDatabase", () => {
  it("handles secret and game lifecycle", () => {
    const db = OracleDatabase.getInstance();

    db.saveSecretKey("game-lifecycle", "secret-value", "hash-value");
    db.trackGame("game-lifecycle", "raffle");

    expect(db.getSecretKey("game-lifecycle")).toEqual({
      secretKey: "secret-value",
      randomHash: "hash-value",
    });
    expect(db.getGameType("game-lifecycle")).toBe("raffle");

    db.markSecretKeyUsed("game-lifecycle");
    expect(db.getSecretKey("game-lifecycle")).toBeNull();

    db.markGameCompleted("game-lifecycle");

    expect(db.getStats()).toEqual({
      totalSecrets: 1,
      usedSecrets: 1,
      pendingGames: 0,
      completedGames: 1,
      cancelledGames: 0,
    });

    expect(db.cleanupOldRecords(-1)).toEqual({
      deletedSecrets: 1,
      deletedGames: 1,
    });
  });

  it("tracks completion attempts and cancellations", () => {
    const db = OracleDatabase.getInstance();

    db.trackGame("pending-game");
    db.trackGame("cancelled-game", "tournament");

    db.incrementCompletionAttempts("pending-game");
    db.incrementCompletionAttempts("pending-game");
    db.incrementCompletionAttempts("cancelled-game");

    expect(db.getPendingGames()).toEqual([
      { game_address: "pending-game", completion_attempts: 2 },
      { game_address: "cancelled-game", completion_attempts: 1 },
    ]);

    db.markGameClosed("cancelled-game");

    expect(db.getPendingGames()).toEqual([
      { game_address: "pending-game", completion_attempts: 2 },
    ]);

    expect(db.getStats()).toEqual({
      totalSecrets: 0,
      usedSecrets: 0,
      pendingGames: 1,
      completedGames: 0,
      cancelledGames: 1,
    });
  });

  it("manages player rosters for games", () => {
    const db = OracleDatabase.getInstance();

    db.addPlayerToGame("game-players", "player-one", 0);
    db.addPlayerToGame("game-players", "player-two", 1);
    db.addPlayerToGame("game-players", "player-two", 1);

    expect(db.getGamePlayers("game-players")).toEqual(["player-one", "player-two"]);

    db.removePlayerFromGame("game-players", 0);
    expect(db.getGamePlayers("game-players")).toEqual(["player-two"]);

    db.clearStalePlayersForGame("game-players");
    expect(db.getGamePlayers("game-players")).toEqual([]);
  });

  it("reports connection info and reopens after close", () => {
    const db = OracleDatabase.getInstance();

    const info = db.getConnectionInfo();
    expect(info.file).toBe(testEnv.tempDb.path);
    expect(info.isOpen).toBe(true);

    db.close();
    expect(db.getConnectionInfo().isOpen).toBe(false);

    const reopened = OracleDatabase.getInstance();
    expect(reopened.getConnectionInfo().isOpen).toBe(true);
  });

  it("falls back to safe defaults when sqlite operations fail", () => {
    const db = OracleDatabase.getInstance();
    const originalHandle = (db as any).db;

    (db as any).db = {
      prepare: () => {
        throw new Error("boom");
      },
      run: () => {
        throw new Error("boom");
      },
    };

    try {
      expect(db.getSecretKey("missing" as string)).toBeNull();
      expect(db.getPendingGames()).toEqual([]);
      expect(db.cleanupOldRecords(-1)).toEqual({ deletedSecrets: 0, deletedGames: 0 });
    } finally {
      (db as any).db = originalHandle;
    }
  });
});
