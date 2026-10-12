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
# A relative directory is relative to the deployment directory; passed bare to -v it would be a named volume.
backup_directory="${ORBIT_BACKUP_DIR:-$repo_dir/backups}"
[[ "$backup_directory" == /* ]] || backup_directory="$repo_dir/$backup_directory"
readonly backup_directory
secrets_directory="${ORBIT_SECRETS_DIR:-$repo_dir/.orbit-secrets}"
[[ "$secrets_directory" == /* ]] || secrets_directory="$repo_dir/$secrets_directory"
readonly secrets_directory
readonly journal_path="$backup_directory/.orbit-restore/restore.journal"
# 75: another backup/restore holds the lock. Only runs that stopped orbit-app take it (a preflight
# takes none), so that run owns orbit-app.
readonly engine_locked_status=75

fail() { printf 'Orbit recovery import: %s\n' "$*" >&2; exit 1; }
# --- Shared by backup.sh, restore.sh, export-recovery-bundle.sh and ----------
# --- import-recovery-bundle.sh (#1345). The same text in all four, pinned by
# --- scripts/compose-project-name-resolution.test.mjs: these scripts stay
# --- standalone (no sourced library), so "shared" means "identical", proved
# --- rather than assumed. Change one, change all four. A script that does not
# --- wait for health still carries health_probe_url and wait_for_health.

# Reads a single KEY=value line out of $environment_file (the last one wins).
read_environment_value() {
  local requested_key="$1" line value="" found=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "${requested_key}="* ]]; then
      # A CRLF .env-orbit is valid; drop the CR.
      value="${line#*=}"
      value="${value%$'\r'}"
      found=1
    fi
  done < "$environment_file"
  [[ "$found" == 1 ]] || return 1
  printf '%s' "$value"
}

# read_compose_project_name <compose-manifest>
#
# Prints <compose-manifest>'s own top-level `name:` value and returns 0, or
# returns 1 with nothing printed when the file has no such line (#921: a
# worktree or an operator directory not literally called "orbit" must not
# guess the project from the directory). A top-level-key line read, not a
# YAML parse, and dependency-free. Identical text in end-maintenance.sh and
# repair.sh -- scripts/compose-project-name-resolution.test.mjs proves that.
read_compose_project_name() {
  local compose_manifest="$1" line value
  [[ -f "$compose_manifest" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^name:[[:space:]]*(.*)$ ]]; then
      value="${BASH_REMATCH[1]%%#*}"
      value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
      value="${value%\"}"
      value="${value#\"}"
      value="${value%\'}"
      value="${value#\'}"
      [[ -n "$value" ]] || return 1
      printf '%s' "$value"
      return 0
    fi
  done < "$compose_manifest"
  return 1
}

# The Compose project to address, with the precedence repair.sh and
# end-maintenance.sh use: .env-orbit's own COMPOSE_PROJECT_NAME, then the
# caller's environment, then docker-compose.yml's own `name:` (#921), then a
# sanitized guess from the current directory's basename. Compose's own order
# puts the caller's environment first, so without an explicit --project-name
# an exported COMPOSE_PROJECT_NAME addressed a different project from the one
# install created (#1345).
derive_compose_project_name() {
  local candidate
  candidate="$(read_environment_value COMPOSE_PROJECT_NAME 2>/dev/null || true)"
  if [[ "$candidate" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
    printf '%s' "$candidate"
    return 0
  fi
  if [[ -n "${COMPOSE_PROJECT_NAME:-}" && "$COMPOSE_PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
    printf '%s' "$COMPOSE_PROJECT_NAME"
    return 0
  fi
  candidate="$(read_compose_project_name docker-compose.yml 2>/dev/null || true)"
  if [[ "$candidate" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
    printf '%s' "$candidate"
    return 0
  fi
  candidate="$(basename -- "$(pwd -P)" 2>/dev/null || true)"
  candidate="$(printf '%s' "$candidate" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-' 2>/dev/null || true)"
  while [[ "$candidate" == [-_]* ]]; do
    candidate="${candidate:1}"
  done
  if [[ -n "$candidate" && "$candidate" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
    printf '%s' "$candidate"
    return 0
  fi
  return 1
}

compose() {
  local project
  project="$(derive_compose_project_name)" || fail 'preflight/configuration failed; could not derive a Compose project name.'
  docker compose --project-name "$project" --env-file "$environment_file" "$@"
}

# require_deployment [health]: "health" is for a script that waits for Orbit
# to answer, which needs curl; the others do not ask for it.
# shellcheck disable=SC2120  # not every script passes the argument
require_deployment() {
  command -v docker >/dev/null 2>&1 || fail 'preflight/tools failed; Docker is required.'
  docker compose version >/dev/null 2>&1 || fail 'preflight/tools failed; Docker Compose v2 is required.'
  [[ "${1:-}" != health ]] || command -v curl >/dev/null 2>&1 || fail 'preflight/tools failed; curl is required.'
  [[ -f "$environment_file" ]] || fail 'preflight/configuration failed; the Orbit environment file is missing.'
  [[ -d "$secrets_directory" && ! -L "$secrets_directory" ]] || fail 'preflight/configuration failed; the secrets directory must be a regular directory.'
  [[ -f "$secrets_directory/document-kek" && ! -L "$secrets_directory/document-kek" ]] || fail 'preflight/key failed; the configured document key is missing.'
}

# Who owns what the engine writes (#1210 D5, #1258). The one-off runs as the
# image's root. Under rootless Docker that root is the operator already, so
# 0:0; under rootful Docker the engine hands each file it creates to the
# operator's own uid/gid. Never `--user`: under rootless Docker a numeric
# --user maps to a subordinate uid the operator cannot access.
engine_host_identity() {
  # Read whole, then matched: `docker info | grep -q` under pipefail could
  # report a SIGPIPE'd docker as "not rootless", the dangerous answer here.
  local security_options
  # Fail closed: a guessed "not rootless" hands the files to a uid the
  # operator cannot reach.
  security_options="$(docker info --format '{{.SecurityOptions}}' 2>/dev/null)" ||
    fail "Could not tell whether Docker is rootless, so refusing to guess who should own the deployment files. Check that 'docker info' works, then rerun."
  if [[ "$security_options" == *rootless* ]]; then
    host_uid=0
    host_gid=0
  else
    host_uid="$(id -u)"
    host_gid="$(id -g)"
  fi
}

# run_engine <bundle|""> <orbit args...>: one compose one-off (#1211 E1/E5).
# A backups or secrets directory outside the deployment gets its own mount;
# the bundle being read is mounted read-only. The ORBIT_HOST_* paths let the
# engine print host paths. The drill's switches are forwarded when set (the
# engine ignores the ones its command does not use). Exit status passes through.
run_engine() {
  local input_file="$1" name
  shift
  local -a run_args=(run --rm --no-deps -i) directory_args=()
  if [[ -t 0 && -t 1 ]]; then run_args+=(-t); else run_args+=(-T); fi
  run_args+=(-e "ORBIT_HOST_UID=$host_uid" -e "ORBIT_HOST_GID=$host_gid" -e "ORBIT_HOST_DEPLOY_DIR=$repo_dir")
  for name in ORBIT_NONINTERACTIVE_RESTORE ORBIT_RECOVERY_PROMPTS ORBIT_RECOVERY_TEST_MODE ORBIT_RESTORE_TEST_MODE ORBIT_RESTORE_TEST_SYNC_FAILURE_STAGE \
    ORBIT_RESTORE_TEST_FAILURE_STAGE ORBIT_RESTORE_TEST_CHECKPOINT_FAILURE ORBIT_RESTORE_TEST_HARD_INTERRUPT_STAGE; do
    [[ -z "${!name:-}" ]] || run_args+=(-e "$name=${!name}")
  done
  run_args+=(-v "$repo_dir:/orbit-deploy:rw")
  if [[ "$backup_directory" != "$repo_dir/backups" ]]; then
    { mkdir -p -- "$backup_directory" && chmod 700 -- "$backup_directory"; } || fail "Could not create ${backup_directory}."
    run_args+=(-v "$backup_directory:/orbit-backups:rw" -e "ORBIT_HOST_BACKUP_DIR=$backup_directory")
    directory_args+=(--backup-dir /orbit-backups)
  fi
  if [[ "$secrets_directory" != "$repo_dir/.orbit-secrets" ]]; then
    run_args+=(-v "$secrets_directory:/orbit-secrets:rw" -e "ORBIT_HOST_SECRETS_DIR=$secrets_directory")
    directory_args+=(--secrets-dir /orbit-secrets)
  fi
  if [[ -n "$input_file" ]]; then
    run_args+=(-v "$input_file:/orbit-input/bundle.tar:ro" -e "ORBIT_HOST_INPUT_FILE=$input_file")
  fi
  compose "${run_args[@]}" --entrypoint node orbit-app /opt/orbit/cli/orbit.js "$@" --dir /orbit-deploy "${directory_args[@]}"
}

# Where compose published orbit-app: the drill's own text, word for word (#383, #684, #1241).
health_probe_url() {
  local bind_address port

  bind_address="$(awk -F= '$1 == "ORBIT_BIND_ADDRESS" { sub(/\r$/, ""); sub(/^[^=]*=/, ""); value = $0 } END { print value }' "$environment_file")"
  port="$(awk -F= '$1 == "ORBIT_PORT" { sub(/\r$/, ""); sub(/^[^=]*=/, ""); value = $0 } END { print value }' "$environment_file")"
  # An exported value wins over the file, exactly as it does for Compose's
  # own interpolation, so the probe reaches the port Compose published (#1241).
  bind_address="${ORBIT_BIND_ADDRESS:-${bind_address:-0.0.0.0}}"
  port="${ORBIT_PORT:-${port:-3000}}"

  # 0.0.0.0 means "listen on every interface"; it is not itself a
  # connectable address, so probe via loopback there, same as any other
  # client on the host would have to.
  [[ "$bind_address" == "0.0.0.0" ]] && bind_address="127.0.0.1"

  printf 'http://%s:%s/api/health' "$bind_address" "$port"
}

# 45s; ORBIT_RESTORE_HEALTH_SECONDS is for the shell's own tests.
wait_for_health() {
  local health_deadline=$((SECONDS + ${ORBIT_RESTORE_HEALTH_SECONDS:-45})) probe_url
  probe_url="$(health_probe_url)"
  until curl --fail --silent --max-time 2 "$probe_url" >/dev/null 2>&1; do
    (( SECONDS < health_deadline )) || return 1
    sleep 1
  done
}
# --- End of the shared functions. -------------------------------------------

[[ "$#" == 1 ]] || fail "Usage: bash scripts/import-recovery-bundle.sh <recovery.tar>"
recovery_bundle="$1"
[[ "$recovery_bundle" == /* ]] || recovery_bundle="$PWD/$recovery_bundle"
[[ -f "$recovery_bundle" && ! -L "$recovery_bundle" && "$recovery_bundle" != *:* ]] ||
  fail "Usage: bash scripts/import-recovery-bundle.sh <recovery.tar>"
require_deployment health
engine_host_identity
run_engine "$recovery_bundle" import-recovery-bundle --preflight /orbit-input/bundle.tar </dev/null || exit $?
keep_stopped_message='Orbit recovery import: the inner restore evidence was preserved; keep Orbit stopped and run bash scripts/restore.sh --recover.'
# A run killed after it swapped in the recovered key leaves the previous key here and no journal:
# the live key no longer matches the database, so starting Orbit would serve it under the wrong key.
rollback_key="$secrets_directory/document-kek.import-rollback"
rollback_key_message() {
  printf 'Orbit recovery import: the import was interrupted after it swapped the document key; the previous document key is preserved at %s. Keep Orbit stopped and move it back to %s by hand before starting Orbit.\n' \
    "$rollback_key" "$secrets_directory/document-kek" >&2
}
# A signal, a timeout or a fail() after the stop must not leave Orbit down: the engine's own
# restart is a no-op in its container. A locked run (75) does not own the app; recovery
# evidence keeps it stopped.
app_stopped=false
# shellcheck disable=SC2317  # run by the EXIT trap
restart_app() {
  [[ "$app_stopped" == true && "${status:-0}" != "$engine_locked_status" ]] || return 0
  if [[ -f "$journal_path" ]]; then
    printf '%s\n' "$keep_stopped_message" >&2
    return 0
  fi
  if [[ -e "$rollback_key" ]]; then
    rollback_key_message
    return 0
  fi
  compose start orbit-app >/dev/null 2>&1 || printf 'Orbit could not be started again.\n' >&2
}
trap restart_app EXIT
compose stop orbit-app >/dev/null || fail "Orbit could not be stopped; the document KEK was not changed."
app_stopped=true
status=0
run_engine "$recovery_bundle" import-recovery-bundle /orbit-input/bundle.tar || status=$?
app_stopped=false # the engine has returned: the lines below decide
[[ "$status" != "$engine_locked_status" ]] || exit "$status"
# A restore that exits 0 keeps its journal and checkpoint until Orbit is healthy on the
# restored data, so a bundle the running image cannot serve can still be recovered. There is
# no automatic rollback: if health never comes, Orbit is stopped again for the operator.
if [[ "$status" == 0 && -f "$journal_path" ]]; then
  if compose start orbit-app >/dev/null 2>&1 && wait_for_health; then
    run_engine "" restore --finish </dev/null ||
      fail 'finish failed; Orbit is running the restored data, but the restore journal and checkpoint could not be removed.'
    exit 0
  fi
  compose stop orbit-app >/dev/null 2>&1 || printf 'Orbit could not be stopped again.\n' >&2
  printf '%s\n' "$keep_stopped_message" >&2
  exit 1
fi
if [[ -f "$journal_path" ]]; then
  printf '%s\n' "$keep_stopped_message" >&2
  exit "$((status == 0 ? 1 : status))"
fi
if [[ -e "$rollback_key" ]]; then
  rollback_key_message
  exit "$((status == 0 ? 1 : status))"
fi
compose start orbit-app >/dev/null 2>&1 || fail "Orbit could not be started again."
wait_for_health || fail "Orbit did not become healthy after the import."
exit "$status"
