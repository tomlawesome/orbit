#!/usr/bin/env bash
set -Eeuo pipefail

# Orbit recovery export: the host shell around `orbit export-recovery-bundle`
# (#1211). Verifying the source backup, the passphrase prompts, wrapping the
# document key and packaging the bundle all run in the engine inside the
# Orbit image (src/lib/backup-restore-cli.ts) as a `docker compose run --rm
# --no-deps` one-off on orbit-app, the deployment mounted at /orbit-deploy.
# orbit-app keeps running: an export reads a backup and changes nothing live.
# The passphrase only ever travels on standard input, or the terminal.

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_dir"

readonly environment_file="${ORBIT_ENV_FILE:-.env-orbit}"
readonly backup_directory="${ORBIT_BACKUP_DIR:-$repo_dir/backups}"
readonly secrets_directory="${ORBIT_SECRETS_DIR:-$repo_dir/.orbit-secrets}"

fail() { printf 'Orbit recovery export: %s\n' "$*" >&2; exit 1; }
compose() { docker compose --env-file "$environment_file" "$@"; }

require_deployment() {
  command -v docker >/dev/null 2>&1 || fail "Docker is required."
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
  [[ -f "$environment_file" ]] || fail "Missing ${environment_file}."
  [[ -f "$secrets_directory/document-kek" && ! -L "$secrets_directory/document-kek" ]] || fail "Missing regular document KEK file."
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

# run_engine <bundle> <orbit args...>: see backup.sh. ORBIT_RECOVERY_TEST_MODE
# (answers as lines on standard input) is forwarded when set.
run_engine() {
  local input_file="$1" && shift
  local -a run_args=(run --rm --no-deps -i) directory_args=()
  if [[ -t 0 && -t 1 ]]; then run_args+=(-t); else run_args+=(-T); fi
  run_args+=(-e "ORBIT_HOST_UID=$host_uid" -e "ORBIT_HOST_GID=$host_gid" -e "ORBIT_HOST_DEPLOY_DIR=$repo_dir")
  [[ -z "${ORBIT_RECOVERY_TEST_MODE:-}" ]] || run_args+=(-e "ORBIT_RECOVERY_TEST_MODE=$ORBIT_RECOVERY_TEST_MODE")
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

[[ "$#" == 1 ]] || fail "Usage: bash scripts/export-recovery-bundle.sh <backup.tar>"
source_bundle="$1"
[[ "$source_bundle" == /* ]] || source_bundle="$PWD/$source_bundle"
[[ -f "$source_bundle" && ! -L "$source_bundle" && "$source_bundle" != *:* ]] ||
  fail "Usage: bash scripts/export-recovery-bundle.sh <backup.tar>"
require_deployment
engine_host_identity
run_engine "$source_bundle" export-recovery-bundle /orbit-input/bundle.tar
