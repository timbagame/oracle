import { describe, expect, test } from "bun:test";
import { generateKeyPairSigner, getBase58Decoder, type Address } from "@solana/kit";
import {
  findStaleActiveGames,
  getEventsSince,
  getProgramHead,
  parseTransactionEvents,
} from "../indexer/solana.ts";
import type { OracleRpc } from "../solana-kit.ts";
import {
  gameClosedEvent,
  gameCompletedEvent,
  gameInitializedEvent,
  operatorGameClosedEvent,
  playerJoinedEvent,
  playerUnjoinedEvent,
  programLogs,
} from "./helpers/program-events.ts";

const GAME_DISCRIMINATOR = Buffer.from([27, 90, 166, 125, 74, 100, 121, 18]);

async function newAddress(): Promise<Address> {
  return (await generateKeyPairSigner()).address;
}

type SixAddresses = [Address, Address, Address, Address, Address, Address];

async function newAddresses(count: 5 | 6): Promise<SixAddresses> {
  return (await Promise.all(Array.from({ length: count }, newAddress))) as SixAddresses;
}

function sig(index: number): string {
  return getBase58Decoder().decode(new Uint8Array(64).fill(index + 1));
}

type Call = { method: string; args: unknown[] };

function fakeRpc(handlers: Record<string, (...args: any[]) => unknown>) {
  const calls: Call[] = [];
  const rpc = new Proxy(
    {},
    {
      get(_target, method: string) {
        return (...args: unknown[]) => {
          calls.push({ method, args });
          const handler = handlers[method];
          if (!handler) throw new Error(`unexpected rpc ${method}`);
          return { send: async () => handler(...args) };
        };
      },
    },
  ) as unknown as OracleRpc;
  return { rpc, calls };
}

describe("parseTransactionEvents", () => {
  test("decodes every Timba lifecycle and membership event", async () => {
    const program = await newAddress();
    const [game, creator, player, moved, mint, operator] = await newAddresses(6);
    const logs = programLogs(program, [
      gameInitializedEvent({ gameKey: game, creator, tokenMint: mint, isPrivate: 1 }),
      playerJoinedEvent({ gameKey: game, player, ticketIndex: 1, ticketsCount: 2 }),
      playerUnjoinedEvent({ gameKey: game, player, movedParticipant: moved }),
      playerUnjoinedEvent({ gameKey: game, player }),
      gameCompletedEvent({ gameKey: game, winner: player }),
      gameClosedEvent({ gameKey: game }),
      operatorGameClosedEvent({ gameKey: game, creator, operator }),
    ]);

    const events = parseTransactionEvents("sig-1", 42, logs, program);

    expect(events.initialized).toEqual([
      expect.objectContaining({
        gameKey: game,
        creator,
        gameType: "coinflip",
        isPrivate: true,
        ticketAmount: 100,
        createdAt: 1000,
        timeout: 3600,
        signature: "sig-1",
        slot: 42,
      }),
    ]);
    expect(events.membership).toEqual([
      {
        kind: "joined",
        gameKey: game,
        player,
        ticketsCount: 2,
        ticketIndex: 1,
        timestamp: 1500,
        signature: "sig-1",
        slot: 42,
      },
      {
        kind: "unjoined",
        gameKey: game,
        player,
        ticketsCount: 1,
        ticketIndex: 0,
        timestamp: 1600,
        movedParticipant: moved,
        signature: "sig-1",
        slot: 42,
      },
      {
        kind: "unjoined",
        gameKey: game,
        player,
        ticketsCount: 1,
        ticketIndex: 0,
        timestamp: 1600,
        signature: "sig-1",
        slot: 42,
      },
    ]);
    expect(events.completed).toEqual([
      expect.objectContaining({
        gameKey: game,
        winner: player,
        winnerAmount: 190,
        feeAmount: 10,
        timestamp: 2000,
      }),
    ]);
    expect(events.closed).toEqual([
      { gameKey: game, timestamp: 3000, operator: false, signature: "sig-1", slot: 42 },
      { gameKey: game, timestamp: 4000, operator: true, signature: "sig-1", slot: 42 },
    ]);
  });

  test("rejects amounts beyond the safe integer range", async () => {
    const program = await newAddress();
    const logs = programLogs(program, [
      gameCompletedEvent({
        gameKey: await newAddress(),
        winner: await newAddress(),
        winnerAmount: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      }),
    ]);

    expect(() => parseTransactionEvents("sig-2", 1, logs, program)).toThrow(
      "Invalid Timba event in sig-2: Event field exceeds the safe integer range",
    );
  });

  test("rejects malformed recognized events", async () => {
    const program = await newAddress();
    const truncated = gameClosedEvent({ gameKey: await newAddress() }).subarray(0, 20);

    expect(() =>
      parseTransactionEvents("sig-3", 1, programLogs(program, [Buffer.from(truncated)]), program),
    ).toThrow("Invalid Timba event in sig-3: Invalid Timba event length");
  });

  test("ignores unknown program events", async () => {
    const program = await newAddress();
    const unknown = Buffer.alloc(16, 7);

    expect(parseTransactionEvents("sig-4", 1, programLogs(program, [unknown]), program)).toEqual({
      initialized: [],
      completed: [],
      closed: [],
      membership: [],
    });
  });
});

