# Oracle Service — Mainnet Deployment Guide

Deploy the oracle as a long-running Bun service that listens to mainnet-beta events and signs completions with a dedicated authority.

## Prerequisites

- Rootless Podman with a working `podman compose` provider
- `admin-keypair.json` funded on mainnet (oracle authority)
- Network access to a low-latency Solana RPC endpoint
- Updated IDL placed in `idl/idl.json`

## 1. Prepare Environment

```bash
cd oracle
cp env.example .env
```

Edit `.env` with production values:

```bash
SOLANA_NETWORK=["https://api.mainnet-beta.solana.com","https://rpc-backup.example.com"]
ORACLE_PORT=3001                # optional
ORACLE_KEYPAIR_PATH=./admin-keypair.json
```

`SOLANA_NETWORK` accepts JSON arrays or comma-delimited strings; the oracle automatically advances through the ordered list when encountering retryable RPC errors.

> Ensure `ORACLE_KEYPAIR_PATH` points to the same oracle authority configured during contract deployment.

## 2. Launch with rootless Podman

```bash
podman network exists timba || podman network create timba
podman compose -f compose.yml pull
podman compose -f compose.yml up -d
podman compose -f compose.yml ps
```

Follow logs with `podman compose -f compose.yml logs -f oracle`.

For automatic startup, place this repository at `~/timba/oracle`, then install the included user service:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/timba-oracle.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now timba-oracle.service
loginctl enable-linger "$USER"
```

If the checkout lives elsewhere, edit `WorkingDirectory` in the copied unit. Do not run rootless Podman commands with `sudo`.

### Migrating an existing Docker deployment

Stop Docker only after confirming the Podman deployment user can read both repositories and their mode-`600` secrets. The SQLite databases remain in place because both deployments use the same bind-mounted files.

```bash
# Run from each repository while Docker still owns the old deployment.
docker compose down

# Then run as the unprivileged Podman deployment user.
podman network exists timba || podman network create timba
cd ~/timba/oracle && podman compose -f compose.yml up -d
cd ~/timba/bot && podman compose -f compose.yml up -d
```

Never run Docker and Podman copies simultaneously: both would write the same SQLite files and process the same games. After validation, disable the old Docker systemd service before enabling the Podman user services.

## 3. Validate Health

```bash
podman compose -f compose.yml exec oracle \
  bun -e "const r = await fetch('http://127.0.0.1:3001/health'); console.log(r.status, await r.text()); if (!r.ok) process.exit(1)"
```

Check Bun logs to confirm event listeners attach successfully and no subscription errors occur.

Game creation clients also call `POST /sign-game-transaction`. The endpoint only signs a single
`initialize_game` instruction tied to an unused oracle commitment; it permits only an optional
associated-token-account setup instruction alongside it. Keep the service on the private Podman
network. If it must cross hosts, use a TLS reverse proxy and network allowlist.

When using the provided Compose file with Podman, the oracle port is exposed only to the shared
`timba` bridge network. Do not publish port 3001 on the VPS host. Configure the same
token in `secrets/oracle-api-token` in both repositories; all service endpoints require it. Set the token and `admin-keypair.json` files to mode `600`.

Run administrative operations inside the oracle container instead of exposing them over HTTP:

```bash
podman compose -f compose.yml exec oracle bun run admin requeue <game-address>
podman compose -f compose.yml exec oracle bun run admin auto-complete <game-address> <on|off>
```

## 4. Ongoing Operations

- Keep the oracle wallet funded to pay for completion transactions. Game creators pay initialization fees.
- Monitor `/stats` to track completions and fallback scans.
- When updating the program IDL, copy the new JSON file into `idl/idl.json` prior to restarting.
