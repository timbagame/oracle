import { test, expect } from "bun:test";
import { buildFetchRouter, buildHandlers } from "../index.ts";
import { createWebGameApi } from "../web-api/api.ts";
import {
  address,
  getBase64Encoder,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
  getAddressEncoder,
} from "@solana/kit";
import { PROGRAM_ID, getGamePDA } from "../web-api/program.ts";
import { contractVersion } from "../web-api/contract-version.ts";
import type { OracleRpc } from "../solana-kit.ts";

// No production accounts or endpoints are used by these tests.
function api() {
  return createWebGameApi(
    {
      getProgramId: () => PROGRAM_ID,
      getConnection: () => ({}) as OracleRpc,
      getTokenPolicies: async () => [],
      generateGameSecrets: async () => {
        throw new Error("unexpected secret generation");
      },
      signGameTransaction: async () => {
        throw new Error("unexpected signing");
      },
    },
    {
      getVerifiedGame: () => null,
      saveVerifiedGame: () => {
        throw new Error("unexpected write");
      },
    },
  );
}

test("web endpoints require authentication and use a shared verification rate bucket", async () => {
  let calls = 0;
  const router = buildFetchRouter({} as ReturnType<typeof buildHandlers>, {
    apiToken: "synthetic-token",
    handleWebGameRequest: async () => {
      calls++;
      return Response.json({ ok: true });
    },
  });
  expect((await router(new Request("http://oracle/web/config"))).status).toBe(401);
  for (let i = 0; i < 10; i++)
    expect(
      (
        await router(
          new Request(`http://oracle/web/verification/${i}`, {
            headers: { authorization: "Bearer synthetic-token" },
          }),
        )
      ).status,
    ).toBe(200);
  expect(
    (
      await router(
        new Request("http://oracle/web/verification/next", {
          headers: { authorization: "Bearer synthetic-token" },
        }),
      )
    ).status,
  ).toBe(429);
  expect(calls).toBe(10);
});

test("rejects invalid and oversized preparation requests before RPC/signing", async () => {
  const handler = api();
  const request = (body: string) =>
    new Request("http://oracle/web/games/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  expect((await handler(request("{}"))).status).toBe(400);
  expect((await handler(request(" ".repeat(4097)))).status).toBe(400);
  expect((await handler(new Request("http://oracle/web/verification/invalid"))).status).toBe(400);
  expect((await handler(new Request("http://oracle/web/games/invalid"))).status).toBe(400);
  expect(
    (
      await handler(
        new Request(`http://oracle/web/unknown/${address("11111111111111111111111111111111")}`),
      )
    ).status,
  ).toBe(404);
});

test("prepares a creator-funded transaction through the oracle API", async () => {
  const creator = address("HGBiGfyR9GF36J4SMPjxsRkFuwYNuNYuzdCjgR4aw4FC");
  const operator = address("4oRdwjBqMGjhh5octi4BLvtNGCgWdJDMv3bBr9Jpi5V8");
  const token = address("So11111111111111111111111111111111111111112");
  const randomHash = Buffer.alloc(32, 7);
  const gameAddress = await getGamePDA(randomHash);
  const account = Buffer.alloc(58);
  const { GAME_TOKEN_DISCRIMINATOR } = await import("@timbagame/protocol/contracts/v0.2.0/kit");
  account.set(GAME_TOKEN_DISCRIMINATOR);
  account.set(getAddressEncoder().encode(token), 8);
  account[40] = 1;
  account[57] = 1;
  account.writeBigUInt64LE(1n, 41);
  const mint = Buffer.alloc(82);
  mint[44] = 9;
  mint[45] = 1;
  const rpc = {
    getAccountInfo: () => ({
      send: async () => ({
        context: { slot: 1n },
        value: {
          data: [account.toString("base64"), "base64"],
          owner: PROGRAM_ID,
          lamports: 1n,
          executable: false,
          space: 58n,
        },
      }),
    }),
    getMultipleAccounts: () => ({
      send: async () => ({
        context: { slot: 1n },
        value: [
          {
            data: [mint.toString("base64"), "base64"],
            owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            lamports: 1n,
            executable: false,
            space: 82n,
          },
        ],
      }),
    }),
    getLatestBlockhash: () => ({
      send: async () => ({
        value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100n },
      }),
    }),
  } as unknown as OracleRpc;
  const handler = createWebGameApi(
    {
      getConnection: () => rpc,
      getProgramId: () => PROGRAM_ID,
      getTokenPolicies: async () => [
        {
          mint: token,
          enabled: true,
          minimumAmountRaw: "1",
          acceptedMinimumAmountRaw: "1",
          revision: 1,
          effectiveAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      generateGameSecrets: async () => ({
        randomHash: randomHash.toString("hex"),
        gameAddress,
        oracleOperator: operator,
      }),
      signGameTransaction: async () => {
        throw new Error("Must not sign before the creator");
      },
    },
    { getVerifiedGame: () => null, saveVerifiedGame: () => {} },
  );
  const response = await handler(
    new Request("http://oracle/web/games/prepare", {
      method: "POST",
      headers: { "content-type": "application/json", "x-timba-contract-version": contractVersion },
      body: JSON.stringify({
        creator,
        tokenMint: token,
        type: "coinflip",
        amount: "1000000",
        minPlayers: 2,
        maxPlayers: 2,
        timeoutSeconds: 600,
      }),
    }),
  );
  if (response.status !== 200) throw new Error(await response.text());
  expect(response.status).toBe(200);
  const result = (await response.json()) as {
    txBase64: string;
    gameAddress: string;
    lastValidBlockHeight: number;
  };
  expect(result.gameAddress).toBe(gameAddress);
  expect(result.lastValidBlockHeight).toBe(100);
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(result.txBase64));
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  expect(message.staticAccounts[0]).toBe(creator);
  expect(Object.keys(tx.signatures)).toContain(operator);
});
