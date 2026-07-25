#!/usr/bin/env bash
set -Eeuo pipefail

# Always operate from the repository root, regardless of the caller's location.
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

readonly environment_file=".env-orbit"

command -v git >/dev/null 2>&1 || { echo "Git is required." >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Docker is required." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required." >&2; exit 1; }

if [[ ! -f "$environment_file" ]]; then
  echo "Missing ${environment_file}. Run: bash scripts/configure.sh" >&2
  exit 1
fi

compose() {
  docker compose --env-file "$environment_file" "$@"
}

git pull --ff-only
compose pull orbit-db
compose build --pull orbit-app
compose up -d --remove-orphans
compose ps
