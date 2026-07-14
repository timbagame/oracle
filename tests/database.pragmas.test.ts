import { beforeAll, afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { rmSync, existsSync } from "fs";
import { Database } from "bun:sqlite";
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
    rmSync(testEnv.tempDb.path + "-wal", { force: true });
    rmSync(testEnv.tempDb.path + "-shm", { force: true });
  } catch {
    // ignore missing file during cleanup
  }
};

beforeAll(async () => {
  const env = await createTestEnv({
    prefix: "oracle-database-pragmas-test",
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

describe("OracleDatabase pragmas", () => {
  it("enables WAL journal mode for better concurrency", () => {
    OracleDatabase.getInstance();

    const external = new Database(testEnv.tempDb.path);
    const row = external.query("PRAGMA journal_mode").get() as
      { journal_mode?: string } | string | null;
    const mode = typeof row === "string" ? row : row?.journal_mode;
    expect((mode ?? "").toLowerCase()).toBe("wal");
    external.close();
  });
});

describe("OracleDatabase shutdown", () => {
  it("checkpoints WAL on close to ensure data persistence", () => {
    const db = OracleDatabase.getInstance();

    // Write some data
    db.saveSecretKey("wal-test-game", "secret-value", "hash-value");
    db.trackGame("wal-test-game");

    // Before close, WAL file may contain uncommitted data
    const walPath = testEnv.tempDb.path + "-wal";

    // Close the database (should checkpoint WAL)
    db.close();

    // WAL file should be truncated or very small after TRUNCATE checkpoint
    // (TRUNCATE mode removes the WAL file contents after checkpoint)
    let walSize = 0;
    if (existsSync(walPath)) {
      const { statSync } = require("fs");
      walSize = statSync(walPath).size;
    }

    // After TRUNCATE checkpoint, WAL should be empty or very small (header only)
    // The header is 32 bytes, so a size <= 32 means WAL was properly checkpointed
    expect(walSize).toBeLessThanOrEqual(32);

    // Verify data was persisted by opening fresh connection
    const verifyDb = new Database(testEnv.tempDb.path, { readonly: true });
    const row = verifyDb
      .query("SELECT secret_key FROM secret_keys WHERE game_address = ?")
      .get("wal-test-game") as { secret_key: string } | null;
    expect(row?.secret_key).toBe("secret-value");
    verifyDb.close();
  });

  it("persists data written immediately before close", () => {
    const db = OracleDatabase.getInstance();

    // Simulate rapid write-then-close scenario (like container shutdown)
    db.saveSecretKey("rapid-close-game", "rapid-secret", "rapid-hash");
    db.trackGame("rapid-close-game", "coinflip");

    // Close immediately after write
    db.close();

    // Reopen and verify data was persisted
    testEnv.resetSingletons();
    const reopened = OracleDatabase.getInstance();

    const secretInfo = reopened.getSecretKeyInfo("rapid-close-game");
    expect(secretInfo).not.toBeNull();
    expect(secretInfo?.secretKey).toBe("rapid-secret");
    expect(reopened.getGameType("rapid-close-game")).toBe("coinflip");
  });

  it("handles checkpoint failure gracefully", () => {
    const db = OracleDatabase.getInstance();
    const internalDb = (db as any).db;

    // Write some data first
    db.saveSecretKey("checkpoint-fail-game", "secret", "hash");

    // Mock the query method to fail on checkpoint
    const originalQuery = internalDb.query;
    let checkpointCalled = false;
    internalDb.query = (sql: string) => {
      if (sql.includes("wal_checkpoint")) {
        checkpointCalled = true;
        throw new Error("checkpoint failed");
      }
      return originalQuery.call(internalDb, sql);
    };

    // Close should not throw even if checkpoint fails
    expect(() => db.close()).not.toThrow();
    expect(checkpointCalled).toBe(true);

    // Restore and verify db is marked as closed
    expect(db.getConnectionInfo().isOpen).toBe(false);
  });

  it("logs success message on clean close", () => {
    const db = OracleDatabase.getInstance();

    // Spy on logger
    const { logger } = require("../logger.ts");
    const infoSpy = spyOn(logger, "info");

    db.saveSecretKey("log-test-game", "secret", "hash");
    db.close();

    // Verify the close message was logged
    const closeLogCall = infoSpy.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes("Database closed successfully"),
    );
    expect(closeLogCall).toBeDefined();
  });
});
