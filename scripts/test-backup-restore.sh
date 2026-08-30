#!/usr/bin/env bash
# Backup/restore acceptance drill. Runs in CI against the container-validation
# deployment (publish-container.yml) and asserts the operator guarantees
# below, cited as Part 2 / script #entry in docs/installer-guarantees.md
# (issue #290 coverage map; the drill predates the catalogue, so citations
# are mapped per test function rather than per assertion):
#
#   run_valid_restore, assert_fixture_present   restore.sh #8 (single-transaction
#     apply), #9 (row-to-blob correspondence — post-restore data equivalence)
#   test_local_key_rejections                   restore.sh #6 (KEK fingerprint
#     match refused before any mutation; wrong and missing key)
#   make_corrupt_{manifest,hmac,checksum}_bundle  restore.sh #3, #6 (HMAC and
#     checksum chain re-verified before the bundle is trusted)
#   make_{missing,extra,truncated,size_mismatch}* variants  restore.sh #9
#   test_missing_crypto_metadata                restore.sh #9 (transient or
#     crypto-incomplete rows refuse a point-in-time restore)
#   test_journal_publication_failures           restore.sh #15-#17 (crash-safe
#     journal; late failure restores the previous journal)
#   test_ordinary_rollback, checkpoint recovery restore.sh #13, #14, #19, #20
#     (verified, durable, point-in-time checkpoint as the rollback target)
#   test_restore_during_maintenance             ADR-0013 decision 4 (#524): a
#     restore works while the instance is closed, and end-maintenance.sh
#     reopens it afterwards
#   recovery-bundle export/import path          export/import-recovery-bundle.sh
#     entries (Part 2)
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

readonly environment_file="${ORBIT_ENV_FILE:-.env-orbit}"
readonly secrets_directory="${ORBIT_SECRETS_DIR:-$repo_dir/.orbit-secrets}"
readonly live_kek="$secrets_directory/document-kek"
readonly document_id="11111111-1111-4111-8111-111111111111"
readonly recovery_document_id="55555555-5555-4555-8555-555555555555"
readonly household_id="22222222-2222-4222-8222-222222222222"
readonly attachment_message_id="33333333-3333-4333-8333-333333333333"
readonly storage_key="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
readonly extra_storage_key="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
readonly attachment_storage_key="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
readonly staging_storage_key="dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
readonly storage_path="/var/lib/orbit/documents/objects/aa/aa/${storage_key}.bin"
readonly attachment_storage_path="/var/lib/orbit/documents/objects/cc/cc/${attachment_storage_key}.bin"
readonly staging_path="/var/lib/orbit/documents/staging/${staging_storage_key}.bin"
backup_path=""
recovery_bundle_path=""
test_directory=""
key_backup=""
variant_directory=""

fail() {
  printf 'Orbit backup test: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$key_backup" && -f "$key_backup" ]]; then
    mv -f -- "$key_backup" "$live_kek" || true
  fi
  [[ -z "$backup_path" ]] || rm -f -- "$backup_path"
  [[ -z "$recovery_bundle_path" ]] || rm -f -- "$recovery_bundle_path"
  [[ -z "$test_directory" ]] || rm -rf -- "$test_directory"
}

trap cleanup EXIT
command -v docker >/dev/null 2>&1 || fail 'Docker is required.'
command -v openssl >/dev/null 2>&1 || fail 'OpenSSL is required.'
command -v sha256sum >/dev/null 2>&1 || fail 'sha256sum is required.'
command -v tar >/dev/null 2>&1 || fail 'tar is required.'
command -v head >/dev/null 2>&1 || fail 'head is required.'
[[ -f "$environment_file" ]] || fail "Missing ${environment_file}."
[[ -f "$live_kek" && ! -L "$live_kek" ]] || fail 'Missing regular disposable document key.'

compose() {
  docker compose --env-file "$environment_file" "$@"
}

health_check() {
  curl --fail --silent --max-time 2 http://127.0.0.1:3000/api/health >/dev/null 2>&1
}

wait_for_health() {
  local health_deadline=$((SECONDS + 45))
  until health_check; do
    (( SECONDS < health_deadline )) || fail 'Orbit did not become healthy within the test deadline.'
    sleep 1
  done
}

fixture_name() {
  compose exec -T orbit-db sh -c \
    'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --tuples-only --no-align --command="select display_name from documents where id = '\''$1'\'';"' \
    sh "$document_id"
}

attachment_fixture_key() {
  compose exec -T orbit-db sh -c \
    'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --tuples-only --no-align --command="select storage_key from imap_ingestion_attachments where message_id = '\''$1'\'' and status = '\''stored'\'';"' \
    sh "$attachment_message_id"
}

assert_fixture_present() {
  [[ "$(fixture_name)" == 'backup-round-trip.bin' ]] || fail 'The document database sentinel changed.'
  local actual_hash
  actual_hash="$(compose exec -T orbit-app sha256sum "$storage_path" | awk '{print $1}')"
  [[ "$actual_hash" == "$expected_hash" ]] || fail 'The document sentinel bytes changed.'
  [[ "$(attachment_fixture_key)" == "$attachment_storage_key" ]] || fail 'The stored IMAP attachment sentinel changed.'
  local actual_attachment_hash
  actual_attachment_hash="$(compose exec -T orbit-app sha256sum "$attachment_storage_path" | awk '{print $1}')"
  [[ "$actual_attachment_hash" == "$attachment_expected_hash" ]] || fail 'The stored IMAP attachment bytes changed.'
}

