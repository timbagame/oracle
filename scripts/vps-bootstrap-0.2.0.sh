#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -eq 0 ]]; then
  echo "Run this as the timba user, not root." >&2
  exit 1
fi

sudo apt-get update
sudo apt-get install -y \
  cosign \
  dbus-user-session \
  fuse-overlayfs \
  podman \
  slirp4netns \
  sqlite3 \
  uidmap
sudo loginctl enable-linger "$USER"

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"
  mkdir -p "$HOME/.local/bin"
  ln -sf "$HOME/.bun/bin/bun" "$HOME/.local/bin/bun"
fi

for tool in bun cosign podman sqlite3; do
  command -v "$tool" >/dev/null
done

test "$(podman info --format '{{.Host.Security.Rootless}}')" = true
test "$(loginctl show-user "$USER" -p Linger --value)" = yes

echo "Timba VPS prerequisites are ready."
