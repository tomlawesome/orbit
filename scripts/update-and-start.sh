#!/usr/bin/env bash
set -Eeuo pipefail

# Always operate from the repository root, regardless of the caller's location.
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

command -v git >/dev/null 2>&1 || { echo "Git is required." >&2; exit 1; }

git pull --ff-only
bash scripts/deploy-container.sh --build
