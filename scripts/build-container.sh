#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

readonly environment_file=".env-orbit"
pull_option="--pull"

[[ "$#" -le 1 && ( "$#" -eq 0 || "$1" == "--no-pull" ) ]] || {
  printf 'Orbit build: usage: bash scripts/build-container.sh [--no-pull]\n' >&2
  exit 1
}
[[ "${1:-}" != "--no-pull" ]] || pull_option=""
[[ -f "$environment_file" ]] || {
  printf 'Orbit build: missing %s; run bash scripts/configure.sh first.\n' "$environment_file" >&2
  exit 1
}
command -v docker >/dev/null 2>&1 || {
  printf 'Orbit build: Docker is required.\n' >&2
  exit 1
}
docker compose version >/dev/null 2>&1 || {
  printf 'Orbit build: Docker Compose v2 is required.\n' >&2
  exit 1
}

if [[ -n "$pull_option" ]]; then
  docker compose --env-file "$environment_file" build --pull orbit-app
else
  docker compose --env-file "$environment_file" build orbit-app
fi
