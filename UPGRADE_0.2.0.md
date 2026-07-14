# Timba 0.2.0 Mainnet Upgrade

This private runbook upgrades the existing mainnet program from 0.1.3 to 0.2.0 and activates the already-deployed rootless Podman oracle, bot, and Cloudflare web clients.

Program ID:

```text
32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5
```

The guide and orchestrator live in the private `oracle` repository. Do not copy them into the public `contracts` repository.

## Current production state

- The deployed contract is 0.1.3, with no uploaded IDL and no reproducible verification record.
- Oracle and bot already run as signed rootless Podman Quadlets compatible with 0.1.3.
- Their data, configuration, keypairs, and secrets already live below `~/timba`.
- Docker, its repository, its old deployment, and the migration backups have been removed.
- The upgrade preserves the program ID and existing oracle account.
- Every funded or joined 0.1.3 game must be settled before deploying 0.2.0. Empty creator-owned accounts may remain inert.

Never initialize a new program, run `anchor migrate`, or reinitialize the oracle.

## Automatic defaults

No shell exports are required. The orchestrator derives the local workspace and uses these VPS defaults:

```text
Podman data root:  ~/timba
release state:     ~/timba-release-0.2.0/release-state.json
handoff bundle:    ~/timba-release-0.2.0/release-state.bundle.json
RPC:               https://api.mainnet-beta.solana.com
```

Only the local upgrade-authority path and the SSH destination used for file transfer must be supplied. The authority must remain on the trusted machine as a regular mode-`400` or mode-`600` file.

## Phase locations

| Phase                                                                                                          | Machine         |
| -------------------------------------------------------------------------------------------------------------- | --------------- |
| `local-preflight`, `prepare`                                                                                   | Trusted machine |
| `vps-preflight`, `drain`, `backup`                                                                             | VPS             |
| `build`, `deploy-contract`, `publish-idl`, `verify-source`, `verify-remote`, `release-clients`, `activate-web` | Trusted machine |
| `activate-clients`, `smoke-test`                                                                               | VPS             |

Every phase is dry-run-first. Use `--execute` only after reviewing its commands. Mainnet-impacting phases also require the exact `--approve <phase>` token.

## 1. Trusted machine: freeze and test the release

From the private Oracle repository:

```bash
bun run simulate-upgrade:0.2.0 --keep

bun run upgrade:0.2.0 local-preflight --host local
bun run upgrade:0.2.0 local-preflight --host local --execute

bun run upgrade:0.2.0 prepare --host local
bun run upgrade:0.2.0 prepare --host local --execute
```

The simulation builds 0.2.0, dumps the exact deployed executable, snapshots every mainnet account owned by the Timba program, and loads the real Program and ProgramData accounts into an isolated local validator. It changes only the local deployment slot, upgrade authority, and Oracle operator, using a disposable signer; the executable, ProgramData allocation, and all Timba-owned account data otherwise remain exact. It upgrades to `contracts/target/deploy/timba.so`, proves all Timba-owned account bytes survive, rejects actionable legacy games, and executes a 0.2.0 Oracle instruction. It never sends a mainnet transaction or reads a production key. Review the retained `manifest.json`, then delete the simulation directory.

Legacy 0.1.3 Game accounts keep their old allocation after the executable upgrade. They are intentionally drained before deployment and remain inert; the upgrade does not resize, close, or reopen them. New 0.2.0 games use new PDAs and the new layout.

This checks the pinned Anchor and Solana tools, clean and pushed repositories, all project tests/builds, exact commits, and identical 0.2.0 IDLs. Production remains on ABI 0.1.3.

Copy only the private orchestrator and verified state bundle to the VPS:

```bash
ssh user@vps 'mkdir -p ~/timba-release-0.2.0'
bun run upgrade:0.2.0 export-bundle
scp scripts/upgrade-0.2.0.ts \
  "$HOME/timba-release-0.2.0/release-state.bundle.json" \
  user@vps:~/timba-release-0.2.0/
```

The Quadlets, secrets, databases, Podman authentication, Cosign 3.0.6, lingering, and auto-update timer are already installed. Do not restage them.

## 2. VPS: drain and stop 0.1.3

