# Oracle API 🔮

A robust Oracle service for Solana-based games that generates cryptographic secrets and automatically completes games using event-driven architecture.

## ✨ Features

- **🔑 Cryptographic Secret Generation**: Secure random secret generation for new games
- **✍️ Initialization Approval**: Validates and partially signs creator-funded game transactions
- **🪙 Creation Policy**: Stores enabled mints and enforces a live USD minimum
- **🎯 Game Type Support**: Supports Coinflip and Giveaway games
- **🎧 Event-Driven Completion**: Real-time game completion via Solana event listeners
- **🔄 Fallback Scanning**: Periodic scanning as backup for missed events
- **📊 Real-Time Monitoring**: Health checks and comprehensive statistics
- **🛡️ Error Resilience**: Robust error handling and retry mechanisms
- **💾 Persistent Storage**: SQLite database for secret and game tracking
- **📈 Public Game Index**: VPS-hosted history, profiles, leaderboards, and cached statistics in a separate SQLite database
- **⚡ Optimized Performance**: Cached game metadata to minimize blockchain calls
- **🎲 Secure Secret Handling**: Secrets retained until game completion

## 🚀 Architecture

The Oracle service uses a hybrid approach with performance optimizations:

1. **Primary**: Event listeners for immediate game completion
2. **Fallback**: Periodic scanning every 5 minutes for missed events
3. **Database**: Persistent tracking of secrets and game states
4. **Caching**: Local game metadata cache to avoid unnecessary blockchain calls
5. **Public index**: Independent `indexer.sqlite` cursor and materialized statistics caches, woken by the shared live subscription

### Performance Optimizations

- **Cached Readiness Checks**: Game metadata (min/max players, timeout) is cached locally
- **Local Player Tracking**: Player count incremented locally on `PlayerJoined` events
- **Minimal Blockchain Calls**: Only fetch from blockchain when actually completing games
- **Smart Fallbacks**: Blockchain queries only when cached data is unavailable

## 📡 API Endpoints

| Endpoint                 | Method | Description                                           | Body Parameters       |
| ------------------------ | ------ | ----------------------------------------------------- | --------------------- |
| `/health`                | GET    | Service health                                        | None                  |
| `/generate-hash`         | POST   | Generate and retain a secret; return commitment       | `gameType` (optional) |
| `/sign-game-transaction` | POST   | Validate and partially sign game initialization       | `txBase64`            |
| `/token-policies`        | GET    | Return the current token creation policies            | None                  |
| `/stats`                 | GET    | Oracle statistics and metrics                         | None                  |
| `/games/complete-now`    | POST   | Attempt immediate completion of one tracked game      | `gameAddress`         |
| `/indexer/health`        | GET    | Public indexer health for authenticated callers       | None                  |
| `/indexer/api/*`         | GET    | Games, profiles, tokens, statistics, and leaderboards | Query-specific        |
| `/`                      | GET    | Generated API documentation                           | None                  |

All endpoints except `/health` and `/` require bearer authentication. Rootless Podman reads the token from the permission-checked `secrets/oracle-api-token` file; local development may use `ORACLE_API_TOKEN`. Administrative requeue, auto-complete, and token-policy controls are intentionally CLI-only:

```bash
bun run admin requeue <game-address>
bun run admin auto-complete <game-address> <on|off>
bun run admin token-policy list
bun run admin token-policy set <mint> <on|off>
```

The Oracle supports the Timba v0.2.0 and v0.3.0 IDLs. `CONTRACT_VERSION`
defaults to `0.2.0`, so this branch can run before the program upgrade. Change it
to `0.3.0` only after the v0.3.0 program is deployed. In v0.2.0 mode, the
contract's `GameToken` account enforces token creation policy. In v0.3.0 mode,
every initialization signature re-reads the durable Oracle policy for the
transaction mint. For enabled mints, it converts a USD 0.10 target to raw tokens
with the current Jupiter price. It accepts up to 5% below the recommendation so
small price changes do not reject a recently quoted amount. Prices are cached
for 60 seconds, and signing fails closed when a current price is unavailable.
Missing, disabled, and below-minimum policies are rejected with typed Protocol
errors.

Enabling a token reads its decimals from the initialized legacy SPL mint and
creates the Oracle operator's associated token account when it is missing. The
operator pays that one-time account rent and transaction fee.

### Game Types Supported

- **`coinflip`**: Traditional coinflip games (Oracle keeps secret until completion)
- **`giveaway`**: Giveaway games (Oracle keeps secret until completion)

## 🔧 Setup & Installation

### Prerequisites

