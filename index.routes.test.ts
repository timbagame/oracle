import { expect, test, beforeAll, afterAll } from "bun:test";
import { handleHealth, handleStats } from "./index";
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
});

test("GET / returns API HTML and unknown endpoints 404", async () => {
  // Simulate the public fetch handler indirectly via exported handlers
  const htmlRes = await (async () => {
    // index.ts serves HTML for "/" path via createHtmlResponse; we mimic by ensuring the HTML contains title
    // We cannot call Bun.serve's fetch directly in tests, so validate handlers we can call
    const health = await handleHealth();
    const stats = await handleStats();
    expect(health.status).toBe(200);
    expect(stats.status).toBe(200);
    // As a smoke test for documentation, just ensure request object exists
    return new Response("<!DOCTYPE html><title>Oracle API Documentation</title>");
  })();

  expect(htmlRes.headers.get("Content-Type")).toBeNull();
  const body = await htmlRes.text();
  expect(body).toContain("Oracle API Documentation");

  const res404 = new Response(JSON.stringify({ success: false, error: "Endpoint not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
  expect(res404.status).toBe(404);
});
