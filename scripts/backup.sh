#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

readonly environment_file="${ORBIT_ENV_FILE:-.env-orbit}"
readonly backup_directory="${ORBIT_BACKUP_DIR:-$repo_dir/backups}"
readonly secrets_directory="${ORBIT_SECRETS_DIR:-$repo_dir/.orbit-secrets}"
readonly document_kek_file="$secrets_directory/document-kek"
readonly bundle_format_version="1"
readonly timestamp="$(date -u +%Y%m%d-%H%M%S)"
work_directory=""
temporary_path=""
app_stopped=false

fail() {
  printf 'Orbit backup: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  [[ -z "$work_directory" ]] || rm -rf -- "$work_directory"
  [[ -z "$temporary_path" ]] || rm -f -- "$temporary_path"
  if [[ "$app_stopped" == true ]]; then
    compose start orbit-app >/dev/null || true
  fi
}

compose() {
  docker compose --env-file "$environment_file" "$@"
}

require_tools() {
  command -v docker >/dev/null 2>&1 || fail "Docker is required."
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
  command -v openssl >/dev/null 2>&1 || fail "OpenSSL is required."
  command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required."
  command -v tar >/dev/null 2>&1 || fail "tar is required."
  [[ -f "$environment_file" ]] || fail "Missing ${environment_file}."
}

read_document_kek() {
  [[ -f "$document_kek_file" && ! -L "$document_kek_file" ]] ||
    fail "Missing regular document KEK file at ${document_kek_file}."
  [[ "$(tr -d '\r\n' < "$document_kek_file")" =~ ^[0-9a-fA-F]{64}$ ]] ||
    fail "Document KEK must be a 32-byte hexadecimal value."
}

write_hmac() {
  local input_path="$1" output_path="$2"
  # The application image reads its mounted key file; the key never appears in
  # a command argument, environment variable, output, or temporary host file.
  compose run --rm --no-deps -T --entrypoint node orbit-app \
    /opt/orbit/scripts/recovery-crypto.mjs hmac /run/secrets/orbit-document-kek \
    < "$input_path" > "$output_path" 2>/dev/null
  [[ "$(tr -d '\r\n' < "$output_path")" =~ ^[A-Za-z0-9+/]{43}=$ ]] ||
    fail "Could not generate a valid bundle authentication tag."
}

document_kek_fingerprint() {
  local fingerprint
  fingerprint="$(compose run --rm --no-deps -T --entrypoint node orbit-app \
    /opt/orbit/scripts/recovery-crypto.mjs fingerprint /run/secrets/orbit-document-kek 2>/dev/null)"
  [[ "$fingerprint" =~ ^[a-f0-9]{64}$ ]] || fail "Could not derive the document-key fingerprint."
  printf '%s' "$fingerprint"
}

verify_hmac() {
  local input_path="$1" expected_path="$2" actual_path
  actual_path="$(mktemp "$work_directory/.hmac.XXXXXX")"
  write_hmac "$input_path" "$actual_path"
  cmp --silent "$actual_path" "$expected_path" || fail "Bundle manifest authentication failed."
  rm -f -- "$actual_path"
}

validate_document_archive() {
  local archive_path="$1" listing_path="$work_directory/document-archive-list"
  tar -tf "$archive_path" > "$listing_path" 2>/dev/null || fail "Document archive is invalid."
  while IFS= read -r entry; do
    if [[ "$entry" == "." || "$entry" == "./objects" || "$entry" == "./objects/" ||
      "$entry" =~ ^\./objects/[a-f0-9]{2}$ || "$entry" =~ ^\./objects/[a-f0-9]{2}/$ ||
      "$entry" =~ ^\./objects/[a-f0-9]{2}/[a-f0-9]{2}$ ||
      "$entry" =~ ^\./objects/[a-f0-9]{2}/[a-f0-9]{2}/$ ]]; then
      continue
    fi
    if [[ "$entry" =~ ^\./objects/([a-f0-9]{2})/([a-f0-9]{2})/([a-f0-9]{64})\.bin$ ]]; then
      [[ "${BASH_REMATCH[1]}${BASH_REMATCH[2]}" == "${BASH_REMATCH[3]:0:4}" ]] ||
        fail "Document archive contains a misplaced object."
      continue
    fi
    fail "Document archive contains an unexpected path."
  done < "$listing_path"
  if ! tar -tvf "$archive_path" 2>/dev/null | awk 'substr($1, 1, 1) !~ /[-d]/ { exit 1 }' >/dev/null; then
    fail "Document archive contains a link or special file."
  fi
}

