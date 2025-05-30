# Oracle API 🔮

A simple Oracle service for Solana Coinflip games that generates random secrets and automatically completes games when ready.

## 🚀 Features

- **Random Secret Generation**: Creates cryptographic secrets for new games
- **Automatic Game Completion**: Scans and completes games every 30 seconds
- **Simple REST API**: Easy-to-use endpoints for game management
- **Database Tracking**: Stores secrets and tracks game status

## 📡 API Endpoints

- `GET /health` - System health check
- `POST /generate-hash` - Generate secrets for new games
- `POST /complete-game` - Manually complete a specific game
- `GET /stats` - Basic Oracle statistics
- `GET /` - API documentation

## 🔧 Setup

1. **Install dependencies**

   ```bash
   bun install
   ```

2. **Configure environment**

   ```bash
   cp env.example .env
   # Edit .env with your Solana network URL
   ```

3. **Start the Oracle**
   ```bash
   bun start
   ```

## 📋 Usage

### Generate Game Secrets

```bash
curl -X POST http://localhost:3001/generate-hash
```

Returns:

```json
{
  "success": true,
  "randomHash": "abc123...",
  "gameAddress": "def456..."
}
```

### Check Health

```bash
curl http://localhost:3001/health
```

### View Statistics

```bash
curl http://localhost:3001/stats
```

## 🔍 How It Works

1. **Game Creation**: Call `/generate-hash` to get secrets for new games
2. **Background Processing**: Oracle automatically scans every 30 seconds
3. **Game Completion**: Automatically completes games when ready (full or expired)
4. **Secret Management**: Stores and manages cryptographic secrets securely

## 🛠 Configuration

Set environment variables in `.env`:

```bash
SOLANA_NETWORK=https://api.devnet.solana.com
ORACLE_PORT=3001
```

## 📊 Database

The Oracle maintains two simple tables:

- `secret_keys` - Game secrets and usage tracking
- `game_tracking` - Game status and completion attempts

Games that fail completion more than 5 times are automatically skipped to prevent infinite retry loops.

## 🔗 Integration

Use with your game client:

1. Call `/generate-hash` before creating a game
2. Use the returned `randomHash` in your game creation transaction
3. The Oracle will automatically complete the game when conditions are met

That's it! The Oracle handles all the complexity behind the scenes.