describe("getProgramHead", () => {
  test("returns the newest confirmed program signature", async () => {
    const program = await newAddress();
    const { rpc, calls } = fakeRpc({
      getSignaturesForAddress: () => [{ signature: "newest", slot: 99n }],
    });

    await expect(getProgramHead(rpc, program)).resolves.toEqual({
      signature: "newest",
      slot: 99,
    });
    expect(calls[0]!.args).toEqual([program, { commitment: "confirmed", limit: 1 }]);
  });

  test("returns null for a program without history", async () => {
    const { rpc } = fakeRpc({ getSignaturesForAddress: () => [] });

    await expect(getProgramHead(rpc, await newAddress())).resolves.toBeNull();
  });
});

describe("getEventsSince", () => {
  const cursor = { signature: sig(0), slot: 1 };

  test("returns an empty batch when nothing happened since the cursor", async () => {
    const { rpc } = fakeRpc({ getSignaturesForAddress: () => [] });

    await expect(getEventsSince(rpc, await newAddress(), cursor)).resolves.toEqual({
      events: { initialized: [], completed: [], closed: [], membership: [] },
      cursor: null,
      transactions: 0,
    });
  });

  test("pages signatures, skips failed transactions and parses oldest first", async () => {
    const program = await newAddress();
    const [firstGame, secondGame] = [await newAddress(), await newAddress()];
    const fullPage = Array.from({ length: 1_000 }, (_, index) => ({
      signature: `page1-${index}`,
      slot: BigInt(3_000 - index),
      err: index === 0 ? null : { InstructionError: [0, "Custom"] },
    }));
    const secondPage = [
      { signature: "page2-0", slot: 1_500n, err: null },
      { signature: "page2-1", slot: 1_400n, err: null },
    ];
    const logsBySignature: Record<string, unknown> = {
      "page1-0": {
        meta: {
          err: null,
          logMessages: programLogs(program, [gameClosedEvent({ gameKey: firstGame })]),
        },
      },
      "page2-0": { meta: { err: { InstructionError: [0, "Custom"] }, logMessages: [] } },
      "page2-1": {
        meta: {
          err: null,
          logMessages: programLogs(program, [
            gameClosedEvent({ gameKey: secondGame, timestamp: 1n }),
          ]),
        },
      },
    };
    const { rpc, calls } = fakeRpc({
      getSignaturesForAddress: (_program: Address, options: { before?: string }) =>
        options.before ? secondPage : fullPage,
      getTransaction: (signature: string) => logsBySignature[signature],
    });

    const result = await getEventsSince(rpc, program, cursor);

    const pageCalls = calls.filter((call) => call.method === "getSignaturesForAddress");
    expect(pageCalls.map((call) => (call.args[1] as { before?: string }).before)).toEqual([
      undefined,
      "page1-999",
    ]);
    expect(calls.filter((call) => call.method === "getTransaction")).toHaveLength(3);
    expect(result.transactions).toBe(1_002);
    expect(result.cursor).toEqual({ signature: "page1-0", slot: 3_000 });
    expect(result.events.closed.map((event) => [event.gameKey, event.signature])).toEqual([
      [secondGame, "page2-1"],
      [firstGame, "page1-0"],
    ]);
  });

  test("fails when a confirmed transaction cannot be loaded", async () => {
    const { rpc } = fakeRpc({
      getSignaturesForAddress: () => [{ signature: "missing", slot: 5n, err: null }],
      getTransaction: () => null,
    });

    await expect(getEventsSince(rpc, await newAddress(), cursor)).rejects.toThrow(
      "Transaction missing is unavailable",
    );
  });

  test("treats a transaction without log messages as empty", async () => {
    const { rpc } = fakeRpc({
      getSignaturesForAddress: () => [{ signature: "quiet", slot: 5n, err: null }],
      getTransaction: () => ({ meta: null }),
    });

    const result = await getEventsSince(rpc, await newAddress(), cursor);

    expect(result.transactions).toBe(1);
    expect(result.events.closed).toEqual([]);
  });
});

describe("findStaleActiveGames", () => {
  function account(owner: Address, data: Buffer) {
    return { owner, data: [data.toString("base64"), "base64"] };
  }

  test("flags invalid keys, closed accounts and accounts that are not games", async () => {
    const program = await newAddress();
    const [live, closed, foreign, short, wrongType] = await newAddresses(5);
    const accounts: Record<string, unknown> = {
      [live]: account(program, Buffer.concat([GAME_DISCRIMINATOR, Buffer.alloc(8)])),
      [closed]: null,
      [foreign]: account(await newAddress(), Buffer.concat([GAME_DISCRIMINATOR, Buffer.alloc(8)])),
      [short]: account(program, Buffer.alloc(4)),
      [wrongType]: account(program, Buffer.alloc(16, 1)),
    };
    const { rpc, calls } = fakeRpc({
      getMultipleAccounts: (keys: Address[]) => ({ value: keys.map((key) => accounts[key]) }),
    });

    const stale = await findStaleActiveGames(rpc, program, [
      live,
      "not-an-address",
      closed,
      foreign,
      short,
      wrongType,
    ]);

    expect(stale.sort()).toEqual(["not-an-address", closed, foreign, short, wrongType].sort());
    expect(calls[0]!.args[1]).toEqual({ commitment: "confirmed", encoding: "base64" });
  });

  test("queries accounts in batches of one hundred", async () => {
    const program = await newAddress();
    const keys = await Promise.all(Array.from({ length: 150 }, newAddress));
    const { rpc, calls } = fakeRpc({
      getMultipleAccounts: (batch: Address[]) => ({
        value: batch.map(() =>
          account(program, Buffer.concat([GAME_DISCRIMINATOR, Buffer.alloc(8)])),
        ),
      }),
    });

    await expect(findStaleActiveGames(rpc, program, keys)).resolves.toEqual([]);
    expect(calls.map((call) => (call.args[0] as Address[]).length)).toEqual([100, 50]);
  });
});
