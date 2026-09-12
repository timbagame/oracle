import { SolanaSignatureSchema } from "@timbagame/protocol/common";
import { FinalizedVerifiedGameSchema } from "@timbagame/protocol/web";
import { createHash } from "node:crypto";
import { getBase58Encoder, signature, type Address } from "@solana/kit";
import {
  decodeProgramEvent,
  getTrustedProgramData,
  type EventData,
} from "@timbagame/protocol/contracts/events";
import { calculateWinner } from "@timbagame/protocol/randomness";
import type { OracleRpc } from "../solana-kit.ts";
import type { VerifiedGameData } from "./verify-types.ts";
import { getGamePDA } from "./program.ts";
import { getTokenSymbol } from "./token-utils.ts";
import { getGameTokenMetadata } from "./game-token-config.ts";
import { tokensToAmount } from "./amounts.ts";

export const isValidSignature = (value: string) => SolanaSignatureSchema.safeParse(value).success;
const completeDiscriminator = Buffer.from([105, 69, 184, 5, 143, 182, 92, 132]);
type Event = NonNullable<ReturnType<typeof decodeProgramEvent>>;

/** Replay in transaction and log order; timestamps are not an ordering key. */
export function replayParticipants(events: readonly Event[], gameKey: string) {
  const participants: string[] = [];
  let lastSlot = 0n;
  for (const event of events) {
    if (!("gameKey" in event.data) || event.data.gameKey !== gameKey) continue;
    if (event.name === "PlayerJoined") {
      if (event.data.ticketIndex !== participants.length)
        throw new Error("Incomplete join history");
      participants.push(event.data.player);
      lastSlot = event.data.lastSlot;
    } else if (event.name === "PlayerUnjoined") {
      const index = event.data.ticketIndex;
      if (participants[index] !== event.data.player) throw new Error("Incomplete unjoin history");
      const last = participants.pop()!;
      if (index < participants.length) participants[index] = last;
      lastSlot = event.data.lastSlot;
    }
    if (
      (event.name === "PlayerJoined" || event.name === "PlayerUnjoined") &&
      participants.length !== event.data.ticketsCount
    )
      throw new Error("Incomplete ticket history");
  }
  return { participants, lastSlot };
}

