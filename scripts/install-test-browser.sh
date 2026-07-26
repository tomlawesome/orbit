#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

command -v pnpm >/dev/null 2>&1 || {
  printf 'Orbit browser setup: pnpm is required.\n' >&2
  exit 1
}

# This is a one-time local download. The headless shell is sufficient for the
# scripted suite and is materially smaller than a full browser installation.
pnpm exec playwright install --only-shell chromium
