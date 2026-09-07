#!/usr/bin/env bash
# tui-dev.sh — run `opencode` in this repo with the TUI plugin actually rendering.
#
# In a dev checkout, node_modules/solid-js and node_modules/@opentui shadow the
# TUI host's injected Solid/OpenTUI instances: Solid's node export condition is
# the SSR build (dist/server.js), so the plugin's signals never update and the
# three progress surfaces silently render nothing. This wrapper stashes the
# shadowing packages, runs opencode, and restores them on exit. Published
# installs of ultraopen don't ship those packages and don't need this.
#
# Usage: bash test/e2e/tui-dev.sh [opencode args...]

set -euo pipefail
cd "$(dirname "$0")/../.." || exit 1

STASH="${TMPDIR:-/tmp}/ultraopen-tui-dev-stash"
restore() {
  for m in solid-js @opentui; do
    if [ -d "$STASH/$m" ]; then mv "$STASH/$m" "node_modules/$m"; fi
  done
  rmdir "$STASH" 2>/dev/null || true
}
trap restore EXIT

if [ ! -d dist ]; then
  echo "dist/ missing — running bun run build first"
  bun run build
fi

mkdir -p "$STASH"
for m in solid-js @opentui; do
  if [ -d "node_modules/$m" ] && [ ! -d "$STASH/$m" ]; then
    mv "node_modules/$m" "$STASH/$m"
    echo "stashed node_modules/$m for the TUI session"
  fi
done

opencode "$@"