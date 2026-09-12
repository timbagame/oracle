export type TimbaGameType = "coinflip" | "giveaway";

export interface ActiveTimbaGame {
  address: string;
  creator: string;
  type: TimbaGameType;
  tokenMint: string;
  stakeAmount: bigint;
  prizeAmount: bigint;
  currentPlayers: number;
  minPlayers: number;
  maxPlayers: number;
  isPrivate: boolean;
  createdAt: number;
  expiresAt: number;
  creationSignature: string;
  priceUsd?: number | null | undefined;
}

export interface TimbaGameAccount extends ActiveTimbaGame {
  lastSlot: bigint;
  participantAddresses: readonly string[];
}

export interface TransactionReview {
  action: "create" | "join" | "unjoin" | "cancel";
  gameAddress: string;
  walletAddress: string;
  tokenMint: string;
  tokenAmount: bigint;
  cluster: string;
}