```bash
"$HOME/.local/bin/bun" run "$HOME/timba-release-0.2.0/upgrade-0.2.0.ts" import-bundle

"$HOME/.local/bin/bun" run "$HOME/timba-release-0.2.0/upgrade-0.2.0.ts" vps-preflight --host vps
"$HOME/.local/bin/bun" run "$HOME/timba-release-0.2.0/upgrade-0.2.0.ts" vps-preflight --host vps --execute
```

The preflight requires both healthy, auto-updating Quadlets to be active on ABI 0.1.3. It verifies rootless Podman, service files, database files, restricted secret modes, and the shared oracle API token.

Announce maintenance and enable the static web maintenance response. Keep the services running while existing games settle:

```bash
"$HOME/.local/bin/bun" run "$HOME/timba-release-0.2.0/upgrade-0.2.0.ts" drain --host vps
"$HOME/.local/bin/bun" run "$HOME/timba-release-0.2.0/upgrade-0.2.0.ts" drain --host vps --execute --approve drain
```

The phase disables supported tokens, runs the oracle shutdown scan inside the existing Podman containers, and independently queries finalized mainnet accounts. It blocks the upgrade if any legacy game still has tickets, participant hashes, or funds.

Stop the clients and create the release checkpoint:

```bash
"$HOME/.local/bin/bun" run "$HOME/timba-release-0.2.0/upgrade-0.2.0.ts" backup --host vps
"$HOME/.local/bin/bun" run "$HOME/timba-release-0.2.0/upgrade-0.2.0.ts" backup --host vps --execute
"$HOME/.local/bin/bun" run "$HOME/timba-release-0.2.0/upgrade-0.2.0.ts" export-bundle
```

This records both Podman container identities, stops bot before oracle, verifies both services are inactive, checkpoints and integrity-checks the four SQLite databases, and stores copies plus hashes below the release directory.

Retrieve the updated bundle:

```bash
scp user@vps:~/timba-release-0.2.0/release-state.bundle.json \
  "$HOME/timba-release-0.2.0/"
```

## 3. Trusted machine: upgrade, publish, and verify

```bash
bun run upgrade:0.2.0 import-bundle

bun run upgrade:0.2.0 build --host local
bun run upgrade:0.2.0 build --host local --execute
```

Before deployment, have a second person verify the mainnet cluster, existing program ID, frozen commit and executable hash, upgrade authority, expected SOL cost, absence of token transfers, and preservation of the existing oracle account.

Replace the example authority path with the real local file:

```bash
bun run upgrade:0.2.0 deploy-contract --host local \
  --authority /secure/path/to/upgrade-authority.json
bun run upgrade:0.2.0 deploy-contract --host local --execute \
  --approve deploy-contract \
  --authority /secure/path/to/upgrade-authority.json
```

The phase compares executable hashes, safely recognizes an already-successful deployment, otherwise upgrades with `--verifiable --no-idl`, dumps the deployed program, and requires an exact hash match.

Publish the program's first canonical IDL:

```bash
bun run upgrade:0.2.0 publish-idl --host local \
  --authority /secure/path/to/upgrade-authority.json
bun run upgrade:0.2.0 publish-idl --host local --execute \
  --approve publish-idl \
  --authority /secure/path/to/upgrade-authority.json
```

Complete both reproducible verification paths:

```bash
bun run upgrade:0.2.0 verify-source --host local
bun run upgrade:0.2.0 verify-source --host local --execute --approve verify-source

bun run upgrade:0.2.0 verify-remote --host local \
  --authority /secure/path/to/upgrade-authority.json
bun run upgrade:0.2.0 verify-remote --host local --execute \
  --approve verify-remote \
  --authority /secure/path/to/upgrade-authority.json
```

Remote verification must report success before continuing.

Freeze the tested client commits already released on `main`:

```bash
bun run upgrade:0.2.0 release-clients --host local
bun run upgrade:0.2.0 release-clients --host local --execute
```

Activate and deploy the Cloudflare client with ABI 0.2.0:

```bash
bun run upgrade:0.2.0 activate-web --host local
bun run upgrade:0.2.0 activate-web --host local --execute --approve activate-web
```

This sets the private GitHub repository variable consumed by the deployment workflow and dispatches `deploy.yml`. Wait for that workflow to succeed before starting the VPS clients.

Send the final state to the VPS:

```bash
bun run upgrade:0.2.0 export-bundle
scp scripts/upgrade-0.2.0.ts \
  "$HOME/timba-release-0.2.0/release-state.bundle.json" \
  user@vps:~/timba-release-0.2.0/
```

