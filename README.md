# Oracle API 🔮

A robust Oracle service for Solana-based games that generates cryptographic secrets and automatically completes games using event-driven architecture.

## ✨ Features

- **🔑 Cryptographic Secret Generation**: Secure random secret generation for new games
- **✍️ Initialization Approval**: Validates and partially signs creator-funded game transactions
- **🎯 Game Type Support**: Supports Coinflip and Giveaway games
- **🎧 Event-Driven Completion**: Real-time game completion via Solana event listeners
- **🔄 Fallback Scanning**: Periodic scanning as backup for missed events
- **📊 Real-Time Monitoring**: Health checks and comprehensive statistics
- **🛡️ Error Resilience**: Robust error handling and retry mechanisms
- **💾 Persistent Storage**: SQLite database for secret and game tracking
- **⚡ Optimized Performance**: Cached game metadata to minimize blockchain calls
- **🎲 Secure Secret Handling**: Secrets retained until game completion

## 🚀 Architecture

The Oracle service uses a hybrid approach with performance optimizations:

1. **Primary**: Event listeners for immediate game completion
2. **Fallback**: Periodic scanning every 5 minutes for missed events
3. **Database**: Persistent tracking of secrets and game states
4. **Caching**: Local game metadata cache to avoid unnecessary blockchain calls

### Performance Optimizations

- **Cached Readiness Checks**: Game metadata (min/max players, timeout) is cached locally
- **Local Player Tracking**: Player count incremented locally on `PlayerJoined` events
- **Minimal Blockchain Calls**: Only fetch from blockchain when actually completing games
- **Smart Fallbacks**: Blockchain queries only when cached data is unavailable

## 📡 API Endpoints

| Endpoint                  | Method | Description                                      | Body Parameters                              |
| ------------------------- | ------ | ------------------------------------------------ | -------------------------------------------- |
| `/health`                 | GET    | Service health                                   | None                                         |
| `/generate-hash`          | POST   | Generate and retain a secret; return commitment  | `gameType` (optional)                        |
| `/sign-game-transaction`  | POST   | Validate and partially sign game initialization  | `txBase64`                                   |
| `/stats`                  | GET    | Oracle statistics and metrics                    | None                                         |
| `/games/complete-now`     | POST   | Attempt immediate completion of one tracked game | `gameAddress`                                |
| `/`                       | GET    | Generated API documentation                      | None                                         |

All endpoints except `/health` and `/` require bearer authentication. Rootless Podman reads the token from the permission-checked `secrets/oracle-api-token` file; local development may use `ORACLE_API_TOKEN`. Administrative requeue and auto-complete controls are intentionally CLI-only:

```bash
bun run admin requeue <game-address>
bun run admin auto-complete <game-address> <on|off>
```

### Game Types Supported

- **`coinflip`**: Traditional coinflip games (Oracle keeps secret until completion)
- **`giveaway`**: Giveaway games (Oracle keeps secret until completion)

## 🔧 Setup & Installation

### Prerequisites

- [Bun](https://bun.sh/) runtime
- Solana admin keypair file
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

3. **Place admin keypair**

   ```bash
   # Place your admin-keypair.json in the project root
   cp /path/to/your/admin-keypair.json ./admin-keypair.json
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

# Optional: API server port (default: 3001)
ORACLE_PORT=3001
ORACLE_API_TOKEN=<shared-random-secret>

# Optional: allow the service to generate an ephemeral admin keypair when the
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
