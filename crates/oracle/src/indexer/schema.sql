CREATE TABLE IF NOT EXISTS verification_jobs (signature TEXT PRIMARY KEY, next_attempt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS verified_games (cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS games (
  signature TEXT PRIMARY KEY, game_key TEXT NOT NULL, winner TEXT NOT NULL,
  winner_amount INTEGER NOT NULL, fee_amount INTEGER NOT NULL,
  tickets_count INTEGER NOT NULL, token_mint TEXT NOT NULL,
  timestamp INTEGER NOT NULL, slot INTEGER NOT NULL, indexed_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_games_game_key_unique ON games(game_key);
CREATE INDEX IF NOT EXISTS idx_games_timestamp ON games(timestamp DESC, slot DESC);
CREATE INDEX IF NOT EXISTS idx_games_winner ON games(winner);
CREATE INDEX IF NOT EXISTS idx_games_token ON games(token_mint, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_games_token_biggest ON games(token_mint, winner_amount DESC, slot DESC);

CREATE TABLE IF NOT EXISTS active_games (
  game_key TEXT PRIMARY KEY, creator TEXT NOT NULL, ticket_amount INTEGER NOT NULL,
  total_amount INTEGER NOT NULL, max_tickets INTEGER NOT NULL,
  min_tickets INTEGER NOT NULL, current_tickets INTEGER NOT NULL DEFAULT 0,
  token_mint TEXT NOT NULL, is_private INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, timeout INTEGER NOT NULL, signature TEXT NOT NULL,
  slot INTEGER NOT NULL, indexed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_active_created ON active_games(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_active_creator ON active_games(creator);

CREATE TABLE IF NOT EXISTS active_game_players (
  game_key TEXT NOT NULL, player TEXT NOT NULL, ticket_index INTEGER NOT NULL,
  joined_at INTEGER NOT NULL, is_joined INTEGER NOT NULL, updated_slot INTEGER NOT NULL,
  PRIMARY KEY (game_key, player),
  FOREIGN KEY (game_key) REFERENCES active_games(game_key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_active_player ON active_game_players(player, is_joined);

CREATE TABLE IF NOT EXISTS game_players (
  game_key TEXT NOT NULL, player TEXT NOT NULL, ticket_index INTEGER NOT NULL,
  joined_at INTEGER NOT NULL, is_joined INTEGER NOT NULL, updated_slot INTEGER NOT NULL,
  PRIMARY KEY (game_key, player)
);
CREATE INDEX IF NOT EXISTS idx_game_players_player ON game_players(player, is_joined);

CREATE TABLE IF NOT EXISTS gameplay_events (
  signature TEXT PRIMARY KEY, game_key TEXT NOT NULL, token_mint TEXT NOT NULL,
  timestamp INTEGER NOT NULL, slot INTEGER NOT NULL, indexed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gameplay_token ON gameplay_events(token_mint);

CREATE TABLE IF NOT EXISTS game_initializations (
  game_key TEXT PRIMARY KEY, signature TEXT NOT NULL, creator TEXT NOT NULL,
  game_type TEXT NOT NULL CHECK (game_type IN ('coinflip', 'giveaway')),
  ticket_amount INTEGER NOT NULL, total_amount INTEGER NOT NULL,
  max_tickets INTEGER NOT NULL, min_tickets INTEGER NOT NULL, token_mint TEXT NOT NULL,
  is_private INTEGER NOT NULL, created_at INTEGER NOT NULL, timeout INTEGER NOT NULL,
  slot INTEGER NOT NULL, indexed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS game_closures (
  game_key TEXT PRIMARY KEY, signature TEXT NOT NULL, timestamp INTEGER NOT NULL,
  slot INTEGER NOT NULL, indexed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS game_lifecycle (
  game_key TEXT PRIMARY KEY, signature TEXT NOT NULL, token_mint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
  creator TEXT, game_type TEXT CHECK (game_type IN ('coinflip', 'giveaway')),
  ticket_amount INTEGER, total_amount INTEGER, max_tickets INTEGER, min_tickets INTEGER,
  is_private INTEGER, created_at INTEGER, timestamp INTEGER NOT NULL,
  slot INTEGER NOT NULL, indexed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_timestamp ON game_lifecycle(timestamp DESC, slot DESC);
CREATE INDEX IF NOT EXISTS idx_lifecycle_token_timestamp ON game_lifecycle(token_mint, timestamp DESC, slot DESC);
CREATE INDEX IF NOT EXISTS idx_lifecycle_type_timestamp ON game_lifecycle(game_type, timestamp DESC, slot DESC);
CREATE INDEX IF NOT EXISTS idx_lifecycle_creator ON game_lifecycle(creator, timestamp DESC);
DROP INDEX IF EXISTS idx_lifecycle_token;

CREATE TABLE IF NOT EXISTS indexer_state (
  name TEXT PRIMARY KEY, signature TEXT NOT NULL, slot INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS historical_backfill (
  name TEXT PRIMARY KEY, before_signature TEXT, pages INTEGER NOT NULL DEFAULT 0,
  transactions INTEGER NOT NULL DEFAULT 0, initialized_events INTEGER NOT NULL DEFAULT 0,
  closed_events INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Retained for direct compatibility with a Cloudflare D1 export.
CREATE TABLE IF NOT EXISTS stats_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1), total_games INTEGER NOT NULL DEFAULT 0,
  total_volume INTEGER NOT NULL DEFAULT 0, total_fees INTEGER NOT NULL DEFAULT 0,
  unique_players INTEGER NOT NULL DEFAULT 0, biggest_win_amount INTEGER NOT NULL DEFAULT 0,
  biggest_win_winner TEXT, biggest_win_signature TEXT, last_indexed_signature TEXT,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO stats_cache
  (id, total_games, total_volume, total_fees, unique_players, biggest_win_amount, updated_at)
VALUES (1, 0, 0, 0, 0, 0, 0);

CREATE TABLE IF NOT EXISTS token_stats_cache (
  token_mint TEXT PRIMARY KEY, games INTEGER NOT NULL, total_volume INTEGER NOT NULL,
  unique_players INTEGER NOT NULL, total_fees INTEGER NOT NULL,
  biggest_win_amount INTEGER, biggest_win_winner TEXT,
  biggest_win_signature TEXT, latest_timestamp INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS token_summary_cache (
  token_mint TEXT PRIMARY KEY, games INTEGER NOT NULL, latest_timestamp INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS leaderboard_cache (
  scope TEXT NOT NULL, player TEXT NOT NULL, games_won INTEGER NOT NULL,
  total_winnings INTEGER, avg_win REAL, PRIMARY KEY (scope, player)
);
CREATE INDEX IF NOT EXISTS idx_leaderboard_rank
  ON leaderboard_cache(scope, games_won DESC, total_winnings DESC);