## 4. VPS: activate 0.2.0 clients

```bash
"$HOME/.local/bin/bun" run "$HOME/timba-release-0.2.0/upgrade-0.2.0.ts" import-bundle

"$HOME/.local/bin/bun" run "$HOME/timba-release-0.2.0/upgrade-0.2.0.ts" activate-clients --host vps
"$HOME/.local/bin/bun" run "$HOME/timba-release-0.2.0/upgrade-0.2.0.ts" activate-clients --host vps --execute \
  --approve activate-clients
```

This requires both services to still be stopped, verifies and pulls the signed Oracle and Bot images, changes only `TIMBA_CONTRACT_VERSION` in their existing mode-`600` environment files, starts oracle before bot, and validates ABI version, health, authentication, image digests, Quadlet supervision, logs, and the auto-update timer.

Keep maintenance enabled for the controlled lifecycle:

```bash
"$HOME/.local/bin/bun" run "$HOME/timba-release-0.2.0/upgrade-0.2.0.ts" smoke-test --host vps
"$HOME/.local/bin/bun" run "$HOME/timba-release-0.2.0/upgrade-0.2.0.ts" smoke-test --host vps --execute \
  --approve smoke-test
```

Using controlled wallets, create, join, optionally unjoin, and complete one low-value game. Confirm contract state, oracle registry, bot result, and web result agree before removing maintenance.

## 5. Remove temporary 0.1.3 compatibility

Do this as a separate cleanup change only after the controlled lifecycle passes, maintenance is removed, and production has remained healthy on 0.2.0. This cleanup is irreversible: after it is deployed, the clients can no longer connect to a 0.1.3 program.

In Oracle, Bot, and Web:

1. Replace the dual-version IDL selector with the canonical generated 0.2.0 IDL.
2. Remove `ContractVersion`, `resolveContractVersion`, `createLegacyIdl`, every `0.1.3` branch, and their compatibility tests.
3. Remove `TIMBA_CONTRACT_VERSION` and `NEXT_PUBLIC_TIMBA_CONTRACT_VERSION` from code, examples, container configuration, and CI. The clients must use 0.2.0 unconditionally.
4. Replace any remaining version-dependent account-size or instruction-account logic with the 0.2.0 behavior.
5. Search all three repositories and review every remaining match:

   ```bash
   rg -n '0\.1\.3|TIMBA_CONTRACT_VERSION|NEXT_PUBLIC_TIMBA_CONTRACT_VERSION|createLegacyIdl|resolveContractVersion' \
     /path/to/oracle /path/to/bot /path/to/timba-web-cf
   ```

   The command must return no active 0.1.3 compatibility code. Do not remove unrelated historical database/event compatibility merely because it uses the word `legacy`.

Format, lint, typecheck, test, and build all three projects. Commit and push the cleanup, wait for signed Oracle and Bot images and the Web deployment to succeed, then let the Podman auto-update timer deploy the new images. Verify both services are healthy and complete a second controlled game.

Finally, remove the now-unused version setting from the VPS without changing any other secrets:

```bash
sed -i '/^TIMBA_CONTRACT_VERSION=/d' "$HOME/timba/oracle.env" "$HOME/timba/bot.env"
chmod 600 "$HOME/timba/oracle.env" "$HOME/timba/bot.env"
systemctl --user restart timba-oracle.service
systemctl --user restart timba-bot.service
```

Confirm both services are healthy after the restart. Preserve the final release bundle and evidence, but remove this upgrade orchestrator and its tests from Oracle in the same cleanup change once they are no longer needed for incident recovery. Keep this runbook as the historical migration record.

## Failure boundaries

Before contract deployment, restore the checkpointed databases if needed, keep both environment files on `TIMBA_CONTRACT_VERSION=0.1.3`, and restart the existing Podman services in order:

```bash
systemctl --user start timba-oracle.service
systemctl --user start timba-bot.service
```

After deploying 0.2.0, never restart clients with ABI 0.1.3. IDL, verification, web deployment, and client activation failures are roll-forward-only while games remain disabled and maintenance remains enabled.

## Evidence

Archive the final state and bundle with database hashes, pre-upgrade Podman identities, binary and IDL hashes, program output before/after, deployment signatures, verification results, final Podman image digests, health/authentication evidence, Cloudflare deployment run, controlled-game signatures, and final SOL cost.
