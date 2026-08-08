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
command -v node >/dev/null 2>&1 || {
  printf 'Orbit build: Node.js is required to calculate the release-train version.\n' >&2
  exit 1
}
docker compose version >/dev/null 2>&1 || {
  printf 'Orbit build: Docker Compose v2 is required.\n' >&2
  exit 1
}
export ORBIT_IMAGE="orbit-local:$(git rev-parse --short=12 HEAD)"
export ORBIT_VERSION="$(node scripts/calculate-version.mjs --channel preview)"
export ORBIT_REVISION="$(git rev-parse HEAD)"
export ORBIT_CHANNEL="preview"

# The build context lives in an overlay, because the base compose file
# describes a deployment that has no source tree.
readonly build_files=(-f docker-compose.yml -f docker-compose.build.yml)

if [[ -n "$pull_option" ]]; then
  docker compose --env-file "$environment_file" "${build_files[@]}" build --pull orbit-app
else
  docker compose --env-file "$environment_file" "${build_files[@]}" build orbit-app
fi