assert_staging_fixture_present() {
  if ! compose exec -T orbit-app test -f "$staging_path" >/dev/null 2>&1; then
    fail 'The encrypted scanner-recovery staging sentinel was not restored.'
  fi
}

assert_recovery_jobs_restored() {
  local recovery_state recovery_deadline=$((SECONDS + 10))
  while (( SECONDS < recovery_deadline )); do
    recovery_state="$(compose exec -T orbit-db sh -c \
      'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --tuples-only --no-align --command="select case when count(*) = 2 and count(*) filter (where generation = 2 and status = '\''failed'\'' and attempts = 5) = 1 and count(*) filter (where generation = 1 and status = '\''pending'\'' and attempts = 2 and locked_at is null and lease_token is null and lease_expires_at is null) = 1 and exists (select 1 from documents where id = '\''$1'\'' and lifecycle = '\''scanning'\'' and scan_status = '\''error'\'' and exists (select 1 from document_staging_objects where document_id = '\''$1'\'' and status = '\''pending'\'')) then '\''pending'\'' when count(*) = 2 and count(*) filter (where generation = 2 and status = '\''failed'\'' and attempts = 5) = 1 and count(*) filter (where generation = 1 and status = '\''processing'\'' and attempts = 3 and locked_at is not null and lease_token is not null and lease_expires_at > now()) = 1 and exists (select 1 from documents where id = '\''$1'\'' and lifecycle = '\''scanning'\'' and scan_status = '\''error'\'' and exists (select 1 from document_staging_objects where document_id = '\''$1'\'' and status = '\''pending'\'')) then '\''processing'\'' when count(*) = 2 and count(*) filter (where generation = 2 and status = '\''failed'\'' and attempts = 5) = 1 and count(*) filter (where generation = 1 and status = '\''completed'\'' and attempts = 3 and completed_at is not null and locked_at is null and lease_token is null and lease_expires_at is null) = 1 and exists (select 1 from documents where id = '\''$1'\'' and lifecycle = '\''rejected'\'' and scan_status = '\''error'\'' and failure_code = '\''staging_object_invalid'\'') and not exists (select 1 from document_staging_objects where document_id = '\''$1'\'') then '\''purged'\'' else '\''invalid'\'' end from document_jobs where document_id = '\''$1'\'' and kind = '\''scan'\'';"' \
      sh "$recovery_document_id" 2>/dev/null | tr -d '[:space:]')" || recovery_state=invalid
    case "$recovery_state" in
      pending|processing)
        compose exec -T orbit-app test -f "$staging_path" >/dev/null 2>&1 && return 0
        ;;
      purged)
        ! compose exec -T orbit-app test -e "$staging_path" >/dev/null 2>&1 && return 0
        ;;
    esac
    sleep 1
  done
  fail 'Scanner recovery did not reach an expected bounded state.'
}

assert_fixture_absent() {
  [[ -z "$(fixture_name)" ]] || fail 'The rollback database sentinel was not restored.'
  if compose exec -T orbit-app test -e "$storage_path" >/dev/null 2>&1; then
    fail 'The rollback document sentinel was not restored.'
  fi
  [[ -z "$(attachment_fixture_key)" ]] || fail 'The rollback IMAP attachment sentinel was not restored.'
  if compose exec -T orbit-app test -e "$attachment_storage_path" >/dev/null 2>&1; then
    fail 'The rollback IMAP attachment sentinel was not restored.'
  fi
  if compose exec -T orbit-app test -e "$staging_path" >/dev/null 2>&1; then
    fail 'The rollback scanner-recovery staging sentinel was not restored.'
  fi
}

