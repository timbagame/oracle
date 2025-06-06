# Oracle API 🔮

A robust Oracle service for Solana-based games that generates cryptographic secrets and automatically completes games using event-driven architecture.

## ✨ Features

- **🔑 Cryptographic Secret Generation**: Secure random secret generation for new games
- **🎯 Multi-Game Type Support**: Supports Coinflip, Giveaway, Dumbflip, and Snowball games
- **🎧 Event-Driven Completion**: Real-time game completion via Solana event listeners
- **🔄 Fallback Scanning**: Periodic scanning as backup for missed events
- **📊 Real-Time Monitoring**: Health checks and comprehensive statistics
- **🛡️ Error Resilience**: Robust error handling and retry mechanisms
- **💾 Persistent Storage**: SQLite database for secret and game tracking
- **⚡ Optimized Performance**: Cached game metadata to minimize blockchain calls
- **🎲 Flexible Secret Handling**: Returns secret keys immediately for Dumbflip and Snowball games

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

| Endpoint         | Method | Description                    | Body Parameters       |
| ---------------- | ------ | ------------------------------ | --------------------- |
| `/health`        | GET    | System health and status       | None                  |
| `/generate-hash` | POST   | Generate secrets for new games | `gameType` (optional) |
| `/stats`         | GET    | Oracle statistics and metrics  | None                  |
| `/`              | GET    | API documentation              | None                  |

### Game Types Supported

- **`coinflip`**: Traditional coinflip games (Oracle keeps secret until completion)
- **`giveaway`**: Giveaway games (Oracle keeps secret until completion)
- **`dumbflip`**: Dumbflip games (Secret returned immediately)
- **`snowball`**: Snowball games (Secret returned immediately)

## 🔧 Setup & Installation

### Prerequisites

- [Bun](https://bun.sh/) runtime
- Solana admin keypair file
- Access to Solana network (devnet/mainnet)

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
# Required: Solana network endpoint
SOLANA_NETWORK=https://api.devnet.solana.com

# Optional: API server port (default: 3001)
ORACLE_PORT=3001
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

#### Dumbflip/Snowball Games

```bash
curl -X POST http://localhost:3001/generate-hash \
  -H "Content-Type: application/json" \
  -d '{"gameType": "dumbflip"}'
```

**Response:**

```json
{
  "success": true,
  "randomHash": "abc123...",
  "gameAddress": "def456...",
  "secretKey": "789xyz..."
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

   - Client creates game on-chain using the provided hash
   - Oracle detects `GameInitialized` event and starts tracking

3. **Player Joining**

   - Players join the game
   - Oracle detects `PlayerJoined` events
   - Checks if game is ready for completion

4. **Game Completion**
   - Oracle automatically completes game when conditions are met
   - Uses stored secret to determine winner fairly
   - Marks game as completed in database

#### For Immediate-Secret Games (Dumbflip, Snowball)

1. **Secret Generation**

   - Client calls `/generate-hash` with `gameType: "dumbflip"` or `"snowball"`
   - Oracle generates cryptographic secret and hash
   - Stores secret in database and returns both hash and secret to client

2. **Game Creation & Management**
   - Client creates game and handles completion using the provided secret
   - Oracle still tracks the game for monitoring and statistics
   - Client is responsible for fair winner determination

### Game Type Differences

- **Coinflip/Giveaway**: Oracle-managed completion for maximum security and fairness
- **Dumbflip/Snowball**: Client-managed completion for immediate gameplay and special mechanics

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

#### Immediate-Secret Games (Client-Managed)

```javascript
// Generate secrets for dumbflip game
const response = await fetch("http://localhost:3001/generate-hash", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ gameType: "dumbflip" }),
});
const { randomHash, gameAddress, secretKey } = await response.json();

// Use randomHash for game creation
// Use secretKey for immediate winner determination
// Client handles game completion logic
```

### Smart Contract Integration

The Oracle works with Solana programs supporting multiple game types:

#### Oracle-Managed Games (Coinflip, Giveaway)

1. Uses the provided hash for game creation
2. Emits required events (`GameInitialized`, `PlayerJoined`, `GameCompleted`)
3. Accepts the secret key from Oracle for winner determination
4. Oracle handles automatic completion when conditions are met

#### Client-Managed Games (Dumbflip, Snowball)

1. Uses the provided hash for game creation
2. Client receives secret key immediately for game logic
3. Supports special game mechanics like `rollSnowballGame` instruction
4. Oracle provides monitoring and statistics tracking

**Required Events for All Game Types:**

- `GameInitialized` - Game creation tracking
- `PlayerJoined`/`PlayerUnjoined` - Player state tracking
- `GameCompleted` - Completion confirmation
