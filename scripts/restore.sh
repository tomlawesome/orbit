#!/usr/bin/env bash
set -Eeuo pipefail

# Orbit restore: the shell around `orbit restore` (#1211, src/lib/restore-engine.ts), a compose one-off
# in the Orbit image. A bundle is checked (--preflight) while Orbit still runs (E3a); then this stops
# orbit-app, restores, starts it and waits for health -- unless a journal was left: it stays stopped (E3).
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_dir"

readonly environment_file="${ORBIT_ENV_FILE:-.env-orbit}"
readonly backup_directory="${ORBIT_BACKUP_DIR:-$repo_dir/backups}"
readonly secrets_directory="${ORBIT_SECRETS_DIR:-$repo_dir/.orbit-secrets}"
readonly journal_path="$backup_directory/.orbit-restore/restore.journal"
readonly engine_locked_status=75 # another backup/restore holds the lock: that run owns orbit-app
readonly usage='usage failed; use bash scripts/restore.sh [--yes] <backup.tar> or bash scripts/restore.sh --recover.'

fail() { printf 'Orbit restore: %s\n' "$*" >&2; exit 1; }
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
      value="${line#*=}"
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
  security_options="$(docker info --format '{{.SecurityOptions}}' 2>/dev/null || true)"
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
  for name in ORBIT_NONINTERACTIVE_RESTORE ORBIT_RECOVERY_TEST_MODE ORBIT_RESTORE_TEST_MODE ORBIT_RESTORE_TEST_SYNC_FAILURE_STAGE \
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

  bind_address="$(awk -F= '$1 == "ORBIT_BIND_ADDRESS" { sub(/^[^=]*=/, ""); value = $0 } END { print value }' "$environment_file")"
  port="$(awk -F= '$1 == "ORBIT_PORT" { sub(/^[^=]*=/, ""); value = $0 } END { print value }' "$environment_file")"
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

yes_flag=() && recover=false && backup_file=""
for argument in "$@"; do
  case "$argument" in
    --yes) yes_flag=(--yes) ;;
    --recover) recover=true ;;
    *) [[ -z "$backup_file" ]] || fail "$usage"; backup_file="$argument" ;;
  esac
done
if [[ "$recover" == true ]]; then
  [[ -z "$backup_file" && "${#yes_flag[@]}" == 0 ]] || fail 'usage failed; --recover does not accept a new backup bundle.'
else
  [[ -n "$backup_file" ]] || fail "$usage"
  [[ "$backup_file" == /* ]] || backup_file="$PWD/$backup_file"
  [[ -f "$backup_file" && ! -L "$backup_file" && "$backup_file" != *:* ]] || fail 'preflight/archive failed; the recovery bundle must be a regular file.'
fi

require_deployment health
engine_host_identity
[[ "$recover" == true ]] || run_engine "$backup_file" restore --preflight /orbit-input/bundle.tar </dev/null || exit $?
compose stop orbit-app >/dev/null 2>&1 || fail 'checkpoint/stop failed; Orbit was not stopped for a consistent recovery point.'
status=0
if [[ "$recover" == true ]]; then run_engine "" restore --recover || status=$?
else run_engine "$backup_file" restore "${yes_flag[@]}" /orbit-input/bundle.tar || status=$?; fi
[[ "$status" != "$engine_locked_status" ]] || exit "$status"
if [[ -f "$journal_path" ]]; then
  printf 'Orbit restore: recovery evidence was preserved; keep Orbit stopped and run bash scripts/restore.sh --recover.\n' >&2
  exit "$((status == 0 ? 1 : status))"
fi
compose start orbit-app >/dev/null 2>&1 || fail 'health failed; Orbit could not be started again.'
wait_for_health || fail 'health failed; Orbit did not become healthy after the restore.'
exit "$status"