insert_document_fixture() {
  compose exec -T orbit-db sh -c \
    'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --set=ON_ERROR_STOP=1 --command="
      delete from households where id = '\''$1'\'';
      delete from imap_ingestion_messages where id = '\''$5'\'';
      insert into households (id, name, timezone, default_currency, setup_completed)
        values ('\''$1'\'', '\''backup-test-household'\'', '\''Europe/London'\'', '\''GBP'\'', true);
      insert into documents (
        id, household_id, display_name, media_type, size_bytes, content_sha256,
        lifecycle, scan_status, available_at
      ) values (
        '\''$2'\'', '\''$1'\'', '\''backup-round-trip.bin'\'', '\''application/octet-stream'\'',
        29, '\''$3'\'', '\''available'\'', '\''skipped'\'', now()
      );
      insert into documents (
        id, household_id, display_name, media_type, size_bytes, content_sha256,
        lifecycle, scan_status, failure_code
      ) values (
        '\''$8'\'', '\''$1'\'', '\''backup-recovery-sentinel'\'', '\''application/octet-stream'\'',
        31, '\''ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'\'', '\''scanning'\'', '\''error'\'', '\''scanner_timeout'\''
      );
      insert into document_staging_objects (
        document_id, storage_key, purpose, ciphertext_size, envelope_version,
        content_iv, content_auth_tag, wrapped_dek, wrap_iv, wrap_auth_tag, key_id,
        status, recovery_expires_at
      ) values (
        '\''$8'\'', '\''$9'\'', '\''scanner_recovery'\'', 30, 1,
        '\''dGVzdC1zdGFnZS1pdg'\'', '\''dGVzdC1zdGFnZS10YWc'\'', '\''dGVzdC1zdGFnZS1kZWs'\'',
        '\''dGVzdC1zdGFnZS13cmFwLWl2'\'', '\''dGVzdC1zdGFnZS13cmFwLXRhZw'\'', '\''backup-stage-key'\'',
        '\''pending'\'', now() + interval '\''1 day'\''
      );
      insert into document_jobs (document_id, kind, status, attempts, next_attempt_at, last_error)
        values ('\''$8'\'', '\''scan'\'', '\''processing'\'', 2, now() - interval '\''1 minute'\'', '\''scanner_timeout'\'');
      insert into document_jobs (document_id, kind, generation, status, attempts, next_attempt_at, last_error)
        values ('\''$8'\'', '\''scan'\'', 2, '\''failed'\'', 5, now() - interval '\''1 minute'\'', '\''scanner_timeout'\'');
      insert into document_crypto (
        document_id, storage_key, ciphertext_size, envelope_version,
        content_iv, content_auth_tag, wrapped_dek, wrap_iv, wrap_auth_tag, key_id
      ) values (
        '\''$2'\'', '\''$4'\'', 29, 1,
        '\''dGVzdC1jb250ZW50LWl2'\'', '\''dGVzdC1jb250ZW50LXRhZw'\'',
        '\''dGVzdC13cmFwcGVkLWRlaw'\'', '\''dGVzdC13cmFwLWl2'\'',
        '\''dGVzdC13cmFwLXRhZw'\'', '\''backup-test-key'\''
      );
      insert into imap_ingestion_messages (
        id, mailbox, mailbox_uid_validity, mailbox_uid, content_sha256,
        recipient_alias_sha256, household_id, status
      ) values (
        '\''$5'\'', '\''backup-test-mailbox'\'', '\''1'\'', 1,
        '\''dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'\'',
        '\''eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'\'',
        '\''$1'\'', '\''pending_review'\''
      );
      insert into imap_ingestion_attachments (
        message_id, display_name, media_type, size_bytes, content_sha256,
        storage_key, ciphertext_size, envelope_version, content_iv,
        content_auth_tag, wrapped_dek, wrap_iv, wrap_auth_tag, key_id, status
      ) values (
        '\''$5'\'', '\''backup-held-attachment.bin'\'', '\''application/octet-stream'\'', 27,
        '\''$7'\'', '\''$6'\'', 27, 1,
        '\''dGVzdC1hdHRhY2htZW50LWl2'\'', '\''dGVzdC1hdHRhY2htZW50LXRhZw'\'',
        '\''dGVzdC1hdHRhY2htZW50LWRlaw'\'', '\''dGVzdC1hdHRhY2htZW50LXdpdg'\'',
        '\''dGVzdC1hdHRhY2htZW50LWF1dGg'\'', '\''imap-test-key'\'', '\''stored'\''
      );"' \
    sh "$household_id" "$document_id" "$1" "$storage_key" "$attachment_message_id" "$attachment_storage_key" "$attachment_expected_hash" "$recovery_document_id" "$staging_storage_key" >/dev/null
}

remove_document_fixture() {
  compose exec -T orbit-db sh -c \
    'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --set=ON_ERROR_STOP=1 --command="delete from households where id = '\''$1'\''; delete from imap_ingestion_messages where id = '\''$2'\'';"' \
    sh "$household_id" "$attachment_message_id" >/dev/null
  compose exec -T orbit-app rm -f "$storage_path" >/dev/null
  compose exec -T orbit-app rm -f "$attachment_storage_path" >/dev/null
  compose exec -T orbit-app rm -f "$staging_path" >/dev/null
}

prepare_variant() {
  local name="$1"
  variant_directory="$test_directory/$name"
  mkdir "$variant_directory"
  tar -xf "$backup_path" -C "$variant_directory"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 \
    -pass "file:$live_kek" \
    -in "$variant_directory/documents.tar.enc" -out "$variant_directory/documents.tar"
  tar -xf "$variant_directory/documents.tar" -C "$variant_directory"
}

rebuild_documents_archive() {
  (cd "$variant_directory" && rm -f documents.tar documents.tar.enc && tar -cf documents.tar ./objects ./staging)
  openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -salt \
    -pass "file:$live_kek" \
    -in "$variant_directory/documents.tar" -out "$variant_directory/documents.tar.enc"
  rm -f -- "$variant_directory/documents.tar"
}

package_variant() {
  local output_path="$1" update_checksum="${2:-true}" refresh_auth="${3:-true}"
  if [[ "$update_checksum" == true ]]; then
    (cd "$variant_directory" && sha256sum database.dump documents.tar.enc > checksums.sha256)
  fi
  if [[ "$refresh_auth" == true ]]; then
    cat "$variant_directory/manifest" "$variant_directory/checksums.sha256" > "$variant_directory/manifest-and-checksums"
    compose run --rm --no-deps -T --entrypoint node orbit-app \
      /opt/orbit/scripts/recovery-crypto.mjs hmac /run/secrets/orbit-document-kek \
      < "$variant_directory/manifest-and-checksums" > "$variant_directory/manifest.hmac"
  fi
  tar -C "$variant_directory" -cf "$output_path" \
    manifest manifest.hmac checksums.sha256 database.dump documents.tar.enc
}

make_missing_object_bundle() {
  prepare_variant missing-object
  rm -f -- "$variant_directory/objects/aa/aa/${storage_key}.bin"
  rebuild_documents_archive
  package_variant "$test_directory/missing-object.tar"
}

make_missing_attachment_object_bundle() {
  prepare_variant missing-attachment-object
  rm -f -- "$variant_directory/objects/cc/cc/${attachment_storage_key}.bin"
  rebuild_documents_archive
  package_variant "$test_directory/missing-attachment-object.tar"
}

