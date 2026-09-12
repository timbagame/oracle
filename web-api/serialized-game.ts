import type { TimbaGameAccount } from "./types.ts";

export interface SerializedTimbaGameAccount {
  address: string;
  creator: string;
  type: TimbaGameAccount["type"];
  tokenMint: string;
  stakeAmount: string;
  prizeAmount: string;
  currentPlayers: number;
  minPlayers: number;
  maxPlayers: number;
  isPrivate: boolean;
  createdAt: number;
  expiresAt: number;
  lastSlot: string;
  participantAddresses: readonly string[];
}

export function serializeGame(game: TimbaGameAccount): SerializedTimbaGameAccount {
  return {
    ...game,
    stakeAmount: game.stakeAmount.toString(),
    prizeAmount: game.prizeAmount.toString(),
    lastSlot: game.lastSlot.toString(),
  };
}

export function deserializeGame(game: SerializedTimbaGameAccount): TimbaGameAccount {
  return {
    ...game,
    creationSignature: "",
    stakeAmount: BigInt(game.stakeAmount),
    prizeAmount: BigInt(game.prizeAmount),
    lastSlot: BigInt(game.lastSlot),
  };
}
