#!/usr/bin/env bash
set -Eeuo pipefail

# Orbit restore: the shell around `orbit restore` (#1211), which restores inside the Orbit image
# (src/lib/restore-engine.ts) as a compose one-off. This stops orbit-app, runs it, then starts
# orbit-app and waits for health -- unless a restore journal was left: Orbit stays stopped (E3).
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_dir"

readonly environment_file="${ORBIT_ENV_FILE:-.env-orbit}"
readonly backup_directory="${ORBIT_BACKUP_DIR:-$repo_dir/backups}"
readonly secrets_directory="${ORBIT_SECRETS_DIR:-$repo_dir/.orbit-secrets}"
readonly journal_path="$backup_directory/.orbit-restore/restore.journal"
readonly engine_locked_status=75 # another backup/restore holds the lock: that run owns orbit-app
readonly usage='usage failed; use bash scripts/restore.sh [--yes] <backup.tar> or bash scripts/restore.sh --recover.'

fail() { printf 'Orbit restore: %s\n' "$*" >&2; exit 1; }
compose() { docker compose --env-file "$environment_file" "$@"; }

require_deployment() {
  command -v docker >/dev/null 2>&1 || fail 'preflight/tools failed; Docker is required.'
  docker compose version >/dev/null 2>&1 || fail 'preflight/tools failed; Docker Compose v2 is required.'
  command -v curl >/dev/null 2>&1 || fail 'preflight/tools failed; curl is required.'
  [[ -f "$environment_file" ]] || fail 'preflight/configuration failed; the Orbit environment file is missing.'
  [[ -f "$secrets_directory/document-kek" && ! -L "$secrets_directory/document-kek" ]] || fail 'preflight/key failed; the configured document key is missing.'
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

# run_engine <bundle|""> <orbit args...>: see backup.sh; also forwards the drill's switches when set.
run_engine() {
  local input_file="$1" name && shift
  local -a run_args=(run --rm --no-deps -i) directory_args=()
  if [[ -t 0 && -t 1 ]]; then run_args+=(-t); else run_args+=(-T); fi
  run_args+=(-e "ORBIT_HOST_UID=$host_uid" -e "ORBIT_HOST_GID=$host_gid" -e "ORBIT_HOST_DEPLOY_DIR=$repo_dir")
  for name in ORBIT_NONINTERACTIVE_RESTORE ORBIT_RESTORE_TEST_MODE ORBIT_RESTORE_TEST_SYNC_FAILURE_STAGE \
    ORBIT_RESTORE_TEST_FAILURE_STAGE ORBIT_RESTORE_TEST_CHECKPOINT_FAILURE ORBIT_RESTORE_TEST_HARD_INTERRUPT_STAGE; do
    [[ -z "${!name:-}" ]] || run_args+=(-e "$name=${!name}")
  done
  run_args+=(-v "$repo_dir:/orbit-deploy:rw")
  [[ "$backup_directory" == "$repo_dir/backups" ]] || { { mkdir -p -- "$backup_directory" && chmod 700 -- "$backup_directory"; } || fail "Could not create ${backup_directory}."
    run_args+=(-v "$backup_directory:/orbit-backups:rw" -e "ORBIT_HOST_BACKUP_DIR=$backup_directory") && directory_args+=(--backup-dir /orbit-backups); }
  [[ "$secrets_directory" == "$repo_dir/.orbit-secrets" ]] ||
    { run_args+=(-v "$secrets_directory:/orbit-secrets:rw" -e "ORBIT_HOST_SECRETS_DIR=$secrets_directory") && directory_args+=(--secrets-dir /orbit-secrets); }
  [[ -z "$input_file" ]] || run_args+=(-v "$input_file:/orbit-input/bundle.tar:ro" -e "ORBIT_HOST_INPUT_FILE=$input_file")
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

wait_for_health() { # 45s; ORBIT_RESTORE_HEALTH_SECONDS is for the shell's own tests
  local health_deadline=$((SECONDS + ${ORBIT_RESTORE_HEALTH_SECONDS:-45})) probe_url
  probe_url="$(health_probe_url)"
  until curl --fail --silent --max-time 2 "$probe_url" >/dev/null 2>&1; do
    (( SECONDS < health_deadline )) || return 1
    sleep 1
  done
}

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

require_deployment
engine_host_identity
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