make_cross_table_duplicate_bundle() {
  local bad_dump="$test_directory/cross-table-duplicate.dump"
  compose stop orbit-app >/dev/null
  compose exec -T orbit-db sh -c \
    'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --set=ON_ERROR_STOP=1 --command="update imap_ingestion_attachments set storage_key = '\''$1'\'', ciphertext_size = 29 where message_id = '\''$2'\'';"' \
    sh "$storage_key" "$attachment_message_id" >/dev/null
  compose exec -T orbit-db sh -c \
    'exec pg_dump --format=custom --compress=6 --no-owner --no-acl --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
    > "$bad_dump"
  compose exec -T orbit-db sh -c \
    'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --set=ON_ERROR_STOP=1 --command="update imap_ingestion_attachments set storage_key = '\''$1'\'' where message_id = '\''$2'\'';"' \
    sh "$attachment_storage_key" "$attachment_message_id" >/dev/null
  compose start orbit-app >/dev/null
  wait_for_health
  insert_document_fixture "$expected_hash"
  prepare_variant cross-table-duplicate
  cp -- "$bad_dump" "$variant_directory/database.dump"
  package_variant "$test_directory/cross-table-duplicate.tar"
}

make_extra_object_bundle() {
  prepare_variant extra-object
  mkdir -p "$variant_directory/objects/bb/bb"
  printf '%s' x > "$variant_directory/objects/bb/bb/${extra_storage_key}.bin"
  rebuild_documents_archive
  package_variant "$test_directory/extra-object.tar"
}

make_truncated_object_bundle() {
  prepare_variant truncated-object
  head -c 10 "$variant_directory/objects/aa/aa/${storage_key}.bin" > "$variant_directory/truncated-object.bin"
  mv -- "$variant_directory/truncated-object.bin" "$variant_directory/objects/aa/aa/${storage_key}.bin"
  rebuild_documents_archive
  package_variant "$test_directory/truncated-object.tar"
}

make_size_mismatch_bundle() {
  prepare_variant size-mismatch
  printf '%s' x >> "$variant_directory/objects/aa/aa/${storage_key}.bin"
  rebuild_documents_archive
  package_variant "$test_directory/size-mismatch.tar"
}

make_corrupt_manifest_bundle() {
  prepare_variant corrupt-manifest
  package_variant "$test_directory/corrupt-manifest.tar"
  printf '%s\n' corruption >> "$variant_directory/manifest"
  package_variant "$test_directory/corrupt-manifest.tar" false false
}

make_corrupt_hmac_bundle() {
  prepare_variant corrupt-hmac
  package_variant "$test_directory/corrupt-hmac.tar"
  printf '%s' x >> "$variant_directory/manifest.hmac"
  package_variant "$test_directory/corrupt-hmac.tar" false false
}

make_corrupt_checksum_bundle() {
  prepare_variant corrupt-checksum
  package_variant "$test_directory/corrupt-checksum.tar"
  awk '{ if ($2 == "database.dump") print "0000000000000000000000000000000000000000000000000000000000000000  database.dump"; else print }' \
    "$variant_directory/checksums.sha256" > "$variant_directory/checksums-bad.sha256"
  mv -- "$variant_directory/checksums-bad.sha256" "$variant_directory/checksums.sha256"
  package_variant "$test_directory/corrupt-checksum.tar" false true
}

make_invalid_database_bundle() {
  prepare_variant invalid-database
  printf '\000' | dd of="$variant_directory/database.dump" bs=1 count=1 conv=notrunc status=none
  package_variant "$test_directory/invalid-database.tar"
}

expect_preflight_rejection() {
  local bundle_path="$1" label="$2"
  if ORBIT_NONINTERACTIVE_RESTORE=true bash scripts/restore.sh --yes "$bundle_path" >/dev/null 2>&1; then
    fail "Restore accepted the ${label} negative case."
  fi
  health_check || fail "Orbit was not healthy after the ${label} preflight rejection."
  assert_fixture_present
  assert_staging_fixture_present
}

run_valid_restore() {
  ORBIT_NONINTERACTIVE_RESTORE=true bash scripts/restore.sh --yes "$backup_path" >/dev/null
  wait_for_health
  assert_fixture_present
  assert_recovery_jobs_restored
}

maintenance_sql() {
  compose exec -T orbit-db sh -c \
    'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --tuples-only --no-align --command="$1"' \
    sh "$1"
}

maintenance_active() {
  maintenance_sql 'select active from instance_maintenance where singleton;'
}

# Maintenance narrative lives in maintenance_windows/maintenance_updates since
# orbit#585 (ADR-0013 decision 1, amended 2026-08-23); the singleton keeps only
# the closure state the guard reads. Closing the instance therefore means an
# open window carrying a `started` entry, with the singleton pointing at it —
# the shape end-maintenance.sh's domain function expects to find. Any window
# left open by an earlier call is resolved first, so this stays safe to call
# more than once against the partial unique index on open windows.
close_instance_for_maintenance() {
  maintenance_sql "update maintenance_windows set status = 'resolved', ended_at = now(), updated_at = now() where status = 'open'; with opened as (insert into maintenance_windows (status, started_at) values ('open', now()) returning id), published as (insert into maintenance_updates (window_id, kind, body) select id, 'started', 'Restore drill.' from opened returning window_id) update instance_maintenance set active = true, current_window_id = (select id from opened), version = instance_maintenance.version + 1, updated_at = now() where singleton;" >/dev/null
}

