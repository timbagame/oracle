# EVM Oracle

`EVM_CONFIG_FILE=/path/config.json bun run start:evm` starts a separate,
explicitly configured service using protocol 0.13.0's EVM ABI and algorithms.
It does not load or alter the Solana service database or operator key.

Every route requires the configured bearer token. Request bodies are limited to
16 KiB and routes share a bounded request rate. Only the deployment and public
token metadata are returned by `/evm/config`; RPC URLs and secrets remain private.

- `POST /evm/authorize`: creation fields (uint256 values as decimal strings), plus
  `proof`. The creator signs protocol's `creationTypedData` with a zero bytes32
  commitment and a deadline no more than five minutes ahead. The Oracle validates
  policy, live limits, nonce and wallet signature; generates and persists the real
  secret; then returns `gameId`, the authorized `request` and Oracle `signature`.
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
bytes are persisted before sending. Completion retries preserve bytes across
restarts; no automatic fee replacement is performed. Back up this database,
restrict its directory, and operate only one writer per deployment/operator.
Use the Operations EVM acceptance test and rollout guide before enabling stakes.

## Shared contracts and discovery

API schemas, authorization input validation and caller action policy live in
`@timbagame/protocol/evm`; lifecycle decisions use `protocol/games`. This service
keeps its EVM-specific operator wallet, event index and durable signed transactions.

`GET /evm/config` includes the current recovery buffer. `GET /evm/games` lists
indexed public games in pages of 20 (`offset`, response `nextOffset`). The optional
`player` address selects games that address created or joined, including private
games. These are public on-chain records, not confidential wallet data. Draft
authorizations are never listed. All routes still require the API bearer token.
Reorg rebuilding also rebuilds the discovery source; no second game registry is
introduced.
