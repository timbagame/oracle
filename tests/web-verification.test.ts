import { describe, test, expect } from "bun:test";
import { createVerificationLoader } from "../web-api/cache.ts";
import { replayParticipants, verifyGameTransaction } from "../web-api/verification.ts";
import { IndexerDatabase } from "../indexer/database.ts";
import { address, getAddressEncoder, getBase58Decoder } from "@solana/kit";
import { createHash } from "node:crypto";
import { getGamePDA, PROGRAM_ID } from "../web-api/program.ts";
import type { OracleRpc } from "../solana-kit.ts";

const gameKey = address("11111111111111111111111111111111");
const player = address("So11111111111111111111111111111111111111112");
const membership = {
  gameKey,
  player,
  totalAmount: 1n,
  ticketsCount: 1,
  ticketIndex: 0,
  lastSlot: 10n,
  timestamp: 1n,
};
describe("verification records", () => {
  test("coalesces misses and serves durable records without another RPC reconstruction", async () => {
    const database = new IndexerDatabase(":memory:");
    let calls = 0;
    const options = {
      read: (key: string) => database.getVerifiedGame(key),
      write: (key: string, value: string) => database.saveVerifiedGame(key, value),
      namespace: "synthetic-program",
      load: async () => {
        calls++;
        return { winner: "synthetic" };
      },
    };
    const load = createVerificationLoader(options);
    expect(await Promise.all([load("same"), load("same")])).toEqual([
      { winner: "synthetic" },
      { winner: "synthetic" },
    ]);
    expect(await createVerificationLoader(options)("same")).toEqual({ winner: "synthetic" });
    expect(calls).toBe(1);
    database.close();
  });
  test("bounds work and never caches failed reconstructions", async () => {
    let resolve!: (value: string) => void;
    const writes: string[] = [];
    const load = createVerificationLoader({
      read: () => null,
      write: (key) => {
        writes.push(key);
      },
      namespace: "test",
      concurrency: 1,
      load: () =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    });
    const first = load("first");
    await Promise.resolve();
    await expect(load("second")).rejects.toThrow("capacity");
    resolve("ok");
    await first;
    let calls = 0;
    const failing = createVerificationLoader({
      read: () => null,
      write: (key) => {
        writes.push(key);
      },
      namespace: "test",
      load: async () => {
        calls++;
        throw new Error("missing history");
      },
    });
    await expect(failing("missing")).rejects.toThrow();
    await expect(failing("missing")).rejects.toThrow();
    expect(calls).toBe(2);
    expect(writes).toHaveLength(1);
  });
  test("replays tied timestamps and swap-remove unjoins in chain order", () => {
    const other = address("F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump");
    expect(
      replayParticipants(
        [
          { name: "PlayerJoined", data: membership },
          {
            name: "PlayerJoined",
            data: { ...membership, player: other, ticketIndex: 1, ticketsCount: 2 },
          },
          {
            name: "PlayerUnjoined",
            data: { ...membership, ticketsCount: 1, movedParticipant: other, lastSlot: 11n },
          },
        ],
        gameKey,
      ),
    ).toEqual({ participants: [other], lastSlot: 11n });
    expect(() =>
      replayParticipants(
        [{ name: "PlayerJoined", data: { ...membership, ticketIndex: 1 } }],
        gameKey,
      ),
    ).toThrow("Incomplete");
  });
});

// End-to-end reconstruction over synthetic finalized RPC history, including a
// second history page and transactions sharing a slot.

