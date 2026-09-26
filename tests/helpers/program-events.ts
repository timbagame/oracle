import {
  getAddressEncoder,
  getStructEncoder,
  getU32Encoder,
  getU64Encoder,
  getU8Encoder,
  type Address,
  type Encoder,
} from "@solana/kit";
import { EVENT_DISCRIMINATORS } from "@timbagame/protocol/contracts/events";

/** Encodes Timba program events exactly as the on-chain program logs them. */
const key = getAddressEncoder();
const u64 = getU64Encoder();
const u32 = getU32Encoder();

function withDiscriminator(
  name: keyof typeof EVENT_DISCRIMINATORS,
  encoder: Encoder<any>,
  value: unknown,
): Buffer {
  return Buffer.concat([
    Buffer.from(EVENT_DISCRIMINATORS[name]),
    Buffer.from(encoder.encode(value)),
  ]);
}

export function gameInitializedEvent(value: {
  gameKey: Address;
  creator: Address;
  gameType?: number;
  ticketAmount?: bigint;
  totalAmount?: bigint;
  maxTickets?: number;
  minTickets?: number;
  tokenMint: Address;
  isPrivate?: number;
  createdAt?: bigint;
  timeout?: bigint;
}): Buffer {
  return withDiscriminator(
    "GameInitialized",
    getStructEncoder([
      ["gameKey", key],
      ["creator", key],
      ["gameType", getU8Encoder()],
      ["ticketAmount", u64],
      ["totalAmount", u64],
      ["maxTickets", u32],
      ["minTickets", u32],
      ["tokenMint", key],
      ["isPrivate", getU8Encoder()],
      ["createdAt", u64],
      ["timeout", u64],
    ]),
    {
      gameType: 0,
      ticketAmount: 100n,
      totalAmount: 0n,
      maxTickets: 2,
      minTickets: 2,
      isPrivate: 0,
      createdAt: 1_000n,
      timeout: 3_600n,
      ...value,
    },
  );
}

export function gameCompletedEvent(value: {
  gameKey: Address;
  winner: Address;
  ticketsCount?: number;
  winnerAmount?: bigint;
  feeAmount?: bigint;
  timestamp?: bigint;
}): Buffer {
  return withDiscriminator(
    "GameCompleted",
    getStructEncoder([
      ["gameKey", key],
      ["winner", key],
      ["ticketsCount", u32],
      ["winnerAmount", u64],
      ["feeAmount", u64],
      ["timestamp", u64],
    ]),
    { ticketsCount: 2, winnerAmount: 190n, feeAmount: 10n, timestamp: 2_000n, ...value },
  );
}

export function gameClosedEvent(value: { gameKey: Address; timestamp?: bigint }): Buffer {
  return withDiscriminator(
    "GameClosed",
    getStructEncoder([
      ["gameKey", key],
      ["timestamp", u64],
    ]),
    { timestamp: 3_000n, ...value },
  );
}

export function operatorGameClosedEvent(value: {
  gameKey: Address;
  creator: Address;
  operator: Address;
  timestamp?: bigint;
}): Buffer {
  return withDiscriminator(
    "OperatorGameClosed",
    getStructEncoder([
      ["gameKey", key],
      ["creator", key],
      ["operator", key],
      ["refundedAmount", u64],
      ["recoveredLamports", u64],
      ["timestamp", u64],
    ]),
    { refundedAmount: 100n, recoveredLamports: 5n, timestamp: 4_000n, ...value },
  );
}

export function playerJoinedEvent(value: {
  gameKey: Address;
  player: Address;
  totalAmount?: bigint;
  ticketsCount?: number;
  ticketIndex?: number;
  lastSlot?: bigint;
  timestamp?: bigint;
}): Buffer {
  return withDiscriminator(
    "PlayerJoined",
    getStructEncoder([
      ["gameKey", key],
      ["player", key],
      ["totalAmount", u64],
      ["ticketsCount", u32],
      ["ticketIndex", u32],
      ["lastSlot", u64],
      ["timestamp", u64],
    ]),
    {
      totalAmount: 100n,
      ticketsCount: 1,
      ticketIndex: 0,
      lastSlot: 10n,
      timestamp: 1_500n,
      ...value,
    },
  );
}

export function playerUnjoinedEvent(value: {
  gameKey: Address;
  player: Address;
  movedParticipant?: Address;
  ticketsCount?: number;
  ticketIndex?: number;
  timestamp?: bigint;
}): Buffer {
  const head = Buffer.from(
    getStructEncoder([
      ["gameKey", key],
      ["player", key],
      ["totalAmount", u64],
      ["ticketsCount", u32],
      ["ticketIndex", u32],
    ]).encode({
      gameKey: value.gameKey,
      player: value.player,
      totalAmount: 100n,
      ticketsCount: value.ticketsCount ?? 1,
      ticketIndex: value.ticketIndex ?? 0,
    }),
  );
  const moved = value.movedParticipant
    ? Buffer.concat([Buffer.from([1]), Buffer.from(key.encode(value.movedParticipant))])
    : Buffer.from([0]);
  return Buffer.concat([
    Buffer.from(EVENT_DISCRIMINATORS.PlayerUnjoined),
    head,
    moved,
    Buffer.from(u64.encode(20n)),
    Buffer.from(u64.encode(value.timestamp ?? 1_600n)),
  ]);
}

/** Wraps event payloads in the log lines of a top-level program invocation. */
export function programLogs(programId: string, events: Buffer[]): string[] {
  return [
    `Program ${programId} invoke [1]`,
    ...events.map((event) => `Program data: ${event.toString("base64")}`),
    `Program ${programId} success`,
  ];
}
