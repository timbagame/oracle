#!/usr/bin/env bash
# Regenerate a differential fixture by running its generator against the
# original TypeScript oracle (the last commit before the Rust rewrite).
# Usage: scripts/regenerate-fixture.sh <generator.mjs> <fixture.json> [generator args...]
# Needs bun and read access to the @timbagame GitHub packages (NODE_AUTH_TOKEN,
# or a `gh auth token` with read:packages).
set -euo pipefail

TS_COMMIT=37d0df4
if [[ $# -lt 2 ]]; then
  sed -n '2,6p' "$0" >&2
  exit 2
fi
generator=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
output=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
shift 2
root=$(git rev-parse --show-toplevel)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git -C "$root" archive "$TS_COMMIT" | tar -x -C "$work"
cd "$work"
export NODE_AUTH_TOKEN=${NODE_AUTH_TOKEN:-$(gh auth token)}
bun install --frozen-lockfile >/dev/null
# Generators import the TypeScript sources as ./src/...; the checkout keeps them at the root.
sed 's#"\./src/#"./#g' "$generator" > generator.mjs
bun generator.mjs "$@" > "$work/fixture.json"
mv "$work/fixture.json" "$output"
echo "Wrote $output"
