# EVM Oracle

`EVM_CONFIG_FILE=/path/config.json timba-evm-oracle` starts a separate,
explicitly configured service using `@timbagame/protocol`'s EVM v0.1.0 ABI and
algorithms. It does not load or alter the Solana service database or operator key.
`config.example.json` lists every setting.

Every route requires the configured bearer token. Request bodies are limited to
16 KiB (larger ones get 413 before the token check), idle connections close after
10 seconds, and routes share a bounded request rate. Only the deployment and public
token metadata are returned by `/evm/config`; RPC URLs and secrets remain private.

- `POST /evm/authorize`: creation fields (uint256 values as decimal strings), plus
  `proof`. The creator signs protocol's `creationTypedData` with a zero bytes32
  commitment and a deadline no more than five minutes ahead. The Oracle validates
  policy, live limits, nonce and wallet signature (EOA, ERC-1271, ERC-6492 or
  ERC-8010); generates and persists the real secret; then returns `gameId`, the
  authorized `request` and Oracle `signature`.
  Retries and changed unsubmitted drafts at the same nonce preserve the secret.
  Only one candidate can execute because the contract consumes the creator nonce;
  signing another draft cannot alter an existing on-chain game.
- `POST /evm/private-join`: `gameId`, `player`, decimal `deadline`, `proof`.
  The proof is the **creator's** signature over protocol's `privateJoinTypedData`.
  The returned Oracle signature permits only that player and deadline.
- `GET /evm/games/:gameId`: current game tuple and up to 100 latest indexed
  canonical events for that game. Bigints are decimal strings.
- `GET /evm/events`: up to 100 most recent canonical events, each with transaction,
  log index, block hash/number and normalized protocol event.
- `GET /evm/health`: process status and the pending settlement transaction hash.
  A failed rebroadcast returns HTTP 503 with a fixed, sanitized error; signed
  bytes remain pending. Health recovers after a successful cycle.

Secrets are written durably before an authorization response. Signed settlement
bytes are persisted before sending. Settlements take nonce, gas and fees from
`eth_fillTransaction` when the node offers it (fee cap × 1.2, like viem), and
otherwise use the pending nonce, a gas estimate and 1.2 × base fee plus tip.
Completion retries preserve bytes across restarts; no automatic fee replacement
is performed. Back up this database, restrict its directory, and operate only one
writer per deployment/operator. Use the Operations EVM acceptance test and rollout
guide before enabling stakes.

## Shared contracts and discovery

API schemas, authorization input validation, contract bindings, event decoding
and lifecycle decisions come from the shared `timba-protocol` crate (`evm` feature),
the Rust port of `@timbagame/protocol`. This service keeps its EVM-specific operator
wallet, event index, durable signed transactions and the vendored viem helper
bytecode in `src/bytecode.rs`.

`GET /evm/config` includes the current recovery buffer. `GET /evm/games` lists
indexed public games in pages of 20 (`offset`, response `nextOffset`). The optional
`player` address selects games that address created or joined, including private
games. These are public on-chain records, not confidential wallet data. Draft
authorizations are never listed. All routes still require the API bearer token.
Reorg rebuilding also rebuilds the discovery source; no second game registry is
introduced.
