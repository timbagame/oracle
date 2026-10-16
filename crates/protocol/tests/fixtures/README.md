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

To regenerate a fixture, check out `37d0df4` and install its dependencies with
`bun install`, plus `@solana/kit@8.5.0`, `@solana-program/token@0.17.0` and
`@solana-program/system@0.15.0`. Copy the generator next to that checkout's
TypeScript sources, fix up its relative `./src/...` imports so they resolve,
and run `bun <generator>.mjs > <fixture>.json`.
