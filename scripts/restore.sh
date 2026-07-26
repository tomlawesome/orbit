#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

readonly environment_file=".env-orbit"
noninteractive=false
if [[ "${1:-}" == "--yes" ]]; then
  noninteractive=true
  shift
fi
readonly backup_file="${1:-}"
temporary_directory=""
app_stopped=false
documents_replaced=false

fail() {
  printf 'Orbit restore: %s\n' "$*" >&2
  exit 1
}

compose() {
  docker compose --env-file "$environment_file" "$@"
}

validate_document_archive() {
  local archive_path="$1" listing_path="$temporary_directory/document-archive-list"
  tar -tf "$archive_path" > "$listing_path" || fail "Document archive is invalid."
  if grep -Ev '^(\./|\./objects/|\./objects/[a-f0-9]{2}/|\./objects/[a-f0-9]{2}/[a-f0-9]{2}/|\./objects/[a-f0-9]{2}/[a-f0-9]{2}/[a-f0-9]{64}\.bin)$' "$listing_path" >/dev/null; then
    fail "Document archive contains an unexpected path."
  fi
  tar -tvf "$archive_path" | awk 'substr($1, 1, 1) !~ /[-d]/ { exit 1 }' ||
    fail "Document archive contains a link or special file."
}

rollback_documents() {
  [[ "$documents_replaced" == true && -f "$temporary_directory/original-documents.tar" ]] || return
  compose run --rm --no-deps --entrypoint sh orbit-app -c \
    'find /var/lib/orbit/documents -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; exec tar -C /var/lib/orbit/documents -xf -' \
    < "$temporary_directory/original-documents.tar" >/dev/null
}

cleanup() {
  if [[ "$app_stopped" == true ]]; then
    rollback_documents || true
    compose start orbit-app >/dev/null || true
  fi
  [[ -z "$temporary_directory" ]] || rm -rf -- "$temporary_directory"
}

trap cleanup EXIT
command -v docker >/dev/null 2>&1 || fail "Docker is required."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
command -v openssl >/dev/null 2>&1 || fail "OpenSSL is required."
[[ -f "$environment_file" ]] || fail "Missing ${environment_file}."
[[ -n "$backup_file" && "$#" == 1 ]] || fail "Usage: bash scripts/restore.sh [--yes] <backup.tar>"
[[ -f "$backup_file" && ! -L "$backup_file" ]] || fail "The backup must be a regular, non-symbolic-link file."

# Validation authenticates the manifest with the locally configured KEK and
# decrypts/checks the document archive before any live data is touched.
bash scripts/backup.sh --verify "$backup_file"

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/orbit-restore.XXXXXX")"
tar -tf "$backup_file" | sort > "$temporary_directory/contents"
printf '%s\n' checksums.sha256 database.dump documents.tar.enc manifest manifest.hmac |
  sort > "$temporary_directory/expected"
cmp --silent "$temporary_directory/expected" "$temporary_directory/contents" ||
  fail "Backup bundle changed after validation."
tar -tvf "$backup_file" | awk 'substr($1, 1, 1) != "-" { exit 1 }' ||
  fail "Backup bundle contains a link or special file."
tar -xf "$backup_file" -C "$temporary_directory"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 \
  -pass "file:${ORBIT_SECRETS_DIR:-$repo_dir/.orbit-secrets}/document-kek" \
  -in "$temporary_directory/documents.tar.enc" -out "$temporary_directory/documents.tar"
validate_document_archive "$temporary_directory/documents.tar"

printf 'This will replace Orbit database contents and encrypted document bytes with:\n  %s\n' "$backup_file"
if [[ "$noninteractive" == true ]]; then
  [[ "${ORBIT_NONINTERACTIVE_RESTORE:-false}" == "true" ]] ||
    fail "--yes requires ORBIT_NONINTERACTIVE_RESTORE=true and is intended for controlled automation."
else
  read -r -p 'Type RESTORE to continue: ' confirmation </dev/tty ||
    fail "An interactive terminal is required."
  [[ "$confirmation" == "RESTORE" ]] || fail "Restore cancelled."
fi

compose stop orbit-app >/dev/null
app_stopped=true
# Keep an on-host rollback archive until the database transaction commits.
compose run --rm --no-deps --entrypoint tar orbit-app -C /var/lib/orbit/documents -cf - . \
  > "$temporary_directory/original-documents.tar"
compose run --rm --no-deps --entrypoint sh orbit-app -c \
  'find /var/lib/orbit/documents -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; exec tar -C /var/lib/orbit/documents -xf -' \
  < "$temporary_directory/documents.tar"
documents_replaced=true

# The document rollback archive is retained until this transactional database
# restore succeeds; a failure leaves both live resources at their prior state.
compose exec -T orbit-db sh -c \
  'exec pg_restore --single-transaction --clean --if-exists --no-owner --no-acl --exit-on-error --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
  < "$temporary_directory/database.dump"

documents_replaced=false
compose start orbit-app >/dev/null
app_stopped=false
trap - EXIT
rm -rf -- "$temporary_directory"
temporary_directory=""
compose ps
printf 'Orbit restore completed successfully.\n'
