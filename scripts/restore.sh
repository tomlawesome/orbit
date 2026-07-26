#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

readonly environment_file=".env-orbit"
readonly backup_file="${1:-}"
app_stopped=false

fail() {
  printf 'Orbit restore: %s\n' "$*" >&2
  exit 1
}

compose() {
  docker compose --env-file "$environment_file" "$@"
}

restart_after_failure() {
  if [[ "$app_stopped" == true ]]; then
    compose start orbit-app >/dev/null || true
  fi
}

trap restart_after_failure EXIT
command -v docker >/dev/null 2>&1 || fail "Docker is required."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
[[ -f "$environment_file" ]] || fail "Missing ${environment_file}."
[[ -n "$backup_file" ]] || fail "Usage: bash scripts/restore.sh <backup.dump>"
[[ -f "$backup_file" && ! -L "$backup_file" ]] || fail "The backup must be a regular, non-symbolic-link file."

# Validate the complete custom-format archive before stopping Orbit.
compose exec -T orbit-db pg_restore --list < "$backup_file" >/dev/null ||
  fail "The selected file is not a valid PostgreSQL custom-format backup."

printf 'This will replace Orbit database contents with:\n  %s\n' "$backup_file"
read -r -p 'Type RESTORE to continue: ' confirmation </dev/tty ||
  fail "An interactive terminal is required."
[[ "$confirmation" == "RESTORE" ]] || fail "Restore cancelled."

compose stop orbit-app >/dev/null
app_stopped=true

# One transaction ensures a failed restore rolls back instead of leaving a
# partially replaced database.
compose exec -T orbit-db sh -c \
  'exec pg_restore --single-transaction --clean --if-exists --no-owner --no-acl --exit-on-error --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
  < "$backup_file"

compose start orbit-app >/dev/null
app_stopped=false
trap - EXIT
compose ps
printf 'Orbit restore completed successfully.\n'
