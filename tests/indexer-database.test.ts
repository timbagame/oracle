import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Keypair } from "./helpers/solana-fixtures.ts";
import { IndexerDatabase } from "../indexer/database.ts";
import { createIndexerApi } from "../indexer/api.ts";
import type { IndexedEvents } from "../indexer/types.ts";
import { createTempDatabaseFile } from "./helpers/test-db.ts";

const databases: IndexerDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture(options: ConstructorParameters<typeof IndexerDatabase>[1] = {}) {
  const database = new IndexerDatabase(":memory:", options);
  databases.push(database);
  const gameKey = Keypair.generate().publicKey.toBase58();
  const creator = Keypair.generate().publicKey.toBase58();
  const player = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const initializedSignature = "1".repeat(64);
  const completedSignature = `${"1".repeat(63)}2`;
  const events: IndexedEvents = {
    initialized: [
      {
        signature: initializedSignature,
        slot: 10,
        gameKey,
        creator,
        gameType: "coinflip",
        ticketAmount: 100,
        totalAmount: 100,
        maxTickets: 2,
        minTickets: 2,
        tokenMint: mint,
        isPrivate: false,
        createdAt: 1_000,
        timeout: 3_600,
      },
    ],
    membership: [
      {
        kind: "joined",
        signature: initializedSignature,
        slot: 11,
        gameKey,
        player,
        ticketsCount: 1,
        ticketIndex: 0,
        timestamp: 1_001,
      },
    ],
    completed: [
      {
        signature: completedSignature,
        slot: 12,
        gameKey,
        winner: player,
        winnerAmount: 198,
        feeAmount: 2,
        ticketsCount: 2,
        timestamp: 1_002,
      },
    ],
    closed: [],
  };
  return { database, events, gameKey, player, mint, completedSignature };
}

