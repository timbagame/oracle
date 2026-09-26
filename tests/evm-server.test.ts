import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Hex } from "viem";
import { createEvmRouter } from "../evm/server.ts";
import { createFakeEvmService, fakeGame, TOKEN } from "./helpers/evm-fixtures.ts";

const TOKEN_SECRET = "router-token";
const gameId = `0x${"5a".repeat(32)}` as Hex;

let fake: ReturnType<typeof createFakeEvmService> | undefined;
afterEach(() => {
  fake?.restore();
  fake = undefined;
});

function setup() {
  fake = createFakeEvmService();
  const router = createEvmRouter(fake.service, TOKEN_SECRET);
  const call = (path: string, init: RequestInit = {}) =>
    router(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: { authorization: `Bearer ${TOKEN_SECRET}`, ...init.headers },
      }),
    );
  return { ...fake, call };
}

function insertCreated(
  store: ReturnType<typeof createFakeEvmService>["store"],
  block: number,
  id: string,
) {
  store.db
    .query("INSERT INTO events VALUES (?,?,?,?)")
    .run(
      block,
      `0x${block.toString(16).padStart(64, "0")}`,
      0,
      JSON.stringify({ event: { kind: "created", reference: { gameId: id }, isPrivate: false } }),
    );
}

describe("createEvmRouter", () => {
  test("serves public deployment config with the live settlement buffer", async () => {
    const { call, chain } = setup();

    const response = await call("/evm/config");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      chainId: 31337,
      address: "0x1111111111111111111111111111111111111111",
      version: "0.1.0",
      tokens: [{ address: TOKEN, symbol: "TEST", decimals: 18, minimumAmount: "100" }],
      confirmations: 2,
      buffer: chain.limits[1],
    });
  });

  test("reports health as degraded until a cycle has run recently", async () => {
    const { call, service } = setup();

    expect((await call("/evm/health")).status).toBe(503);
    service.lastCycleAt = Date.now();
    const response = await call("/evm/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "healthy",
      error: null,
      pendingTransaction: null,
    });
  });

  test("reports the journaled settlement transaction in health", async () => {
    const { call, service, store } = setup();
    service.lastCycleAt = Date.now();
    store.submit({ game: gameId, raw: "0xab", hash: gameId });

    expect(await (await call("/evm/health")).json()).toMatchObject({
      status: "healthy",
      pendingTransaction: gameId,
    });
  });

  test("lists indexed events", async () => {
    const { call, store } = setup();
    insertCreated(store, 1, gameId);

    const body = (await (await call("/evm/events")).json()) as { events: unknown[] };

    expect(body.events).toEqual([
      { event: { kind: "created", reference: { gameId }, isPrivate: false } },
    ]);
  });

  test("pages public games with their on-chain state", async () => {
    const { call, store, chain } = setup();
    const ids = Array.from(
      { length: 21 },
      (_, index) => `0x${(index + 1).toString(16).padStart(64, "0")}`,
    );
    ids.forEach((id, index) => {
      insertCreated(store, index + 1, id);
      chain.games.set(id, fakeGame({ minPlayers: index + 1 }));
    });

    const first = (await (await call("/evm/games")).json()) as {
      games: Array<{ id: string; game: { minPlayers: number } }>;
      nextOffset: number | null;
    };
    const second = (await (await call("/evm/games?offset=20")).json()) as typeof first;

    expect(first.games).toHaveLength(20);
    expect(first.games[0]).toMatchObject({ id: ids[20]!, game: { minPlayers: 21 } });
    expect(first.nextOffset).toBe(20);
    expect(second.games.map((game) => game.id)).toEqual([ids[0]!]);
    expect(second.nextOffset).toBeNull();
  });

  test("rejects malformed game list queries", async () => {
    const { call } = setup();

    expect((await call("/evm/games?offset=-1")).status).toBe(400);
    expect((await call("/evm/games?offset=01")).status).toBe(400);
    expect((await call("/evm/games?player=alice")).status).toBe(400);
  });

  test("serves a single game with its events", async () => {
    const { call, store, chain } = setup();
    insertCreated(store, 1, gameId);
    chain.games.set(gameId, fakeGame({ maxPlayers: 4 }));

    const body = (await (await call(`/evm/games/${gameId}`)).json()) as {
      game: { maxPlayers: number };
      events: unknown[];
    };

    expect(body.game.maxPlayers).toBe(4);
    expect(body.events).toHaveLength(1);
  });

  test("returns 404 for unknown routes and methods", async () => {
    const { call } = setup();

    expect((await call("/evm/unknown")).status).toBe(404);
    expect((await call("/evm/authorize")).status).toBe(404);
  });

  test("forwards authorization and invitation bodies to the service", async () => {
    const { call, service } = setup();
    const authorize = spyOn(service, "authorize").mockResolvedValue({
      gameId,
      request: { ok: true },
      signature: "0x12",
    });
    const privateJoin = spyOn(service, "privateJoin").mockResolvedValue({
      deadline: "5",
      signature: "0x34",
    });

    try {
      const authorized = await call("/evm/authorize", {
        method: "POST",
        body: JSON.stringify({ creator: "a" }),
      });
      const joined = await call("/evm/private-join", {
        method: "POST",
        body: JSON.stringify({ player: "b" }),
      });

      expect(await authorized.json()).toEqual({ gameId, request: { ok: true }, signature: "0x12" });
      expect(authorize).toHaveBeenCalledWith({ creator: "a" });
      expect(await joined.json()).toEqual({ deadline: "5", signature: "0x34" });
      expect(privateJoin).toHaveBeenCalledWith({ player: "b" });
    } finally {
      authorize.mockRestore();
      privateJoin.mockRestore();
    }
  });

  test("hides service errors behind a generic rejection", async () => {
    const { call, service } = setup();
    const authorize = spyOn(service, "authorize").mockRejectedValue(new Error("secret detail"));

    try {
      const response = await call("/evm/authorize", { method: "POST", body: "{}" });

      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("secret detail");
    } finally {
      authorize.mockRestore();
    }
  });

  test("returns 503 when a read route fails", async () => {
    const { call, chain } = setup();
    chain.games.clear();

    const response = await call(`/evm/games/${gameId}`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "EVM service temporarily unavailable" });
  });

  test("rate limits bursts above thirty requests per second", async () => {
    const { call } = setup();
    const now = spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    try {
      const statuses: number[] = [];
      for (let index = 0; index < 31; index++) statuses.push((await call("/evm/events")).status);

      expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
      expect(statuses[30]).toBe(429);
      now.mockReturnValue(1_700_000_001_000);
      expect((await call("/evm/events")).status).toBe(200);
    } finally {
      now.mockRestore();
    }
  });
});
