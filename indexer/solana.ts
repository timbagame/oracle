import { PublicKey, type Connection, type ConfirmedSignatureInfo } from "@solana/web3.js";
import { createHash } from "node:crypto";
import type {
  GameClosedEvent,
  GameCompletedEvent,
  GameInitializedEvent,
  IndexedEvents,
  IndexerCursor,
  PlayerMembershipEvent,
} from "./types.ts";

const GAME_INITIALIZED = Buffer.from([82, 221, 11, 2, 244, 52, 240, 250]);
const GAME_COMPLETED = Buffer.from([103, 26, 106, 108, 240, 191, 179, 120]);
const GAME_CLOSED = Buffer.from([178, 203, 179, 224, 43, 18, 209, 4]);
const PLAYER_JOINED = Buffer.from([39, 144, 49, 106, 108, 210, 183, 38]);
const PLAYER_UNJOINED = Buffer.from([191, 34, 140, 22, 253, 20, 237, 73]);
const OPERATOR_GAME_CLOSED = createHash("sha256")
  .update("event:OperatorGameClosed")
  .digest()
  .subarray(0, 8);
const GAME_ACCOUNT_DISCRIMINATOR = Buffer.from([27, 90, 166, 125, 74, 100, 121, 18]);

const EMPTY_EVENTS = (): IndexedEvents => ({
  initialized: [],
  completed: [],
  closed: [],
  membership: [],
});

function publicKey(data: Buffer, offset: number): string {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58();
}

