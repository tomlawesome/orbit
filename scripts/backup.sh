#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

readonly environment_file=".env-orbit"
readonly backup_directory="${ORBIT_BACKUP_DIR:-$repo_dir/backups}"
readonly timestamp="$(date -u +%Y%m%d-%H%M%S)"
final_path=""
temporary_path=""

fail() {
  printf 'Orbit backup: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  [[ -z "$temporary_path" ]] || rm -f -- "$temporary_path"
}

trap cleanup EXIT
command -v docker >/dev/null 2>&1 || fail "Docker is required."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
[[ -f "$environment_file" ]] || fail "Missing ${environment_file}."

compose() {
  docker compose --env-file "$environment_file" "$@"
}

mkdir -p -- "$backup_directory"
chmod 700 "$backup_directory"
umask 077
temporary_path="$(mktemp "$backup_directory/.orbit-backup.XXXXXX")"
readonly suffix="${temporary_path##*.}"
final_path="$backup_directory/orbit-$timestamp-$suffix.dump"

# Database credentials remain inside the PostgreSQL container environment.
compose exec -T orbit-db sh -c \
  'exec pg_dump --format=custom --compress=6 --no-owner --no-acl --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
  > "$temporary_path"

[[ -s "$temporary_path" ]] || fail "PostgreSQL produced an empty backup."
compose exec -T orbit-db pg_restore --list < "$temporary_path" >/dev/null
mv --no-clobber -- "$temporary_path" "$final_path"
temporary_path=""

printf 'Orbit backup created: %s\n' "$final_path"
