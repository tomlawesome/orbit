#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

readonly recovery_bundle="${1:-}"
readonly environment_file="${ORBIT_ENV_FILE:-.env-orbit}"
readonly secrets_directory="${ORBIT_SECRETS_DIR:-$repo_dir/.orbit-secrets}"
readonly live_kek="$secrets_directory/document-kek"
readonly backup_directory="${ORBIT_BACKUP_DIR:-$repo_dir/backups}"
readonly restore_journal="$backup_directory/.orbit-restore/restore.journal"
temporary_directory=""
previous_kek=""
key_replaced=false
app_stopped=false
unfinished_restore=false

fail() { printf 'Orbit recovery import: %s\n' "$*" >&2; exit 1; }
compose() { docker compose --env-file "$environment_file" "$@"; }
cleanup() {
  if [[ "$unfinished_restore" == true ]]; then
    printf 'Orbit recovery import: the inner restore evidence was preserved; keep Orbit stopped and run bash scripts/restore.sh --recover.\n' >&2
  elif [[ "$key_replaced" == true && -n "$previous_kek" ]]; then
    compose stop orbit-app >/dev/null 2>&1 || true
    mv -f -- "$previous_kek" "$live_kek" || true
    compose start orbit-app >/dev/null 2>&1 || true
  elif [[ "$app_stopped" == true ]]; then
    compose start orbit-app >/dev/null 2>&1 || true
  fi
  [[ -z "$temporary_directory" ]] || rm -rf -- "$temporary_directory"
}
trap cleanup EXIT

read_recovery_passphrase() {
  if [[ "${ORBIT_RECOVERY_TEST_MODE:-false}" == true ]]; then
    read -r -s -p '' recovery_passphrase || fail "A recovery passphrase is required on standard input."
  else
    read -r -s -p 'Recovery passphrase: ' recovery_passphrase </dev/tty || fail "An interactive terminal is required."
    printf '\n' >&2
  fi
}

[[ -n "$recovery_bundle" && -f "$recovery_bundle" && ! -L "$recovery_bundle" ]] ||
  fail "Usage: bash scripts/import-recovery-bundle.sh <recovery.tar>"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required."
command -v tar >/dev/null 2>&1 || fail "tar is required."
command -v docker >/dev/null 2>&1 || fail "Docker is required."
[[ -f "$environment_file" ]] || fail "Missing ${environment_file}."
[[ -d "$secrets_directory" && ! -L "$secrets_directory" ]] || fail "Missing regular secrets directory."
[[ ! -e "$restore_journal" && ! -L "$restore_journal" ]] ||
  fail "preflight/journal failed; an unfinished restore exists; run bash scripts/restore.sh --recover before importing another recovery bundle."

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/orbit-recovery-import.XXXXXX")"
if ! tar -tf "$recovery_bundle" 2>/dev/null | sort > "$temporary_directory/contents"; then
  fail "preflight/archive failed; the recovery bundle archive is invalid."
fi
if ! tar -tvf "$recovery_bundle" 2>/dev/null | awk 'substr($1, 1, 1) != "-" { exit 1 }' >/dev/null; then
  fail "preflight/archive failed; the recovery bundle contains a link or special file."
fi
printf '%s\n' checksums.sha256 document-kek.enc manifest orbit-backup.tar | sort > "$temporary_directory/expected"
cmp --silent "$temporary_directory/expected" "$temporary_directory/contents" ||
  fail "preflight/archive failed; the recovery bundle does not contain the expected files."
if ! tar -xf "$recovery_bundle" -C "$temporary_directory" 2>/dev/null; then
  fail "preflight/archive failed; the recovery bundle could not be extracted."
fi
grep --quiet '^format_version=1$' "$temporary_directory/manifest" ||
  fail "preflight/manifest failed; the recovery bundle format is unsupported."
if ! (cd "$temporary_directory" && sha256sum --check --status checksums.sha256) 2>/dev/null; then
  fail "preflight/checksum failed; a recovery bundle member is corrupt."
fi

read_recovery_passphrase
[[ "${#recovery_passphrase}" -ge 12 ]] || fail "A recovery passphrase of at least 12 characters is required."
chmod 600 "$temporary_directory/document-kek.enc"
printf '%s' "$recovery_passphrase" |
  compose run --rm --no-deps -T \
    --volume "$temporary_directory/document-kek.enc:/recovery/document-kek.enc:ro" \
    --entrypoint node orbit-app /opt/orbit/scripts/recovery-crypto.mjs decrypt /recovery/document-kek.enc \
    > "$temporary_directory/document-kek" 2>/dev/null ||
  fail "preflight/decryption failed; the recovery key could not be decrypted."
unset recovery_passphrase
recovered_kek="$(tr -d '\r\n' < "$temporary_directory/document-kek")"
[[ "$recovered_kek" =~ ^[0-9a-fA-F]{64}$ ]] || fail "Recovery passphrase did not decrypt a valid document KEK."
unset recovered_kek
chmod 600 "$temporary_directory/document-kek"

printf 'This will replace the local document KEK and restore:\n  %s\n' "$recovery_bundle"
if [[ "${ORBIT_RECOVERY_TEST_MODE:-false}" == true ]]; then
  read -r -p '' confirmation || fail "A recovery confirmation is required on standard input."
else
  read -r -p 'Type IMPORT RECOVERY to continue: ' confirmation </dev/tty || fail "An interactive terminal is required."
fi
[[ "$confirmation" == 'IMPORT RECOVERY' ]] || fail "Recovery import cancelled."
[[ -f "$live_kek" && ! -L "$live_kek" ]] || fail "The current document KEK must be a regular file."
compose stop orbit-app >/dev/null
app_stopped=true
previous_kek="$temporary_directory/previous-document-kek"
mv -- "$live_kek" "$previous_kek"
mv -- "$temporary_directory/document-kek" "$live_kek"
key_replaced=true

# restore.sh authenticates the inner bundle with the recovered KEK. Revert the
# key automatically if the inner restore fails, keeping the prior deployment usable.
if ORBIT_RESTORE_ROLLBACK_KEK_FILE="$previous_kek" bash scripts/restore.sh "$temporary_directory/orbit-backup.tar"; then
  app_stopped=false
  key_replaced=false
  rm -f -- "$previous_kek"
  previous_kek=""
  trap - EXIT
  rm -rf -- "$temporary_directory"
  temporary_directory=""
  printf 'Orbit recovery import completed successfully.\n'
else
  if [[ -f "$restore_journal" ]]; then
    unfinished_restore=true
    key_replaced=false
    fail "Inner backup restore left durable recovery evidence; run bash scripts/restore.sh --recover."
  fi
  fail "Inner backup restore failed; the previous document key was restored."
fi
