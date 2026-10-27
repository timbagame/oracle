# Oracle service deployment

This guide covers only the Oracle service. Cross-project production operations are documented in the private Operations repository.

## Configuration

Copy `.env.example` to `.env` and set the production values. `SOLANA_NETWORK` accepts a JSON array or comma-separated RPC list and fails over in order.

Keep `CONTRACT_VERSION=0.2.0` while mainnet runs v0.2.0. After deploying the
v0.3.0 program, set `CONTRACT_VERSION=0.3.0` before restarting the Oracle. The
service validates the value and refuses unsupported versions.

Keep these files outside `.env` and set them to mode `600`:

- `operator-keypair.json` (the shared bot/oracle operator)
- `secrets/oracle-api-token`
- `secrets/jupiter-api-key`

The API token must match the Bot repository copy. The configured keypair must be the Oracle operator stored on chain.

The service uses two independent SQLite files in `~/timba/oracle/data`, mounted at `/app/data`. `oracle.sqlite` contains secrets and completion state. `indexer.sqlite` contains only public chain history and cached statistics. Never replace one with the other. SQLite keeps `-wal` and `-shm` files next to each database, so always mount and back up the whole directory, never a single file.

After switching the Oracle to v0.3.0 and before activating Bot or Web game creation, define every supported mint in the durable Oracle database. A missing policy disables game creation for that mint:

```bash
podman exec oracle timba-oracle admin token-policy set <mint> on
podman exec oracle timba-oracle admin token-policy list
```

Oracle uses the mint decimals and a live Jupiter price to publish a USD 0.10
recommended minimum. It accepts 5% below that recommendation to tolerate a
small price move after the user receives a quote. Prices are cached for no more
than 60 seconds, and Oracle refuses to sign creation transactions if the current
price is unavailable. Enabling a mint also creates the Oracle operator's
associated token account when needed, so ensure the operator has enough SOL for
the one-time rent and transaction fee.

## Rootless Podman Quadlet

The production checkout is expected at `~/timba/oracle`. Install the shared network and Oracle service before the Bot:

```bash
mkdir -p ~/.config/containers/systemd
install -d -m 700 ~/timba/oracle/data
cp deploy/quadlet/timba.network deploy/quadlet/timba-oracle.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start timba-oracle.service
systemctl --user enable --now podman-auto-update.timer
loginctl enable-linger "$USER"
```

The shared network uses `10.89.0.0/24`, and the Oracle has the fixed address
`10.89.0.48`. Keep this address synchronized with the Workers VPC Service.
Changing it without updating the VPC Service interrupts Web access to the
Oracle.

The Quadlet uses `AutoUpdate=registry`. Inspect updates and logs with:

```bash
podman auto-update --dry-run
journalctl --user -u timba-oracle.service -f
```

Do not publish port 3001 on the VPS host, run another service copy against the same databases, or use `sudo` for rootless Podman. If the checkout path changes, update the `%h/timba/oracle` paths in the installed Quadlet.

## Private web access

The web Worker reaches the oracle through a Cloudflare Workers VPC Service. The
oracle remains private: do not create a public hostname or publish port 3001.

After creating the remotely managed tunnel, store its connector token at
`~/timba/cloudflared/secrets/tunnel-token`. Keep the `secrets` directory mode
`700`; the bind-mounted file must be mode `644` so the non-root connector can
read it inside the container.
Install and start the connector Quadlet:

```bash
cp deploy/quadlet/timba-cloudflared.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start timba-cloudflared.service
```

Attach the Workers VPC HTTP service to this tunnel with IPv4 address
`10.89.0.48` and HTTP port `3001`. Bind only that VPC Service to the Web
Worker; do not bind the entire private network.

## Service Checks

```bash
podman exec oracle timba-oracle healthcheck && echo healthy
```

Administrative service commands also run inside the container:

```bash
podman exec oracle timba-oracle admin requeue <game-address>
podman exec oracle timba-oracle admin auto-complete <game-address> <on|off>
podman exec oracle timba-oracle admin token-policy list
podman exec oracle timba-oracle admin token-policy set <mint> <on|off>
```

Monitor logs for subscription failures, `/stats` for completion activity, `/indexer/api/stats` for the public index, and the operator wallet balance for transaction fees. Back up the whole `data` directory. Copy it while the service is stopped, or use `sqlite3 data/oracle.sqlite ".backup <file>"`, so the backup includes commits still in the WAL.

For coordinated deployment order, chain administration, upgrades, and incident procedures, use `operations/DEPLOYMENT.md` and the relevant Operations runbook.
