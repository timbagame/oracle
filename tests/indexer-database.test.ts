import { afterEach, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { IndexerDatabase } from "../indexer/database.ts";
import { createIndexerApi } from "../indexer/api.ts";
import type { IndexedEvents } from "../indexer/types.ts";

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
});