/** Only finalized, complete, internally consistent chain records can be persisted. */
export async function verifyGameTransaction(
  rpc: OracleRpc,
  programId: Address,
  value: string,
): Promise<VerifiedGameData> {
  if (!isValidSignature(value)) throw new Error("Invalid signature");
  const abortSignal = AbortSignal.timeout(120_000);
  const load = (value: string) =>
    rpc
      .getTransaction(signature(value), {
        commitment: "finalized",
        encoding: "json",
        maxSupportedTransactionVersion: 0,
      })
      .send({ abortSignal });
  const completedTx = await load(value);
  if (!completedTx?.meta || completedTx.meta.err || !completedTx.meta.logMessages)
    throw new Error("Finalized transaction unavailable");
  const decode = (logs: readonly string[]) =>
    getTrustedProgramData(logs, programId)
      .map(decodeProgramEvent)
      .filter((event): event is Event => event !== null);
  const completed = decode(completedTx.meta.logMessages).find(
    (event) => event.name === "GameCompleted",
  );
  if (!completed || completed.name !== "GameCompleted") throw new Error("Not a completed game");
  const game = completed.data;
  const keys = [
    ...completedTx.transaction.message.accountKeys,
    ...(completedTx.meta.loadedAddresses?.writable ?? []),
    ...(completedTx.meta.loadedAddresses?.readonly ?? []),
  ];
  let secret: Buffer | undefined;
  let commitment: Buffer | undefined;
  let submittedWinner: number | undefined;
  for (const ix of completedTx.transaction.message.instructions) {
    if (keys[ix.programIdIndex] !== programId || keys[ix.accounts[0]!] !== game.gameKey) continue;
    const data = Buffer.from(getBase58Encoder().encode(ix.data));
    if (data.length < 76 || !data.subarray(0, 8).equals(completeDiscriminator)) continue;
    commitment = data.subarray(8, 40);
    secret = data.subarray(40, 72);
    submittedWinner = data.readUInt32LE(72);
    break;
  }
  if (
    !secret ||
    !commitment ||
    !createHash("sha256").update(secret).digest().equals(commitment) ||
    (await getGamePDA(commitment)) !== game.gameKey
  )
    throw new Error("Invalid revealed commitment");

  const transactions = new Map<string, NonNullable<typeof completedTx>>([[value, completedTx]]);
  let before: ReturnType<typeof signature> | undefined;
  let initialized: EventData<"GameInitialized"> | undefined;
  // Bounded backfill. Refuse to invent a result if archived history exceeds the budget or is missing.
  for (let page = 0; page < 20 && !initialized; page++) {
    const signatures = await rpc
      .getSignaturesForAddress(game.gameKey, { limit: 100, before, commitment: "finalized" })
      .send({ abortSignal });
    if (!signatures.length) break;
    for (const info of signatures) {
      if (info.err || info.slot > completedTx.slot || info.signature === value) continue;
      const tx = await load(info.signature);
      if (!tx?.meta || tx.meta.err || !tx.meta.logMessages)
        throw new Error("Incomplete transaction history");
      transactions.set(info.signature, tx);
      const init = decode(tx.meta.logMessages).find(
        (event) => event.name === "GameInitialized" && event.data.gameKey === game.gameKey,
      );
      if (init?.name === "GameInitialized") initialized = init.data;
    }
    before = signatures.at(-1)!.signature;
  }
  if (!initialized) throw new Error("Initialization history unavailable");
  const ordered = [...transactions.entries()].sort((a, b) =>
    a[1].slot < b[1].slot ? -1 : a[1].slot > b[1].slot ? 1 : 0,
  );
  const positions = new Map<string, number>();
  for (const slot of new Set(ordered.map(([, tx]) => tx.slot))) {
    const sameSlot = ordered.filter(([, tx]) => tx.slot === slot);
    if (sameSlot.length < 2) continue;
    const block = await rpc
      .getBlock(slot, { commitment: "finalized", transactionDetails: "signatures", rewards: false })
      .send({ abortSignal });
    if (!block) throw new Error("Transaction order unavailable");
    for (const [sig] of sameSlot) {
      const index = block.signatures.indexOf(signature(sig));
      if (index < 0) throw new Error("Transaction order unavailable");
      positions.set(sig, index);
    }
  }
  ordered.sort((a, b) =>
    a[1].slot < b[1].slot
      ? -1
      : a[1].slot > b[1].slot
        ? 1
        : positions.get(a[0])! - positions.get(b[0])!,
  );
  const events: Event[] = [];
  let started = false;
  let finished = false;
  for (const [sig, tx] of ordered) {
    for (const event of decode(tx.meta!.logMessages!)) {
      if (!("gameKey" in event.data) || event.data.gameKey !== game.gameKey) continue;
      if (event.name === "GameInitialized") started = true;
      if (!started) continue;
      if (event.name === "GameCompleted" && sig === value) {
        finished = true;
        break;
      }
      events.push(event);
    }
    if (finished) break;
  }
  if (!started || !finished) throw new Error("Incomplete game history");
  const { participants, lastSlot } = replayParticipants(events, game.gameKey);
  if (participants.length !== game.ticketsCount || !participants.length)
    throw new Error("Ticket count mismatch");
  const result = await calculateWinner(secret, lastSlot, BigInt(game.ticketsCount));
  if (result.winnerIndex !== submittedWinner || participants[result.winnerIndex] !== game.winner)
    throw new Error("Winner mismatch");
  const metadata = (await getGameTokenMetadata(rpc, [initialized.tokenMint])).get(
    initialized.tokenMint,
  );
  if (!metadata) throw new Error("Token metadata unavailable");
  const decimals = metadata.decimals;
  return FinalizedVerifiedGameSchema.parse({
    gameKey: game.gameKey,
    signature: value,
    timestamp: Number(game.timestamp),
    gameType: initialized.gameType,
    creator: initialized.creator,
    isPrivate: initialized.isPrivate,
    ticketAmount: tokensToAmount(initialized.ticketAmount, decimals),
    totalAmount: tokensToAmount(initialized.totalAmount, decimals),
    maxTickets: initialized.maxTickets,
    createdAt: Number(initialized.createdAt),
    participants: participants.map((address, index) => ({
      address,
      ticketCount: 1,
      ticketIndices: [index],
    })),
    totalTickets: game.ticketsCount,
    winner: game.winner,
    winnerTicketIndex: result.winnerIndex,
    prizeAmount: tokensToAmount(game.winnerAmount, decimals),
    feeAmount: tokensToAmount(game.feeAmount, decimals),
    tokenMint: initialized.tokenMint,
    tokenSymbol: getTokenSymbol(initialized.tokenMint),
    tokenDecimals: decimals,
    randomValue: result.randomValue.toString(),
    secretKey: secret.toString("hex"),
    randomHash: commitment.toString("hex"),
    lastSlot: lastSlot.toString(),
    transactionSignatures: ordered
      .slice(0, ordered.findIndex(([sig]) => sig === value) + 1)
      .map(([sig]) => sig),
    calculationBreakdown: {
      randomValue: result.randomValue.toString(),
      totalTickets: game.ticketsCount,
      winnerIndex: result.winnerIndex,
      formula: `u64_le_window(SHA-256(secret || ${lastSlot}_le)) % ${game.ticketsCount} = ${result.winnerIndex}`,
    },
    explorerUrl: `https://solscan.io/tx/${value}`,
  });
}
