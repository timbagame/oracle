# Timba 0.2.0 Mainnet Upgrade

This private runbook upgrades the existing mainnet program from 0.1.3 to 0.2.0 and migrates the production oracle and bot from Docker Compose to rootless Podman Quadlets.

Program ID:

```text
32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5
```

The guide and orchestrator live in the private `oracle` repository. Do not copy them into the public `contracts` repository.

## Current production state

- The deployed contract is 0.1.3, with no uploaded IDL and no reproducible verification record.
- The VPS oracle and bot are 0.1.3-compatible Docker Compose containers.
- The upgrade preserves the program ID and existing oracle account.
- Every 0.1.3 game must be settled or closed before deploying 0.2.0.
- The new Podman services start in oracle → bot order.

Never initialize a new program, run `anchor migrate`, or reinitialize the oracle.

## Automatic defaults

No environment configuration is required.

On the trusted machine, the command automatically derives the Timba workspace from the `oracle` repository. On the VPS, `--host vps` automatically uses:

```text
source/deployment root: ~/timba
release state:          ~/timba-release-0.2.0/release-state.json
handoff bundle:         ~/timba-release-0.2.0/release-state.bundle.json
RPC:                    https://api.mainnet-beta.solana.com
client branch:          contracts-0.2.0-compat
```

Only two values cannot be inferred:

- the local upgrade-authority path when signing;
- the SSH destination used to copy the orchestrator and state bundle.

The authority file must be regular, not a symlink, and have mode `400` or `600`. Never transfer it to the VPS.

## Where phases run

| Phase                                                                                          | Machine         |
| ---------------------------------------------------------------------------------------------- | --------------- |
| `local-preflight`, `prepare`                                                                   | Trusted machine |
| `vps-preflight`, `drain`, `backup`                                                             | VPS             |
| `build`, `deploy-contract`, `publish-idl`, `verify-source`, `verify-remote`, `release-clients` | Trusted machine |
| `migrate-clients`, `smoke-test`                                                                | VPS             |

Executing a phase requires the matching `--host local` or `--host vps`. The CLI refuses the wrong machine.

All phases are dry-run-first. Add `--execute` only after reviewing the printed operations. Mainnet-impacting phases additionally require their exact `--approve <phase>` token.

## 1. Trusted machine: prepare

From the private Oracle repository:

```bash
bun run upgrade:0.2.0 local-preflight --host local
bun run upgrade:0.2.0 local-preflight --host local --execute

bun run upgrade:0.2.0 prepare --host local
bun run upgrade:0.2.0 prepare --host local --execute
```

This verifies the pinned toolchain, clean and pushed repositories, all project tests/builds, exact commits, and identical 0.2.0 IDLs. Authority and deployed-program matching are checked later when the authority path is supplied for signing.

Create the VPS release directory, export state, and copy the private orchestrator plus bundle. Replace `user@vps` with the real SSH destination:

```bash
ssh user@vps 'mkdir -p ~/timba-release-0.2.0'
bun run upgrade:0.2.0 export-bundle
scp scripts/upgrade-0.2.0.ts \
  "$HOME/timba-release-0.2.0/release-state.bundle.json" \
  user@vps:~/timba-release-0.2.0/
```

## 2. VPS: drain and back up 0.1.3

```bash
bun run "$HOME/timba-release-0.2.0/upgrade-0.2.0.ts" import-bundle

bun run "$HOME/timba-release-0.2.0/upgrade-0.2.0.ts" vps-preflight --host vps
bun run "$HOME/timba-release-0.2.0/upgrade-0.2.0.ts" vps-preflight --host vps --execute
```

The VPS needs only `~/timba/oracle` and `~/timba/bot`, including their current Compose deployments.

Before draining, announce maintenance and enable the static web maintenance response. Keep the old services running while existing games settle.

```bash
bun run "$HOME/timba-release-0.2.0/upgrade-0.2.0.ts" drain --host vps
bun run "$HOME/timba-release-0.2.0/upgrade-0.2.0.ts" drain --host vps --execute --approve drain
```

The phase disables supported tokens and runs the shutdown scan inside the existing Docker oracle. Independently verify through mainnet RPC that no 0.1.3 game can still require completion, cancellation, or unjoin.

```bash
bun run "$HOME/timba-release-0.2.0/upgrade-0.2.0.ts" backup --host vps
bun run "$HOME/timba-release-0.2.0/upgrade-0.2.0.ts" backup --host vps --execute
bun run "$HOME/timba-release-0.2.0/upgrade-0.2.0.ts" export-bundle
```