# The restore-during-maintenance check (#524, ADR-0013 decision 4). Two claims
# that ADR-0013 argues from first principles and nothing has ever tested: a
# restore still works while the instance is closed to users, and an operator
# can always reopen it afterwards — including when the restored database is
# itself the thing saying "closed".
#
# It is also the first end-to-end exercise of scripts/end-maintenance.sh
# against a real deployment. Until now that wrapper had only been syntax
# checked, which is a poor place to discover a mistake: the one moment it
# runs is the moment nobody can sign in.
test_restore_during_maintenance() {
  close_instance_for_maintenance
  [[ "$(maintenance_active)" == 't' ]] || fail 'Maintenance did not become active for the restore drill.'
  # Maintenance is a healthy category, not an outage, so the readiness probe
  # restore.sh waits on must keep answering while the instance is closed.
  health_check || fail 'Health stopped answering while maintenance was active.'

  local maintenance_backup_output maintenance_backup_path
  maintenance_backup_output="$(bash scripts/backup.sh)"
  maintenance_backup_path="${maintenance_backup_output#Orbit backup created: }"
  [[ -f "$maintenance_backup_path" ]] || fail 'Backup during maintenance did not return a bundle path.'

  ORBIT_NONINTERACTIVE_RESTORE=true bash scripts/restore.sh --yes "$maintenance_backup_path" >/dev/null
  wait_for_health
  [[ "$(maintenance_active)" == 't' ]] || fail 'The restored instance did not come back closed to users.'
  assert_fixture_present

  bash scripts/end-maintenance.sh >/dev/null
  [[ "$(maintenance_active)" == 'f' ]] || fail 'The operator recovery path did not reopen Orbit after a restore.'
  # Idempotent by design, so an operator who is unsure may simply run it again.
  bash scripts/end-maintenance.sh >/dev/null
  [[ "$(maintenance_active)" == 'f' ]] || fail 'Re-running the recovery path did not leave Orbit open.'

  rm -f -- "$maintenance_backup_path"
  # Leave the canonical bundle applied for the assertions that follow.
  run_valid_restore
}

test_local_key_rejections() {
  key_backup="$test_directory/document-kek.backup"
  cp -- "$live_kek" "$key_backup"
  printf '%064d\n' 0 > "$live_kek"
  expect_preflight_rejection "$backup_path" 'wrong local key'
  mv -f -- "$key_backup" "$live_kek"
  key_backup="$test_directory/document-kek.backup"
  mv -- "$live_kek" "$key_backup"
  expect_preflight_rejection "$backup_path" 'missing local key'
  mv -f -- "$key_backup" "$live_kek"
  key_backup=""
}

test_missing_crypto_metadata() {
  local lifecycle="${1:-available}" bad_dump="$test_directory/missing-crypto-${1:-available}.dump"
  compose stop orbit-app >/dev/null
  compose exec -T orbit-db sh -c \
    'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --set=ON_ERROR_STOP=1 --command="delete from document_crypto where document_id = '\''$1'\'';"' \
    sh "$document_id" >/dev/null
  if [[ "$lifecycle" == pending_deletion ]]; then
    compose exec -T orbit-db sh -c \
      'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --set=ON_ERROR_STOP=1 --command="update documents set lifecycle = '\''pending_deletion'\'', delete_after = now() + interval '\''1 day'\'' where id = '\''$1'\'';"' \
      sh "$document_id" >/dev/null
  fi
  compose exec -T orbit-db sh -c \
    'exec pg_dump --format=custom --compress=6 --no-owner --no-acl --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
    > "$bad_dump"
  compose start orbit-app >/dev/null
  wait_for_health
  insert_document_fixture "$expected_hash"
  prepare_variant "missing-crypto-$lifecycle"
  cp -- "$bad_dump" "$variant_directory/database.dump"
  package_variant "$test_directory/missing-crypto.tar"
  expect_preflight_rejection "$test_directory/missing-crypto.tar" 'missing crypto metadata'
}

# Issue #678: a report query that cannot run must be reported as an incomplete
# check naming itself, never as a verdict on the operator's bundle. Dumping
# without document_staging_objects reproduces what was observed live -- psql
# failing with `relation "document_staging_objects" does not exist` -- against
# a real database, and without mutating live state to do it.
test_incomplete_correspondence_query() {
  local bad_dump="$test_directory/absent-relation.dump" output=""
  compose exec -T orbit-db sh -c \
    'exec pg_dump --format=custom --compress=6 --no-owner --no-acl --exclude-table=document_staging_objects --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
    > "$bad_dump"
  prepare_variant absent-relation
  cp -- "$bad_dump" "$variant_directory/database.dump"
  package_variant "$test_directory/absent-relation.tar"
  if output="$(ORBIT_NONINTERACTIVE_RESTORE=true bash scripts/restore.sh --yes "$test_directory/absent-relation.tar" 2>&1)"; then
    fail 'Restore accepted a bundle whose correspondence query could not run.'
  fi
  grep -q 'preflight/correspondence-incomplete failed' <<< "$output" ||
    fail "A correspondence query that could not run was not reported as an incomplete check: ${output}"
  grep -q 'the document-stage check did not run to completion' <<< "$output" ||
    fail "The incomplete correspondence failure did not name the check that stopped: ${output}"
  if grep -q 'use a complete backup and retry' <<< "$output"; then
    fail 'A correspondence query that could not run was still reported to the operator as a corrupt backup.'
  fi
  health_check || fail 'Orbit was not healthy after the incomplete correspondence rejection.'
  assert_fixture_present
  assert_staging_fixture_present
}