async function historyFixture() {
  const secret = Buffer.alloc(32, 7);
  const hash = createHash("sha256").update(secret).digest();
  const game = await getGamePDA(hash);
  const sig = (n: number) =>
    getBase58Decoder().decode(Uint8Array.from({ length: 64 }, (_, i) => (i === 0 ? 100 : n)));
  const completeSig = sig(3),
    joinSig = sig(2),
    initSig = sig(1);
  const key = (value: string) => Buffer.from(getAddressEncoder().encode(address(value)));
  const initialized = Buffer.alloc(146);
  initialized.set([82, 221, 11, 2, 244, 52, 240, 250]);
  key(game).copy(initialized, 8);
  key(player).copy(initialized, 40);
  initialized[72] = 1;
  initialized.writeBigUInt64LE(100n, 73);
  initialized.writeBigUInt64LE(100n, 81);
  initialized.writeUInt32LE(2, 89);
  initialized.writeUInt32LE(1, 93);
  key(player).copy(initialized, 97);
  initialized.writeBigUInt64LE(1n, 130);
  initialized.writeBigUInt64LE(600n, 138);
  const joined = Buffer.alloc(104);
  joined.set([39, 144, 49, 106, 108, 210, 183, 38]);
  key(game).copy(joined, 8);
  key(player).copy(joined, 40);
  joined.writeBigUInt64LE(100n, 72);
  joined.writeUInt32LE(1, 80);
  joined.writeUInt32LE(0, 84);
  joined.writeBigUInt64LE(3n, 88);
  joined.writeBigUInt64LE(1n, 96);
  const completed = Buffer.alloc(100);
  completed.set([103, 26, 106, 108, 240, 191, 179, 120]);
  key(game).copy(completed, 8);
  key(player).copy(completed, 40);
  completed.writeUInt32LE(1, 72);
  completed.writeBigUInt64LE(99n, 76);
  completed.writeBigUInt64LE(1n, 84);
  completed.writeBigUInt64LE(2n, 92);
  const data = Buffer.concat([
    Buffer.from([105, 69, 184, 5, 143, 182, 92, 132]),
    hash,
    secret,
    Buffer.alloc(4),
  ]);
  const tx = (slot: bigint, event: Buffer, complete = false) => ({
    slot,
    blockTime: 2n,
    meta: {
      err: null,
      logMessages: [
        `Program ${PROGRAM_ID} invoke [1]`,
        `Program data: ${event.toString("base64")}`,
        `Program ${PROGRAM_ID} success`,
      ],
    },
    transaction: {
      message: {
        accountKeys: [game, player, PROGRAM_ID],
        instructions: complete
          ? [{ programIdIndex: 2, accounts: [0, 1], data: getBase58Decoder().decode(data) }]
          : [],
      },
    },
  });
  const transactions = new Map([
    [initSig, tx(1n, initialized)],
    [joinSig, tx(2n, joined)],
    [completeSig, tx(2n, completed, true)],
  ]);
  let pages = 0;
  const mint = Buffer.alloc(82);
  mint[44] = 9;
  mint[45] = 1;
  const rpc = {
    getTransaction: (signature: string, config: { commitment: string }) => ({
      send: async () => {
        expect(config.commitment).toBe("finalized");
        return transactions.get(signature) ?? null;
      },
    }),
    getSignaturesForAddress: () => ({
      send: async () => {
        pages++;
        return pages === 1
          ? [
              { signature: completeSig, slot: 2n, err: null },
              { signature: joinSig, slot: 2n, err: null },
            ]
          : pages === 2
            ? [{ signature: initSig, slot: 1n, err: null }]
            : [];
      },
    }),
    getBlock: () => ({ send: async () => ({ signatures: [joinSig, completeSig] }) }),
    getMultipleAccounts: () => ({
      send: async () => ({
        context: { slot: 3n },
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
  } as unknown as OracleRpc;
  return { rpc, completeSig, initSig, transactions, pages: () => pages };
}

test("reconstructs finalized history across pages and uses block order for tied slots", async () => {
  const fixture = await historyFixture();
  const result = await verifyGameTransaction(fixture.rpc, PROGRAM_ID, fixture.completeSig);
  expect(result.winner).toBe(player);
  expect(result.winnerTicketIndex).toBe(0);
  expect(result.randomValue).toBe("7669647862329529978");
  expect(fixture.pages()).toBe(2);
  expect(result.transactionSignatures?.at(-1)).toBe(fixture.completeSig);
});

test("missing initialization and failed completion never produce a verification record", async () => {
  const missing = await historyFixture();
  missing.transactions.delete(missing.initSig);
  await expect(verifyGameTransaction(missing.rpc, PROGRAM_ID, missing.completeSig)).rejects.toThrow(
    "Incomplete",
  );
  const failed = await historyFixture();
  const complete = failed.transactions.get(failed.completeSig)!;
  complete.meta.err = "synthetic failure" as never;
  await expect(verifyGameTransaction(failed.rpc, PROGRAM_ID, failed.completeSig)).rejects.toThrow(
    "Finalized",
  );
});
