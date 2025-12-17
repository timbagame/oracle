import { beforeAll, afterAll, beforeEach, describe, expect, it } from "bun:test";
import { spyOn } from "bun:test";
import { rmSync } from "fs";
import { OracleDatabase } from "../database.ts";
import { createTestEnv } from "./helpers/create-test-env.ts";

let testEnv: Awaited<ReturnType<typeof createTestEnv>>;

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
  const env = await createTestEnv({
    prefix: "oracle-database-test",
    singletons: {
      OracleDatabase: async () => OracleDatabase,
    },
  });
  testEnv = env;
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

    expect(db.getStats().usedSecrets).toBe(0);

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
      deletedPlayers: 0,
    });
  });

  it("preserves pending games during cleanup until they finish", () => {
    const db = OracleDatabase.getInstance();
    const gameAddress = "cleanup-pending";

    db.saveSecretKey(gameAddress, "aa".repeat(32), "bb".repeat(32));
    db.trackGame(gameAddress);
    db.addPlayerToGame(gameAddress, "player-one", 0);

    const firstPass = db.cleanupOldRecords(-1);
    expect(firstPass).toEqual({ deletedSecrets: 0, deletedGames: 0, deletedPlayers: 0 });
    expect(db.getSecretKey(gameAddress)).not.toBeNull();
    expect(db.getPendingGames()).toEqual([
      { game_address: gameAddress, completion_attempts: 0 },
    ]);
    expect(db.getGamePlayers(gameAddress)).toEqual(["player-one"]);

    db.markSecretKeyUsed(gameAddress);
    db.markGameCompleted(gameAddress);

    const secondPass = db.cleanupOldRecords(-1);
    expect(secondPass).toEqual({ deletedSecrets: 1, deletedGames: 1, deletedPlayers: 1 });
    expect(db.getSecretKey(gameAddress)).toBeNull();
    expect(db.getPendingGames()).toEqual([]);
    expect(db.getGamePlayers(gameAddress)).toEqual([]);
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

    expect(db.getPendingGames(2)).toEqual([
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

  it("resets completion attempts for eligible games", () => {
    const db = OracleDatabase.getInstance();
    const sqlite = (db as any).db as {
      prepare: (
        sql: string,
      ) => {
        get: (
          ...args: unknown[]
        ) => { status: string; completion_attempts: number; completed_at?: number | null } | undefined;
      };
    };

    const pending = "requeue-pending";
    db.trackGame(pending);
    db.incrementCompletionAttempts(pending);
    db.incrementCompletionAttempts(pending);

    expect(db.resetCompletionAttempts(pending)).toEqual({ success: true });
    let snapshot = sqlite
      .prepare("SELECT status, completion_attempts FROM game_tracking WHERE game_address = ?")
      .get(pending);
    expect(snapshot?.status).toBe("pending");
    expect(snapshot?.completion_attempts).toBe(0);

    const desynced = "requeue-desynced";
    db.trackGame(desynced);
    db.incrementCompletionAttempts(desynced);
    db.markGameDesynced(desynced);

    expect(db.resetCompletionAttempts(desynced)).toEqual({ success: true });
    snapshot = sqlite
      .prepare("SELECT status, completion_attempts FROM game_tracking WHERE game_address = ?")
      .get(desynced);
    expect(snapshot?.status).toBe("pending");
    expect(snapshot?.completion_attempts).toBe(0);

    const finalized = "requeue-finalized";
    db.trackGame(finalized);
    db.markGameCompleted(finalized);

    expect(db.resetCompletionAttempts(finalized)).toEqual({
      success: false,
      reason: "finalized",
    });

    expect(db.resetCompletionAttempts(finalized, { allowFinalized: true })).toEqual({ success: true });

    snapshot = sqlite
      .prepare("SELECT status, completion_attempts, completed_at FROM game_tracking WHERE game_address = ?")
      .get(finalized);
    expect(snapshot?.status).toBe("pending");
    expect(snapshot?.completion_attempts).toBe(0);
    expect(snapshot?.completed_at).toBeNull();

    expect(db.resetCompletionAttempts("missing-game")).toEqual({
      success: false,
      reason: "not-found",
    });
  });

  it("keeps freshly completed games when cleanup window is zero", () => {
    const db = OracleDatabase.getInstance();
    const gameAddress = "fresh-complete";

    db.saveSecretKey(gameAddress, "aa".repeat(32), "bb".repeat(32));
    db.trackGame(gameAddress);
    db.markSecretKeyUsed(gameAddress);
    db.markGameCompleted(gameAddress);

    const sqlite = (db as any).db as {
      prepare: (
        sql: string,
      ) => { get: (...args: unknown[]) => { status?: string } | undefined };
    };

    const before = sqlite
      .prepare("SELECT status FROM game_tracking WHERE game_address = ?")
      .get(gameAddress);
    expect(before?.status).toBe("completed");

    const summary = db.cleanupOldRecords(0);
    expect(summary).toEqual({ deletedSecrets: 0, deletedGames: 0, deletedPlayers: 0 });

    const after = sqlite
      .prepare("SELECT status FROM game_tracking WHERE game_address = ?")
      .get(gameAddress);
    expect(after?.status).toBe("completed");

    db.cleanupOldRecords(-1);
  });

  it("returns pending games ordered by last_checked and enforces scan limit", () => {
    const db = OracleDatabase.getInstance();
    const rawDb = (db as any).db as { prepare: (sql: string) => { run: (...args: any[]) => void } };

    const total = 60;
    const baseTimestamp = 1_700_000_000_000;
    const expected: string[] = [];

    for (let i = 0; i < total; i++) {
      const address = `pending-${i}`;
      db.trackGame(address);
      const lastChecked = baseTimestamp + (total - i);
      rawDb
        .prepare("UPDATE game_tracking SET last_checked = ?, completion_attempts = ? WHERE game_address = ?")
        .run(lastChecked, i, address);

      if (i >= total - 50) {
        expected.push(address);
      }
    }

    expected.reverse();

    const pending = db.getPendingGames();
    expect(pending).toHaveLength(50);
    expect(pending.map((game) => game.game_address)).toEqual(expected);
    expect(pending.map((game) => game.completion_attempts)).toEqual(
      expected.map((address) => Number(address.split("-")[1]))
    );
  });

  it("manages player rosters for games", () => {
    const db = OracleDatabase.getInstance();

    db.addPlayerToGame("game-players", "player-one", 0);
    db.addPlayerToGame("game-players", "player-one", 1);
    db.addPlayerToGame("game-players", "player-two", 2);

    expect(db.getGamePlayers("game-players")).toEqual([
      "player-one",
      "player-one",
      "player-two",
    ]);

    db.removePlayerFromGame("game-players", 0);
    expect(db.getGamePlayers("game-players")).toEqual(["player-one", "player-two"]);

    db.clearStalePlayersForGame("game-players");
    expect(db.getGamePlayers("game-players")).toEqual([]);
  });

  it("applies player mutations in a single transaction", () => {
    const db = OracleDatabase.getInstance();
    const game = "game-batch";

    db.applyPlayerMutations(game, [
      { action: "joined", playerAddress: "player-a", ticketIndex: 0 },
      { action: "joined", playerAddress: "player-b", ticketIndex: 1 },
      { action: "joined", playerAddress: "player-c", ticketIndex: 2 },
    ]);

    expect(db.getGamePlayers(game)).toEqual(["player-a", "player-b", "player-c"]);

    db.applyPlayerMutations(game, [
      { action: "unjoined", ticketIndex: 1 },
      { action: "joined", playerAddress: "player-d", ticketIndex: 1 },
      { action: "unjoined", ticketIndex: 0 },
    ]);

    expect(db.getGamePlayers(game)).toEqual(["player-d", "player-c"]);
  });

  it("reports connection info and reopens after close", () => {
    const db = OracleDatabase.getInstance();

    const info = db.getConnectionInfo();
    expect(info.file).toBe(testEnv.tempDb.path);
    expect(info.isOpen).toBe(true);

    db.close();
    expect(db.getConnectionInfo().isOpen).toBe(false);

    const reopened = OracleDatabase.getInstance();
    expect(reopened).not.toBe(db);
    expect(reopened.getConnectionInfo().isOpen).toBe(true);
    expect(reopened.getConnectionInfo().file).toBe(testEnv.tempDb.path);
  });

  it("ensures tracking indexes exist for scans and cleanup", () => {
    const db = OracleDatabase.getInstance();
    const sqlite = (db as any).db;

    const indexes = sqlite
      .query("PRAGMA index_list('game_tracking')")
      .all() as Array<{ name: string }>;
    const names = indexes.map((entry) => entry.name);

    expect(names).toContain("idx_tracking_pending");
    expect(names).toContain("idx_tracking_completed_at");
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
      expect(db.cleanupOldRecords(-1)).toEqual({
        deletedSecrets: 0,
        deletedGames: 0,
        deletedPlayers: 0,
      });
    } finally {
      (db as any).db = originalHandle;
    }
  });
});

describe("finalizeCompletedGame", () => {
  it("runs atomically", () => {
    const db = OracleDatabase.getInstance();
    const gameAddress = "atomic-game";

    db.saveSecretKey(gameAddress, "aa".repeat(32), "bb".repeat(32));
    db.trackGame(gameAddress);
    db.addPlayerToGame(gameAddress, "player-a", 0);
    db.addPlayerToGame(gameAddress, "player-b", 1);

    const markSpy = spyOn(db, "markGameCompleted").mockImplementation(() => {
      throw new Error("forced failure");
    });

    try {
      expect(() => db.finalizeCompletedGame(gameAddress)).toThrow(
        `Failed to finalize completed game ${gameAddress}`
      );
      expect(db.getSecretKey(gameAddress)).not.toBeNull();
      expect(
        db
          .getPendingGames(Number.POSITIVE_INFINITY)
          .some((entry) => entry.game_address === gameAddress)
      ).toBe(true);
      expect(db.getGamePlayers(gameAddress)).toHaveLength(2);
    } finally {
      markSpy.mockRestore();
    }

    db.finalizeCompletedGame(gameAddress);
    expect(db.getSecretKey(gameAddress)).toBeNull();
    expect(
      db
        .getPendingGames(Number.POSITIVE_INFINITY)
        .some((entry) => entry.game_address === gameAddress)
    ).toBe(false);
    expect(db.getGamePlayers(gameAddress)).toEqual([]);
  });
});