validate_bundle() {
  local bundle_path="$1" extracted contents
  [[ -f "$bundle_path" && ! -L "$bundle_path" ]] || fail "The bundle must be a regular, non-symbolic-link file."
  work_directory="$(mktemp -d "${TMPDIR:-/tmp}/orbit-bundle-verify.XXXXXX")"
  extracted="$work_directory/extracted"
  mkdir "$extracted"

  contents="$(tar -tf "$bundle_path" 2>/dev/null)" || fail "Bundle archive is invalid."
  printf '%s\n' "$contents" | sort > "$work_directory/contents"
  tar -tvf "$bundle_path" 2>/dev/null | awk 'substr($1, 1, 1) != "-" { exit 1 }' ||
    fail "Bundle contains a link or special file."
  printf '%s\n' checksums.sha256 database.dump documents.tar.enc manifest manifest.hmac | sort > "$work_directory/expected"
  cmp --silent "$work_directory/expected" "$work_directory/contents" ||
    fail "Bundle does not contain the expected recovery files."
  tar -xf "$bundle_path" -C "$extracted" 2>/dev/null || fail "Bundle archive is invalid."

  grep --quiet "^format_version=${bundle_format_version}$" "$extracted/manifest" ||
    fail "Unsupported bundle format."
  grep --quiet "^document_kek_sha256=$(document_kek_fingerprint)$" "$extracted/manifest" ||
    fail "Bundle was encrypted with a different document KEK."
  cat "$extracted/manifest" "$extracted/checksums.sha256" > "$work_directory/manifest-and-checksums"
  verify_hmac "$work_directory/manifest-and-checksums" "$extracted/manifest.hmac"
  (cd "$extracted" && sha256sum --check --status checksums.sha256) ||
    fail "Bundle checksum validation failed."
  compose exec -T orbit-db pg_restore --list < "$extracted/database.dump" >/dev/null 2>/dev/null ||
    fail "The bundle database dump is invalid."
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -pass "file:$document_kek_file" \
    -in "$extracted/documents.tar.enc" -out "$extracted/documents.tar" 2>/dev/null ||
    fail "Document archive decryption failed."
  validate_document_archive "$extracted/documents.tar"
  printf '%s\n' "$extracted"
}

create_bundle() {
  mkdir -p -- "$backup_directory"
  chmod 700 "$backup_directory"
  umask 077
  work_directory="$(mktemp -d "$backup_directory/.orbit-backup.XXXXXX")"
  temporary_path="$backup_directory/orbit-$timestamp.tar.installing"
  local manifest_path="$work_directory/manifest"
  local document_archive="$work_directory/documents.tar"
  local encrypted_documents="$work_directory/documents.tar.enc"

  # Stop writers for a cross-resource point-in-time backup. A one-off app
  # container then mounts the volume without starting the web server.
  compose stop orbit-app >/dev/null
  app_stopped=true
  compose exec -T orbit-db sh -c \
    'exec pg_dump --format=custom --compress=6 --no-owner --no-acl --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
    > "$work_directory/database.dump"
  [[ -s "$work_directory/database.dump" ]] || fail "PostgreSQL produced an empty backup."
  compose exec -T orbit-db pg_restore --list < "$work_directory/database.dump" >/dev/null
  compose run --rm --no-deps --entrypoint tar orbit-app -C /var/lib/orbit/documents -cf - . > "$document_archive"
  validate_document_archive "$document_archive"
  openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -salt -pass "file:$document_kek_file" \
    -in "$document_archive" -out "$encrypted_documents"
  rm -f -- "$document_archive"

  cat > "$manifest_path" <<EOF
format_version=$bundle_format_version
created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
database_dump=database.dump
documents_archive=documents.tar.enc
documents_encryption=aes-256-cbc-pbkdf2-sha256-iter-600000
document_kek_sha256=$(document_kek_fingerprint)
EOF
  (cd "$work_directory" && sha256sum database.dump documents.tar.enc > checksums.sha256)
  cat "$manifest_path" "$work_directory/checksums.sha256" > "$work_directory/manifest-and-checksums"
  write_hmac "$work_directory/manifest-and-checksums" "$work_directory/manifest.hmac"
  tar -C "$work_directory" -cf "$temporary_path" manifest manifest.hmac checksums.sha256 database.dump documents.tar.enc
  tar -tf "$temporary_path" >/dev/null || fail "Could not validate the completed bundle."
  final_path="$backup_directory/orbit-$timestamp.tar"
  mv --no-clobber -- "$temporary_path" "$final_path"
  temporary_path=""
  compose start orbit-app >/dev/null
  app_stopped=false
  printf 'Orbit backup created: %s\n' "$final_path"
}

trap cleanup EXIT
require_tools
read_document_kek

if [[ "${1:-}" == "--verify" ]]; then
  [[ "$#" == 2 ]] || fail "Usage: bash scripts/backup.sh --verify <backup.tar>"
  validate_bundle "$2" >/dev/null
  printf 'Orbit backup is valid: %s\n' "$2"
elif [[ "$#" == 0 ]]; then
  create_bundle
else
  fail "Usage: bash scripts/backup.sh [--verify <backup.tar>]"
fi
