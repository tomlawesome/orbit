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
command -v docker >/dev/null 2>&1 || fail "Docker is required."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."

if [[ "$mode" == "--build" ]]; then
  export ORBIT_IMAGE="orbit-local:$(git rev-parse --short=12 HEAD)"
else
  configured_image="${ORBIT_IMAGE:-}"
  if [[ -z "$configured_image" && -f "$environment_file" ]]; then
    configured_image="$(sed -n 's/^ORBIT_IMAGE=//p' "$environment_file" | tail -n 1)"
  fi
  [[ "$configured_image" =~ ^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$ ]] ||
    fail "Pull deployments require ORBIT_IMAGE to identify an immutable registry digest."
  export ORBIT_IMAGE="$configured_image"
fi

compose() {
  docker compose --env-file "$environment_file" "$@"
}

# The image has to exist before configuration, because configuration runs
# inside it (#1210 D4): build or pull it first. Nothing here touches the
# existing .env-orbit, secrets or volumes, so an existing deployment keeps
# its data.
if [[ "$mode" == "--build" ]]; then
  bash scripts/build-container.sh
else
  docker pull "$ORBIT_IMAGE"
fi

bash scripts/configure.sh

# Prepare the remaining images before touching a running deployment.
compose pull orbit-db
compose pull orbit-clamav

# Database migrations happen on application startup. Preserve a validated
# recovery point whenever this is an update rather than a first deployment.
if [[ -n "$(compose ps --status running --quiet orbit-db)" ]]; then
  backup_message="$(bash scripts/backup.sh)"
  printf '%s\n' "$backup_message"
  backup_path="${backup_message#Orbit backup created: }"
fi

if ! compose up --detach --no-build --wait --wait-timeout 180; then
  printf 'Orbit deploy: the application image did not become healthy.\n' >&2
  compose ps >&2 || true
  if [[ -n "$backup_path" ]]; then
    printf 'Recovery point: %s\n' "$backup_path" >&2
    printf 'Inspect the logs before restoring with: bash scripts/restore.sh %q\n' "$backup_path" >&2
  fi
  exit 1
fi
compose ps
printf 'Orbit deployment is healthy.\n'
