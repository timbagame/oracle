import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { initialize, shutdown } from "../index.ts";

let exitBackup: any;

beforeAll(() => {
  process.env["NODE_ENV"] = "test";
  // stub exit to avoid terminating runner
  exitBackup = (process as any).exit;
  (process as any).exit = () => {};
});

afterAll(() => {
  (process as any).exit = exitBackup;
});

describe("lifecycle helpers", () => {
  it("initialize resolves and logs even on failure", async () => {
    await initialize({
      // success path
      startEventListening: async () => {},
      stopEventListening: async () => {},
      scanAndCompleteActiveGames: async () => ({ completed: 0, errors: 0, notReady: 0 }),
      generateGameSecrets: () => ({ randomHash: "", gameAddress: "" }),
      getStats: () => ({ totalSecrets: 0, usedSecrets: 0, pendingGames: 0, completedGames: 0, cancelledGames: 0 }),
      cleanupOldRecords: () => ({ deletedSecrets: 0, deletedGames: 0 }),
    } as any);

    await initialize({
      // failure path: should be caught internally
      startEventListening: async () => {
        throw new Error("boom");
      },
      stopEventListening: async () => {},
      scanAndCompleteActiveGames: async () => ({ completed: 0, errors: 0, notReady: 0 }),
      generateGameSecrets: () => ({ randomHash: "", gameAddress: "" }),
      getStats: () => ({ totalSecrets: 0, usedSecrets: 0, pendingGames: 0, completedGames: 0, cancelledGames: 0 }),
      cleanupOldRecords: () => ({ deletedSecrets: 0, deletedGames: 0 }),
    } as any);
  });

  it("shutdown stops listeners and does not exit in tests", async () => {
    let stopped = false;
    await shutdown({
      startEventListening: async () => {},
      stopEventListening: async () => {
        stopped = true;
      },
      scanAndCompleteActiveGames: async () => ({ completed: 0, errors: 0, notReady: 0 }),
      generateGameSecrets: () => ({ randomHash: "", gameAddress: "" }),
      getStats: () => ({ totalSecrets: 0, usedSecrets: 0, pendingGames: 0, completedGames: 0, cancelledGames: 0 }),
      cleanupOldRecords: () => ({ deletedSecrets: 0, deletedGames: 0 }),
    } as any, "SIGINT");
    expect(stopped).toBe(true);
  });
});