This records Docker identities, stops bot before oracle, proves both are stopped, integrity-checks and copies the SQLite databases, and records their hashes.

From the trusted machine, retrieve the updated bundle:

```bash
scp user@vps:~/timba-release-0.2.0/release-state.bundle.json \
  "$HOME/timba-release-0.2.0/"
```

## 3. Trusted machine: upgrade and verify

From the Oracle repository:

```bash
bun run upgrade:0.2.0 import-bundle

bun run upgrade:0.2.0 build --host local
bun run upgrade:0.2.0 build --host local --execute
```

Before deployment, have a second person verify the mainnet cluster, existing program ID, frozen commit and executable hash, authority, expected SOL cost, absence of token transfers, and preservation of the existing oracle account.

Replace `/secure/path/to/upgrade-authority.json` with the real local path:

```bash
bun run upgrade:0.2.0 deploy-contract --host local \
  --authority /secure/path/to/upgrade-authority.json
bun run upgrade:0.2.0 deploy-contract --host local --execute \
  --approve deploy-contract \
  --authority /secure/path/to/upgrade-authority.json
```

The phase compares executable hashes, safely recognizes an already successful deployment, otherwise deploys with `--verifiable --no-idl`, dumps the program, and requires an exact hash match.

Create the first canonical IDL:

```bash
bun run upgrade:0.2.0 publish-idl --host local \
  --authority /secure/path/to/upgrade-authority.json
bun run upgrade:0.2.0 publish-idl --host local --execute \
  --approve publish-idl \
  --authority /secure/path/to/upgrade-authority.json
```

Complete reproducible verification:

```bash
bun run upgrade:0.2.0 verify-source --host local
bun run upgrade:0.2.0 verify-source --host local --execute \
  --approve verify-source

bun run upgrade:0.2.0 verify-remote --host local \
  --authority /secure/path/to/upgrade-authority.json
bun run upgrade:0.2.0 verify-remote --host local --execute \
  --approve verify-remote \
  --authority /secure/path/to/upgrade-authority.json
```

Remote verification must report success before continuing.

Merge the reviewed oracle, bot, and web compatibility branches into `main` and wait for the two signed image workflows plus the Cloudflare deployment. Then freeze the released commits:

```bash
bun run upgrade:0.2.0 release-clients --host local
bun run upgrade:0.2.0 release-clients --host local --execute
```

Export and send the final VPS handoff:

```bash
bun run upgrade:0.2.0 export-bundle
scp scripts/upgrade-0.2.0.ts \
  "$HOME/timba-release-0.2.0/release-state.bundle.json" \
  user@vps:~/timba-release-0.2.0/
```

## 4. VPS: migrate to Podman

```bash
bun run "$HOME/timba-release-0.2.0/upgrade-0.2.0.ts" import-bundle

bun run "$HOME/timba-release-0.2.0/upgrade-0.2.0.ts" migrate-clients --host vps
bun run "$HOME/timba-release-0.2.0/upgrade-0.2.0.ts" migrate-clients --host vps --execute \
  --approve migrate-clients
```

This refuses active Docker services; pulls the exact recorded Oracle and Bot commits; validates Cosign identities and secrets; installs the Podman network and Quadlets; starts oracle before bot; and validates health, authentication, image digests, supervision, logs, and continued Docker shutdown.

Keep maintenance enabled and run the controlled lifecycle:

```bash
bun run "$HOME/timba-release-0.2.0/upgrade-0.2.0.ts" smoke-test --host vps
bun run "$HOME/timba-release-0.2.0/upgrade-0.2.0.ts" smoke-test --host vps --execute \
  --approve smoke-test
```

Using controlled wallets, create, join, optionally unjoin, and complete one low-value game. Confirm contract state, oracle registry, bot result, and web result agree. Inspect all logs before removing maintenance.

Finally:

```bash
systemctl --user enable --now podman-auto-update.timer
loginctl enable-linger "$USER"
```

## Failure boundaries

Before contract deployment, keep tokens disabled, restore the checkpointed databases, and restart the retained Docker services in oracle → bot order:

```bash
cd "$HOME/timba/oracle" && docker compose up -d oracle
cd "$HOME/timba/bot" && docker compose up -d bot
```

Never run Docker and Podman against the same databases.

After deploying 0.2.0, the old Docker clients are incompatible and must not be restarted. IDL, verification, and Podman failures are roll-forward-only while games remain disabled.

## Evidence

Archive the final state and bundle with database hashes, Docker identities, binary and IDL hashes, program output before/after, deployment signatures, verification result, Podman image digests, health/authentication evidence, controlled-game signatures, and final SOL cost.
