#!/usr/bin/env bash
# Smoke-test a built oracle image: both binaries run, and the image has no shell.
# Usage: scripts/smoke-image.sh <image>
set -euo pipefail

image=${1:?usage: scripts/smoke-image.sh <image>}
failures=0

# expect <exit code> <output substring> <command...>
expect() {
  local want=$1 needle=$2 output status
  shift 2
  set +e
  output=$(podman run --rm --env SOLANA_NETWORK=http://127.0.0.1:9 "$image" "$@" 2>&1)
  status=$?
  set -e
  if [[ $status -ne $want || $output != *"$needle"* ]]; then
    echo "FAIL: $* -> exit $status (want $want, output containing '$needle')"
    printf '    %s\n' "$output"
    failures=$((failures + 1))
  else
    echo "ok: $*"
  fi
}

expect 0 "timba-oracle" timba-oracle --version
# No server is listening, so the probe must fail quickly instead of exec failing (127).
expect 1 "" timba-oracle healthcheck
expect 1 "ORACLE_API_TOKEN is required" timba-oracle serve
expect 1 "EVM_CONFIG_FILE is required" timba-evm-oracle
# Distroless: there is no shell to exec into.
expect 127 "" sh -c true

if [[ $failures -ne 0 ]]; then
  echo "$failures image smoke check(s) failed"
  exit 1
fi
