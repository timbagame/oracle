import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { EvmStore } from "../evm/store.ts";
import { intentSchema } from "../evm/service.ts";
import { createEvmRouter } from "../evm/server.ts";
import type { EvmService } from "../evm/service.ts";
const id = `0x${"11".repeat(32)}` as const;
const secret = `0x${"22".repeat(32)}` as const;

test("EVM secrets, pending bytes and database identity survive restart", () => {
  const folder = mkdtempSync(resolve(tmpdir(), "timba-evm-store-"));
  try {
    const path = resolve(folder, "oracle.sqlite");
    const store = new EvmStore(path, "31337:proxy");
    store.save({ id, secret, intent: "terms", request: "first", signature: "0x12" });
    store.save({
      id,
      secret: `0x${"33".repeat(32)}`,
      intent: "changed",
      request: "renewed",
      signature: "0x34",
    });
    store.submit({ game: id, raw: "0xab", hash: id });
    store.close();
    expect(() => new EvmStore(path, "1:proxy")).toThrow("different deployment");
    const restored = new EvmStore(path, "31337:proxy");
    expect(restored.game(id)).toMatchObject({ secret, intent: "changed", request: "renewed" });
    expect(restored.pending()).toEqual({ game: id, raw: "0xab", hash: id });
    restored.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("authorization wire validation rejects overflow, numbers and excessive client limits", () => {
  const valid = {
    creator: `0x${"11".repeat(20)}`,
    token: `0x${"22".repeat(20)}`,
    gameType: 0,
    amount: "1",
    minPlayers: 2,
    maxPlayers: 2,
    timeout: 3600,
    isPrivate: false,
    nonce: "0",
    deadline: "12345",
    proof: "0x12",
  };
  expect(intentSchema.safeParse(valid).success).toBe(true);
  for (const override of [
    { amount: (2n ** 256n).toString() },
    { amount: 1 },
    { amount: "01" },
    { maxPlayers: 101 },
    { timeout: 86401 },
    { secret: "never accepted" },
  ])
    expect(intentSchema.safeParse({ ...valid, ...override }).success).toBe(false);
});

test("all EVM API routes require bearer auth and body limits cannot be bypassed", async () => {
  const router = createEvmRouter({} as EvmService, "test-token");
  expect((await router(new Request("http://localhost/evm/config"))).status).toBe(401);
  expect(
    (
      await router(
        new Request("http://localhost/evm/authorize", {
          method: "POST",
          headers: { authorization: "Bearer test-token" },
          body: "x".repeat(20_000),
        }),
      )
    ).status,
  ).toBe(413);
  expect(
    (
      await router(
        new Request("http://localhost/evm/authorize", {
          method: "POST",
          headers: { authorization: "Bearer test-token" },
          body: "not json",
        }),
      )
    ).status,
  ).toBe(400);
});