test_journal_publication_failures() {
  local restore_root="${ORBIT_BACKUP_DIR:-$repo_dir/backups}/.orbit-restore"
  if ORBIT_RESTORE_TEST_MODE=true ORBIT_RESTORE_TEST_SYNC_FAILURE_STAGE=journal-file \
    ORBIT_NONINTERACTIVE_RESTORE=true bash scripts/restore.sh --yes "$backup_path" >/dev/null 2>&1; then
    fail 'Restore unexpectedly succeeded when initial journal file synchronization failed.'
  fi
  wait_for_health
  [[ ! -f "$restore_root/restore.journal" ]] || fail 'Unpublished checkpoint failure left a journal behind.'
  if find "$restore_root" -mindepth 1 -maxdepth 1 -type d -name 'checkpoint-*' -print -quit | grep -q .; then
    fail 'Unpublished checkpoint failure left a checkpoint behind.'
  fi
  assert_fixture_present
  assert_staging_fixture_present

  remove_document_fixture
  if ORBIT_RESTORE_TEST_MODE=true ORBIT_RESTORE_TEST_SYNC_FAILURE_STAGE=journal-replacement-directory \
    ORBIT_RESTORE_TEST_FAILURE_STAGE=checkpoint-restore ORBIT_NONINTERACTIVE_RESTORE=true \
    bash scripts/restore.sh --yes "$backup_path" >/dev/null 2>&1; then
    fail 'Restore unexpectedly succeeded when a later journal replacement synchronization failed.'
  fi
  [[ -f "$restore_root/restore.journal" ]] || fail 'Later journal replacement failure did not retain the previous journal.'
  [[ "$(awk -F= '$1 == "state" { print $2 }' "$restore_root/restore.journal")" == checkpointed ]] ||
    fail 'Later journal replacement failure did not preserve the previous published journal state.'
  if health_check; then fail 'Orbit restarted after later journal replacement failure and rollback failure.'; fi
  assert_fixture_absent
  bash scripts/restore.sh --recover >/dev/null
  wait_for_health
  assert_fixture_absent
  run_valid_restore
}

test_ordinary_rollback() {
  remove_document_fixture
  if ORBIT_RESTORE_TEST_MODE=true ORBIT_RESTORE_TEST_FAILURE_STAGE=after-document-replacement \
    ORBIT_NONINTERACTIVE_RESTORE=true bash scripts/restore.sh --yes "$backup_path" >/dev/null 2>&1; then
    fail 'The forced ordinary cutover failure unexpectedly succeeded.'
  fi
  health_check || fail 'Orbit was not healthy after automatic rollback.'
  assert_fixture_absent
  run_valid_restore
}

test_checkpoint_failure_recovery() {
  remove_document_fixture
  if ORBIT_RESTORE_TEST_MODE=true ORBIT_RESTORE_TEST_FAILURE_STAGE=after-document-replacement \
    ORBIT_RESTORE_TEST_CHECKPOINT_FAILURE=true \
    ORBIT_NONINTERACTIVE_RESTORE=true bash scripts/restore.sh --yes "$backup_path" >/dev/null 2>&1; then
    fail 'The forced checkpoint restoration failure unexpectedly succeeded.'
  fi
  [[ -f "${ORBIT_BACKUP_DIR:-$repo_dir/backups}/.orbit-restore/restore.journal" ]] ||
    fail 'Checkpoint failure did not preserve a restore journal.'
  if health_check; then fail 'Orbit restarted after checkpoint restoration failure.'; fi
  bash scripts/restore.sh --recover >/dev/null
  wait_for_health
  assert_fixture_absent
  run_valid_restore
}

create_recovery_bundle() {
  local export_output
  export_output="$(printf '%s\n%s\n' 'orbit-test-recovery-passphrase' 'orbit-test-recovery-passphrase' |
    ORBIT_RECOVERY_TEST_MODE=true bash scripts/export-recovery-bundle.sh "$backup_path")"
  recovery_bundle_path="${export_output#Orbit recovery bundle created: }"
  [[ -f "$recovery_bundle_path" ]] || fail 'Recovery bundle export did not produce a bundle.'
}

test_recovery_bundle_diagnostics() {
  local malformed_bundle="$test_directory/malformed-recovery.tar"
  local unexpected_bundle="$test_directory/unexpected-recovery-member.tar"
  local checksum_bundle="$test_directory/corrupt-recovery-checksum.tar"
  local unexpected_directory="$test_directory/unexpected-recovery-member"
  local checksum_directory="$test_directory/corrupt-recovery-checksum"
  local output

  printf '%s\n' 'not a tar archive' > "$malformed_bundle"
  output="$(ORBIT_RECOVERY_TEST_MODE=true bash scripts/import-recovery-bundle.sh "$malformed_bundle" 2>&1 || true)"
  [[ "$output" == *'preflight/archive failed'* ]] || fail 'Malformed recovery archive did not return a stable archive category.'
  [[ "$output" != *'tar:'* ]] || fail 'Malformed recovery archive exposed raw tar diagnostics.'

  mkdir "$unexpected_directory"
  printf '%s\n' attacker-controlled-content > "$unexpected_directory/attacker-controlled-member"
  tar -C "$unexpected_directory" -cf "$unexpected_bundle" attacker-controlled-member
  output="$(ORBIT_RECOVERY_TEST_MODE=true bash scripts/import-recovery-bundle.sh "$unexpected_bundle" 2>&1 || true)"
  [[ "$output" == *'preflight/archive failed'* ]] || fail 'Unexpected recovery archive member did not return a stable archive category.'
  [[ "$output" != *'attacker-controlled-member'* ]] || fail 'Unexpected recovery archive member name was exposed.'

  mkdir "$checksum_directory"
  tar -xf "$recovery_bundle_path" -C "$checksum_directory"
  awk '{ if ($2 == "orbit-backup.tar") print "0000000000000000000000000000000000000000000000000000000000000000  orbit-backup.tar"; else print }' \
    "$checksum_directory/checksums.sha256" > "$checksum_directory/checksums-bad.sha256"
  mv -- "$checksum_directory/checksums-bad.sha256" "$checksum_directory/checksums.sha256"
  tar -C "$checksum_directory" -cf "$checksum_bundle" manifest checksums.sha256 orbit-backup.tar document-kek.enc
  output="$(ORBIT_RECOVERY_TEST_MODE=true bash scripts/import-recovery-bundle.sh "$checksum_bundle" 2>&1 || true)"
  [[ "$output" == *'preflight/checksum failed'* ]] || fail 'Corrupt recovery checksum did not return a stable checksum category.'
  [[ "$output" != *'sha256sum:'* && "$output" != *'orbit-backup.tar'* ]] || fail 'Corrupt recovery checksum exposed raw checksum diagnostics or a member name.'
}

