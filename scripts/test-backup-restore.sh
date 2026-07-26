#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

readonly environment_file="${ORBIT_ENV_FILE:-.env-orbit}"
readonly storage_key="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
readonly storage_path="/var/lib/orbit/documents/objects/aa/aa/${storage_key}.bin"
backup_path=""

fail() {
  printf 'Orbit backup test: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  [[ -z "$backup_path" ]] || rm -f -- "$backup_path"
}

trap cleanup EXIT
command -v docker >/dev/null 2>&1 || fail "Docker is required."
[[ -f "$environment_file" ]] || fail "Missing ${environment_file}."

compose() {
  docker compose --env-file "$environment_file" "$@"
}

# The marker represents an already encrypted opaque storage object; this test
# verifies cross-resource preservation rather than document cryptography.
compose exec -T orbit-app sh -c \
  'mkdir -p /var/lib/orbit/documents/objects/aa/aa && printf "%s" "orbit-backup-document-marker" > "$1"' \
  sh "$storage_path"
expected_hash="$(compose exec -T orbit-app sha256sum "$storage_path" | awk '{print $1}')"
compose exec -T orbit-db sh -c \
  'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --set=ON_ERROR_STOP=1 --command="create table orbit_ci_backup_marker (value text not null); insert into orbit_ci_backup_marker values (\$\$preserved\$\$);"' \
  >/dev/null

backup_output="$(bash scripts/backup.sh)"
backup_path="${backup_output#Orbit backup created: }"
[[ -f "$backup_path" ]] || fail "Backup script did not return a bundle path."
bash scripts/backup.sh --verify "$backup_path" >/dev/null

compose exec -T orbit-app rm -f "$storage_path"
compose exec -T orbit-db sh -c \
  'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --set=ON_ERROR_STOP=1 --command="drop table orbit_ci_backup_marker;"' \
  >/dev/null
ORBIT_NONINTERACTIVE_RESTORE=true bash scripts/restore.sh --yes "$backup_path" >/dev/null

actual_hash="$(compose exec -T orbit-app sha256sum "$storage_path" | awk '{print $1}')"
[[ "$actual_hash" == "$expected_hash" ]] || fail "Restored document bytes do not match the backup."
marker="$(compose exec -T orbit-db sh -c \
  'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --tuples-only --no-align --command="select value from orbit_ci_backup_marker;"')"
[[ "$marker" == "preserved" ]] || fail "Restored database marker is missing."

# A restored container has a fresh startup path. Poll its endpoint rather than
# racing the first TCP accept, which can briefly reset while Node initializes.
health_deadline=$((SECONDS + 30))
until curl --fail --silent --max-time 2 http://127.0.0.1:3000/api/health >/dev/null 2>&1; do
  (( SECONDS < health_deadline )) ||
    fail "Orbit did not become healthy after restoration."
  sleep 1
done

printf 'Orbit backup test: database and encrypted document bytes round-tripped successfully.\n'
