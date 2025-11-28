import { describe, expect, it, mock } from "bun:test";
import { RegistrySyncManager } from "../registry-sync-manager.ts";

const makeDb = (players: string[]) => {
  return {
    getGamePlayers: mock(() => players.slice()),
    replaceGamePlayers: mock((_game: string, newPlayers: string[]) => {
      players.splice(0, players.length, ...newPlayers);
    }),
  };
};

const contextStub = {} as any;
const readinessStub = { gameAccount: { ticketsCount: 2 } } as any;

describe("RegistrySyncManager.ensurePlayersInSync", () => {
  it("returns cached clean registry without invoking recovery", async () => {
    const players = ["p1"];
    const db = makeDb(players);
    const recoverPlayerRegistry = mock(async () => null);

    const manager = new RegistrySyncManager({ db, recoverPlayerRegistry });

    const first = await manager.ensurePlayersInSync(
      "game1",
      contextStub,
      readinessStub,
      1,
      () => ({ success: false } as any),
    );

    const second = await manager.ensurePlayersInSync(
      "game1",
      contextStub,
      readinessStub,
      1,
      () => ({ success: false } as any),
    );

    expect("players" in first && first.players).toEqual(["p1"]);
    expect("players" in second && second.players).toEqual(["p1"]);
    expect(recoverPlayerRegistry).not.toHaveBeenCalled();
  });

  it("recovers missing players and updates db when sizes match", async () => {
    const players: string[] = [];
    const db = makeDb(players);
    const recoverPlayerRegistry = mock(async () => ["p1", "p2"]);

    const manager = new RegistrySyncManager({
      db,
      recoverPlayerRegistry,
    });

    const result = await manager.ensurePlayersInSync(
      "game2",
      contextStub,
      readinessStub,
      2,
      () => ({ success: false } as any),
    );

    expect("players" in result && result.players).toEqual(["p1", "p2"]);
    expect(db.replaceGamePlayers).toHaveBeenCalledWith("game2", ["p1", "p2"]);
  });

  it("marks desynced when recovery fails to reach expected count", async () => {
    const players: string[] = [];
    const db = makeDb(players);
    const markGameDesynced = mock(() => {});
    const recordFatal = mock(() => ({ success: false }));

    const manager = new RegistrySyncManager({
      db,
      markGameDesynced,
      recoverPlayerRegistry: async () => ["only-one"],
    });

    const result = await manager.ensurePlayersInSync(
      "game3",
      contextStub,
      readinessStub,
      2,
      recordFatal,
    );

    expect("error" in result).toBe(true);
    expect(markGameDesynced).toHaveBeenCalledWith("game3");
    expect(recordFatal).toHaveBeenCalled();
  });
});
