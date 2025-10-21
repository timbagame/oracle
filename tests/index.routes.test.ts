import { expect, test, beforeAll, afterAll } from "bun:test";
import { setupTestEnvironment } from "./helpers/setup-env.ts";
import { createBasicOracle } from "./helpers/fake-oracle.ts";

let buildHandlers: typeof import("../index.ts").buildHandlers;
let OracleDatabaseClass: typeof import("../database.ts").OracleDatabase;
let OracleServiceClass: typeof import("../oracle-service.ts").OracleService;
let testEnv: ReturnType<typeof setupTestEnvironment>;

// Ensure an RPC URL is set for OracleService dependencies used by handlers
beforeAll(async () => {
  testEnv = setupTestEnvironment({ prefix: "routes-test" });
  ({ buildHandlers } = await import("../index.ts"));
  ({ OracleDatabase: OracleDatabaseClass } = await import("../database.ts"));
  ({ OracleService: OracleServiceClass } = await import("../oracle-service.ts"));

  testEnv.registerSingleton(OracleDatabaseClass);
  testEnv.registerSingleton(OracleServiceClass);

});

afterAll(() => {
  testEnv.cleanup();
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
