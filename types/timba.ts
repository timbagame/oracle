import type * as anchor from "@coral-xyz/anchor";
import type { PublicKeyLike } from "../solana-utils.ts";

export type NumericLike =
  | number
  | bigint
  | anchor.BN
  | { toNumber(): number }
  | { valueOf(): number | bigint };

export interface TimbaEventPayload {
  gameKey?: PublicKeyLike;
  gameAddress?: PublicKeyLike;
  game?: PublicKeyLike;
  [key: string]: unknown;
}

export interface TimbaPlayerEvent extends TimbaEventPayload {
  player?: PublicKeyLike;
  playerAddress?: PublicKeyLike;
  ticketIndex?: NumericLike;
  ticket_index?: NumericLike;
}

export interface TimbaGameInitializedEvent extends TimbaEventPayload {
  gameType?: Record<string, unknown>;
}

export interface TimbaGameStatusEvent extends TimbaEventPayload {}

export interface TimbaEventMap {
  playerJoined: TimbaPlayerEvent;
  playerUnjoined: TimbaPlayerEvent;
  gameInitialized: TimbaGameInitializedEvent;
  gameCompleted: TimbaGameStatusEvent;
  gameClosed: TimbaGameStatusEvent;
}

export type TimbaEvent = TimbaEventMap[keyof TimbaEventMap];

export interface TimbaGameAccount {
  creator: PublicKeyLike;
  tokenMint: PublicKeyLike;
  tokenProgram?: PublicKeyLike | null;
  ticketsCount: NumericLike;
  maxTickets: NumericLike;
  minTickets: NumericLike;
  lastSlot: NumericLike;
  timeout: NumericLike;
  createdAt: NumericLike;
  [key: string]: unknown;
}
