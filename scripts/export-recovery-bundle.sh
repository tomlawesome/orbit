#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

readonly source_bundle="${1:-}"
readonly environment_file="${ORBIT_ENV_FILE:-.env-orbit}"
readonly backup_directory="${ORBIT_BACKUP_DIR:-$repo_dir/backups}"
readonly kek_file="${ORBIT_SECRETS_DIR:-$repo_dir/.orbit-secrets}/document-kek"
readonly timestamp="$(date -u +%Y%m%d-%H%M%S)"
temporary_directory=""
temporary_path=""

fail() { printf 'Orbit recovery export: %s\n' "$*" >&2; exit 1; }

# Race-free equivalent of `mv --no-clobber`: `ln` succeeds atomically only
# if $final_path does not already exist (POSIX EEXIST). `mv --no-clobber`'s
# own existence check is a separate stat-then-rename, not atomic, and on a
# same-second timestamp collision it silently exits 0 without moving
# anything -- the script then reports success naming the OLD recovery
# bundle, while the new one is forgotten as a stale .tar.installing file
# cleanup never runs for, since temporary_path is cleared right after.
# Mirrors publish_bundle_atomically in scripts/backup.sh.
# $temporary_path and $final_path must be on the same filesystem, which they
# already are (both under $backup_directory).
publish_bundle_atomically() {
  local link_error=""
  if ! link_error="$(ln -- "$temporary_path" "$final_path" 2>&1)"; then
    # Only a name that is really taken is a collision; anything else (a
    # full or read-only disk) is reported as what it is, or the operator
    # retries a timestamp forever.
    [[ -e "$final_path" ]] && fail "A recovery bundle already exists at $final_path; rerun to get a distinct timestamp."
    fail "Could not publish the recovery bundle at $final_path: ${link_error#ln: }"
  fi
  rm -f -- "$temporary_path"
}
cleanup() { [[ -z "$temporary_directory" ]] || rm -rf -- "$temporary_directory"; [[ -z "$temporary_path" ]] || rm -f -- "$temporary_path"; }
trap cleanup EXIT

read_recovery_passphrase() {
  if [[ "${ORBIT_RECOVERY_TEST_MODE:-false}" == true ]]; then
    read -r -s -p '' recovery_passphrase || fail "A recovery passphrase is required on standard input."
  else
    read -r -s -p 'Recovery passphrase: ' recovery_passphrase </dev/tty || fail "An interactive terminal is required."
    printf '\n' >&2
  fi
}

[[ -n "$source_bundle" && -f "$source_bundle" && ! -L "$source_bundle" ]] ||
  fail "Usage: bash scripts/export-recovery-bundle.sh <backup.tar>"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required."
command -v tar >/dev/null 2>&1 || fail "tar is required."
command -v docker >/dev/null 2>&1 || fail "Docker is required."
[[ -f "$environment_file" ]] || fail "Missing ${environment_file}."
[[ -f "$kek_file" && ! -L "$kek_file" ]] || fail "Missing regular document KEK file."
bash scripts/backup.sh --verify "$source_bundle" >/dev/null

read_recovery_passphrase
[[ "${#recovery_passphrase}" -ge 12 ]] || fail "Use a recovery passphrase of at least 12 characters."
if [[ "${ORBIT_RECOVERY_TEST_MODE:-false}" == true ]]; then
  read -r -s -p '' recovery_passphrase_confirmation || fail "A recovery passphrase confirmation is required on standard input."
else
  read -r -s -p 'Confirm recovery passphrase: ' recovery_passphrase_confirmation </dev/tty || fail "An interactive terminal is required."
  printf '\n' >&2
fi
[[ "$recovery_passphrase" == "$recovery_passphrase_confirmation" ]] || fail "Recovery passphrases do not match."
unset recovery_passphrase_confirmation

mkdir -p -- "$backup_directory"
chmod 700 "$backup_directory"
umask 077
temporary_directory="$(mktemp -d "$backup_directory/.orbit-recovery.XXXXXX")"
cp -- "$source_bundle" "$temporary_directory/orbit-backup.tar"
compose() {
  docker compose --env-file "$environment_file" "$@"
}
printf '%s' "$recovery_passphrase" |
  compose run --rm --no-deps -T --entrypoint node orbit-app \
    /opt/orbit/scripts/recovery-crypto.mjs encrypt /run/secrets/orbit-document-kek \
    > "$temporary_directory/document-kek.enc"
unset recovery_passphrase
[[ "$(head -c 8 "$temporary_directory/document-kek.enc")" == "ORBKEK01" ]] ||
  fail "Could not create a valid authenticated recovery-key envelope."
(cd "$temporary_directory" && sha256sum orbit-backup.tar document-kek.enc > checksums.sha256)
printf 'format_version=1\nkey_encryption=aes-256-gcm-scrypt-n131072-r8-p1\n' > "$temporary_directory/manifest"
temporary_path="$backup_directory/orbit-recovery-$timestamp.tar.installing"
tar -C "$temporary_directory" -cf "$temporary_path" manifest checksums.sha256 orbit-backup.tar document-kek.enc
final_path="$backup_directory/orbit-recovery-$timestamp.tar"
publish_bundle_atomically
# Cleared only once the publish succeeded: a refused publish exits above
# with temporary_path still set, so the cleanup trap removes it.
temporary_path=""
printf 'Orbit recovery bundle created: %s\n' "$final_path"
