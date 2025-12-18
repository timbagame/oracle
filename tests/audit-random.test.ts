import { describe, expect, it } from "bun:test";
import {
  applyMutationToPlayersCache,
  extractGameAddressFromEventPayload,
  extractPlayerMutation,
  materializePlayersCache,
  parseArgs,
} from "../scripts/audit-random.ts";

describe("audit-random helpers", () => {
  it("parseArgs uses safe defaults", () => {
    expect(parseArgs([])).toEqual({
      gameAddress: undefined,
      intervalMs: 2500,
      lookaheadSlots: 25,
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
      "50",
      "--once",
      "--no-listen",
      "--db-refresh",
      "--write-db",
      "--with-block-time",
    ]);

    expect(parsed).toEqual({
      gameAddress: "GameAddr",
      intervalMs: 5000,
      lookaheadSlots: 50,
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
    expect(() => parseArgs(["--interval", "10"])).toThrow("--interval must be a number >= 100 (ms)");
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

