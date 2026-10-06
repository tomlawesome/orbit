#!/usr/bin/env bash
set -Eeuo pipefail

# Orbit backup: the host shell around `orbit backup` (#1211).
#
# Taking and verifying the bundle -- the lock, the dump, the document
# archive, encryption, the manifest and its authentication tag -- runs once,
# in the TypeScript engine inside the Orbit image (src/cli/orbit.ts,
# src/lib/backup-restore-cli.ts), as a `docker compose run --rm --no-deps`
# one-off on orbit-app, with the deployment mounted at /orbit-deploy (docs/
# engine-events.md, "In-container engine invocation"). This script only stops
# orbit-app for a point-in-time copy, runs the engine, and starts it again.

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_dir"

readonly environment_file="${ORBIT_ENV_FILE:-.env-orbit}"
readonly backup_directory="${ORBIT_BACKUP_DIR:-$repo_dir/backups}"
readonly secrets_directory="${ORBIT_SECRETS_DIR:-$repo_dir/.orbit-secrets}"
# The engine's exit status when another backup or restore holds the
# backup/restore lock: that run owns orbit-app, so this one leaves it alone.
readonly engine_locked_status=75

fail() {
  printf 'Orbit backup: %s\n' "$*" >&2
  exit 1
}

compose() {
  docker compose --env-file "$environment_file" "$@"
}

require_deployment() {
  command -v docker >/dev/null 2>&1 || fail "Docker is required."
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
  [[ -f "$environment_file" ]] || fail "Missing ${environment_file}."
  # compose cannot even create the one-off without the secret it mounts.
  [[ -f "$secrets_directory/document-kek" && ! -L "$secrets_directory/document-kek" ]] ||
    fail "preflight/key failed; the configured document key is missing."
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
# engine print host paths. Exit status passes through.
run_engine() {
  local input_file="$1"
  shift
  local -a run_args=(run --rm --no-deps -i) directory_args=()
  if [[ -t 0 && -t 1 ]]; then run_args+=(-t); else run_args+=(-T); fi
  run_args+=(-e "ORBIT_HOST_UID=$host_uid" -e "ORBIT_HOST_GID=$host_gid" -e "ORBIT_HOST_DEPLOY_DIR=$repo_dir")
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

# The bundle as an absolute path to a regular file, never a link.
input_bundle() {
  local path="$1"
  [[ "$path" == /* ]] || path="$PWD/$path"
  [[ -f "$path" && ! -L "$path" ]] || fail "The bundle must be a regular, non-symbolic-link file."
  [[ "$path" != *:* ]] || fail "The bundle path must not contain a colon."
  printf '%s' "$path"
}

if [[ "${1:-}" == "--verify" ]]; then
  [[ "$#" == 2 ]] || fail "Usage: bash scripts/backup.sh --verify <backup.tar>"
  require_deployment
  bundle="$(input_bundle "$2")"
  engine_host_identity
  # --verify reads a bundle and changes nothing: the app keeps running.
  run_engine "$bundle" backup --verify /orbit-input/bundle.tar
elif [[ "$#" == 0 ]]; then
  require_deployment
  engine_host_identity
  compose stop orbit-app >/dev/null || fail "Orbit could not be stopped for a point-in-time backup."
  status=0
  run_engine "" backup || status=$?
  if [[ "$status" != "$engine_locked_status" ]]; then
    compose start orbit-app >/dev/null || fail "Orbit could not be started again after the backup."
  fi
  exit "$status"
else
  fail "Usage: bash scripts/backup.sh [--verify <backup.tar>]"
fi
