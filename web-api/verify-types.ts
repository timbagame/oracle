export interface VerifiedGameData {
  gameKey: string;
  signature: string;
  timestamp: number;
  gameType?: "coinflip" | "giveaway";
  creator?: string;
  isPrivate?: boolean;
  ticketAmount?: number;
  totalAmount?: number;
  maxTickets?: number;
  createdAt?: number;

  participants: {
    address: string;
    ticketCount: number;
    ticketIndices: number[];
  }[];
  totalTickets: number;

  winner: string;
  winnerTicketIndex: number;
  prizeAmount: number;
  feeAmount: number;

  tokenMint: string;
  tokenSymbol: string;
  tokenDecimals: number;

  randomValue: string;
  secretKey?: string;
  randomHash?: string;
  transactionSignatures?: string[];
  lastSlot?: string;

  calculationBreakdown: {
    randomValue: string;
    totalTickets: number;
    winnerIndex: number;
    formula: string;
  };

  explorerUrl: string;
}
