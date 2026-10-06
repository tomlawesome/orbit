#!/usr/bin/env bash
set -Eeuo pipefail

# Orbit recovery import: the host shell around `orbit import-recovery-bundle`
# (#1211), which checks the bundle, asks for the passphrase and IMPORT
# RECOVERY, swaps the document key and restores the inner backup -- all in
# the engine inside the Orbit image (src/lib/backup-restore-cli.ts) as a
# compose one-off on orbit-app. The bundle is checked first (--preflight,
# asking nothing) while Orbit still runs (amendment E3a); only then does
# this stop orbit-app, run the engine, start orbit-app and wait for health
# -- unless the inner restore left a journal, which keeps Orbit stopped for
# restore.sh --recover (build E3). The passphrase is asked once, in the full run.

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_dir"

readonly environment_file="${ORBIT_ENV_FILE:-.env-orbit}"
readonly backup_directory="${ORBIT_BACKUP_DIR:-$repo_dir/backups}"
readonly secrets_directory="${ORBIT_SECRETS_DIR:-$repo_dir/.orbit-secrets}"
readonly journal_path="$backup_directory/.orbit-restore/restore.journal"
readonly engine_locked_status=75 # another backup/restore holds the lock: that run owns orbit-app

fail() { printf 'Orbit recovery import: %s\n' "$*" >&2; exit 1; }
compose() { docker compose --env-file "$environment_file" "$@"; }

require_deployment() {
  command -v docker >/dev/null 2>&1 || fail "Docker is required."
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
  command -v curl >/dev/null 2>&1 || fail "curl is required."
  [[ -f "$environment_file" ]] || fail "Missing ${environment_file}."
  [[ -d "$secrets_directory" && ! -L "$secrets_directory" ]] || fail "Missing regular secrets directory."
  [[ -f "$secrets_directory/document-kek" && ! -L "$secrets_directory/document-kek" ]] ||
    fail "preflight/key failed; the configured document key is missing."
}

# Who owns what the engine writes: configure.sh's own text (#1210 D5).
engine_host_identity() {
  # Read whole, then matched: `docker info | grep -q` under pipefail could
  # report a SIGPIPE'd docker as "not rootless", the dangerous answer here.
  local security_options
  security_options="$(docker info --format '{{.SecurityOptions}}' 2>/dev/null || true)"
  if [[ "$security_options" == *rootless* ]]; then
    host_uid=0
    host_gid=0
  else
    host_uid="$(id -u)"
    host_gid="$(id -g)"
  fi
}

# run_engine <bundle> <orbit args...>: see backup.sh; also forwards the drill's switches when set.
run_engine() {
  local input_file="$1" name && shift
  local -a run_args=(run --rm --no-deps -i) directory_args=()
  if [[ -t 0 && -t 1 ]]; then run_args+=(-t); else run_args+=(-T); fi
  run_args+=(-e "ORBIT_HOST_UID=$host_uid" -e "ORBIT_HOST_GID=$host_gid" -e "ORBIT_HOST_DEPLOY_DIR=$repo_dir")
  for name in ORBIT_RECOVERY_TEST_MODE ORBIT_RESTORE_TEST_MODE ORBIT_RESTORE_TEST_SYNC_FAILURE_STAGE \
    ORBIT_RESTORE_TEST_FAILURE_STAGE ORBIT_RESTORE_TEST_CHECKPOINT_FAILURE ORBIT_RESTORE_TEST_HARD_INTERRUPT_STAGE; do
    [[ -z "${!name:-}" ]] || run_args+=(-e "$name=${!name}")
  done
  run_args+=(-v "$repo_dir:/orbit-deploy:rw")
  if [[ "$backup_directory" != "$repo_dir/backups" ]]; then
    { mkdir -p -- "$backup_directory" && chmod 700 -- "$backup_directory"; } || fail "Could not create ${backup_directory}."
    run_args+=(-v "$backup_directory:/orbit-backups:rw" -e "ORBIT_HOST_BACKUP_DIR=$backup_directory") && directory_args+=(--backup-dir /orbit-backups)
  fi
  if [[ "$secrets_directory" != "$repo_dir/.orbit-secrets" ]]; then
    run_args+=(-v "$secrets_directory:/orbit-secrets:rw" -e "ORBIT_HOST_SECRETS_DIR=$secrets_directory") && directory_args+=(--secrets-dir /orbit-secrets)
  fi
  run_args+=(-v "$input_file:/orbit-input/bundle.tar:ro" -e "ORBIT_HOST_INPUT_FILE=$input_file")
  compose "${run_args[@]}" --entrypoint node orbit-app /opt/orbit/cli/orbit.js "$@" --dir /orbit-deploy "${directory_args[@]}"
}

# Where compose published orbit-app; an exported value wins over the file (#383, #1241).
health_probe_url() {
  local bind_address port
  bind_address="$(awk -F= '$1 == "ORBIT_BIND_ADDRESS" { sub(/^[^=]*=/, ""); value = $0 } END { print value }' "$environment_file")"
  port="$(awk -F= '$1 == "ORBIT_PORT" { sub(/^[^=]*=/, ""); value = $0 } END { print value }' "$environment_file")"
  bind_address="${ORBIT_BIND_ADDRESS:-${bind_address:-0.0.0.0}}"
  [[ "$bind_address" == "0.0.0.0" ]] && bind_address="127.0.0.1"
  printf 'http://%s:%s/api/health' "$bind_address" "${ORBIT_PORT:-${port:-3000}}"
}

wait_for_health() { # 45s, as restore.sh
  local health_deadline=$((SECONDS + 45)) probe_url
  probe_url="$(health_probe_url)"
  until curl --fail --silent --max-time 2 "$probe_url" >/dev/null 2>&1; do
    (( SECONDS < health_deadline )) || return 1
    sleep 1
  done
}

[[ "$#" == 1 ]] || fail "Usage: bash scripts/import-recovery-bundle.sh <recovery.tar>"
recovery_bundle="$1"
[[ "$recovery_bundle" == /* ]] || recovery_bundle="$PWD/$recovery_bundle"
[[ -f "$recovery_bundle" && ! -L "$recovery_bundle" && "$recovery_bundle" != *:* ]] ||
  fail "Usage: bash scripts/import-recovery-bundle.sh <recovery.tar>"
require_deployment
engine_host_identity
run_engine "$recovery_bundle" import-recovery-bundle --preflight /orbit-input/bundle.tar </dev/null || exit $?
compose stop orbit-app >/dev/null || fail "Orbit could not be stopped; the document KEK was not changed."
status=0
run_engine "$recovery_bundle" import-recovery-bundle /orbit-input/bundle.tar || status=$?
[[ "$status" != "$engine_locked_status" ]] || exit "$status"
if [[ -f "$journal_path" ]]; then
  printf 'Orbit recovery import: the inner restore evidence was preserved; keep Orbit stopped and run bash scripts/restore.sh --recover.\n' >&2
  exit "$((status == 0 ? 1 : status))"
fi
compose start orbit-app >/dev/null 2>&1 || fail "Orbit could not be started again."
wait_for_health || fail "Orbit did not become healthy after the import."
exit "$status"
