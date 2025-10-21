import { expect, test, beforeAll, afterAll } from "bun:test";
import { createTempDatabaseFile, type TempDatabaseFile } from "./helpers/test-db.ts";
import { createBasicOracle } from "./helpers/fake-oracle.ts";

let buildHandlers: typeof import("../index.ts").buildHandlers;
let OracleDatabaseClass: typeof import("../database.ts").OracleDatabase;
let OracleServiceClass: typeof import("../oracle-service.ts").OracleService;
let tempDb: TempDatabaseFile;

// Ensure an RPC URL is set for OracleService dependencies used by handlers
beforeAll(async () => {
  process.env["NODE_ENV"] = "test";
  process.env["SOLANA_NETWORK"] = process.env["SOLANA_NETWORK"] || "http://localhost";
  tempDb = createTempDatabaseFile("routes-test");
  process.env["DATABASE_FILE"] = tempDb.path;

  ({ buildHandlers } = await import("../index.ts"));
  ({ OracleDatabase: OracleDatabaseClass } = await import("../database.ts"));
  ({ OracleService: OracleServiceClass } = await import("../oracle-service.ts"));
  // Reset DB singleton to ensure isolated file
  (OracleDatabaseClass as any).instance = undefined;
  (OracleServiceClass as any).instance = undefined;

});

afterAll(() => {
  try {
    OracleDatabaseClass.getInstance().close();
  } catch {
    // ignore
  }
  (OracleDatabaseClass as any).instance = undefined;
  (OracleServiceClass as any).instance = undefined;
  tempDb.cleanup();
  delete process.env["DATABASE_FILE"];
});

test("GET / returns API HTML and unknown endpoints 404", async () => {
  const { handleHealth, handleStats } = buildHandlers(
    createBasicOracle({
      generateGameSecrets: () => ({ randomHash: "abcd", gameAddress: "addr" }),
    })
  );

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
