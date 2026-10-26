# Differential fixtures

These fixtures were produced by the original TypeScript oracle (commit
`37d0df4`, the last commit before the Rust rewrite) so the Rust port can be
checked byte-for-byte against it. The protocol codec fixtures moved to the
shared `timba-protocol` crate in timbagame/protocol.

| Fixture | Generator | Checked by |
| --- | --- | --- |
| `signer.json` | `generators/signer.mjs` | `crates/oracle/src/core/signer.rs` (v0.2.0 cases) |
| `TS_PREPARED_*` constants | `generators/web-prepare.mjs <checkout>` | `crates/oracle/src/web_api/tests.rs` |

The TypeScript signer predates the v0.3.0 instruction renames, so its v0.3.0
cases are no longer checked. `crates/oracle/src/core/signer_scenarios.rs` ports
the generator to Rust: it rebuilds the v0.2.0 transactions byte for byte and
builds the v0.3.0 cases the signer tests assert directly.

To regenerate a fixture, run its generator against that commit:

```sh
scripts/regenerate-fixture.sh crates/oracle/tests/fixtures/generators/signer.mjs crates/oracle/tests/fixtures/signer.json
```

The script exports `37d0df4` to a temporary directory, installs its
dependencies with `bun install` (the `@timbagame` packages need
`NODE_AUTH_TOKEN` or a `gh auth token` with `read:packages`), points the
generator's `./src/...` imports at the checkout and writes the output.
`web-prepare.mjs` also needs the checkout path: pass `.` after the output file.
