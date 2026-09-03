export type GameType = "coinflip" | "giveaway";

export interface IndexerCursor {
  signature: string;
  slot: number;
}

export interface GameInitializedEvent extends IndexerCursor {
  gameKey: string;
  creator: string;
  gameType: GameType;
  ticketAmount: number;
  totalAmount: number;
  maxTickets: number;
  minTickets: number;
  tokenMint: string;
  isPrivate: boolean;
  createdAt: number;
  timeout: number;
}

export interface GameCompletedEvent extends IndexerCursor {
  gameKey: string;
  winner: string;
  winnerAmount: number;
  feeAmount: number;
  ticketsCount: number;
  timestamp: number;
}

export interface GameClosedEvent extends IndexerCursor {
  gameKey: string;
  timestamp: number;
}

export interface PlayerMembershipEvent extends IndexerCursor {
  kind: "joined" | "unjoined";
  gameKey: string;
  player: string;
  ticketsCount: number;
  ticketIndex: number;
  timestamp: number;
}

export interface IndexedEvents {
  initialized: GameInitializedEvent[];
  completed: GameCompletedEvent[];
  closed: GameClosedEvent[];
  membership: PlayerMembershipEvent[];
}

export interface ActiveGameRow {
  game_key: string;
  creator: string;
  ticket_amount: number;
  total_amount: number;
  max_tickets: number;
  min_tickets: number;
  current_tickets: number;
  token_mint: string;
  is_private: 0 | 1;
  created_at: number;
  timeout: number;
  signature: string;
  slot: number;
  indexed_at: number;
  game_type: GameType | null;
}

export interface LifecycleRow {
  signature: string;
  game_key: string;
  token_mint: string;
  status: "active" | "completed" | "cancelled";
  timestamp: number;
  slot: number;
  creator: string | null;
  game_type: GameType | null;
  ticket_amount: number | null;
  total_amount: number | null;
  max_tickets: number | null;
  min_tickets: number | null;
  is_private: 0 | 1 | null;
  created_at: number | null;
  timeout: number | null;
  winner: string | null;
  winner_amount: number | null;
  fee_amount: number | null;
  tickets_count: number | null;
}

export interface PlayerHistoryRow extends LifecycleRow {
  is_creator: 0 | 1;
  is_player: 0 | 1;
  is_joined: 0 | 1;
}

export interface HistoricalBackfillState {
  beforeSignature: string | null;
  pages: number;
  transactions: number;
  initializedEvents: number;
  closedEvents: number;
  complete: boolean;
}
