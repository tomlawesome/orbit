#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

readonly environment_file="${ORBIT_ENV_FILE:-.env-orbit}"
readonly backup_directory="${ORBIT_BACKUP_DIR:-$repo_dir/backups}"
readonly restore_root="$backup_directory/.orbit-restore"
readonly journal_path="$restore_root/restore.journal"
readonly secrets_directory="${ORBIT_SECRETS_DIR:-$repo_dir/.orbit-secrets}"
readonly document_kek_file="$secrets_directory/document-kek"
readonly bundle_format_version="1"

noninteractive=false
recover_mode=false
backup_file=""
temporary_directory=""
stage_database=""
checkpoint_directory=""
checkpoint_verified=false
app_stopped=false
documents_replaced=false
completed=false
manual_recovery_required=false
restore_id=""
checkpoint_database_sha256=""
checkpoint_documents_sha256=""
checkpoint_document_kek_sha256=""

fail() {
  printf 'Orbit restore: %s\n' "$*" >&2
  exit 1
}

compose() {
  docker compose --env-file "$environment_file" "$@"
}

require_tools() {
  command -v docker >/dev/null 2>&1 || fail 'preflight/tools failed; Docker is required.'
  docker compose version >/dev/null 2>&1 || fail 'preflight/tools failed; Docker Compose v2 is required.'
  command -v openssl >/dev/null 2>&1 || fail 'preflight/tools failed; OpenSSL is required.'
  command -v sha256sum >/dev/null 2>&1 || fail 'preflight/tools failed; sha256sum is required.'
  command -v tar >/dev/null 2>&1 || fail 'preflight/tools failed; tar is required.'
  command -v find >/dev/null 2>&1 || fail 'preflight/tools failed; find is required.'
  command -v stat >/dev/null 2>&1 || fail 'preflight/tools failed; stat is required.'
  command -v sync >/dev/null 2>&1 || fail 'preflight/tools failed; sync is required.'
  command -v curl >/dev/null 2>&1 || fail 'preflight/tools failed; curl is required.'
  [[ -f "$environment_file" ]] || fail 'preflight/configuration failed; the Orbit environment file is missing.'
}

read_document_kek() {
  [[ -f "$document_kek_file" && ! -L "$document_kek_file" ]] ||
    fail 'preflight/key failed; the configured document key is missing.'
  [[ "$(tr -d '\r\n' < "$document_kek_file")" =~ ^[0-9a-fA-F]{64}$ ]] ||
    fail 'preflight/key failed; the configured document key is invalid.'
}

write_hmac() {
  local input_path="$1" output_path="$2"
  if ! compose run --rm --no-deps -T --entrypoint node orbit-app \
    /opt/orbit/scripts/recovery-crypto.mjs hmac /run/secrets/orbit-document-kek \
    < "$input_path" > "$output_path" 2>/dev/null; then
    fail 'preflight/authentication failed; the bundle could not be authenticated.'
  fi
  [[ "$(tr -d '\r\n' < "$output_path")" =~ ^[A-Za-z0-9+/]{43}=$ ]] ||
    fail 'preflight/authentication failed; the bundle authentication tag is invalid.'
}

document_kek_fingerprint() {
  local fingerprint
  if ! fingerprint="$(compose run --rm --no-deps -T --entrypoint node orbit-app \
    /opt/orbit/scripts/recovery-crypto.mjs fingerprint /run/secrets/orbit-document-kek 2>/dev/null)"; then
    fail 'preflight/key failed; the configured document key could not be checked.'
  fi
  [[ "$fingerprint" =~ ^[a-f0-9]{64}$ ]] || fail 'preflight/key failed; the configured document key is invalid.'
  printf '%s' "$fingerprint"
}

verify_hmac() {
  local input_path="$1" expected_path="$2" actual_path
  actual_path="$temporary_directory/hmac"
  write_hmac "$input_path" "$actual_path"
  cmp --silent "$actual_path" "$expected_path" ||
    fail 'preflight/authentication failed; the bundle manifest authentication tag does not match.'
}

validate_document_archive() {
  local archive_path="$1" listing_path="$temporary_directory/document-archive-list"
  if ! tar -tf "$archive_path" > "$listing_path" 2>/dev/null; then
    fail 'preflight/archive failed; the document archive is invalid.'
  fi
  while IFS= read -r entry; do
    if [[ "$entry" == '.' || "$entry" == './' || "$entry" == './objects' || "$entry" == './objects/' ||
      "$entry" =~ ^\./objects/[a-f0-9]{2}$ || "$entry" =~ ^\./objects/[a-f0-9]{2}/$ ||
      "$entry" =~ ^\./objects/[a-f0-9]{2}/[a-f0-9]{2}$ ||
      "$entry" =~ ^\./objects/[a-f0-9]{2}/[a-f0-9]{2}/$ ]]; then
      continue
    fi
    if [[ "$entry" =~ ^\./objects/([a-f0-9]{2})/([a-f0-9]{2})/([a-f0-9]{64})\.bin$ ]]; then
      [[ "${BASH_REMATCH[1]}${BASH_REMATCH[2]}" == "${BASH_REMATCH[3]:0:4}" ]] ||
        fail 'preflight/archive failed; the document archive contains a misplaced object.'
      continue
    fi
    fail 'preflight/archive failed; the document archive contains an unsafe path.'
  done < "$listing_path"
  if ! tar -tvf "$archive_path" 2>/dev/null | awk 'substr($1, 1, 1) !~ /[-d]/ { exit 1 }' >/dev/null; then
    fail 'preflight/archive failed; the document archive contains a link or special file.'
  fi
}

