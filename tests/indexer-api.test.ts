import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { getBase58Decoder } from "@solana/kit";
import { Keypair } from "./helpers/solana-fixtures.ts";
import { IndexerDatabase } from "../indexer/database.ts";
import { createIndexerApi } from "../indexer/api.ts";
import { logger } from "../logger.ts";
import type { IndexedEvents } from "../indexer/types.ts";

const databases: IndexerDatabase[] = [];
const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
  for (const database of databases.splice(0)) database.close();
});

const key = () => Keypair.generate().publicKey.toBase58();
const signatureFor = (seed: number) =>
  getBase58Decoder().decode(new Uint8Array(64).fill((seed % 250) + 1));

/**
 * One completed coinflip, one cancelled giveaway and one still-open private game,
 * all sharing a creator and a player so every player view has data.
 */
function seededApi(apiKey: string | null = null) {
  const database = new IndexerDatabase(":memory:", { cacheRebuildIntervalMs: 0 });
  databases.push(database);
  const now = Math.floor(Date.now() / 1000);
  const creator = key();
  const player = key();
  const mint = key();
  const completed = key();
  const cancelled = key();
  const active = key();
  const initialized = (gameKey: string, seed: number, extra: Record<string, unknown> = {}) => ({
    signature: signatureFor(seed),
    slot: seed,
    gameKey,
    creator,
    gameType: "coinflip" as const,
    ticketAmount: 100,
    totalAmount: 0,
    maxTickets: 2,
    minTickets: 2,
    tokenMint: mint,
    isPrivate: false,
    createdAt: now - 100,
    timeout: 3_600,
    ...extra,
  });
  const joined = (gameKey: string, seed: number, who: string, index: number) => ({
    kind: "joined" as const,
    signature: signatureFor(seed),
    slot: seed,
    gameKey,
    player: who,
    ticketsCount: index + 1,
    ticketIndex: index,
    timestamp: now - 90 + seed,
  });
  const events: IndexedEvents = {
    initialized: [
      initialized(completed, 1),
      initialized(cancelled, 2, { gameType: "giveaway", totalAmount: 500, minTickets: 1 }),
      initialized(active, 3, { isPrivate: true }),
    ],
    membership: [
      joined(completed, 4, creator, 0),
      joined(completed, 5, player, 1),
      joined(active, 6, player, 0),
    ],
    completed: [
      {
        signature: signatureFor(7),
        slot: 7,
        gameKey: completed,
        winner: player,
        winnerAmount: 190,
        feeAmount: 10,
        ticketsCount: 2,
        timestamp: now - 50,
      },
    ],
    closed: [{ signature: signatureFor(8), slot: 8, gameKey: cancelled, timestamp: now - 40 }],
  };
  database.apply(events, { signature: signatureFor(8), slot: 8 });
  database.flushCaches({ force: true });
  const api = createIndexerApi(database, apiKey);
  const get = async (path: string) => {
    const response = await api(new Request(`http://oracle/indexer${path}`));
    return { response, body: (await response.json()) as any };
  };
  return { database, api, get, creator, player, mint, completed, cancelled, active };
}

