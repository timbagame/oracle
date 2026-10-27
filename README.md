# Timba oracle

**The service that commits to each game's secret, approves game creation and settles Timba games.**

[Timba](https://timba.cc) is a platform for multiplayer coinflips and giveaways played on the web or in Telegram.
Every game commits to a secret before anyone joins. This service makes that secret, keeps it until the game is ready, then reveals it on chain so the program can pick the winner.
It also keeps the public game history that the website reads.

| Binary             | Chain  | Docs                                                       |
| ------------------ | ------ | ---------------------------------------------------------- |
| `timba-oracle`     | Solana | This README, [deployment](MAINNET_DEPLOYMENT.md)           |
| `timba-evm-oracle` | EVM    | [crates/evm-oracle/README.md](crates/evm-oracle/README.md) |

## Trust model

- **The oracle is trusted.** It knows each secret before settlement and can decline to reveal it. If it never settles a game, the contracts unlock the funds after a recovery buffer. See the [contracts security policy](https://github.com/timbagame/contracts/blob/main/SECURITY.md).
- **Secrets stay private until settlement.** They live only in `oracle.sqlite`. The API returns the commitment, never the secret.
- **Token policy is enforced here.** The oracle decides which tokens and minimum amounts it will sign for.

## How a game works

1. **Commit.** `/generate-hash` creates a random 32-byte secret, stores it and returns its SHA-256 hash and the game address.
2. **Approve.** The creator builds the game transaction and sends it to `/sign-game-transaction`.
   - The oracle checks that the commitment is unused, the accounts match and the token policy allows it.
   - It adds its signature. The creator signs and sends the transaction, so neither key leaves its owner.
3. **Track.** The oracle follows the program's events (`GameCreated`, `PlayerJoined`, `PlayerRefunded`, `GameCompleted`).
   - Every 5 minutes it also scans pending games, in case it missed an event.
4. **Settle.** When a game is ready, the oracle reveals the secret on chain. The program checks it and pays the winner.
   - A failed attempt retries after 5, 15 and 30 seconds, then waits 5 minutes. The wait survives restarts.
5. **Index.** A separate `indexer.sqlite` keeps the public history: games, profiles, tokens, leaderboards and stats.

## Token policy

Each token must be enabled before games can use it:

```bash
timba-oracle admin token-policy set <mint> on
timba-oracle admin token-policy list
```

- **Minimum amount.** For each enabled mint, the oracle turns a USD 0.10 target into tokens using the live Jupiter price.
- **Price moves.** It accepts amounts up to 5% below that minimum and caches prices for 60 seconds.
- **Fails closed.** Without a current price, it refuses to sign.
- **Setup cost.** Enabling a mint creates the operator's token account if needed. The operator pays that rent.

On contract v0.2.0, the program's `GameToken` accounts enforce token policy instead.

## API

Every route except `/health` and `/` needs `Authorization: Bearer <token>`.

| Route                    | Method    | What it does                                         |
| ------------------------ | --------- | ---------------------------------------------------- |
| `/health`                | GET       | Service health                                       |
| `/`                      | GET       | Generated API documentation                          |
| `/generate-hash`         | POST      | Create a secret and return its commitment            |
| `/sign-game-transaction` | POST      | Validate and co-sign a game creation transaction     |
| `/token-policies`        | GET       | Enabled tokens and their minimum amounts             |
| `/stats`                 | GET       | Oracle statistics                                    |
| `/games/complete-now`    | POST      | Try to settle one tracked game now                   |
| `/indexer/*`             | GET       | Games, profiles, tokens, statistics and leaderboards |
| `/web/*`                 | GET, POST | Blockchain API for the website                       |

```bash
curl -X POST http://localhost:3001/generate-hash \
  -H "Authorization: Bearer $ORACLE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"gameType": "coinflip"}'
```

Requeue, auto-complete and token policy changes are only available from the CLI (`timba-oracle admin --help`).

### Website API

The website reaches the oracle over a private network and uses `/web/*` for its blockchain work:

- `GET /web/config`: token configuration and prices.
- `POST /web/games/prepare`: checks the game terms and returns an unsigned transaction. Requires `X-Timba-Contract-Version` to match `CONTRACT_VERSION`.
- `POST /web/games/submit`: validates and co-signs the player's transaction, then broadcasts it.
- `GET /web/games/:address?fresh=1`: reads an active game account.
- `GET /web/verification/:signature`: the verified result of a finished game.

Verified results are rebuilt only from finalized, successful transactions, and the rebuilt winner must match. They contain only the secret already revealed on chain. If history is missing or too long, the route returns 503 and stores nothing.

## Configuration

Copy [`.env.example`](.env.example) to `.env`. It lists every setting. The main ones:

| Setting                 | What it does                                                   |
| ----------------------- | -------------------------------------------------------------- |
| `SOLANA_NETWORK`        | RPC endpoints, tried in order                                  |
| `CONTRACT_VERSION`      | `0.2.0` or `0.3.0`, matching the deployed program              |
| `OPERATOR_KEYPAIR_PATH` | The operator keypair stored on chain                           |
| `ORACLE_API_TOKEN_FILE` | File with the API token (or `ORACLE_API_TOKEN` for local work) |
| `JUPITER_API_KEY_FILE`  | File with the Jupiter API key, needed for prices               |
| `DATABASE_FILE`         | Secrets and completion state (default `oracle.sqlite`)         |
| `INDEXER_DATABASE_FILE` | Public history (default `indexer.sqlite`)                      |

The binary doesn't read `.env` itself. Export the variables first, or use the Quadlet's `EnvironmentFile=`.

## Run it locally

```bash
cp .env.example .env
set -a; . ./.env; set +a
cargo run --release --bin timba-oracle -- serve
```

With `USE_FAKE_KEYPAIR=true`, the oracle makes a throwaway operator keypair when the file is missing. `timba-oracle --help` lists the other commands, such as `inspect-game`, `audit-random` and `healthcheck`.

## Reporting a vulnerability

- **Don't open a public issue** for security problems.
- **Report privately** through this repository's [Security tab](https://github.com/timbagame/oracle/security/advisories/new).
- **Never post** unrevealed secrets, API tokens or private keys.

## Related

- **[timbagame/contracts](https://github.com/timbagame/contracts):** the Solana and EVM programs
- **[timbagame/protocol](https://github.com/timbagame/protocol):** shared clients, API schemas and winner verification
- **[timbagame/bot](https://github.com/timbagame/bot):** the Telegram bot
- **[timba.cc](https://timba.cc):** play on the web and verify games
- **[@playtimbabot](https://t.me/playtimbabot):** play in Telegram

## Development

<details>
<summary>Toolchain, checks and code layout</summary>

The Rust version is pinned in [`rust-toolchain.toml`](rust-toolchain.toml), and the extra cargo tools in [`mise.toml`](mise.toml).

Run the same checks as CI:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo llvm-cov --workspace --locked --lcov --output-path coverage/lcov.info
python3 scripts/check-coverage.py coverage/lcov.info coverage-scope.json
```

```
crates/
├── common/      # logging, env and secret helpers, shutdown signal
├── oracle/      # timba-oracle
│   └── src/
│       ├── core/       # completion, events, scan loop, signer, service
│       ├── http/       # authenticated API router
│       ├── indexer/    # public history and /indexer API
│       ├── web_api/    # /web API
│       ├── cli/        # operator commands
│       └── server.rs   # `serve`: API, listeners and background workers
└── evm-oracle/  # timba-evm-oracle
```

The protocol codecs live in the shared `timba-protocol` crate in [timbagame/protocol](https://github.com/timbagame/protocol). Test fixtures from the earlier TypeScript oracle are described in [`crates/oracle/tests/fixtures/README.md`](crates/oracle/tests/fixtures/README.md).

</details>
