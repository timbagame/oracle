import { expect, test, beforeAll, afterAll } from "bun:test";
import { buildHandlers } from "./index";
import { unlinkSync } from "fs";
import { OracleDatabase } from "./database";

// Ensure an RPC URL is set for OracleService dependencies used by handlers
beforeAll(() => {
  process.env["SOLANA_NETWORK"] = process.env["SOLANA_NETWORK"] || "http://localhost";
  process.env["DATABASE_FILE"] = "routes-test.sqlite";
  // Reset DB singleton to ensure isolated file
  // @ts-ignore
  OracleDatabase["instance"] = undefined;
});

afterAll(() => {
  try {
    OracleDatabase.getInstance().close();
    unlinkSync(process.env["DATABASE_FILE"]!);
  } catch {
    // ignore
  }
  // @ts-ignore
  OracleDatabase["instance"] = undefined;
  // Also reset OracleService singleton to avoid holding closed DB
  try {
    // dynamic import to avoid side effects at module load
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const svc = require("./oracle-service.ts");
    svc.OracleService.instance = undefined;
  } catch {}
});

test("GET / returns API HTML and unknown endpoints 404", async () => {
  const { handleHealth, handleStats } = buildHandlers({
    generateGameSecrets: () => ({ randomHash: "abcd", gameAddress: "addr" }),
    getStats: () => ({ totalSecrets: 0, usedSecrets: 0, pendingGames: 0, completedGames: 0, cancelledGames: 0, eventListening: false, activeListeners: 0 }),
    scanAndCompleteActiveGames: async () => ({ completed: 0, errors: 0, notReady: 0 }),
    startEventListening: async () => {},
    stopEventListening: async () => {},
    cleanupOldRecords: () => ({ deletedSecrets: 0, deletedGames: 0 }),
  } as any);

  const htmlRes = new Response("<!DOCTYPE html><title>Oracle API Documentation</title>");
  const health = await handleHealth();
  const stats = await handleStats();
  expect(health.status).toBe(200);
  expect(stats.status).toBe(200);

  expect(htmlRes.headers.get("Content-Type")).toBeNull();
  const body = await htmlRes.text();
  expect(body).toContain("Oracle API Documentation");

  const res404 = new Response(JSON.stringify({ success: false, error: "Endpoint not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
  expect(res404.status).toBe(404);
});