test_hard_interruption_recovery() {
  remove_document_fixture
  if ORBIT_RESTORE_TEST_MODE=true ORBIT_RESTORE_TEST_HARD_INTERRUPT_STAGE=after-checkpoint \
    ORBIT_NONINTERACTIVE_RESTORE=true bash scripts/restore.sh --yes "$backup_path" >/dev/null 2>&1; then
    fail 'The hard-interruption seam unexpectedly returned success.'
  fi
  [[ -f "${ORBIT_BACKUP_DIR:-$repo_dir/backups}/.orbit-restore/restore.journal" ]] ||
    fail 'Hard interruption did not preserve a restore journal.'
  grep -Eq '^database_sha256=[0-9a-f]{64}$' "${ORBIT_BACKUP_DIR:-$repo_dir/backups}/.orbit-restore/restore.journal" ||
    fail 'Hard interruption journal did not persist a database checkpoint digest.'
  grep -Eq '^documents_sha256=[0-9a-f]{64}$' "${ORBIT_BACKUP_DIR:-$repo_dir/backups}/.orbit-restore/restore.journal" ||
    fail 'Hard interruption journal did not persist a document checkpoint digest.'
  grep -Eq '^document_kek_sha256=[0-9a-f]{64}$' "${ORBIT_BACKUP_DIR:-$repo_dir/backups}/.orbit-restore/restore.journal" ||
    fail 'Hard interruption journal did not persist a checkpoint-key digest.'
  if health_check; then fail 'Orbit restarted after hard interruption.'; fi
  test_import_refuses_existing_journal
  test_corrupted_checkpoint_integrity
  if ORBIT_NONINTERACTIVE_RESTORE=true bash scripts/restore.sh --yes "$backup_path" >/dev/null 2>&1; then
    fail 'A new restore overwrote unfinished interruption evidence.'
  fi
  bash scripts/restore.sh --recover >/dev/null
  wait_for_health
  assert_fixture_absent
  run_valid_restore
}

test_import_refuses_existing_journal() {
  local before_key_hash before_started_at after_started_at
  before_key_hash="$(sha256sum "$live_kek" | awk '{print $1}')"
  before_started_at="$(docker inspect --format '{{.State.StartedAt}}' orbit)"
  if printf '%s\n%s\n' 'orbit-test-recovery-passphrase' 'IMPORT RECOVERY' |
    ORBIT_RECOVERY_TEST_MODE=true bash scripts/import-recovery-bundle.sh "$recovery_bundle_path" >/dev/null 2>&1; then
    fail 'Recovery import accepted an unfinished restore journal.'
  fi
  [[ -f "${ORBIT_BACKUP_DIR:-$repo_dir/backups}/.orbit-restore/restore.journal" ]] ||
    fail 'Recovery import removed unfinished restore evidence.'
  if health_check; then fail 'Recovery import restarted Orbit despite unfinished restore evidence.'; fi
  after_started_at="$(docker inspect --format '{{.State.StartedAt}}' orbit)"
  [[ "$after_started_at" == "$before_started_at" ]] || fail 'Recovery import started Orbit while refusing an unfinished restore.'
  [[ "$(sha256sum "$live_kek" | awk '{print $1}')" == "$before_key_hash" ]] ||
    fail 'Recovery import changed the live document key while refusing an unfinished restore.'
  assert_fixture_absent
}

