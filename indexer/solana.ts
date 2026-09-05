import { address, signature, type Address } from "@solana/kit";
import {
  decodeProgramEvent,
  getTrustedProgramData as trustedData,
} from "@timbagame/protocol/contracts/events";
import { base64ToBytes, sendRpcRequest, type OracleRpc } from "../solana-kit.ts";
import type { IndexedEvents, IndexerCursor } from "./types.ts";

const GAME_ACCOUNT_DISCRIMINATOR = Buffer.from([27, 90, 166, 125, 74, 100, 121, 18]);

const EMPTY_EVENTS = (): IndexedEvents => ({
  initialized: [],
  completed: [],
  closed: [],
  membership: [],
});

export function getTrustedProgramData(logs: readonly string[], programId: string): Buffer[] {
  return trustedData(logs, programId).map((bytes) => Buffer.from(bytes));
}

export function parseTransactionEvents(
  signature: string,
  slot: number,
  logs: readonly string[],
  programId: string,
): IndexedEvents {
  const events = EMPTY_EVENTS();
  for (const data of getTrustedProgramData(logs, programId)) {
    const cursor = { signature, slot };
    try {
      const event = decodeProgramEvent(data);
      if (!event) continue;
      const safe = (value: bigint): number => {
        if (value > BigInt(Number.MAX_SAFE_INTEGER))
          throw new Error("Event field exceeds the safe integer range");
        return Number(value);
      };
      switch (event.name) {
        case "GameInitialized": {
          const value = event.data;
          events.initialized.push({
            ...value,
            ticketAmount: safe(value.ticketAmount),
            totalAmount: safe(value.totalAmount),
            createdAt: safe(value.createdAt),
            timeout: safe(value.timeout),
            ...cursor,
          });
          break;
        }
        case "GameCompleted": {
          const value = event.data;
          events.completed.push({
            ...value,
            winnerAmount: safe(value.winnerAmount),
            feeAmount: safe(value.feeAmount),
            timestamp: safe(value.timestamp),
            ...cursor,
          });
          break;
        }
        case "GameClosed":
        case "OperatorGameClosed":
          events.closed.push({
            gameKey: event.data.gameKey,
            timestamp: safe(event.data.timestamp),
            operator: event.name === "OperatorGameClosed",
            ...cursor,
          });
          break;
        case "PlayerJoined":
        case "PlayerUnjoined": {
          const value = event.data;
          const movedParticipant =
            event.name === "PlayerUnjoined" ? event.data.movedParticipant : null;
          events.membership.push({
            kind: event.name === "PlayerJoined" ? "joined" : "unjoined",
            gameKey: value.gameKey,
            player: value.player,
            ticketsCount: value.ticketsCount,
            ticketIndex: value.ticketIndex,
            timestamp: safe(value.timestamp),
            ...(movedParticipant ? { movedParticipant } : {}),
            ...cursor,
          });
          break;
        }
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
  connection: OracleRpc,
  programId: Address,
): Promise<IndexerCursor | null> {
  const head = (
    await sendRpcRequest(
      connection.getSignaturesForAddress(programId, { commitment: "confirmed", limit: 1 }),
    )
  )[0];
  return head ? { signature: head.signature, slot: Number(head.slot) } : null;
}

type SignatureInfo = Awaited<
  ReturnType<ReturnType<OracleRpc["getSignaturesForAddress"]>["send"]>
>[number];

async function getSignaturesSince(
  connection: OracleRpc,
  programId: Address,
  cursor: IndexerCursor,
): Promise<SignatureInfo[]> {
  const signatures: SignatureInfo[] = [];
  let before: ReturnType<typeof signature> | undefined;
  while (true) {
    const page = await sendRpcRequest(
      connection.getSignaturesForAddress(programId, {
        ...(before ? { before } : {}),
        commitment: "confirmed",
        limit: 1_000,
        until: signature(cursor.signature),
      }),
    );
    signatures.push(...page);
    if (page.length < 1_000) break;
    before = page.at(-1)?.signature;
    if (!before) break;
  }
  return signatures;
}

export async function getEventsSince(
  connection: OracleRpc,
  programId: Address,
  cursor: IndexerCursor,
): Promise<{ events: IndexedEvents; cursor: IndexerCursor | null; transactions: number }> {
  const newestFirst = await getSignaturesSince(connection, programId, cursor);
  if (newestFirst.length === 0) return { events: EMPTY_EVENTS(), cursor: null, transactions: 0 };

  const oldestFirst = [...newestFirst].reverse();
  const parsed = await mapConcurrent(oldestFirst, 4, async (item) => {
    if (item.err) return EMPTY_EVENTS();
    const transaction = await sendRpcRequest(
      connection.getTransaction(item.signature, {
        commitment: "confirmed",
        encoding: "json",
        maxSupportedTransactionVersion: 0,
      }),
    );
    if (!transaction) throw new Error(`Transaction ${item.signature} is unavailable`);
    if (transaction.meta?.err) return EMPTY_EVENTS();
    return parseTransactionEvents(
      item.signature,
      Number(item.slot),
      transaction.meta?.logMessages ?? [],
      programId,
    );
  });
  return {
    events: {
      initialized: parsed.flatMap((item) => item.initialized),
      completed: parsed.flatMap((item) => item.completed),
      closed: parsed.flatMap((item) => item.closed),
      membership: parsed.flatMap((item) => item.membership),
    },
    cursor: { signature: newestFirst[0]!.signature, slot: Number(newestFirst[0]!.slot) },
    transactions: newestFirst.length,
  };
}

export async function findStaleActiveGames(
  connection: OracleRpc,
  programId: Address,
  gameKeys: string[],
): Promise<string[]> {
  const stale: string[] = [];
  for (let offset = 0; offset < gameKeys.length; offset += 100) {
    const batch = gameKeys.slice(offset, offset + 100);
    const valid: Array<{ key: string; publicKey: Address }> = [];
    for (const key of batch) {
      try {
        valid.push({ key, publicKey: address(key) });
      } catch {
        stale.push(key);
      }
    }
    const { value: accounts } = await sendRpcRequest(
      connection.getMultipleAccounts(
        valid.map((item) => item.publicKey),
        {
          commitment: "confirmed",
          encoding: "base64",
        },
      ),
    );
    valid.forEach((item, index) => {
      const account = accounts[index];
      if (
        !account ||
        account.owner !== programId ||
        base64ToBytes(account.data[0]).length < 8 ||
        !Buffer.from(base64ToBytes(account.data[0]).subarray(0, 8)).equals(
          GAME_ACCOUNT_DISCRIMINATOR,
        )
      ) {
        stale.push(item.key);
      }
    });
  }
  return stale;
}
