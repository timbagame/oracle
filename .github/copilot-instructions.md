# Timba Oracle AI Guide

## Architecture Snapshot
- index.ts runs Bun's HTTP server, wires REST handlers from buildHandlers to an OracleService-backed API, and supervises a 5 min fallback scan loop via ScanLoopRunner.
- OracleService (oracle-service.ts) orchestrates OracleEventProcessor, GameCompletionManager, ScanLoopRunner, PlayerRegistrySync, and caches readiness/token program state for reuse.
- Use OracleService.getInstance() (or createWith for tests) instead of new; it eagerly loads config, admin keypair, IDL, and SQLite connection.
- Event listeners are registered via EVENT_HANDLER_CONFIG and removed on shutdown; backgroundAbortController handles restart-on-failure semantics.

## On-chain & Completion Flow
- POST /generate-hash delegates to OracleService.generateGameSecrets, which saves secrets in secret_keys and tracks the game; failures roll back the DB insert.
- OracleEventProcessor listens for player/game events, mutates game_players and game_tracking, queues registry reconciliation, then calls tryAutoComplete.
- GameCompletionManager.resolveContextAndReadiness caches readiness when games are full or expired (minPlayers met) and clears caches on failures.
- Completion picks a winner by hashing the secret key with lastSlot; registry mismatches trigger PlayerRegistrySync.fetchPlayersFromChain or markGameDesynced.

## Database & Persistence
- OracleDatabase wraps bun:sqlite with helper guards; trackGame uses INSERT OR REPLACE but preserves finalized rows when preserveFinalized is true.
- getPendingGames limits to 50 and filters by completion_attempts < max; ScanLoopRunner.touchGameCheck bumps last_checked to avoid tight loops.
- cleanupOldRecords (default 48h) purges secrets, tracking rows, and players for finalized games; metrics.recordCleanupSweep logs the sweep.
- Requeue flow (index.ts /games/requeue) resets attempts only when status is pending/desynced and a secret exists, otherwise returns reason codes.

## Configuration & Runtime
- SOLANA_NETWORK is mandatory (env.ts); optional envs include ORACLE_PORT, DATABASE_FILE, ORACLE_SCAN_THROTTLE_MS, USE_FAKE_KEYPAIR, ORACLE_KEYPAIR_PATH.
- shouldUseEphemeralKeypair() enables fake keypairs in tests/CI or when USE_FAKE_KEYPAIR=true; production must ship admin-keypair.json at repo root.
- Primary commands: bun install, bun start (prod), bun run dev (watch), bun test, bunx tsc --noEmit (or bun run typecheck).
- Background scans wait FALLBACK_SCAN_INTERVAL (300000 ms) and throttle per game using config.scanThrottleMs; adjust via env if scan pressure changes.

## Testing Workflow
- Tests live under tests/ and use Bun's runner; call setupTestEnvironment (tests/helpers/setup-env.ts) to seed temp DB + env per suite.
- setupTestEnvironment.registerSingleton resets modules with static instance (OracleDatabase, OracleService, metrics) to avoid cross-test leakage.
- Helpers such as tests/helpers/fake-oracle.ts and program-stub.ts mock Solana interactions so unit tests stay offline.
- Router tests exercise buildFetchRouter with FakeOracle, while lifecycle suites start the Bun server; study tests/index.router.test.ts and index.lifecycle.test.ts for patterns.

## Coding Patterns
- TypeScript strict mode is enforced (tsconfig.json); avoid any and keep optionals explicit.
- Modules favor dependency injection (e.g., OracleEventProcessorOptions) and expect functions passed in; mirror this when extending behavior.
- Logger (logger.ts) wraps console with emoji conventions; use logger.success/failure/warning for consistency instead of raw console.log.
- HTTP layer sanitizes error messages (sanitizeErrorMessage) and enforces shared CORS headers; align new endpoints with createSuccessResponse/createErrorResponse.