test_corrupted_checkpoint_integrity() {
  local restore_root="${ORBIT_BACKUP_DIR:-$repo_dir/backups}/.orbit-restore"
  local restore_id checkpoint_key checkpoint_documents checkpoint_documents_backup before_key_hash output
  restore_id="$(awk -F= '$1 == "restore_id" { print $2 }' "$restore_root/restore.journal")"
  checkpoint_key="$restore_root/checkpoint-$restore_id/document-kek"
  checkpoint_documents="$restore_root/checkpoint-$restore_id/documents.tar"
  checkpoint_documents_backup="$test_directory/checkpoint-documents.tar.backup"
  before_key_hash="$(sha256sum "$live_kek" | awk '{print $1}')"
  cp -- "$checkpoint_documents" "$checkpoint_documents_backup"

  printf '%064d\n' 1 > "$checkpoint_key"
  output="$(bash scripts/restore.sh --recover 2>&1 || true)"
  [[ "$output" == *'recovery/integrity failed'* ]] || fail 'Recovery did not reject a different valid checkpoint document key by digest.'
  if [[ "$output" == *'sha256='* ]]; then
    fail 'Checkpoint integrity failure exposed a digest.'
  fi
  [[ -f "$restore_root/restore.journal" && -f "$checkpoint_key" ]] ||
    fail 'Corrupted checkpoint-key recovery did not preserve durable evidence.'
  if health_check; then fail 'Corrupted checkpoint-key recovery restarted Orbit.'; fi
  [[ "$(sha256sum "$live_kek" | awk '{print $1}')" == "$before_key_hash" ]] ||
    fail 'Corrupted checkpoint-key recovery changed the live document key.'
  assert_fixture_absent
  cp -- "$live_kek" "$checkpoint_key"
  chmod 600 "$checkpoint_key"

  printf '\001' | dd of="$checkpoint_documents" bs=1 count=1 conv=notrunc status=none
  output="$(bash scripts/restore.sh --recover 2>&1 || true)"
  [[ "$output" == *'recovery/integrity failed'* ]] || fail 'Recovery accepted same-length checkpoint document corruption.'
  [[ -f "$restore_root/restore.journal" && -f "$checkpoint_documents" ]] ||
    fail 'Same-length checkpoint corruption did not preserve durable evidence.'
  if health_check; then fail 'Same-length checkpoint corruption restarted Orbit.'; fi
  assert_fixture_absent
  cp -- "$checkpoint_documents_backup" "$checkpoint_documents"
  chmod 600 "$checkpoint_documents"
}

test_wrong_recovery_material() {
  local before_key_hash
  before_key_hash="$(sha256sum "$live_kek" | awk '{print $1}')"
  if printf '%s\n' 'orbit-wrong-recovery-passphrase' |
    ORBIT_RECOVERY_TEST_MODE=true bash scripts/import-recovery-bundle.sh "$recovery_bundle_path" >/dev/null 2>&1; then
    fail 'Import accepted wrong recovery material.'
  fi
  [[ "$(sha256sum "$live_kek" | awk '{print $1}')" == "$before_key_hash" ]] ||
    fail 'Wrong recovery material replaced the live document key.'
  health_check || fail 'Orbit was not healthy after wrong recovery material was rejected.'
  assert_fixture_present
  assert_recovery_jobs_restored
}

test_directory="$(mktemp -d "${TMPDIR:-/tmp}/orbit-backup-test.XXXXXX")"
compose exec -T --user orbit:orbit orbit-app sh -c \
  'mkdir -p /var/lib/orbit/documents/objects/aa/aa /var/lib/orbit/documents/objects/cc/cc /var/lib/orbit/documents/staging && printf "%s" "orbit-backup-ciphertext-00001" > "$1" && printf "%s" "orbit-imap-attachment-00001" > "$2" && printf "%s" "orbit-encrypted-recovery-00001" > "$3"' \
  sh "$storage_path" "$attachment_storage_path" "$staging_path"
expected_hash="$(compose exec -T orbit-app sha256sum "$storage_path" | awk '{print $1}')"
attachment_expected_hash="$(compose exec -T orbit-app sha256sum "$attachment_storage_path" | awk '{print $1}')"
insert_document_fixture "$expected_hash"

backup_output="$(bash scripts/backup.sh)"
backup_path="${backup_output#Orbit backup created: }"
[[ -f "$backup_path" ]] || fail 'Backup script did not return a bundle path.'
bash scripts/backup.sh --verify "$backup_path" >/dev/null
create_recovery_bundle
test_recovery_bundle_diagnostics

make_missing_object_bundle
expect_preflight_rejection "$test_directory/missing-object.tar" 'missing ciphertext object'
make_missing_attachment_object_bundle
expect_preflight_rejection "$test_directory/missing-attachment-object.tar" 'missing held IMAP attachment object'
make_cross_table_duplicate_bundle
expect_preflight_rejection "$test_directory/cross-table-duplicate.tar" 'cross-table duplicate object reference'
make_extra_object_bundle
expect_preflight_rejection "$test_directory/extra-object.tar" 'extra ciphertext object'
make_truncated_object_bundle
expect_preflight_rejection "$test_directory/truncated-object.tar" 'truncated ciphertext object'
make_size_mismatch_bundle
expect_preflight_rejection "$test_directory/size-mismatch.tar" 'size-mismatched ciphertext object'
make_corrupt_manifest_bundle
expect_preflight_rejection "$test_directory/corrupt-manifest.tar" 'corrupt manifest'
make_corrupt_hmac_bundle
expect_preflight_rejection "$test_directory/corrupt-hmac.tar" 'corrupt manifest authentication tag'
make_corrupt_checksum_bundle
expect_preflight_rejection "$test_directory/corrupt-checksum.tar" 'corrupt checksum'
make_invalid_database_bundle
expect_preflight_rejection "$test_directory/invalid-database.tar" 'invalid database archive'
test_local_key_rejections
test_missing_crypto_metadata available
test_missing_crypto_metadata pending_deletion
test_incomplete_correspondence_query
test_journal_publication_failures
test_ordinary_rollback
test_checkpoint_failure_recovery
test_hard_interruption_recovery
test_wrong_recovery_material
test_restore_during_maintenance

remove_document_fixture
assert_fixture_absent

printf 'Orbit backup test: staged correspondence, rollback, interruption recovery, key handling, restore during maintenance, and document/crypto round trip passed.\n'
