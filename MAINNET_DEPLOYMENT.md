# Oracle — Service Deployment

This guide covers only the Oracle service. Cross-project production operations are documented in the private Operations repository.

## Configuration

Copy `env.example` to `.env` and set the production values. `SOLANA_NETWORK` accepts a JSON array or comma-separated RPC list and fails over in order.

Keep these files outside `.env` and set them to mode `600`:

- `operator-keypair.json` (the shared bot/oracle operator)
- `secrets/oracle-api-token`

The API token must match the Bot repository copy. The configured keypair must be the Oracle operator stored on chain.

## Rootless Podman Quadlet

The production checkout is expected at `~/timba/oracle`. Install the shared network and Oracle service before the Bot:

```bash
mkdir -p ~/.config/containers/systemd
cp deploy/quadlet/timba.network deploy/quadlet/timba-oracle.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start timba-oracle.service
systemctl --user enable --now podman-auto-update.timer
loginctl enable-linger "$USER"
```

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

Attach the Workers VPC HTTP service to this tunnel with internal hostname
`oracle` and HTTP port `3001`. Bind only that VPC Service to the web Worker;
do not bind the entire private network.

## Service Checks

```bash
podman exec oracle \
  bun -e "const r = await fetch('http://127.0.0.1:3001/health'); console.log(r.status, await r.text()); if (!r.ok) process.exit(1)"
```

Administrative service commands also run inside the container:

```bash
podman exec oracle bun run admin requeue <game-address>
podman exec oracle bun run admin auto-complete <game-address> <on|off>
```

Monitor logs for subscription failures, `/stats` for completion activity, and the operator wallet balance for transaction fees.

For coordinated deployment order, chain administration, upgrades, and incident procedures, use `operations/DEPLOYMENT.md` and the relevant Operations runbook.
