# Timba 0.2.0 Mainnet Upgrade

This private runbook upgrades the existing mainnet program from 0.1.3 to 0.2.0 and migrates the production oracle and bot from Docker Compose to rootless Podman Quadlets.

Program ID:

```text
32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5
```

This guide and its orchestrator live in the private `oracle` repository, which owns the production drain and is deployed first. They must not be copied into the public `contracts` repository.

## Current production state

- The deployed contract is 0.1.3, with no uploaded IDL and no reproducible verification record.
- The VPS oracle and bot are 0.1.3-compatible Docker Compose containers.
- The upgrade must preserve the program ID and existing oracle account.
- Every 0.1.3 game must be settled or closed before deploying 0.2.0.
- The new services must start in oracle → bot order and use the reviewed 0.2.0 Podman Quadlets.

Never initialize a new program, run `anchor migrate`, or reinitialize the oracle.

## Where each phase runs

| Phase                                                                                          | Machine                     |
| ---------------------------------------------------------------------------------------------- | --------------------------- |
| `local-preflight`, `prepare`                                                                   | Trusted local/build machine |
| `vps-preflight`, `drain`, `backup`                                                             | VPS                         |
| `build`, `deploy-contract`, `publish-idl`, `verify-source`, `verify-remote`, `release-clients` | Trusted local/build machine |
| `migrate-clients`, `smoke-test`                                                                | VPS                         |

The upgrade-authority key stays on the trusted machine. Bot/oracle production secrets stay on the VPS.

The orchestrator refuses an executing phase unless `--host local` or `--host vps` matches this table.

## Files and configuration

Private local files:

```text
$SOURCE_ROOT/oracle/UPGRADE_0.2.0.md
$SOURCE_ROOT/oracle/scripts/upgrade-0.2.0.ts
```

On the trusted machine:

```bash
export SOURCE_ROOT=/home/astro/Documents/timba
export SCRIPT="$SOURCE_ROOT/oracle/scripts/upgrade-0.2.0.ts"
export RELEASE_DIR="$HOME/timba-release-0.2.0"
export STATE="$RELEASE_DIR/release-state.json"
export BUNDLE="$RELEASE_DIR/release-state.bundle.json"
export RPC_URL=https://api.mainnet-beta.solana.com
export UPGRADE_AUTHORITY=/secure/path/to/upgrade-authority.json
export VPS=<user@host>
mkdir -p "$RELEASE_DIR"
```

On the VPS, only the oracle and bot checkouts and their existing Compose deployments are required below `$HOME/timba`:

```bash
export DEPLOY_ROOT="$HOME/timba"
export SOURCE_ROOT="$DEPLOY_ROOT"
export RELEASE_DIR="$HOME/timba-release-0.2.0"
export STATE="$RELEASE_DIR/release-state.json"
export BUNDLE="$RELEASE_DIR/release-state.bundle.json"
export SCRIPT="$RELEASE_DIR/upgrade-0.2.0.ts"
mkdir -p "$RELEASE_DIR"
```

The authority file must be a regular file with mode `400` or `600`. Never transfer it to the VPS. State bundles contain commits, hashes, command output, and phase status only; they must never contain key or token contents.

## Safety rules

Every phase is dry-run-first:

```bash
bun run "$SCRIPT" <phase> --host local
bun run "$SCRIPT" <phase> --host local --execute
```

Mainnet-impacting phases also require an exact approval:

```bash
--approve drain
--approve deploy-contract
--approve publish-idl
--approve verify-source
--approve verify-remote
--approve migrate-clients
--approve smoke-test
```

Inspect progress at any time:

```bash
bun run "$SCRIPT" status --state "$STATE"
```

The result reports both the next phase and the machine on which it must run.

## 1. Trusted machine: prepare the release

```bash
bun run "$SCRIPT" local-preflight --host local
bun run "$SCRIPT" local-preflight --host local --execute

bun run "$SCRIPT" prepare --host local
bun run "$SCRIPT" prepare --host local --execute
```