function safeU64(data: Buffer, offset: number, field: string): number {
  const value = data.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${field} exceeds the safe integer range`);
  }
  return Number(value);
}

function parseInitialized(data: Buffer): Omit<GameInitializedEvent, keyof IndexerCursor> {
  if (data.length !== 146) throw new Error("Invalid GameInitialized event length");
  const gameType = data.readUInt8(72);
  const isPrivate = data.readUInt8(129);
  if (gameType > 1) throw new Error("Invalid game type");
  if (isPrivate > 1) throw new Error("Invalid private-game flag");
  return {
    gameKey: publicKey(data, 8),
    creator: publicKey(data, 40),
    gameType: gameType === 0 ? "coinflip" : "giveaway",
    ticketAmount: safeU64(data, 73, "ticketAmount"),
    totalAmount: safeU64(data, 81, "totalAmount"),
    maxTickets: data.readUInt32LE(89),
    minTickets: data.readUInt32LE(93),
    tokenMint: publicKey(data, 97),
    isPrivate: isPrivate === 1,
    createdAt: safeU64(data, 130, "createdAt"),
    timeout: safeU64(data, 138, "timeout"),
  };
}

function parseCompleted(data: Buffer): Omit<GameCompletedEvent, keyof IndexerCursor> {
  if (data.length !== 100) throw new Error("Invalid GameCompleted event length");
  return {
    gameKey: publicKey(data, 8),
    winner: publicKey(data, 40),
    ticketsCount: data.readUInt32LE(72),
    winnerAmount: safeU64(data, 76, "winnerAmount"),
    feeAmount: safeU64(data, 84, "feeAmount"),
    timestamp: safeU64(data, 92, "timestamp"),
  };
}

function parseClosed(data: Buffer, operator: boolean): Omit<GameClosedEvent, keyof IndexerCursor> {
  const expectedLength = operator ? 128 : 48;
  if (data.length !== expectedLength) throw new Error("Invalid game closure event length");
  return {
    gameKey: publicKey(data, 8),
    timestamp: safeU64(data, data.length - 8, "timestamp"),
  };
}

function parseMembership(
  data: Buffer,
  kind: PlayerMembershipEvent["kind"],
): Omit<PlayerMembershipEvent, keyof IndexerCursor> {
  const minimumLength = kind === "joined" ? 104 : 105;
  const validLength =
    kind === "joined" ? data.length === minimumLength : data.length === 105 || data.length === 137;
  if (!validLength) throw new Error(`Invalid Player${kind} event length`);
  return {
    kind,
    gameKey: publicKey(data, 8),
    player: publicKey(data, 40),
    ticketsCount: data.readUInt32LE(80),
    ticketIndex: data.readUInt32LE(84),
    timestamp: safeU64(data, data.length - 8, "timestamp"),
  };
}

/** Extract only data emitted while the Timba program is the active invocation frame. */
export function getTrustedProgramData(logs: readonly string[], programId: string): Buffer[] {
  const stack: string[] = [];
  const result: Buffer[] = [];
  for (const log of logs) {
    const invocation = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)]$/.exec(log);
    if (invocation) {
      const depth = Number(invocation[2]);
      stack.length = Math.max(0, depth - 1);
      stack.push(invocation[1]!);
      continue;
    }
    const completion = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (?:success|failed:)/.exec(log);
    if (completion) {
      if (stack.at(-1) === completion[1]) stack.pop();
      continue;
    }
    if (stack.at(-1) !== programId) continue;
    const encoded = /^Program data: ([A-Za-z0-9+/]+={0,2})$/.exec(log)?.[1];
    if (!encoded) continue;
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.length >= 8) result.push(decoded);
  }
  return result;
}

export function parseTransactionEvents(
  signature: string,
  slot: number,
  logs: readonly string[],
  programId: string,
): IndexedEvents {
  const events = EMPTY_EVENTS();
  for (const data of getTrustedProgramData(logs, programId)) {
    const discriminator = data.subarray(0, 8);
    const cursor = { signature, slot };
    try {
      if (discriminator.equals(GAME_INITIALIZED)) {
        events.initialized.push({ ...parseInitialized(data), ...cursor });
      } else if (discriminator.equals(GAME_COMPLETED)) {
        events.completed.push({ ...parseCompleted(data), ...cursor });
      } else if (discriminator.equals(GAME_CLOSED)) {
        events.closed.push({ ...parseClosed(data, false), ...cursor });
      } else if (discriminator.equals(OPERATOR_GAME_CLOSED)) {
        events.closed.push({ ...parseClosed(data, true), ...cursor });
      } else if (discriminator.equals(PLAYER_JOINED)) {
        events.membership.push({ ...parseMembership(data, "joined"), ...cursor });
      } else if (discriminator.equals(PLAYER_UNJOINED)) {
        events.membership.push({ ...parseMembership(data, "unjoined"), ...cursor });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid Timba event in ${signature}: ${message}`, { cause: error });
    }
  }
  return events;
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(items.length);
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length) {
      const current = index++;
      result[current] = await mapper(items[current]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return result;
}

export async function getProgramHead(
  connection: Connection,
  programId: PublicKey,
): Promise<IndexerCursor | null> {
  const head = (await connection.getSignaturesForAddress(programId, { limit: 1 }, "confirmed"))[0];
  return head ? { signature: head.signature, slot: head.slot } : null;
}

async function getSignaturesSince(
  connection: Connection,
  programId: PublicKey,
  cursor: IndexerCursor,
): Promise<ConfirmedSignatureInfo[]> {
  const signatures: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  while (true) {
    const page = await connection.getSignaturesForAddress(
      programId,
      { before, until: cursor.signature, limit: 1_000 },
      "confirmed",
    );
    signatures.push(...page);
    if (page.length < 1_000) break;
    before = page.at(-1)?.signature;
    if (!before) break;
  }
  return signatures;
}

export async function getEventsSince(
  connection: Connection,
  programId: PublicKey,
  cursor: IndexerCursor,
): Promise<{ events: IndexedEvents; cursor: IndexerCursor | null; transactions: number }> {
  const newestFirst = await getSignaturesSince(connection, programId, cursor);
  if (newestFirst.length === 0) return { events: EMPTY_EVENTS(), cursor: null, transactions: 0 };

  const oldestFirst = [...newestFirst].reverse();
  const parsed = await mapConcurrent(oldestFirst, 4, async (item) => {
    if (item.err) return EMPTY_EVENTS();
    const transaction = await connection.getTransaction(item.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!transaction) throw new Error(`Transaction ${item.signature} is unavailable`);
    if (transaction.meta?.err) return EMPTY_EVENTS();
    return parseTransactionEvents(
      item.signature,
      item.slot,
      transaction.meta?.logMessages ?? [],
      programId.toBase58(),
    );
  });
  return {
    events: {
      initialized: parsed.flatMap((item) => item.initialized),
      completed: parsed.flatMap((item) => item.completed),
      closed: parsed.flatMap((item) => item.closed),
      membership: parsed.flatMap((item) => item.membership),
    },
    cursor: { signature: newestFirst[0]!.signature, slot: newestFirst[0]!.slot },
    transactions: newestFirst.length,
  };
}

export async function findStaleActiveGames(
  connection: Connection,
  programId: PublicKey,
  gameKeys: string[],
): Promise<string[]> {
  const stale: string[] = [];
  for (let offset = 0; offset < gameKeys.length; offset += 100) {
    const batch = gameKeys.slice(offset, offset + 100);
    const valid: Array<{ key: string; publicKey: PublicKey }> = [];
    for (const key of batch) {
      try {
        valid.push({ key, publicKey: new PublicKey(key) });
      } catch {
        stale.push(key);
      }
    }
    const accounts = await connection.getMultipleAccountsInfo(
      valid.map((item) => item.publicKey),
      "confirmed",
    );
    valid.forEach((item, index) => {
      const account = accounts[index];
      if (
        !account ||
        !account.owner.equals(programId) ||
        account.data.length < 8 ||
        !account.data.subarray(0, 8).equals(GAME_ACCOUNT_DISCRIMINATOR)
      ) {
        stale.push(item.key);
      }
    });
  }
  return stale;
}
