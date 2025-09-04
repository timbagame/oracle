# Repository Guidelines

## Project Structure & Module Organization
- `index.ts`: HTTP API (Bun server) exposing `/health`, `/generate-hash`, `/stats`.
- `oracle-service.ts`: Core oracle logic (event listeners, completion flow, winner selection).
- `database.ts`: SQLite access layer (`oracle.sqlite`) for secrets, games, players, stats.
- `idl/`: Solana program IDL (`idl.json`) and generated types (`idlType.ts`).
- `.env` / `env.example`: Runtime configuration.

## Build, Test, and Development Commands
- Install: `bun install` — install dependencies.
- Run (prod-like): `bun start` — runs `index.ts`.
- Run (watch): `bun run --watch index.ts` — auto‑reload on change.
- Type-check: `bunx tsc --noEmit` — validate types using the repo’s `tsconfig.json`.
- Test: `bun test` — Bun’s test runner (add tests as described below).

## Coding Style & Naming Conventions
- Language: TypeScript (strict mode; no `any`; fix `noUnused*` warnings).
- Indentation: 2 spaces; keep lines concise; include semicolons.
- Naming: files kebab/lowercase (e.g., `oracle-service.ts`, `database.ts`); types/interfaces PascalCase; functions/variables camelCase; constants UPPER_SNAKE_CASE.
- Imports: prefer explicit file extensions (e.g., `"./oracle-service.ts"`).

## Testing Guidelines
- Framework: Use Bun’s built-in runner.
- Location: `tests/**/*.test.ts` (all tests consolidated under `tests/`).
- Scope: unit tests for database and winner-index logic; lightweight API tests for `/health`, `/stats`, `/generate-hash`.
- Run: `bun test`; aim to cover edge cases (empty players, max tickets, expiry logic). No coverage threshold enforced yet.

## Commit & Pull Request Guidelines
- Commits: imperative mood, concise summary, scope when helpful (e.g., "Refactor: winner selection bounds"). Group related changes only.
- PRs: clear description, motivation, and testing notes; link issues; include commands to verify (e.g., `bunx tsc`, `bun start`, `curl /health`). Keep PRs small and reviewable.

## Security & Configuration Tips
- Required env: `SOLANA_NETWORK`, optional `ORACLE_PORT`. Use `env.example` as reference.
- Secrets: place `admin-keypair.json` at repo root; never commit `.env`, keypairs, or `*.sqlite` (already ignored).
- Local DB: `oracle.sqlite` is for development/runtime; delete/regenerate as needed.
