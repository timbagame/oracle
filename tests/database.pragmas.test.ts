import { beforeAll, afterAll, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "fs";
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
    const row = external.query("PRAGMA journal_mode").get() as { journal_mode?: string } | string | null;
    const mode = typeof row === "string" ? row : row?.journal_mode;
    expect((mode ?? "").toLowerCase()).toBe("wal");
    external.close();
  });
});