describe("IndexerDatabase", () => {
  test("stores lifecycle data and serves materialized stats without duplicate totals", () => {
    const { database, events, gameKey, player, mint, completedSignature } = fixture();
    database.apply(events, { signature: completedSignature, slot: 12 });
    database.apply(events, { signature: completedSignature, slot: 12 });

    expect(database.getCursor()).toEqual({ signature: completedSignature, slot: 12 });
    expect(database.getStats()).toMatchObject({ totalGames: 1, uniquePlayers: 1 });
    expect(database.getStats().financials).toEqual([
      {
        tokenMint: mint,
        totalVolume: 200,
        totalFees: 2,
        biggestWin: { amount: 198, winner: player, signature: completedSignature },
      },
    ]);
    expect(database.getGame(gameKey)?.status).toBe("completed");
    expect(database.getActiveGames()).toEqual([]);
    expect(database.getPlayerProfile(player).summary).toMatchObject({
      related_games: 1,
      played_games: 1,
      wins: 1,
    });
  });

  test("returns responses compatible with the existing indexer API", async () => {
    const { database, events, completedSignature } = fixture();
    database.apply(events, { signature: completedSignature, slot: 12 });
    const api = createIndexerApi(database, null);
    const response = await api(new Request("http://oracle/indexer/api/stats"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ totalGames: 1, uniquePlayers: 1 });
  });

  test("migrates legacy active membership columns before creating indexes", () => {
    const temporary = createTempDatabaseFile("indexer-legacy-membership");
    try {
      const legacy = new Database(temporary.path, { create: true, strict: true });
      legacy.exec(`
        CREATE TABLE active_game_players (
          game_key TEXT NOT NULL, player TEXT NOT NULL, ticket_index INTEGER NOT NULL,
          joined_at INTEGER NOT NULL, PRIMARY KEY (game_key, player)
        );
        CREATE INDEX idx_active_player ON active_game_players(player);
        INSERT INTO active_game_players VALUES ('game', 'player', 0, 1000);
      `);
      legacy.close();

      const migrated = new IndexerDatabase(temporary.path);
      migrated.close();

      const inspected = new Database(temporary.path, { readonly: true, strict: true });
      expect(
        inspected.query("SELECT is_joined, updated_slot FROM active_game_players").get(),
      ).toEqual({ is_joined: 1, updated_slot: 0 });
      const index = inspected
        .query("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_active_player'")
        .get() as { sql: string } | null;
      expect(index?.sql).toContain("player, is_joined");
      inspected.close();
    } finally {
      temporary.cleanup();
    }
  });

  test("rejects an import until historical player data is complete", () => {
    const { database, events, completedSignature } = fixture();
    database.apply(events, { signature: completedSignature, slot: 12 });

    expect(() => database.assertD1ImportReady()).toThrow("historical backfill is incomplete");
    database.importSql(`
      INSERT INTO historical_backfill
        (name, pages, transactions, initialized_events, closed_events, complete, updated_at)
      VALUES ('game-lifecycle-v3-player-history', 1, 1, 1, 0, 1, 1000)
    `);
    expect(() => database.assertD1ImportReady()).not.toThrow();
  });

  test("throttles cache rebuilds and flushes them once the window passes", () => {
    let now = 1_000_000;
    const { database, events, gameKey, completedSignature } = fixture({
      cacheRebuildIntervalMs: 30_000,
      now: () => now,
    });
    const initializedOnly: IndexedEvents = { ...events, membership: [], completed: [] };
    database.apply(initializedOnly, { signature: events.initialized[0]!.signature, slot: 10 });
    expect(database.hasPendingCacheRebuild()).toBe(false);
    expect(database.msUntilCacheFlush()).toBeNull();
    expect(database.getStats().totalGames).toBe(1);

    now += 1_000;
    const otherKey = Keypair.generate().publicKey.toBase58();
    database.apply(
      {
        ...initializedOnly,
        initialized: [
          { ...events.initialized[0]!, gameKey: otherKey, signature: "3".repeat(64), slot: 13 },
        ],
      },
      { signature: "3".repeat(64), slot: 13 },
    );
    expect(database.hasPendingCacheRebuild()).toBe(true);
    expect(database.msUntilCacheFlush()).toBe(29_000);
    expect(database.getStats().totalGames).toBe(1);
    expect(database.flushCaches()).toBe(false);

    now += 29_000;
    expect(database.msUntilCacheFlush()).toBe(0);
    expect(database.flushCaches()).toBe(true);
    expect(database.flushCaches()).toBe(false);
    expect(database.getStats().totalGames).toBe(2);
    expect(database.hasPendingCacheRebuild()).toBe(false);

    now += 1_000;
    database.apply(events, { signature: completedSignature, slot: 12 });
    expect(database.hasPendingCacheRebuild()).toBe(true);
    expect(database.flushCaches({ force: true })).toBe(true);
    expect(database.getGame(gameKey)?.status).toBe("completed");
    expect(database.getStats().financials).toHaveLength(1);

    now += 30_000;
    database.apply(
      {
        ...initializedOnly,
        initialized: [
          { ...events.initialized[0]!, gameKey: otherKey, signature: "3".repeat(64), slot: 14 },
        ],
      },
      { signature: "3".repeat(64), slot: 14 },
    );
    expect(database.hasPendingCacheRebuild()).toBe(false);
  });

  test("rebuilds after every batch when throttling is disabled", () => {
    const { database, events } = fixture({ cacheRebuildIntervalMs: 0, now: () => 5 });
    const initializedOnly: IndexedEvents = { ...events, membership: [], completed: [] };
    database.apply(initializedOnly, { signature: events.initialized[0]!.signature, slot: 10 });
    database.apply(
      {
        ...initializedOnly,
        initialized: [
          {
            ...events.initialized[0]!,
            gameKey: Keypair.generate().publicKey.toBase58(),
            signature: "4".repeat(64),
          },
        ],
      },
      { signature: "4".repeat(64), slot: 11 },
    );
    expect(database.hasPendingCacheRebuild()).toBe(false);
    expect(database.getStats().totalGames).toBe(2);
  });

  test("ranks windowed leaderboards from recent games and caches them briefly", async () => {
    const nowSeconds = 2_000_000;
    let now = nowSeconds * 1000;
    const { database, events, player, mint } = fixture({
      cacheRebuildIntervalMs: 0,
      leaderboardCacheTtlMs: 30_000,
      now: () => now,
    });
    const other = Keypair.generate().publicKey.toBase58();
    const game = (
      key: string,
      winner: string,
      timestamp: number,
      amount: number,
      slot: number,
    ) => ({
      signature: `${String(slot).padStart(3, "0")}${"5".repeat(61)}`,
      slot,
      gameKey: key,
      winner,
      winnerAmount: amount,
      feeAmount: 1,
      ticketsCount: 2,
      timestamp,
    });
    const completed = [
      game(Keypair.generate().publicKey.toBase58(), player, nowSeconds - 86_390, 50, 20),
      game(Keypair.generate().publicKey.toBase58(), other, nowSeconds - 3 * 86_400, 500, 21),
      game(Keypair.generate().publicKey.toBase58(), other, nowSeconds - 30 * 86_400, 900, 22),
      game(Keypair.generate().publicKey.toBase58(), other, nowSeconds - 60 * 86_400, 900, 23),
    ];
    const initialized = completed.map((item) => ({
      ...events.initialized[0]!,
      gameKey: item.gameKey,
      signature: `${String(item.slot).padStart(3, "0")}${"6".repeat(61)}`,
    }));
    database.apply(
      { initialized, membership: [], completed, closed: [] },
      { signature: completed[3]!.signature, slot: 23 },
    );

    expect(database.getLeaderboard(10, undefined, "24h")).toEqual([
      { player, games_won: 1, total_winnings: null, avg_win: null },
    ]);
    expect(database.getLeaderboard(10, mint, "7d")).toEqual([
      { player: other, games_won: 1, total_winnings: 500, avg_win: 500 },
      { player, games_won: 1, total_winnings: 50, avg_win: 50 },
    ]);
    expect(database.getLeaderboard(1, mint, "7d")).toHaveLength(1);
    expect(database.getLeaderboard(10, undefined, "all")[0]).toMatchObject({
      player: other,
      games_won: 3,
    });

    // Served from memory until the TTL expires, even as time moves on.
    now += 20_000;
    expect(database.getLeaderboard(10, undefined, "24h")).toHaveLength(1);
    now += 10_000;
    expect(database.getLeaderboard(10, undefined, "24h")).toEqual([]);

    const api = createIndexerApi(database, null);
    const response = await api(
      new Request(`http://oracle/indexer/api/leaderboard?period=7d&tokenMint=${mint}`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=30");
    expect(((await response.json()) as { count: number }).count).toBe(2);
    const invalid = await api(new Request("http://oracle/indexer/api/leaderboard?period=1y"));
    expect(invalid.status).toBe(400);
    const allTime = await api(new Request("http://oracle/indexer/api/leaderboard"));
    expect(((await allTime.json()) as { count: number }).count).toBe(2);
  });

  test("does not cache windowed leaderboards when the TTL is zero", () => {
    let now = 3_000_000_000;
    const { database } = fixture({ leaderboardCacheTtlMs: 0, now: () => now });
    expect(database.getLeaderboard(5, undefined, "24h")).toEqual([]);
    now += 1;
    expect(database.getLeaderboard(5, undefined, "7d")).toEqual([]);
  });

  test("returns timeout and current tickets for incomplete player games", async () => {
    const { database, events, gameKey, player } = fixture({ cacheRebuildIntervalMs: 0 });
    database.apply(
      { ...events, completed: [] },
      { signature: events.initialized[0]!.signature, slot: 11 },
    );
    const [active] = database.getPlayerGames(player, 10, 0);
    expect(active).toMatchObject({ game_key: gameKey, status: "active", timeout: 3_600 });
    expect(active?.tickets_count).toBe(1);

    // After reconciliation drops the live row, membership still yields a count.
    database.removeStaleActiveGames([gameKey]);
    const [stale] = database.getPlayerGames(player, 10, 0);
    expect(stale).toMatchObject({ status: "active", timeout: 3_600, tickets_count: 1 });

    const api = createIndexerApi(database, null);
    const response = await api(
      new Request(`http://oracle/indexer/api/player-games?player=${player}`),
    );
    const body = (await response.json()) as {
      games: Array<{ timeout: number; expiresAt: number; ticketsCount: number }>;
    };
    expect(body.games[0]).toMatchObject({ timeout: 3_600, expiresAt: 4_600, ticketsCount: 1 });
  });
});