validate_bundle_layout() {
  local bundle_path="$1" contents_path="$temporary_directory/bundle-contents" contents
  if ! contents="$(tar -tf "$bundle_path" 2>/dev/null)"; then
    fail 'preflight/archive failed; the recovery bundle is invalid.'
  fi
  printf '%s\n' "$contents" | sort > "$contents_path"
  printf '%s\n' checksums.sha256 database.dump documents.tar.enc manifest manifest.hmac | sort > "$temporary_directory/bundle-expected"
  cmp --silent "$temporary_directory/bundle-expected" "$contents_path" ||
    fail 'preflight/archive failed; the recovery bundle does not contain the expected files.'
  if ! tar -tvf "$bundle_path" 2>/dev/null | awk 'substr($1, 1, 1) != "-" { exit 1 }' >/dev/null; then
    fail 'preflight/archive failed; the recovery bundle contains a link or special file.'
  fi
}

validate_bundle() {
  local bundle_path="$1" extracted
  [[ -f "$bundle_path" && ! -L "$bundle_path" ]] ||
    fail 'preflight/archive failed; the recovery bundle must be a regular file.'
  validate_bundle_layout "$bundle_path"
  extracted="$temporary_directory/extracted"
  mkdir "$extracted"
  if ! tar -xf "$bundle_path" -C "$extracted" 2>/dev/null; then
    fail 'preflight/archive failed; the recovery bundle could not be extracted.'
  fi
  grep --quiet "^format_version=${bundle_format_version}$" "$extracted/manifest" ||
    fail 'preflight/manifest failed; the recovery bundle format is unsupported.'
  grep --quiet "^document_kek_sha256=$(document_kek_fingerprint)$" "$extracted/manifest" ||
    fail 'preflight/key failed; the bundle was encrypted with a different document key.'
  cat "$extracted/manifest" "$extracted/checksums.sha256" > "$temporary_directory/manifest-and-checksums"
  verify_hmac "$temporary_directory/manifest-and-checksums" "$extracted/manifest.hmac"
  if ! (cd "$extracted" && sha256sum --check --status checksums.sha256) 2>/dev/null; then
    fail 'preflight/checksum failed; a recovery bundle member is corrupt.'
  fi
  if ! compose exec -T orbit-db pg_restore --list < "$extracted/database.dump" >/dev/null 2>&1; then
    fail 'preflight/database-archive failed; the PostgreSQL archive is invalid.'
  fi
  if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 \
    -pass "file:$document_kek_file" \
    -in "$extracted/documents.tar.enc" -out "$extracted/documents.tar" 2>/dev/null; then
    fail 'preflight/decryption failed; the document archive could not be authenticated with the configured key.'
  fi
  validate_document_archive "$extracted/documents.tar"
  printf '%s' "$extracted"
}

create_stage_database() {
  local database_name="$1"
  if ! compose exec -T orbit-db sh -c \
    'exec psql --username="$POSTGRES_USER" --dbname=postgres --set=ON_ERROR_STOP=1 --command="CREATE DATABASE \"$1\";"' \
    sh "$database_name" >/dev/null 2>&1; then
    fail 'preflight/database-stage failed; a private staging database could not be created.'
  fi
}

drop_stage_database() {
  local database_name="${1:-}"
  [[ -n "$database_name" ]] || return 0
  compose exec -T orbit-db sh -c \
    'psql --username="$POSTGRES_USER" --dbname=postgres --set=ON_ERROR_STOP=1 --command="DROP DATABASE IF EXISTS \"$1\";"' \
    sh "$database_name" >/dev/null 2>&1 || true
}

restore_dump_to_database() {
  local database_name="$1" dump_path="$2"
  if ! compose exec -T orbit-db sh -c \
    'exec pg_restore --single-transaction --exit-on-error --no-owner --no-acl --username="$POSTGRES_USER" --dbname="$1"' \
    sh "$database_name" < "$dump_path" >/dev/null 2>&1; then
    return 1
  fi
}

query_report() {
  local database_name="$1" query="$2" report_path="$3"
  if ! compose exec -T orbit-db sh -c \
    'exec psql --username="$POSTGRES_USER" --dbname="$1" --tuples-only --no-align --field-separator="|" --command="$2"' \
    sh "$database_name" "$query" > "$report_path" 2>/dev/null; then
    return 1
  fi
}

query_active_report() {
  local query="$1" report_path="$2"
  if ! compose exec -T orbit-db sh -c \
    'exec psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --tuples-only --no-align --field-separator="|" --command="$1"' \
    sh "$query" > "$report_path" 2>/dev/null; then
    return 1
  fi
}

