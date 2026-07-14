import { describe, expect, it } from "bun:test";
import {
  applyMutationToPlayersCache,
  calculateWinProbabilities,
  extractGameAddressFromEventPayload,
  extractPlayerMutation,
  formatPlayerLabel,
  materializePlayersCache,
  parseArgs,
} from "../scripts/audit-random.ts";

describe("audit-random helpers", () => {
  it("parseArgs uses safe defaults", () => {
    expect(parseArgs([])).toEqual({
      gameAddress: undefined,
      intervalMs: 2500,
      lookaheadSlots: 50,
      once: false,
      listen: true,
      refreshFromDbEachTick: false,
      writeDb: false,
      withBlockTime: false,
    });
  });

  it("parseArgs accepts flags and positional game address", () => {
    const parsed = parseArgs([
      "GameAddr",
      "--interval",
      "5000",
      "--slots",
      "100",
      "--once",
      "--no-listen",
      "--db-refresh",
      "--write-db",
      "--with-block-time",
    ]);

    expect(parsed).toEqual({
      gameAddress: "GameAddr",
      intervalMs: 5000,
      lookaheadSlots: 100,
      once: true,
      listen: false,
      refreshFromDbEachTick: true,
      writeDb: true,
      withBlockTime: true,
    });
  });

  it("parseArgs validates values", () => {
    expect(() => parseArgs(["--interval"])).toThrow("Missing value for --interval");
    expect(() => parseArgs(["--slots"])).toThrow("Missing value for --slots");
    expect(() => parseArgs(["--game"])).toThrow("Missing value for --game");
    expect(() => parseArgs(["--interval", "10"])).toThrow(
      "--interval must be a number >= 100 (ms)",
    );
    expect(() => parseArgs(["--slots", "0"])).toThrow("--slots must be a number between 1 and 500");
    expect(() => parseArgs(["--unknown-flag"])).toThrow("Unknown argument: --unknown-flag");
  });

  it("extractPlayerMutation reads join/unjoin payloads", () => {
    const joined = extractPlayerMutation("joined", {
      gameAddress: "game-1",
      playerAddress: "player-1",
      ticketIndex: 3,
    });
    expect(joined).toEqual({
      gameAddress: "game-1",
      mutation: { action: "joined", playerAddress: "player-1", ticketIndex: 3 },
    });

    const unjoined = extractPlayerMutation("unjoined", {
      gameAddress: "game-1",
      ticketIndex: 3,
    });
    expect(unjoined).toEqual({
      gameAddress: "game-1",
      mutation: { action: "unjoined", ticketIndex: 3 },
    });
  });

  it("extractGameAddressFromEventPayload supports legacy keys", () => {
    expect(extractGameAddressFromEventPayload({ gameAddress: "a" })).toBe("a");
    expect(extractGameAddressFromEventPayload({ gameKey: "b" })).toBe("b");
    expect(extractGameAddressFromEventPayload({ game: "c" })).toBe("c");
    expect(extractGameAddressFromEventPayload({ game_key: "d" })).toBe("d");
    expect(extractGameAddressFromEventPayload({})).toBeNull();
  });

  it("players cache applies mutations and materializes players", () => {
    const cache: (string | undefined)[] = [];

    applyMutationToPlayersCache(cache, { action: "joined", playerAddress: "p0", ticketIndex: 0 });
    applyMutationToPlayersCache(cache, { action: "joined", playerAddress: "p2", ticketIndex: 2 });
    applyMutationToPlayersCache(cache, { action: "unjoined", ticketIndex: 0 });
    applyMutationToPlayersCache(cache, { action: "joined", playerAddress: "p1", ticketIndex: 1 });

    expect(cache).toEqual([undefined, "p1", "p2"]);
    expect(materializePlayersCache(cache)).toEqual(["p1", "p2"]);
  });
});

describe("win probability calculations", () => {
  it("calculateWinProbabilities computes correct probabilities for empty game", () => {
    const winCounts = new Map<number, number>();
    winCounts.set(0, 10); // new join wins 10/10

    const result = calculateWinProbabilities(winCounts, 10, []);

    expect(result).toEqual([
      { position: 1, wins: 10, total: 10, probability: 100, playerLabel: "<new join>" },
    ]);
  });

  it("calculateWinProbabilities computes correct probabilities for game with existing players", () => {
    const winCounts = new Map<number, number>();
    winCounts.set(0, 25); // player 0 wins 25/50
    winCounts.set(1, 15); // player 1 wins 15/50
    winCounts.set(2, 10); // new join wins 10/50

    const players = ["player-A", "player-B"];
    const result = calculateWinProbabilities(winCounts, 50, players);

    expect(result).toEqual([
      { position: 1, wins: 25, total: 50, probability: 50, playerLabel: "player-A" },
      { position: 2, wins: 15, total: 50, probability: 30, playerLabel: "player-B" },
      { position: 3, wins: 10, total: 50, probability: 20, playerLabel: "<new join>" },
    ]);
  });

  it("calculateWinProbabilities handles zero wins", () => {
    const winCounts = new Map<number, number>();
    winCounts.set(0, 0);
    winCounts.set(1, 50);

    const result = calculateWinProbabilities(winCounts, 50, ["player-A"]);

    expect(result[0]?.probability).toBe(0);
    expect(result[1]?.probability).toBe(100);
  });

  it("calculateWinProbabilities handles missing players in map", () => {
    const winCounts = new Map<number, number>();
    // Player 0 not in map, should default to 0 wins
    winCounts.set(1, 50);

    const result = calculateWinProbabilities(winCounts, 50, ["player-A"]);

    expect(result[0]?.wins).toBe(0);
    expect(result[0]?.probability).toBe(0);
  });

  it("calculateWinProbabilities marks missing player labels", () => {
    const winCounts = new Map<number, number>();
    winCounts.set(0, 25);
    winCounts.set(1, 15);
    winCounts.set(2, 10);

    // Create sparse array with undefined element at index 1
    const players: string[] = ["player-A", undefined as unknown as string, "player-C"];

    const result = calculateWinProbabilities(winCounts, 50, players);

    expect(result[0]?.playerLabel).toBe("player-A");
    expect(result[1]?.playerLabel).toBe("<missing>");
    expect(result[2]?.playerLabel).toBe("player-C");
    expect(result[3]?.playerLabel).toBe("<new join>");
  });
});

describe("formatPlayerLabel", () => {
  it("returns short labels unchanged", () => {
    expect(formatPlayerLabel("short")).toBe("short");
    expect(formatPlayerLabel("exactly12ch")).toBe("exactly12ch");
  });

  it("truncates long labels with ellipsis", () => {
    const longLabel = "HGBiGfyR9GF36J4SMPjxsRkFuwYNuNYuzdCjgR4aw4FC";
    expect(formatPlayerLabel(longLabel)).toBe("HGBi...w4FC");
  });

  it("handles special labels", () => {
    expect(formatPlayerLabel("<new join>")).toBe("<new join>");
    expect(formatPlayerLabel("<missing>")).toBe("<missing>");
  });

  it("respects custom maxLength", () => {
    expect(formatPlayerLabel("123456789", 8)).toBe("1234...6789");
    expect(formatPlayerLabel("12345678", 8)).toBe("12345678");
  });
});
