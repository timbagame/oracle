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

test("indexed game discovery excludes private games from public lists", () => {
  const store = new EvmStore(":memory:", "test");
  // Use the real event envelope; only indexed games can be discovered.
  const insert = (block: number, event: unknown) =>
    store.db
      .query("INSERT INTO events VALUES (?,?,?,?)")
      .run(block, `hash${block}`, 0, JSON.stringify({ event }));
  insert(1, {
    kind: "created",
    reference: { gameId: "0x1111" },
    creator: "alice",
    isPrivate: false,
  });
  insert(2, { kind: "created", reference: { gameId: "0x2222" }, creator: "bob", isPrivate: true });
  insert(3, { kind: "joined", reference: { gameId: "0x2222" }, player: "alice" });
  expect(store.listedGameIds(0)).toEqual(["0x1111"]);
  expect(store.listedGameIds(0, "alice")).toEqual(["0x2222", "0x1111"]);
  expect(store.listedGameIds(0, "stranger")).toEqual([]);
  store.resetIndex();
  expect(store.listedGameIds(0, "alice")).toEqual([]);
  store.close();
});

test("failed settlement rebroadcast degrades health without discarding pending bytes", async () => {
  const { spyOn } = await import("bun:test");
  const { TransactionReceiptNotFoundError } = await import("viem");
  const { EvmService } = await import("../evm/service.ts");
  const store = new EvmStore(":memory:", "health-test");
  const service = new EvmService(
    {
      chainId: 31337,
      address: `0x${"11".repeat(20)}`,
      version: "0.1.0",
      rpcUrls: ["http://127.0.0.1:1"],
      startBlock: "0",
      confirmations: 2,
      pollMs: 250,
      database: ":memory:",
      operatorKeyFile: "unused",
      apiTokenFile: "unused",
      port: 3002,
      tokens: [
        { address: `0x${"22".repeat(20)}`, symbol: "TEST", decimals: 18, minimumAmount: "1" },
      ],
    },
    `0x${"1".padStart(64, "0")}`,
    store,
  );
  const pending = { game: id, raw: "0xab" as const, hash: id };
  store.submit(pending);
  const deployment = spyOn(service, "validateDeployment").mockResolvedValue(undefined);
  const index = spyOn(service, "index").mockResolvedValue(undefined);
  const receipt = spyOn(service.publicClient, "getTransactionReceipt").mockRejectedValue(
    new TransactionReceiptNotFoundError({ hash: id }),
  );
  const send = spyOn(service.publicClient, "sendRawTransaction").mockRejectedValue(
    new Error("secret RPC URL"),
  );
  const router = createEvmRouter(service, "test-token");
  const health = () =>
    router(
      new Request("http://localhost/evm/health", {
        headers: { authorization: "Bearer test-token" },
      }),
    );
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(service.tick()).rejects.toThrow();
      expect(store.pending()).toEqual(pending);
      const response = await health();
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(body).toContain("durable work retained");
      expect(body).not.toContain("secret RPC URL");
    }
    send.mockResolvedValue(id);
    await service.tick();
    expect(store.pending()).toEqual(pending);
    expect((await health()).status).toBe(200);
    expect(send).toHaveBeenLastCalledWith({ serializedTransaction: pending.raw });
  } finally {
    deployment.mockRestore();
    index.mockRestore();
    receipt.mockRestore();
    send.mockRestore();
    store.close();
  }
});
