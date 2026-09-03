import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Keypair } from "@solana/web3.js";
import { IndexerDatabase } from "../indexer/database.ts";
import { createIndexerApi } from "../indexer/api.ts";
import type { IndexedEvents } from "../indexer/types.ts";
import { createTempDatabaseFile } from "./helpers/test-db.ts";

const databases: IndexerDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture() {
  const database = new IndexerDatabase(":memory:");
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
});
