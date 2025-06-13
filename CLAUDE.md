# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Timba Oracle** is a TypeScript/Node.js Oracle service for Solana blockchain gaming applications. It provides cryptographic secret generation and automated game completion for multiple game types (Coinflip, Giveaway, Dumbflip, Snowball).

## Development Commands

```bash
# Install dependencies
bun install

# Development with hot reload
bun run dev

# Production start
bun start
```

## Architecture

### Core Components

- **`index.ts`** - HTTP API server with REST endpoints
- **`oracle-service.ts`** - Main Oracle service logic (singleton pattern)
- **`database.ts`** - SQLite database operations and schema management
- **`idl/`** - Solana program IDL definitions for blockchain integration

### API Endpoints

- `POST /generate-hash` - Generate game secrets (main functionality)
- `GET /health` - Service health and monitoring
- `GET /stats` - Oracle statistics
- `GET /` - API documentation

### Game Types and Secret Handling

**Oracle-Managed Games** (Coinflip, Giveaway):
- Oracle keeps secrets until game completion
- Event-driven automatic completion
- Maximum security for winner determination

**Client-Managed Games** (Dumbflip, Snowball):
- Secrets returned immediately to client
- Client handles completion logic
- Oracle provides monitoring only

### Event-Driven Architecture

The service uses a hybrid approach:
1. **Primary**: Real-time Solana event listeners (`GameInitialized`, `PlayerJoined`, `GameCompleted`)
2. **Fallback**: 5-minute periodic scanning for missed events
3. **Performance**: Cached game metadata to minimize blockchain calls

### Database Schema

**Tables:**
- `secret_keys` - Cryptographic secrets and hashes
- `game_tracking` - Game completion status
- `game_players` - Player participation tracking (with metadata caching)

## Configuration

Required environment variables in `.env`:
```bash
SOLANA_NETWORK=https://api.devnet.solana.com  # Required
ORACLE_PORT=3001                              # Optional (default: 3001)
```

Required files:
- `admin-keypair.json` - Solana admin wallet keypair (project root)

## Key Implementation Patterns

### Service Management
- **Singleton Pattern**: `OracleService` uses singleton with proper initialization
- **Graceful Shutdown**: Services handle cleanup on process termination
- **Error Resilience**: Comprehensive error handling with retry mechanisms

### Performance Optimizations
- **Metadata Caching**: Game metadata cached locally to avoid blockchain calls
- **Local Player Tracking**: Player counts tracked locally via events
- **Smart Fallbacks**: Blockchain queries only when cached data unavailable

### Database Operations
- **Atomic Transactions**: Database operations use transactions for consistency
- **Connection Management**: Proper SQLite connection handling
- **Migration Safety**: Database schema initialized on startup

### Blockchain Integration
- **Anchor Framework**: Uses `@coral-xyz/anchor` for Solana program interaction
- **Event Listening**: Real-time blockchain event processing
- **Keypair Management**: Secure admin keypair handling for transactions

## Runtime Environment

- **Runtime**: Bun (not Node.js)
- **Database**: SQLite (via Bun's built-in support)
- **TypeScript**: Strict mode enabled
- **Package Manager**: Bun (uses `bun.lock`)