- [Bun](https://bun.sh/) runtime
- Solana operator keypair file
- Access to a Solana RPC endpoint (mainnet-beta for production)

### Installation

1. **Clone and install dependencies**

   ```bash
   git clone <repository>
   cd oracle
   bun install
   ```

2. **Configure environment**

   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

3. **Place operator keypair**

   ```bash
   # Place the shared bot/oracle operator keypair in the project root
   cp /path/to/your/operator-keypair.json ./operator-keypair.json
   ```

4. **Start the Oracle**
   ```bash
   bun start
   ```

## ⚙️ Configuration

Configure via environment variables in `.env`:

```bash
# Required: Solana network endpoints (JSON array or comma-separated list); the oracle walks
# the ordered set automatically when it encounters transient RPC failures.
SOLANA_NETWORK=["https://api.mainnet-beta.solana.com","https://rpc-backup.example.com"]
# Optional: add rebate-address to Helius sendTransaction requests on every endpoint.
HELIUS_REBATE_ADDRESS=

# Keep 0.2.0 until the program upgrade; switch to 0.3.0 during migration.
CONTRACT_VERSION=0.2.0

# Optional: API server port (default: 3001)
ORACLE_PORT=3001
ORACLE_API_TOKEN=<shared-random-secret>

# Public history database and missed-event recovery interval. Live program events
# wake a prompt, coalesced cursor catch-up.
INDEXER_DATABASE_FILE=./indexer.sqlite
INDEXER_POLL_INTERVAL_MS=300000

# Required in production for USD prices and dynamic minimum amounts
JUPITER_API_KEY=<jupiter-api-key>

# Optional: allow the service to generate an ephemeral operator keypair when the
# configured keypair file is missing. This is automatically enabled during tests
# and CI runs to avoid checking sensitive keys into the repository.
# USE_FAKE_KEYPAIR=true
```

## 📋 Usage Examples

### Generate Game Secrets

#### Traditional Games (Coinflip, Giveaway)

```bash
curl -X POST http://localhost:3001/generate-hash \
  -H "Content-Type: application/json" \
  -d '{"gameType": "coinflip"}'
```

**Response:**

```json
{
  "success": true,
  "randomHash": "abc123...",
  "gameAddress": "def456..."
}
```

#### Default (No Game Type)

```bash
curl -X POST http://localhost:3001/generate-hash
```

**Response:**

```json
{
  "success": true,
  "randomHash": "abc123...",
  "gameAddress": "def456..."
}
```

### Check System Health

```bash
curl http://localhost:3001/health
```

**Response:**

```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "pendingGames": 5,
  "completedGames": 142,
  "eventListening": true,
  "activeListeners": 3
}
```

### View Statistics

```bash
curl http://localhost:3001/stats
```

**Response:**

```json
{
  "success": true,
  "stats": {
    "totalSecrets": 150,
    "usedSecrets": 142,
    "pendingGames": 5,
    "completedGames": 142,
    "eventListening": true,
    "activeListeners": 3
  }
}
```

## 🔍 How It Works

### Game Lifecycle

#### For Traditional Games (Coinflip, Giveaway)

1. **Secret Generation**

   - Client calls `/generate-hash` with `gameType: "coinflip"` or `"giveaway"`
   - Oracle generates cryptographic secret and hash
   - Stores secret in database and returns only hash to client (keeps secret secure)

2. **Game Creation**

   - The creator builds the transaction with itself as signer and fee payer
   - The oracle validates the unused commitment and transaction accounts, then partially signs through `/sign-game-transaction`
   - The creator adds its signature and submits the same transaction; neither private key leaves its device
   - Oracle detects `GameInitialized` event and starts tracking

3. **Player Joining**

   - Players join the game
   - Oracle detects `PlayerJoined` events
   - Checks if game is ready for completion

4. **Game Completion**
   - Oracle automatically completes game when conditions are met
   - Uses stored secret to determine winner fairly
   - Marks game as completed in database

### Game Type Differences

- **Coinflip/Giveaway**: Oracle-managed completion for security and fairness

### Event-Driven Architecture

The Oracle listens for three key events:

- `GameInitialized` - Start tracking new games
- `PlayerJoined` - Check if game ready for completion
- `GameCompleted` - Cleanup completed games

### Fallback Mechanism

If events are missed due to network issues, the Oracle:

- Scans pending games every 5 minutes
- Attempts completion for ready games
- Distinguishes between actual errors and games that are simply not ready yet
- Skips games that have failed too many times
- Retries transient failures at 5, 15, and 30 seconds, then pauses that game's automatic recovery for 5 minutes
- Persists the cooldown deadline so a process restart cannot immediately reopen the same retry burst; the fallback scan resumes recovery after the deadline

### Smart Error Handling

The Oracle intelligently categorizes completion attempts:

- **Completed**: Games successfully completed
- **Not Ready**: Games that aren't ready yet (normal state)
- **Errors**: Actual failures (network issues, invalid secrets, etc.)

This prevents normal "not ready" states from being reported as errors in logs and statistics.

## 🛠 Development

### Code Structure

```
├── oracle-service.ts    # Main Oracle service logic
├── database.ts          # SQLite database management
├── index.ts            # HTTP API server
├── idl/               # Solana program IDL files
└── README.md          # This file
```

### Testing

Run the test suite, optionally with coverage, and TypeScript checks to verify changes:

```bash
bun test
bun test --coverage  # view coverage
bun run typecheck
```

### Key Improvements

- **Constants Extraction**: All magic numbers and strings are now constants
- **Error Handling**: Comprehensive error handling with proper logging
- **Type Safety**: Full TypeScript interfaces for all data structures
- **Method Organization**: Focused methods with single responsibilities
- **Resource Management**: Proper cleanup and graceful shutdown

### Database Schema

**secret_keys table:**

- `game_address` (PRIMARY KEY)
- `secret_key` (encrypted secret)
- `random_hash` (public hash)
- `created_at` (timestamp)
- `used` (boolean flag)

**game_tracking table:**

- `game_address` (PRIMARY KEY)
- `status` (pending/completed)
- `last_checked` (timestamp)
- `completion_attempts` (retry counter)
- `completion_failure_kind` and `completion_retry_after` (transient/permanent failure state and persisted recovery cooldown)
- `completed_at` (completion timestamp)

**game_metadata table:** _(Performance optimization)_

- `game_address` (PRIMARY KEY)
- `min_players` (minimum players required)
- `max_players` (maximum players allowed)
- `expires_at` (game expiration timestamp)
- `current_players` (cached player count)

## 🔒 Security Features

- **Secret Isolation**: Secrets stored securely and marked as used after completion
- **Retry Limits**: Games that fail completion multiple times are skipped
- **Input Validation**: All inputs validated before processing
- **Error Logging**: Comprehensive logging without exposing sensitive data

## 📊 Monitoring

The Oracle provides comprehensive monitoring through:

- Health endpoint with real-time status
- Statistics tracking for all operations
- Detailed logging with emoji indicators
- Event listener status monitoring

## 🤝 Integration

### Frontend Integration

#### Traditional Games (Oracle-Managed)

```javascript
// Generate secrets for coinflip game
const response = await fetch("http://localhost:3001/generate-hash", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ gameType: "coinflip" }),
});
const { randomHash, gameAddress } = await response.json();

// Use randomHash in your game creation transaction
// Oracle will automatically complete the game when ready
```

### Smart Contract Integration

The Oracle works with Solana programs supporting multiple game types:

#### Oracle-Managed Games (Coinflip, Giveaway)

1. Uses the provided hash for game creation
2. Emits required events (`GameInitialized`, `PlayerJoined`, `GameCompleted`)
3. Oracle retains the secret key until winner determination
4. Oracle handles automatic completion when conditions are met

**Required Events for All Game Types:**

- `GameInitialized` - Game creation tracking
- `PlayerJoined`/`PlayerUnjoined` - Player state tracking
- `GameCompleted` - Completion confirmation

## Cross-repository integration

The shared local-validator suite lives in the sibling `operations/integration` directory. Run `bun run test:integration --web` from `operations`; see its README for pinned toolchains, candidate protocol packages and optional manual GitHub runs. Normal CI does not run the combined system suite or require a cross-repository credential.

`SOLANA_WS_ENDPOINT` optionally selects a WebSocket endpoint separately from `SOLANA_NETWORK`. `JUPITER_PRICE_URL` overrides the price endpoint for both signing policies and indexer pricing. The integration runner supplies local endpoints.

When `HELIUS_REBATE_ADDRESS` is set, Oracle applies it to Helius transaction submissions, including completion and token onboarding. Each configured endpoint gets the same handling when selected. Reads, WebSocket subscriptions, and non-Helius providers are unchanged.

## Web blockchain API

The authenticated `/web/*` routes move blockchain RPC, transaction construction,
and history verification off the Cloudflare Worker:

- `GET /web/config`: cached token configuration and prices.
- `POST /web/games/prepare`: validates terms/policy and returns an unsigned transaction.
  Requires `X-Timba-Contract-Version` matching `CONTRACT_VERSION`.
- `POST /web/games/submit`: validates and co-signs the user's transaction using the
  existing signing policy, then broadcasts the exact signed bytes.
- `GET /web/games/:address?fresh=1`: reads and decodes an active account.
- `GET /web/verification/:signature`: returns a persisted finalized verification record.

Web retains the public endpoint URLs and the private VPC transport. Deploy this
Oracle change before merging/deploying the dependent Web PR. Both repositories use
the existing Protocol 0.12.1 builders and request schemas; no package release is needed.

Verification records and background jobs live in `indexer.sqlite`. Newly indexed
completions queue a backfill after one minute, with one background job at a time and
exponential retry delays. Requests can backfill older records on demand. At most two
reconstructions run concurrently across background and HTTP work; duplicate reads
share the same work. No task is added to the critical payout/completion queue.

Reconstruction requires finalized, successful transactions, trusted program events,
initialization history, a valid commitment/game PDA, complete ticket replay, and a
matching calculated winner. Transactions sharing a slot are ordered using the block's
signature list, and events retain their log order. History is bounded to 2,000 signatures
and a two-minute RPC deadline; missing/pruned history or an exceeded budget returns
503 without storing an incomplete result. Failures and live account data are never
stored as immutable results. Public records contain only the on-chain revealed secret,
not unpublished oracle secrets, and include chain transaction references.