validate_correspondence() {
  local database_name="$1" documents_root="$2" category="$3"
  local report_directory="$temporary_directory/reports-$category"
  local crypto_report="$report_directory/crypto.tsv"
  local visible_report="$report_directory/visible.tsv"
  local attachment_report="$report_directory/attachments.tsv"
  local transient_report="$report_directory/transient"
  local document_id attachment_id storage_key ciphertext_size lifecycle key_id actual_size relative_path object_key object_count
  declare -A referenced_objects=()
  declare -A stored_counts=()

  mkdir -p "$report_directory"
  query_report "$database_name" \
    'SELECT c.document_id::text, c.storage_key, c.ciphertext_size::text, COALESCE(d.lifecycle::text, '\''<missing-document>'\'') FROM document_crypto c LEFT JOIN documents d ON d.id = c.document_id ORDER BY c.storage_key;' \
    "$crypto_report" || return 1
  query_report "$database_name" \
    'SELECT d.id::text, d.lifecycle::text, COALESCE(c.storage_key, '\'''\''), COALESCE(c.ciphertext_size::text, '\'''\'') FROM documents d LEFT JOIN document_crypto c ON c.document_id = d.id WHERE d.lifecycle IN ('\''available'\'', '\''pending_deletion'\'') ORDER BY d.id;' \
    "$visible_report" || return 1
  query_report "$database_name" \
    'SELECT a.id::text, a.storage_key, a.ciphertext_size::text, a.key_id FROM imap_ingestion_attachments a WHERE a.status = '\''stored'\'' ORDER BY a.storage_key;' \
    "$attachment_report" || return 1
  query_report "$database_name" \
    'SELECT count(*)::text FROM documents WHERE lifecycle IN ('\''receiving'\'', '\''validating'\'', '\''quarantined'\'', '\''scanning'\'', '\''encrypting'\'');' \
    "$transient_report" || return 1
  [[ "$(tr -d '[:space:]' < "$transient_report")" == "0" ]] ||
    return 1

  while IFS='|' read -r document_id storage_key ciphertext_size lifecycle; do
    [[ -n "$document_id" ]] || continue
    [[ "$storage_key" =~ ^[a-f0-9]{64}$ && "$ciphertext_size" =~ ^[1-9][0-9]*$ && "$lifecycle" != '<missing-document>' ]] ||
      return 1
    [[ -z "${referenced_objects[$storage_key]+present}" ]] ||
      return 1
    local object_path="$documents_root/objects/${storage_key:0:2}/${storage_key:2:2}/${storage_key}.bin"
    [[ -f "$object_path" && ! -L "$object_path" ]] ||
      return 1
    actual_size="$(stat -c '%s' -- "$object_path" 2>/dev/null)" ||
      return 1
    [[ "$actual_size" == "$ciphertext_size" ]] ||
      return 1
    referenced_objects["$storage_key"]=1
  done < "$crypto_report"

  while IFS='|' read -r attachment_id storage_key ciphertext_size key_id; do
    [[ -n "$attachment_id" ]] || continue
    [[ "$storage_key" =~ ^[a-f0-9]{64}$ && "$ciphertext_size" =~ ^[1-9][0-9]*$ && -n "$key_id" ]] ||
      return 1
    [[ -z "${referenced_objects[$storage_key]+present}" ]] ||
      return 1
    local attachment_object_path="$documents_root/objects/${storage_key:0:2}/${storage_key:2:2}/${storage_key}.bin"
    [[ -f "$attachment_object_path" && ! -L "$attachment_object_path" ]] ||
      return 1
    actual_size="$(stat -c '%s' -- "$attachment_object_path" 2>/dev/null)" ||
      return 1
    [[ "$actual_size" == "$ciphertext_size" ]] ||
      return 1
    referenced_objects["$storage_key"]=1
  done < "$attachment_report"

  while IFS='|' read -r document_id lifecycle storage_key ciphertext_size; do
    [[ -n "$document_id" ]] || continue
    [[ "$storage_key" =~ ^[a-f0-9]{64}$ && "$ciphertext_size" =~ ^[1-9][0-9]*$ ]] ||
      return 1
  done < "$visible_report"

  while IFS='|' read -r relative_path actual_size; do
    [[ -n "$relative_path" ]] || continue
    [[ "$relative_path" =~ ^([a-f0-9]{2})/([a-f0-9]{2})/([a-f0-9]{64})\.bin$ ]] ||
      return 1
    object_key="${BASH_REMATCH[3]}"
    [[ "${BASH_REMATCH[1]}${BASH_REMATCH[2]}" == "${object_key:0:4}" ]] ||
      return 1
    [[ -n "${referenced_objects[$object_key]+present}" ]] ||
      return 1
    object_count="${stored_counts[$object_key]:-0}"
    object_count=$((object_count + 1))
    stored_counts["$object_key"]="$object_count"
    [[ "$object_count" == "1" ]] ||
      return 1
  done < <(find "$documents_root/objects" -type f -printf '%P|%s\n' 2>/dev/null)

  for storage_key in "${!referenced_objects[@]}"; do
    [[ "${stored_counts[$storage_key]:-0}" == "1" ]] ||
      return 1
  done
}

prepare_staged_bundle() {
  local extracted staged_documents
  temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/orbit-restore.XXXXXX")"
  extracted="$(validate_bundle "$backup_file")"
  staged_documents="$temporary_directory/staged-documents"
  mkdir "$staged_documents"
  if ! tar -xf "$extracted/documents.tar" -C "$staged_documents" 2>/dev/null; then
    fail 'preflight/staging failed; the document tree could not be staged privately.'
  fi
  stage_database="orbit_restore_stage_$(date -u +%Y%m%d%H%M%S)_$$"
  create_stage_database "$stage_database"
  if ! restore_dump_to_database "$stage_database" "$extracted/database.dump"; then
    fail 'preflight/database-stage failed; the PostgreSQL archive could not be restored transactionally.'
  fi
  if ! validate_correspondence "$stage_database" "$staged_documents" preflight; then
    fail 'preflight/correspondence failed; the staged database and document tree do not correspond; use a complete backup and retry.'
  fi
  drop_stage_database "$stage_database"
  stage_database=""
}

check_capacity() {
  local staged_kib backup_bytes backup_kib current_database_bytes current_database_kib current_document_kib
  local required_backup_kib host_available_kib volume_available_kib temp_available_kib temp_required_kib
  local working_headroom_kib=65536 checkpoint_headroom_kib=65536
  staged_kib="$(du -sk "$temporary_directory/staged-documents" 2>/dev/null | awk 'NR == 1 { print $1 }')" ||
    fail 'preflight/capacity failed; staged document usage could not be measured.'
  [[ "$staged_kib" =~ ^[0-9]+$ ]] ||
    fail 'preflight/capacity failed; staged document usage is not numeric.'
  backup_bytes="$(stat -c '%s' -- "$backup_file" 2>/dev/null)" ||
    fail 'preflight/capacity failed; backup size could not be measured.'
  [[ "$backup_bytes" =~ ^[0-9]+$ ]] ||
    fail 'preflight/capacity failed; backup size is not numeric.'
  backup_kib=$(( (backup_bytes + 1023) / 1024 ))
  current_database_bytes="$(compose exec -T orbit-db sh -c \
    'exec psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --tuples-only --no-align --command="select pg_database_size(current_database());"' \
    2>/dev/null | tr -d '[:space:]')" ||
    fail 'preflight/capacity failed; current database size could not be measured.'
  [[ "$current_database_bytes" =~ ^[0-9]+$ ]] ||
    fail 'preflight/capacity failed; current database size is not numeric.'
  current_database_kib=$(( (current_database_bytes + 1023) / 1024 ))
  current_document_kib="$(compose run --rm --no-deps --entrypoint sh orbit-app -c \
    'du -sk /var/lib/orbit/documents | awk '\''NR == 1 { print $1 }'\''' 2>/dev/null | tr -d '[:space:]')" ||
    fail 'preflight/capacity failed; current document usage could not be measured.'
  [[ "$current_document_kib" =~ ^[0-9]+$ ]] ||
    fail 'preflight/capacity failed; current document usage is not numeric.'
  required_backup_kib=$((backup_kib + current_database_kib + current_document_kib + staged_kib * 2 + working_headroom_kib + checkpoint_headroom_kib))
  host_available_kib="$(df -Pk "$backup_directory" 2>/dev/null | awk 'NR == 2 { print $4 }')" ||
    fail 'preflight/capacity failed; private backup filesystem capacity could not be checked.'
  [[ "$host_available_kib" =~ ^[0-9]+$ && "$host_available_kib" -ge "$required_backup_kib" ]] ||
    fail 'preflight/capacity failed; reserve working, checkpoint, database, document, and rollback space in the private backup location.'
  temp_available_kib="$(df -Pk "$temporary_directory" 2>/dev/null | awk 'NR == 2 { print $4 }')" ||
    fail 'preflight/capacity failed; temporary filesystem capacity could not be checked.'
  temp_required_kib=$((staged_kib + current_document_kib + checkpoint_headroom_kib))
  [[ "$temp_available_kib" =~ ^[0-9]+$ && "$temp_available_kib" -ge "$temp_required_kib" ]] ||
    fail 'preflight/capacity failed; reserve temporary filesystem space for checkpoint extraction.'
  volume_available_kib="$(compose run --rm --no-deps --entrypoint sh orbit-app -c \
    'df -Pk /var/lib/orbit/documents | awk '\''NR == 2 { print $4 }'\''' 2>/dev/null | tr -d '[:space:]')" ||
    fail 'preflight/capacity failed; document-volume capacity could not be checked.'
  [[ "$volume_available_kib" =~ ^[0-9]+$ ]] ||
    fail 'preflight/capacity failed; document-volume capacity is not numeric.'
  [[ $((volume_available_kib + current_document_kib)) -ge "$staged_kib" ]] ||
    fail 'preflight/capacity failed; reserve document-volume space for the staged tree after current contents are removed.'
}

checkpoint_sha256() {
  local artifact_path="$1" digest
  if ! digest="$(sha256sum -- "$artifact_path" 2>/dev/null)"; then
    return 1
  fi
  digest="${digest%% *}"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s' "$digest"
}

compute_checkpoint_digests() {
  checkpoint_database_sha256="$(checkpoint_sha256 "$checkpoint_directory/database.dump")" || return 1
  checkpoint_documents_sha256="$(checkpoint_sha256 "$checkpoint_directory/documents.tar")" || return 1
  checkpoint_document_kek_sha256="$(checkpoint_sha256 "$checkpoint_directory/document-kek")" || return 1
}

sync_checkpoint_artifacts() {
  if ! sync -d \
    "$checkpoint_directory/database.dump" \
    "$checkpoint_directory/documents.tar" \
    "$checkpoint_directory/document-kek" >/dev/null 2>&1; then
    sync \
      "$checkpoint_directory/database.dump" \
      "$checkpoint_directory/documents.tar" \
      "$checkpoint_directory/document-kek" >/dev/null 2>&1 || return 1
  fi
  if ! sync -d "$checkpoint_directory" >/dev/null 2>&1; then
    sync "$checkpoint_directory" >/dev/null 2>&1 || return 1
  fi
}

sync_journal_file() {
  local journal_file="$1" state="$2" test_failure_stage="${ORBIT_RESTORE_TEST_SYNC_FAILURE_STAGE:-}"
  if [[ "${ORBIT_RESTORE_TEST_MODE:-false}" == true &&
    ( "$test_failure_stage" == journal-file ||
      ( "$test_failure_stage" == journal-replacement && "$state" != checkpointed ) ) ]]; then
    return 1
  fi
  if ! sync -d "$journal_file" >/dev/null 2>&1; then
    sync "$journal_file" >/dev/null 2>&1 || return 1
  fi
}

sync_journal_directory() {
  local state="$1" test_failure_stage="${ORBIT_RESTORE_TEST_SYNC_FAILURE_STAGE:-}"
  if [[ "${ORBIT_RESTORE_TEST_MODE:-false}" == true &&
    ( "$test_failure_stage" == journal-directory ||
      ( "$test_failure_stage" == journal-replacement-directory && "$state" != checkpointed ) ) ]]; then
    return 1
  fi
  if ! sync -d "$restore_root" >/dev/null 2>&1; then
    sync "$restore_root" >/dev/null 2>&1 || return 1
  fi
}

validate_checkpoint_integrity() {
  local database_sha256 documents_sha256 document_kek_sha256
  [[ "$checkpoint_database_sha256" =~ ^[0-9a-f]{64}$ &&
    "$checkpoint_documents_sha256" =~ ^[0-9a-f]{64}$ &&
    "$checkpoint_document_kek_sha256" =~ ^[0-9a-f]{64}$ ]] || return 1
  database_sha256="$(checkpoint_sha256 "$checkpoint_directory/database.dump")" || return 1
  documents_sha256="$(checkpoint_sha256 "$checkpoint_directory/documents.tar")" || return 1
  document_kek_sha256="$(checkpoint_sha256 "$checkpoint_directory/document-kek")" || return 1
  [[ "$database_sha256" == "$checkpoint_database_sha256" &&
    "$documents_sha256" == "$checkpoint_documents_sha256" &&
    "$document_kek_sha256" == "$checkpoint_document_kek_sha256" ]]
}

write_journal() {
  local state="$1" journal_temporary previous_journal=""
  journal_temporary="$restore_root/.restore.journal.$$"
  umask 077
  [[ ! -L "$journal_path" ]] || return 1
  [[ "$checkpoint_database_sha256" =~ ^[0-9a-f]{64}$ &&
    "$checkpoint_documents_sha256" =~ ^[0-9a-f]{64}$ &&
    "$checkpoint_document_kek_sha256" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'checkpoint/integrity failed; checkpoint digests were not available for the recovery journal.'
  printf 'format_version=1\nrestore_id=%s\nstate=%s\ndatabase_sha256=%s\ndocuments_sha256=%s\ndocument_kek_sha256=%s\n' \
    "$restore_id" "$state" "$checkpoint_database_sha256" "$checkpoint_documents_sha256" "$checkpoint_document_kek_sha256" > "$journal_temporary"
  chmod 600 "$journal_temporary"
  if ! sync_journal_file "$journal_temporary" "$state"; then
    rm -f -- "$journal_temporary" >/dev/null 2>&1 || true
    return 1
  fi
  if [[ -f "$journal_path" ]]; then
    previous_journal="$restore_root/.restore.journal.previous.$$"
    if ! cp -- "$journal_path" "$previous_journal" >/dev/null 2>&1; then
      rm -f -- "$journal_temporary" >/dev/null 2>&1 || true
      return 1
    fi
    chmod 600 "$previous_journal"
  fi
  if ! mv -f -- "$journal_temporary" "$journal_path" >/dev/null 2>&1; then
    rm -f -- "$journal_temporary" "$previous_journal" >/dev/null 2>&1 || true
    return 1
  fi
  if ! sync_journal_directory "$state"; then
    if [[ -n "$previous_journal" ]]; then
      mv -f -- "$previous_journal" "$journal_path" >/dev/null 2>&1 ||
        cp -f -- "$previous_journal" "$journal_path" >/dev/null 2>&1 || true
    else
      rm -f -- "$journal_path" >/dev/null 2>&1 || true
    fi
    rm -f -- "$previous_journal" >/dev/null 2>&1 || true
    return 1
  fi
  rm -f -- "$previous_journal" >/dev/null 2>&1 || true
}

copy_checkpoint_key() {
  local source_key="${ORBIT_RESTORE_ROLLBACK_KEK_FILE:-$document_kek_file}"
  [[ -f "$source_key" && ! -L "$source_key" ]] || return 1
  [[ "$(tr -d '\r\n' < "$source_key")" =~ ^[0-9a-fA-F]{64}$ ]] || return 1
  cp -- "$source_key" "$checkpoint_directory/document-kek"
  chmod 600 "$checkpoint_directory/document-kek"
}

create_checkpoint() {
  local checkpoint_dump checkpoint_documents checkpoint_stage
  mkdir -p "$restore_root"
  chmod 700 "$restore_root"
  checkpoint_directory="$(mktemp -d "$restore_root/checkpoint-XXXXXXXX")"
  chmod 700 "$checkpoint_directory"
  checkpoint_dump="$checkpoint_directory/database.dump"
  checkpoint_documents="$checkpoint_directory/documents.tar"
  restore_id="${checkpoint_directory##*/checkpoint-}"
  if ! compose stop orbit-app >/dev/null 2>&1; then
    fail 'checkpoint/stop failed; Orbit was not stopped for a consistent recovery point.'
  fi
  app_stopped=true
  if ! compose exec -T orbit-db sh -c \
    'exec pg_dump --format=custom --compress=6 --no-owner --no-acl --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
    > "$checkpoint_dump" 2>/dev/null; then
    fail 'checkpoint/database failed; PostgreSQL could not be captured.'
  fi
  [[ -s "$checkpoint_dump" ]] || fail 'checkpoint/database failed; PostgreSQL produced an empty recovery point.'
  if ! compose exec -T orbit-db pg_restore --list < "$checkpoint_dump" >/dev/null 2>&1; then
    fail 'checkpoint/database failed; the captured PostgreSQL archive is invalid.'
  fi
  if ! compose run --rm --no-deps --entrypoint tar orbit-app -C /var/lib/orbit/documents -cf - . > "$checkpoint_documents" 2>/dev/null; then
    fail 'checkpoint/documents failed; the current document tree could not be captured.'
  fi
  validate_document_archive "$checkpoint_documents"
  copy_checkpoint_key || fail 'checkpoint/key failed; the current document key could not be checkpointed safely.'

  checkpoint_stage="orbit_restore_checkpoint_stage_${restore_id}"
  stage_database="$checkpoint_stage"
  create_stage_database "$checkpoint_stage"
  if ! restore_dump_to_database "$checkpoint_stage" "$checkpoint_dump"; then
    fail 'checkpoint/verification failed; the captured PostgreSQL archive is not restorable transactionally.'
  fi
  mkdir "$temporary_directory/checkpoint-documents"
  if ! tar -xf "$checkpoint_documents" -C "$temporary_directory/checkpoint-documents" 2>/dev/null; then
    fail 'checkpoint/verification failed; the captured document tree could not be staged.'
  fi
  if ! validate_correspondence "$checkpoint_stage" "$temporary_directory/checkpoint-documents" checkpoint; then
    fail 'checkpoint/verification failed; the rollback database and document tree do not correspond.'
  fi
  drop_stage_database "$checkpoint_stage"
  stage_database=""
  compute_checkpoint_digests ||
    fail 'checkpoint/integrity failed; checkpoint artifact digests could not be computed.'
  sync_checkpoint_artifacts ||
    fail 'checkpoint/integrity failed; checkpoint artifacts could not be durably synchronized.'
  write_journal checkpointed ||
    fail 'checkpoint/journal failed; the recovery journal could not be durably published.'
  checkpoint_verified=true
}

replace_documents_from_archive() {
  local archive_path="$1"
  documents_replaced=true
  if ! compose run --rm --no-deps --entrypoint sh orbit-app -c \
    'set -eu; find /var/lib/orbit/documents -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; exec tar -C /var/lib/orbit/documents -xf -' \
    < "$archive_path" >/dev/null 2>&1; then
    return 1
  fi
}

restore_active_database() {
  local dump_path="$1"
  compose exec -T orbit-db sh -c \
    'exec pg_restore --single-transaction --clean --if-exists --no-owner --no-acl --exit-on-error --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
    < "$dump_path" >/dev/null 2>&1
}

validate_checkpoint_key() {
  [[ -f "$checkpoint_directory/document-kek" && ! -L "$checkpoint_directory/document-kek" ]] || return 1
  [[ "$(tr -d '\r\n' < "$checkpoint_directory/document-kek")" =~ ^[0-9a-fA-F]{64}$ ]]
}

install_checkpoint_key() {
  validate_checkpoint_key || return 1
  cp -- "$checkpoint_directory/document-kek" "$document_kek_file"
  chmod 600 "$document_kek_file"
}

capture_active_documents() {
  local archive_path="$temporary_directory/active-documents.tar"
  local active_root="$temporary_directory/active-documents"
  mkdir -p "$active_root"
  if ! compose run --rm --no-deps --entrypoint tar orbit-app -C /var/lib/orbit/documents -cf - . > "$archive_path" 2>/dev/null; then
    return 1
  fi
  validate_document_archive "$archive_path"
  tar -xf "$archive_path" -C "$active_root" 2>/dev/null
}

validate_active_correspondence() {
  capture_active_documents || return 1
  local report_directory="$temporary_directory/reports-active"
  mkdir -p "$report_directory"
  local crypto_report="$report_directory/crypto.tsv"
  local visible_report="$report_directory/visible.tsv"
  local attachment_report="$report_directory/attachments.tsv"
  local transient_report="$report_directory/transient"
  if ! query_active_report \
    'SELECT c.document_id::text, c.storage_key, c.ciphertext_size::text, COALESCE(d.lifecycle::text, '\''<missing-document>'\'') FROM document_crypto c LEFT JOIN documents d ON d.id = c.document_id ORDER BY c.storage_key;' \
    "$crypto_report"; then
    return 1
  fi
  if ! query_active_report \
    'SELECT d.id::text, d.lifecycle::text, COALESCE(c.storage_key, '\'''\''), COALESCE(c.ciphertext_size::text, '\'''\'') FROM documents d LEFT JOIN document_crypto c ON c.document_id = d.id WHERE d.lifecycle IN ('\''available'\'', '\''pending_deletion'\'') ORDER BY d.id;' \
    "$visible_report"; then
    return 1
  fi
  if ! query_active_report \
    'SELECT a.id::text, a.storage_key, a.ciphertext_size::text, a.key_id FROM imap_ingestion_attachments a WHERE a.status = '\''stored'\'' ORDER BY a.storage_key;' \
    "$attachment_report"; then
    return 1
  fi
  if ! query_active_report \
    'SELECT count(*)::text FROM documents WHERE lifecycle IN ('\''receiving'\'', '\''validating'\'', '\''quarantined'\'', '\''scanning'\'', '\''encrypting'\'');' \
    "$transient_report"; then
    return 1
  fi
  if ! validate_correspondence_reports "$temporary_directory/active-documents" "$crypto_report" "$visible_report" "$attachment_report" "$transient_report" active; then
    return 1
  fi
}

validate_correspondence_reports() {
  local documents_root="$1" crypto_report="$2" visible_report="$3" attachment_report="$4" transient_report="$5" category="$6"
  local document_id attachment_id storage_key ciphertext_size lifecycle key_id actual_size relative_path object_key object_count
  declare -A referenced_objects=()
  declare -A stored_counts=()
  [[ "$(tr -d '[:space:]' < "$transient_report")" == "0" ]] ||
    return 1
  while IFS='|' read -r document_id storage_key ciphertext_size lifecycle; do
    [[ -n "$document_id" ]] || continue
    [[ "$storage_key" =~ ^[a-f0-9]{64}$ && "$ciphertext_size" =~ ^[1-9][0-9]*$ && "$lifecycle" != '<missing-document>' ]] ||
      return 1
    [[ -z "${referenced_objects[$storage_key]+present}" ]] ||
      return 1
    local object_path="$documents_root/objects/${storage_key:0:2}/${storage_key:2:2}/${storage_key}.bin"
    [[ -f "$object_path" && ! -L "$object_path" ]] || return 1
    actual_size="$(stat -c '%s' -- "$object_path" 2>/dev/null)" || return 1
    [[ "$actual_size" == "$ciphertext_size" ]] || return 1
    referenced_objects["$storage_key"]=1
  done < "$crypto_report"
  while IFS='|' read -r attachment_id storage_key ciphertext_size key_id; do
    [[ -n "$attachment_id" ]] || continue
    [[ "$storage_key" =~ ^[a-f0-9]{64}$ && "$ciphertext_size" =~ ^[1-9][0-9]*$ && -n "$key_id" ]] ||
      return 1
    [[ -z "${referenced_objects[$storage_key]+present}" ]] ||
      return 1
    local attachment_object_path="$documents_root/objects/${storage_key:0:2}/${storage_key:2:2}/${storage_key}.bin"
    [[ -f "$attachment_object_path" && ! -L "$attachment_object_path" ]] || return 1
    actual_size="$(stat -c '%s' -- "$attachment_object_path" 2>/dev/null)" || return 1
    [[ "$actual_size" == "$ciphertext_size" ]] || return 1
    referenced_objects["$storage_key"]=1
  done < "$attachment_report"
  while IFS='|' read -r document_id lifecycle storage_key ciphertext_size; do
    [[ -n "$document_id" ]] || continue
    [[ "$storage_key" =~ ^[a-f0-9]{64}$ && "$ciphertext_size" =~ ^[1-9][0-9]*$ ]] ||
      return 1
  done < "$visible_report"
  while IFS='|' read -r relative_path actual_size; do
    [[ -n "$relative_path" ]] || continue
    [[ "$relative_path" =~ ^([a-f0-9]{2})/([a-f0-9]{2})/([a-f0-9]{64})\.bin$ ]] || return 1
    object_key="${BASH_REMATCH[3]}"
    [[ "${BASH_REMATCH[1]}${BASH_REMATCH[2]}" == "${object_key:0:4}" ]] || return 1
    [[ -n "${referenced_objects[$object_key]+present}" ]] || return 1
    object_count="${stored_counts[$object_key]:-0}"
    object_count=$((object_count + 1))
    stored_counts["$object_key"]="$object_count"
    [[ "$object_count" == "1" ]] || return 1
  done < <(find "$documents_root/objects" -type f -printf '%P|%s\n' 2>/dev/null)
  for storage_key in "${!referenced_objects[@]}"; do
    [[ "${stored_counts[$storage_key]:-0}" == "1" ]] || return 1
  done
}

wait_for_health() {
  local health_deadline=$((SECONDS + 45))
  until curl --fail --silent --max-time 2 http://127.0.0.1:3000/api/health >/dev/null 2>&1; do
    (( SECONDS < health_deadline )) || return 1
    sleep 1
  done
}

start_and_wait_for_health() {
  compose start orbit-app >/dev/null 2>&1 || return 1
  app_stopped=false
  wait_for_health
}

restore_checkpoint_state() {
  if [[ "${ORBIT_RESTORE_TEST_MODE:-false}" == true &&
    "${ORBIT_RESTORE_TEST_FAILURE_STAGE:-}" == checkpoint-restore ]]; then
    return 1
  fi
  restore_active_database "$checkpoint_directory/database.dump" || return 1
  replace_documents_from_archive "$checkpoint_directory/documents.tar" || return 1
  install_checkpoint_key || return 1
  validate_active_correspondence || return 1
}

rollback_checkpoint() {
  validate_checkpoint_integrity || return 1
  compose stop orbit-app >/dev/null 2>&1 || true
  app_stopped=true
  restore_checkpoint_state || return 1
  start_and_wait_for_health || return 1
}

load_recovery_journal() {
  [[ -f "$journal_path" && ! -L "$journal_path" ]] ||
    fail 'recovery/journal failed; no unfinished restore evidence was found.'
  [[ "$(stat -c '%a' -- "$journal_path" 2>/dev/null)" == "600" ]] ||
    fail 'recovery/journal failed; the restore journal permissions are unsafe.'
  restore_id="$(awk -F= '$1 == "restore_id" { print $2 }' "$journal_path")"
  local journal_state
  journal_state="$(awk -F= '$1 == "state" { print $2 }' "$journal_path")"
  [[ "$restore_id" =~ ^[A-Za-z0-9_-]+$ && "$journal_state" =~ ^(checkpointed|documents-replaced|database-restored|rollback-failed)$ ]] ||
    fail 'recovery/journal failed; the restore journal is invalid and must be reviewed by an operator.'
  checkpoint_database_sha256="$(awk -F= '$1 == "database_sha256" { print $2 }' "$journal_path")"
  checkpoint_documents_sha256="$(awk -F= '$1 == "documents_sha256" { print $2 }' "$journal_path")"
  checkpoint_document_kek_sha256="$(awk -F= '$1 == "document_kek_sha256" { print $2 }' "$journal_path")"
  [[ "$checkpoint_database_sha256" =~ ^[0-9a-f]{64}$ &&
    "$checkpoint_documents_sha256" =~ ^[0-9a-f]{64}$ &&
    "$checkpoint_document_kek_sha256" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'recovery/integrity failed; the checkpoint journal digests are invalid; keep Orbit stopped and preserve the recovery evidence.'
  checkpoint_directory="$restore_root/checkpoint-$restore_id"
  [[ -d "$checkpoint_directory" && ! -L "$checkpoint_directory" ]] ||
    fail 'recovery/checkpoint failed; the durable rollback checkpoint is missing.'
  [[ -f "$checkpoint_directory/database.dump" && ! -L "$checkpoint_directory/database.dump" &&
    -f "$checkpoint_directory/documents.tar" && ! -L "$checkpoint_directory/documents.tar" &&
    -f "$checkpoint_directory/document-kek" && ! -L "$checkpoint_directory/document-kek" ]] ||
    fail 'recovery/checkpoint failed; the durable rollback checkpoint is incomplete.'
}

recover_restore() {
  local checkpoint_stage
  temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/orbit-recover.XXXXXX")"
  load_recovery_journal
  validate_checkpoint_integrity ||
    fail 'recovery/integrity failed; a durable checkpoint artifact changed; keep Orbit stopped and preserve the recovery evidence.'
  validate_checkpoint_key ||
    fail 'recovery/key failed; the durable checkpoint key is invalid; keep Orbit stopped and preserve the recovery evidence.'
  mkdir "$temporary_directory/checkpoint-documents"
  validate_document_archive "$checkpoint_directory/documents.tar"
  tar -xf "$checkpoint_directory/documents.tar" -C "$temporary_directory/checkpoint-documents" 2>/dev/null ||
    fail 'recovery/checkpoint failed; the durable document checkpoint is invalid.'
  checkpoint_stage="orbit_recover_checkpoint_stage_${restore_id}"
  stage_database="$checkpoint_stage"
  create_stage_database "$checkpoint_stage"
  restore_dump_to_database "$checkpoint_stage" "$checkpoint_directory/database.dump" ||
    fail 'recovery/checkpoint failed; the durable database checkpoint is invalid.'
  if ! validate_correspondence "$checkpoint_stage" "$temporary_directory/checkpoint-documents" recovery; then
    fail 'recovery/checkpoint failed; the durable rollback database and document tree do not correspond.'
  fi
  drop_stage_database "$checkpoint_stage"
  stage_database=""
  checkpoint_verified=true
  manual_recovery_required=true
  compose stop orbit-app >/dev/null 2>&1 || fail 'recovery/stop failed; keep Orbit stopped and retry recovery.'
  app_stopped=true
  restore_checkpoint_state || fail 'recovery/restore failed; Orbit remains stopped and the checkpoint is preserved for another explicit recovery attempt.'
  start_and_wait_for_health || fail 'recovery/health failed; Orbit remains stopped and the checkpoint is preserved for another explicit recovery attempt.'
  manual_recovery_required=false
  completed=true
  rm -f -- "$journal_path"
  rm -rf -- "$checkpoint_directory"
  printf 'Orbit recovery completed; the prior database, document tree, and key state were restored.\n'
}

cleanup() {
  local status=$?
  set +e
  if [[ "$checkpoint_verified" == true && "$completed" != true ]]; then
    if [[ "$manual_recovery_required" == true ]]; then
      compose stop orbit-app >/dev/null 2>&1 || true
      app_stopped=true
      write_journal rollback-failed >/dev/null 2>&1 || true
      printf 'Orbit restore: recovery evidence was preserved; keep Orbit stopped and run bash scripts/restore.sh --recover.\n' >&2
    elif ! rollback_checkpoint; then
      compose stop orbit-app >/dev/null 2>&1 || true
      app_stopped=true
      write_journal rollback-failed >/dev/null 2>&1 || true
      printf 'Orbit restore: automatic rollback failed; keep Orbit stopped and run bash scripts/restore.sh --recover.\n' >&2
    else
      rm -f -- "$journal_path"
      rm -rf -- "$checkpoint_directory"
    fi
  elif [[ "$app_stopped" == true ]]; then
    compose start orbit-app >/dev/null 2>&1 || true
  fi
  [[ -z "$stage_database" ]] || drop_stage_database "$stage_database"
  if [[ "$checkpoint_verified" != true && "$recover_mode" != true && -n "$checkpoint_directory" ]]; then
    rm -rf -- "$checkpoint_directory"
  fi
  [[ -z "$temporary_directory" ]] || rm -rf -- "$temporary_directory"
  exit "$status"
}

trap cleanup EXIT

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --yes)
      noninteractive=true
      shift
      ;;
    --recover)
      recover_mode=true
      shift
      ;;
    --)
      shift
      break
      ;;
    *)
      if [[ -z "$backup_file" ]]; then backup_file="$1"; shift; else fail 'usage failed; use bash scripts/restore.sh [--yes] <backup.tar> or bash scripts/restore.sh --recover.'; fi
      ;;
  esac
done
[[ "$#" == 0 ]] || fail 'usage failed; use bash scripts/restore.sh [--yes] <backup.tar> or bash scripts/restore.sh --recover.'

require_tools
[[ ! -L "$backup_directory" ]] || fail 'preflight/configuration failed; the private backup directory must not be a symbolic link.'
mkdir -p "$backup_directory"
chmod 700 "$backup_directory"
[[ ! -L "$restore_root" ]] || fail 'preflight/configuration failed; the restore evidence directory must not be a symbolic link.'

if [[ "$recover_mode" == true ]]; then
  [[ -z "$backup_file" ]] || fail 'usage failed; --recover does not accept a new backup bundle.'
  recover_restore
  exit 0
fi

[[ -n "$backup_file" ]] || fail 'usage failed; use bash scripts/restore.sh [--yes] <backup.tar>.'
[[ ! -f "$journal_path" ]] || fail 'preflight/journal failed; an unfinished restore exists; run bash scripts/restore.sh --recover before starting a new restore.'
read_document_kek
prepare_staged_bundle
check_capacity

printf 'This will replace Orbit database contents and encrypted document bytes after a verified recovery checkpoint.\n'
if [[ "$noninteractive" == true ]]; then
  [[ "${ORBIT_NONINTERACTIVE_RESTORE:-false}" == true ]] ||
    fail 'confirmation failed; --yes requires ORBIT_NONINTERACTIVE_RESTORE=true.'
else
  read -r -p 'Type RESTORE to continue: ' confirmation </dev/tty || fail 'confirmation failed; an interactive terminal is required.'
  [[ "$confirmation" == RESTORE ]] || fail 'confirmation failed; restore cancelled.'
fi

create_checkpoint
if [[ "${ORBIT_RESTORE_TEST_MODE:-false}" == true && "${ORBIT_RESTORE_TEST_HARD_INTERRUPT_STAGE:-}" == after-checkpoint ]]; then
  kill -KILL "$$"
fi

extracted_directory="$temporary_directory/extracted"
staged_documents="$temporary_directory/staged-documents"
replace_documents_from_archive "$extracted_directory/documents.tar" || fail 'cutover/documents failed; the staged document tree could not replace active state.'
write_journal documents-replaced || fail 'cutover/journal failed; the documents-replaced recovery state could not be durably published.'
if [[ "${ORBIT_RESTORE_TEST_MODE:-false}" == true && "${ORBIT_RESTORE_TEST_FAILURE_STAGE:-}" == after-document-replacement ]]; then
  fail 'cutover/test-failure requested; prior state will be restored.'
fi
restore_active_database "$extracted_directory/database.dump" || fail 'cutover/database failed; the staged PostgreSQL archive was rejected transactionally.'
write_journal database-restored || fail 'cutover/journal failed; the database-restored recovery state could not be durably published.'
validate_active_correspondence || fail 'cutover/correspondence failed; active database and documents do not correspond.'
start_and_wait_for_health || fail 'cutover/health failed; Orbit did not become healthy after restore.'

completed=true
rm -f -- "$journal_path"
rm -rf -- "$checkpoint_directory"
printf 'Orbit restore completed successfully.\n'
