# Oracle Service — Mainnet Deployment Guide

Deploy the oracle as a long-running Bun service that listens to mainnet-beta events and signs completions with a dedicated authority.

## Prerequisites

- Rootless Podman with Quadlet support
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

## 2. Launch with rootless Podman Quadlet

Place this repository at `~/timba/oracle` and install the included rootless network and container Quadlets:

```bash
mkdir -p ~/.config/containers/systemd
rm -f ~/.config/systemd/user/timba-oracle.service
cp deploy/quadlet/timba.network deploy/quadlet/timba-oracle.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start timba-oracle.service
systemctl --user enable --now podman-auto-update.timer
loginctl enable-linger "$USER"
```

The Quadlet uses `AutoUpdate=registry`. After a reviewed merge publishes a new `:main` image, the user timer pulls it and recreates the service. Check with `podman auto-update --dry-run` and follow logs with `journalctl --user -u timba-oracle.service -f`.

If the checkout lives outside `~/timba/oracle`, update the `%h/timba/oracle` paths in the installed Quadlet. Do not run rootless Podman commands with `sudo`.

### Migrating an existing container deployment

Stop the legacy containers only after confirming the Podman deployment user can read both repositories and their mode-`600` secrets. The SQLite databases remain in place because both deployments use the same bind-mounted files.

```bash
# Run as the unprivileged Podman deployment user after stopping the old services.
systemctl --user daemon-reload
systemctl --user start timba-oracle.service
systemctl --user start timba-bot.service
```

Never run old and new container copies simultaneously: both would write the same SQLite files and process the same games. After validation, disable the legacy systemd services before enabling the Podman user services.

## 3. Validate Health

```bash
podman exec oracle \
  bun -e "const r = await fetch('http://127.0.0.1:3001/health'); console.log(r.status, await r.text()); if (!r.ok) process.exit(1)"
```

Check Bun logs to confirm event listeners attach successfully and no subscription errors occur.

Game creation clients also call `POST /sign-game-transaction`. The endpoint only signs a single
`initialize_game` instruction tied to an unused oracle commitment; it permits only an optional
associated-token-account setup instruction alongside it. Keep the service on the private Podman
network. If it must cross hosts, use a TLS reverse proxy and network allowlist.

The production Quadlet exposes the oracle port only to the shared
`timba` bridge network. Do not publish port 3001 on the VPS host. Configure the same
token in `secrets/oracle-api-token` in both repositories; all service endpoints require it. Set the token and `admin-keypair.json` files to mode `600`.

Run administrative operations inside the oracle container instead of exposing them over HTTP:

```bash
podman exec oracle bun run admin requeue <game-address>
podman exec oracle bun run admin auto-complete <game-address> <on|off>
```

## 4. Ongoing Operations

- Keep the oracle wallet funded to pay for completion transactions. Game creators pay initialization fees.
- Monitor `/stats` to track completions and fallback scans.
- Review `podman auto-update --dry-run` before maintenance windows and monitor `podman-auto-update.timer` with `systemctl --user list-timers`.
- When updating the program IDL, copy the new JSON file into `idl/idl.json` prior to restarting.
