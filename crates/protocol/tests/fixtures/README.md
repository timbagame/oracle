# Differential fixtures

These JSON files were produced by the original TypeScript oracle (commit
`37d0df4`, the last commit before the Rust rewrite) so the Rust port can be
checked byte-for-byte against it.

| Fixture | Generator | Checked by |
| --- | --- | --- |
| `plans.json` | `generators/plans.mjs` | `crates/protocol/tests/kit_parity.rs` |
| `complete.json` | `generators/complete.mjs` | `crates/protocol/tests/kit_parity.rs` |
| `../../../oracle/tests/fixtures/signer.json` | `generators/signer.mjs` | `crates/oracle/src/core/signer.rs` |
| `TS_PREPARED_*` constants | `generators/web-prepare.mjs <checkout>` | `crates/oracle/src/web_api/tests.rs` |

To regenerate a fixture, run its generator against that commit:

```sh
scripts/regenerate-fixture.sh crates/protocol/tests/fixtures/generators/signer.mjs crates/oracle/tests/fixtures/signer.json
```

The script exports `37d0df4` to a temporary directory, installs its
dependencies with `bun install` (the `@timbagame` packages need
`NODE_AUTH_TOKEN` or a `gh auth token` with `read:packages`), points the
generator's `./src/...` imports at the checkout and writes the output.
`web-prepare.mjs` also needs the checkout path: pass `.` after the output file.