describe("indexer API", () => {
  test("reports health", async () => {
    const { get } = seededApi();

    const { response, body } = await get("/health");

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
  });

  test("lists completed games with paging metadata", async () => {
    const { get, completed, player, mint } = seededApi();

    const { response, body } = await get(`/api/games?limit=10&offset=0&tokenMint=${mint}`);

    expect(response.headers.get("Cache-Control")).toBe("public, max-age=5");
    expect(body).toMatchObject({ total: 1, page: 1, limit: 10 });
    expect(body.games).toEqual([
      expect.objectContaining({
        gameKey: completed,
        winner: player,
        winnerAmount: 190,
        feeAmount: 10,
        tokenMint: mint,
        priceUsd: null,
      }),
    ]);
  });

  test("lists latest completed games in the compact format", async () => {
    const { get, completed } = seededApi();

    const { body } = await get("/api/games/latest?limit=5");

    expect(body).toEqual([
      expect.objectContaining({
        gameKey: completed,
        status: "completed",
        creator: null,
        expiresAt: null,
      }),
    ]);
  });

  test("lists latest lifecycle entries filtered by token and game type", async () => {
    const { get, cancelled, mint } = seededApi();

    const { body } = await get(
      `/api/games/latest?limit=5&includeLifecycle=1&gameType=giveaway&tokenMint=${mint}`,
    );

    expect(body).toEqual([
      expect.objectContaining({ gameKey: cancelled, status: "cancelled", gameType: "giveaway" }),
    ]);
    expect(body[0].expiresAt).toBe(body[0].createdAt + body[0].timeout);
  });

  test("serves one game by key and 404s unknown games", async () => {
    const { get, completed, player } = seededApi();

    const found = await get(`/api/games/by-key?gameKey=${completed}`);
    const missing = await get(`/api/games/by-key?gameKey=${key()}`);

    expect(found.body).toMatchObject({
      gameKey: completed,
      status: "completed",
      winner: player,
      isPrivate: false,
    });
    expect(found.response.headers.get("Cache-Control")).toBe(
      "public, max-age=2, stale-while-revalidate=2",
    );
    expect(missing.response.status).toBe(404);
    expect(missing.body).toEqual({ error: "Game not found" });
  });

  test("lists tokens with the number of games created in each", async () => {
    const { get, mint } = seededApi();

    const { body } = await get("/api/tokens");

    expect(body.tokens).toEqual([
      expect.objectContaining({ tokenMint: mint, games: 3, priceUsd: null }),
    ]);
  });

  test("lists open games and a player's open games", async () => {
    const { get, active, player, creator } = seededApi();

    const all = await get("/api/active-games");
    const mine = await get(`/api/my-active-games?player=${player}`);
    const stranger = await get(`/api/my-active-games?player=${key()}`);

    expect(all.body.count).toBe(1);
    expect(all.body.games[0]).toMatchObject({ game_key: active, creator, isPrivate: true });
    expect(all.body.games[0].timeLeft).toBeGreaterThan(0);
    expect(all.body.games[0]).not.toHaveProperty("tokenMint");
    expect(mine.body.games.map((game: { game_key: string }) => game.game_key)).toEqual([active]);
    expect(stranger.body).toEqual({ games: [], count: 0 });
  });

  test("rejects a player lookup without a player", async () => {
    const { get } = seededApi();

    const { response, body } = await get("/api/my-active-games");

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: "Invalid query parameters" });
  });

  test("lists a player's games with their role in each", async () => {
    const { get, player, completed, active } = seededApi();

    const { body } = await get(`/api/player-games?player=${player}&limit=10&offset=0`);

    expect(body).toMatchObject({ count: 2, limit: 10, offset: 0 });
    const byKey = Object.fromEntries(
      body.games.map((game: { gameKey: string }) => [game.gameKey, game]),
    );
    expect(byKey[completed]).toMatchObject({ isCreator: false, isPlayer: true, isJoined: true });
    expect(byKey[active]).toMatchObject({ status: "active", isPlayer: true });
  });

  test("builds a player profile with wins, tokens and frequent opponents", async () => {
    const { get, player, creator, mint } = seededApi();

    const { body } = await get(`/api/player-profile?player=${player}`);

    expect(body.wallet).toBe(player);
    expect(body.summary).toMatchObject({
      relatedGames: 2,
      playedGames: 2,
      completedGames: 1,
      activeGames: 1,
      wins: 1,
      losses: 0,
    });
    expect(body.summary.lastActivity).toEqual(expect.any(Number));
    expect(body.tokens).toEqual([
      expect.objectContaining({ tokenMint: mint, gamesPlayed: 2, wonAmount: 190 }),
    ]);
    expect(body.frequentPlayers).toEqual([{ player: creator, gamesTogether: 1 }]);
    expect(body.historyComplete).toBe(false);
  });

  test("returns an empty profile for an unknown wallet", async () => {
    const { get } = seededApi();
    const wallet = key();

    const { body } = await get(`/api/player-profile?player=${wallet}`);

    expect(body.summary).toMatchObject({ relatedGames: 0, wins: 0, lastActivity: null });
    expect(body.tokens).toEqual([]);
  });

  test("attaches live USD prices when a Jupiter key is configured", async () => {
    const { get, mint } = seededApi("jupiter-key");
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
      Response.json({ [mint]: { usdPrice: 2.5 } })) as unknown as typeof fetch);
    restores.push(() => fetchSpy.mockRestore());

    const { body } = await get("/api/stats");

    expect(body.financials).toEqual([expect.objectContaining({ tokenMint: mint, priceUsd: 2.5 })]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("rejects non-GET requests, bad queries and unknown endpoints", async () => {
    const { api, get } = seededApi();

    const post = await api(new Request("http://oracle/indexer/health", { method: "POST" }));
    expect(post.status).toBe(405);
    expect((await get("/api/games?limit=abc")).response.status).toBe(400);
    expect((await get("/api/stats?tokenMint=%20")).response.status).toBe(400);
    expect((await get("/api/games/latest?limit=-1")).response.status).toBe(400);
    expect((await get("/api/games/by-key")).response.status).toBe(400);
    expect((await get("/api/leaderboard?period=year")).response.status).toBe(400);
    expect((await get("/api/player-games")).response.status).toBe(400);
    expect((await get("/api/player-profile")).response.status).toBe(400);
    const unknown = await get("/api/nope");
    expect(unknown.response.status).toBe(404);
    expect(unknown.body).toEqual({ error: "Endpoint not found" });
  });

  test("hides database failures behind a 500", async () => {
    const { database, get } = seededApi();
    const failure = spyOn(logger, "failure").mockImplementation(() => {});
    const tokens = spyOn(database, "getTokens").mockImplementation(() => {
      throw new Error("disk I/O error");
    });
    restores.push(
      () => failure.mockRestore(),
      () => tokens.mockRestore(),
    );

    const { response, body } = await get("/api/tokens");

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "Internal server error" });
    expect(failure).toHaveBeenCalledWith("Indexer API failed for /api/tokens:", expect.any(Error));
  });
});
