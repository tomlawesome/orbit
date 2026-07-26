#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

readonly environment_file=".env-orbit"
readonly mode="${1:---pull}"
backup_path=""

fail() {
  printf 'Orbit deploy: %s\n' "$*" >&2
  exit 1
}

[[ "$mode" == "--pull" || "$mode" == "--build" ]] ||
  fail "Usage: bash scripts/deploy-container.sh [--pull|--build]"
[[ -f "$environment_file" ]] ||
  fail "Missing ${environment_file}; run bash scripts/configure.sh first."
command -v docker >/dev/null 2>&1 || fail "Docker is required."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."

bash scripts/configure.sh

compose() {
  docker compose --env-file "$environment_file" "$@"
}

# Prepare the candidate image before touching a running deployment.
compose pull orbit-db
compose pull orbit-clamav
if [[ "$mode" == "--build" ]]; then
  bash scripts/build-container.sh
else
  compose pull orbit-app
fi

# Database migrations happen on application startup. Preserve a validated
# recovery point whenever this is an update rather than a first deployment.
if [[ -n "$(compose ps --status running --quiet orbit-db)" ]]; then
  backup_message="$(bash scripts/backup.sh)"
  printf '%s\n' "$backup_message"
  backup_path="${backup_message#Orbit backup created: }"
fi

if ! compose up --detach --no-build --wait --wait-timeout 180; then
  printf 'Orbit deploy: the candidate did not become healthy.\n' >&2
  compose ps >&2 || true
  if [[ -n "$backup_path" ]]; then
    printf 'Recovery point: %s\n' "$backup_path" >&2
    printf 'Inspect the logs before restoring with: bash scripts/restore.sh %q\n' "$backup_path" >&2
  fi
  exit 1
fi
compose ps
printf 'Orbit deployment is healthy.\n'