This verifies the pinned Anchor/Solana toolchain, authority and program, clean and pushed repositories, all project tests/builds, exact commits, and identical 0.2.0 IDLs.

Export the first handoff bundle and copy the private orchestrator plus bundle to the VPS:

```bash
bun run "$SCRIPT" export-bundle --state "$STATE" --bundle "$BUNDLE"
scp "$SCRIPT" "$BUNDLE" "$VPS:~/timba-release-0.2.0/"
```

Do not transfer `UPGRADE_AUTHORITY`.

## 2. VPS: drain and back up 0.1.3

Import the state:

```bash
bun run "$SCRIPT" import-bundle --state "$STATE" --bundle "$BUNDLE"
```

Verify the VPS and current Docker deployment:

```bash
bun run "$SCRIPT" vps-preflight --host vps --source-root "$SOURCE_ROOT" --deploy-root "$DEPLOY_ROOT"
bun run "$SCRIPT" vps-preflight --host vps --source-root "$SOURCE_ROOT" --deploy-root "$DEPLOY_ROOT" --execute
```

Before draining, announce maintenance and enable the static web maintenance response. Keep the old oracle and bot running while games settle.

```bash
bun run "$SCRIPT" drain --host vps --source-root "$SOURCE_ROOT" --deploy-root "$DEPLOY_ROOT"
bun run "$SCRIPT" drain --host vps --source-root "$SOURCE_ROOT" --deploy-root "$DEPLOY_ROOT" --execute --approve drain
```

The phase disables supported tokens and runs the shutdown scan inside the existing Docker oracle. Independently verify through mainnet RPC that no legacy `Game` can require completion, cancellation, or unjoin.

Then stop Docker and preserve production state:

```bash
bun run "$SCRIPT" backup --host vps --source-root "$SOURCE_ROOT" --deploy-root "$DEPLOY_ROOT"
bun run "$SCRIPT" backup --host vps --source-root "$SOURCE_ROOT" --deploy-root "$DEPLOY_ROOT" --execute
```

This records Docker container/image identities, stops bot before oracle, proves both are stopped, integrity-checks and copies all SQLite databases, and records their hashes. The stopped Docker containers and images remain available for rollback before contract deployment.

Export and return the updated state:

```bash
bun run "$SCRIPT" export-bundle --state "$STATE" --bundle "$BUNDLE"
scp "$BUNDLE" <trusted-user@trusted-host>:"$RELEASE_DIR/"
```

## 3. Trusted machine: upgrade and verify the contract

Import the returned bundle:

```bash
bun run "$SCRIPT" import-bundle --state "$STATE" --bundle "$BUNDLE"
```

Build the frozen artifact:

```bash
bun run "$SCRIPT" build --host local
bun run "$SCRIPT" build --host local --execute
```

Before deploying, have a second person verify the mainnet cluster, existing program ID, frozen commit and executable hash, authority, expected SOL cost, absence of token transfers, and preservation of the existing oracle account.

```bash
bun run "$SCRIPT" deploy-contract --host local --authority "$UPGRADE_AUTHORITY"
bun run "$SCRIPT" deploy-contract --host local --authority "$UPGRADE_AUTHORITY" --execute --approve deploy-contract
```

The phase compares executable hashes, safely recognizes an already successful matching deployment, otherwise deploys with `--verifiable --no-idl`, dumps the deployed program, and requires an exact executable-hash match.

Create and verify the first canonical IDL:

```bash
bun run "$SCRIPT" publish-idl --host local --authority "$UPGRADE_AUTHORITY"
bun run "$SCRIPT" publish-idl --host local --authority "$UPGRADE_AUTHORITY" --execute --approve publish-idl
```

The phase resumes safely if an identical canonical IDL already exists; otherwise it runs `anchor idl init` exactly once and verifies the fetched contents.

Complete reproducible verification:

```bash
bun run "$SCRIPT" verify-source --host local
bun run "$SCRIPT" verify-source --host local --execute --approve verify-source

bun run "$SCRIPT" verify-remote --host local --authority "$UPGRADE_AUTHORITY"
bun run "$SCRIPT" verify-remote --host local --authority "$UPGRADE_AUTHORITY" --execute --approve verify-remote
```

`verify-remote` records and polls the job and refuses to complete until it reports success. If the installed CLI output does not expose a parseable job ID, rerun with `--verification-job-id <JOB_ID>`.

Do not migrate clients until both verification phases complete.

Merge the reviewed oracle, bot, and web compatibility branches into `main` and wait for the two signed image workflows plus the Cloudflare deployment. Record and validate the exact released commits:

```bash
bun run "$SCRIPT" release-clients --host local
bun run "$SCRIPT" release-clients --host local --execute
```

This proves every tested compatibility commit is an ancestor of its released `main` and freezes the three production commits in the handoff state.

Export the second VPS handoff:

```bash
bun run "$SCRIPT" export-bundle --state "$STATE" --bundle "$BUNDLE"
scp "$SCRIPT" "$BUNDLE" "$VPS:~/timba-release-0.2.0/"
```

## 4. VPS: migrate Docker to Podman

Import the verified state:

```bash
bun run "$SCRIPT" import-bundle --state "$STATE" --bundle "$BUNDLE"
```

The VPS pulls the exact recorded oracle and bot `main` commits before installing their images. Run:

```bash
bun run "$SCRIPT" migrate-clients --host vps --source-root "$SOURCE_ROOT" --deploy-root "$DEPLOY_ROOT"
bun run "$SCRIPT" migrate-clients --host vps --source-root "$SOURCE_ROOT" --deploy-root "$DEPLOY_ROOT" --execute --approve migrate-clients
```

This refuses active Docker services; validates commit ancestry, Cosign identities, secrets, and shared API token; pulls the images with rootless Podman; installs `timba.network` and both Quadlets; reloads user systemd; starts oracle before bot; and validates health, authentication, image digests, systemd labels, auto-update labels, logs, and continued Docker shutdown.

Confirm the Cloudflare deployment uses the recorded web commit.

Keep maintenance enabled and perform the controlled lifecycle:

```bash
bun run "$SCRIPT" smoke-test --host vps --source-root "$SOURCE_ROOT" --deploy-root "$DEPLOY_ROOT"
bun run "$SCRIPT" smoke-test --host vps --source-root "$SOURCE_ROOT" --deploy-root "$DEPLOY_ROOT" --execute --approve smoke-test
```

Using controlled wallets, create, join, optionally unjoin, and complete one low-value game. Confirm contract state, oracle registry, bot result, and web result agree. Inspect all logs before removing maintenance.

Finally:

```bash
systemctl --user enable --now podman-auto-update.timer
loginctl enable-linger "$USER"
```

## Failure boundaries

### Before contract deployment

Keep tokens disabled. Restore the checkpointed databases and restart retained Docker services in oracle → bot order:

```bash
cd "$DEPLOY_ROOT/oracle" && docker compose up -d oracle
cd "$DEPLOY_ROOT/bot" && docker compose up -d bot
```

Never run Docker and Podman against the same databases.

### After contract deployment

The old Docker clients are incompatible with 0.2.0 and must not be restarted. IDL, verification, or Podman failures are roll-forward-only while games remain disabled.

Before accepting any 0.2.0 traffic, a failed Podman startup may be retried after stopping both units and restoring the checkpointed databases. After accepting 0.2.0 traffic, do not restore old databases or redeploy 0.1.3 without a separately reviewed migration.

## Evidence

Archive the final state and bundle with database hashes, Docker identities, binary and IDL hashes, program output before/after, deployment signatures, verification job/result, Podman image digests, service health/authentication evidence, controlled-game signatures, and final SOL cost.
