#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

readonly recovery_bundle="${1:-}"
readonly secrets_directory="${ORBIT_SECRETS_DIR:-$repo_dir/.orbit-secrets}"
readonly live_kek="$secrets_directory/document-kek"
temporary_directory=""
previous_kek=""
key_replaced=false
app_stopped=false

fail() { printf 'Orbit recovery import: %s\n' "$*" >&2; exit 1; }
compose() { docker compose --env-file .env-orbit "$@"; }
cleanup() {
  if [[ "$key_replaced" == true && -n "$previous_kek" ]]; then
    compose stop orbit-app >/dev/null 2>&1 || true
    mv -f -- "$previous_kek" "$live_kek" || true
    compose start orbit-app >/dev/null 2>&1 || true
  elif [[ "$app_stopped" == true ]]; then
    compose start orbit-app >/dev/null 2>&1 || true
  fi
  [[ -z "$temporary_directory" ]] || rm -rf -- "$temporary_directory"
}
trap cleanup EXIT

[[ -n "$recovery_bundle" && -f "$recovery_bundle" && ! -L "$recovery_bundle" ]] ||
  fail "Usage: bash scripts/import-recovery-bundle.sh <recovery.tar>"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required."
command -v tar >/dev/null 2>&1 || fail "tar is required."
command -v docker >/dev/null 2>&1 || fail "Docker is required."
[[ -d "$secrets_directory" && ! -L "$secrets_directory" ]] || fail "Missing regular secrets directory."

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/orbit-recovery-import.XXXXXX")"
tar -tf "$recovery_bundle" | sort > "$temporary_directory/contents"
tar -tvf "$recovery_bundle" | awk 'substr($1, 1, 1) != "-" { exit 1 }' ||
  fail "Recovery bundle contains a link or special file."
printf '%s\n' checksums.sha256 document-kek.enc manifest orbit-backup.tar | sort > "$temporary_directory/expected"
cmp --silent "$temporary_directory/expected" "$temporary_directory/contents" || fail "Recovery bundle does not contain the expected files."
tar -xf "$recovery_bundle" -C "$temporary_directory"
grep --quiet '^format_version=1$' "$temporary_directory/manifest" || fail "Unsupported recovery bundle format."
(cd "$temporary_directory" && sha256sum --check --status checksums.sha256) || fail "Recovery bundle checksum validation failed."

read -r -s -p 'Recovery passphrase: ' recovery_passphrase </dev/tty || fail "An interactive terminal is required."
printf '\n' >&2
[[ "${#recovery_passphrase}" -ge 12 ]] || fail "A recovery passphrase of at least 12 characters is required."
chmod 644 "$temporary_directory/document-kek.enc"
printf '%s' "$recovery_passphrase" |
  compose run --rm --no-deps -T \
    --volume "$temporary_directory/document-kek.enc:/recovery/document-kek.enc:ro" \
    --entrypoint node orbit-app /opt/orbit/scripts/recovery-crypto.mjs decrypt /recovery/document-kek.enc \
    > "$temporary_directory/document-kek"
unset recovery_passphrase
recovered_kek="$(tr -d '\r\n' < "$temporary_directory/document-kek")"
[[ "$recovered_kek" =~ ^[0-9a-fA-F]{64}$ ]] || fail "Recovery passphrase did not decrypt a valid document KEK."
unset recovered_kek
chmod 600 "$temporary_directory/document-kek"

printf 'This will replace the local document KEK and restore:\n  %s\n' "$recovery_bundle"
read -r -p 'Type IMPORT RECOVERY to continue: ' confirmation </dev/tty || fail "An interactive terminal is required."
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
if bash scripts/restore.sh "$temporary_directory/orbit-backup.tar"; then
  app_stopped=false
  key_replaced=false
  rm -f -- "$previous_kek"
  previous_kek=""
  trap - EXIT
  rm -rf -- "$temporary_directory"
  temporary_directory=""
  printf 'Orbit recovery import completed successfully.\n'
else
  fail "Inner backup restore failed; the previous document KEK was restored."
fi
