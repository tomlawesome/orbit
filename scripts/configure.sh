#!/usr/bin/env bash
set -Eeuo pipefail

# Orbit configuration: the host shell around the configure engine (#1210).
#
# Every flow -- creating and updating .env-orbit, generating secrets and
# VAPID keys, guided configuration, the OIDC client secret, deployment
# profiles, readiness checks and the configuration migration -- runs once,
# in the TypeScript engine shipped inside the Orbit image
# (src/cli/orbit.ts, src/lib/configure-engine.ts,
# src/lib/configuration-migration.ts). This script only resolves which image
# to run, makes sure it is present, and runs it as a disposable one-off with
# the deployment directory mounted at /orbit-deploy (docs/engine-events.md,
# "In-container engine invocation"). It never writes configuration itself
# and Node is never needed on the host.

caller_dir="$(pwd -P)"
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_dir"

readonly environment_file=".env-orbit"
readonly engine_mount="/orbit-deploy"
readonly engine_cli="/opt/orbit/cli/orbit.js"

fail() {
  printf 'Orbit configuration: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'Usage: %s [--check|--check-rollback|--init|--set-oidc-secret|--set-deployment-profile PRESET [MODEL]|--preflight [--file F]|--migrate [--transaction] [--file F] ...]\n' "$0" >&2
}

is_valid_orbit_image() {
  [[ "$1" =~ ^orbit-local:[0-9a-f]{12}$ || "$1" =~ ^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$ ]]
}

# The image the engine runs from (#1210 D2): ORBIT_IMAGE from the
# environment, else the ORBIT_IMAGE line already in .env-orbit (a plain read,
# never sourced), else refuse. A digest that is not present locally is
# pulled; a local build tag that is not present cannot be, so it refuses.
resolve_engine_image() {
  local image="${ORBIT_IMAGE:-}" candidate
  # --check-rollback may run while .env-orbit itself is damaged, so the
  # rollback copy beside it is the second place to look.
  for candidate in "$environment_file" "${environment_file}.orbit-config.rollback"; do
    [[ -z "$image" ]] || break
    [[ "$candidate" == "$environment_file" || "$flow" == --check-rollback ]] || continue
    if [[ -f "$candidate" && ! -L "$candidate" ]]; then
      image="$(sed -n 's/^ORBIT_IMAGE=//p' "$candidate" | tail -n 1)"
    fi
  done
  [[ -n "$image" ]] ||
    fail "No Orbit image to run configuration with. Set ORBIT_IMAGE to an immutable registry digest (or the local tag scripts/build-container.sh builds), or install with get-orbit.sh, which records it in ${environment_file}."
  is_valid_orbit_image "$image" ||
    fail "ORBIT_IMAGE must be an immutable registry digest or the installer-generated local build tag."
  command -v docker >/dev/null 2>&1 || fail "Docker is required to run Orbit configuration."
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    [[ "$image" == *@sha256:* ]] ||
      fail "The Orbit image ${image} is not present locally. Build it with bash scripts/build-container.sh, or set ORBIT_IMAGE to a published digest."
    docker pull --quiet "$image" >/dev/null || fail "Could not pull ${image}."
  fi
  engine_image="$image"
}

# Who owns what the engine writes (#1210 D5, #1258). The one-off runs as the
# image's root. Under rootless Docker that root is the operator already, so
# 0:0; under rootful Docker the engine hands each file it creates to the
# operator's own uid/gid. Never `--user`: under rootless Docker a numeric
# --user maps to a subordinate uid the operator cannot access.
engine_host_identity() {
  if docker info --format '{{.SecurityOptions}}' 2>/dev/null | grep -q rootless; then
    host_uid=0
    host_gid=0
  else
    host_uid="$(id -u)"
    host_gid="$(id -g)"
  fi
}

# run_engine <mount-dir> <ro|rw> <stdin:none|pipe|terminal> <orbit args...>
#
# One `docker run --rm` (#1210 D1). Values travel as `-e NAME`, which docker
# reads from this script's environment and passes only when set, so nothing
# configured ever appears on a command line; the OIDC client secret only
# ever arrives on standard input. `terminal` gives the engine the operator's
# terminal (#1210 D3): this one when stdin and stdout are both terminals,
# otherwise the controlling terminal itself, as configure.sh's own prompts
# used it. Exit codes pass straight through.
run_engine() {
  local mount_dir="$1" mount_mode="$2" input="$3"
  shift 3
  local -a docker_args=(run --rm --network none)
  local use_controlling_terminal=0
  case "$input" in
    pipe) docker_args+=(-i) ;;
    terminal)
      docker_args+=(-i -t)
      [[ -t 0 && -t 1 ]] || use_controlling_terminal=1
      ;;
  esac
  docker_args+=(
    -e ORBIT_HOST_UID="$host_uid"
    -e ORBIT_HOST_GID="$host_gid"
    -e ORBIT_IMAGE
    -e ORBIT_CONFIGURE_TRUST_ORBIT_IMAGE
    -e ORBIT_CONFIGURE_PROMPTS
    -e ORBIT_CONFIGURE_APP_URL
    -e ORBIT_CONFIGURE_OIDC_ISSUER
    -e ORBIT_CONFIGURE_OIDC_CLIENT_ID
    -e ORBIT_CONFIGURE_AUTH_MODE
    -v "${mount_dir}:${engine_mount}:${mount_mode}"
    --entrypoint node
    "$engine_image" "$engine_cli" "$@" --dir "$engine_mount"
  )
  if [[ "$use_controlling_terminal" == 1 ]]; then
    exec docker "${docker_args[@]}" </dev/tty >/dev/tty
  fi
  if [[ "$input" == none ]]; then
    exec docker "${docker_args[@]}" </dev/null
  fi
  exec docker "${docker_args[@]}"
}

# Whether this flow asks the operator questions on a terminal, and has one:
# guided --init with neither the ORBIT_CONFIGURE_* answers nor machine
# prompts, and --set-oidc-secret asked to read from the terminal
# (ORBIT_CONFIGURE_TTY_INPUT=1, as install.sh does) or run at one.
terminal_available() {
  [[ -t 0 && -t 1 ]] && return 0
  { : </dev/tty; } 2>/dev/null
}

init_input() {
  if [[ "${ORBIT_CONFIGURE_PROMPTS:-}" != machine && -z "${ORBIT_CONFIGURE_APP_URL:-}" ]] && terminal_available; then
    printf 'terminal'
  else
    printf 'pipe'
  fi
}

secret_input() {
  if [[ "${ORBIT_CONFIGURE_PROMPTS:-}" != machine ]] &&
    { [[ "${ORBIT_CONFIGURE_TTY_INPUT:-}" == 1 ]] || [[ -t 0 ]]; } && terminal_available; then
    printf 'terminal'
  else
    printf 'pipe'
  fi
}

# --preflight/--migrate act on the file --file names (relative to the
# caller's directory, default .env-orbit here): its directory is the mount,
# because the rollback copy and the deploy lock live beside it.
run_configuration_contract() {
  local -a args=()
  local file="$repo_dir/$environment_file" mode=ro
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --file)
        [[ $# -ge 2 ]] || { usage; exit 2; }
        file="$2"
        [[ "$file" == /* ]] || file="$caller_dir/$file"
        shift 2
        ;;
      --migrate) mode=rw; args+=("$1"); shift ;;
      *) args+=("$1"); shift ;;
    esac
  done
  local file_dir
  file_dir="$(cd -- "$(dirname -- "$file")" 2>/dev/null && pwd -P)" || fail "configuration_syntax"
  run_engine "$file_dir" "$mode" none configure "${args[@]}" --file "${engine_mount}/$(basename -- "$file")"
}

flow="${1:-}"
case "$flow" in
  "" | --init | --set-oidc-secret | --set-deployment-profile | --check | --check-rollback | --preflight | --migrate) ;;
  *)
    usage
    exit 2
    ;;
esac
case "$flow" in
  "" | --init | --set-oidc-secret | --check | --check-rollback)
    if [[ $# -gt 1 ]]; then
      usage
      exit 2
    fi
    ;;
  --set-deployment-profile)
    if [[ $# -lt 2 || $# -gt 3 ]]; then
      usage
      exit 2
    fi
    ;;
esac

resolve_engine_image
engine_host_identity

case "$flow" in
  "") run_engine "$repo_dir" rw none configure ;;
  --init) run_engine "$repo_dir" rw "$(init_input)" configure --init ;;
  --set-oidc-secret) run_engine "$repo_dir" rw "$(secret_input)" configure --set-oidc-secret ;;
  --set-deployment-profile) run_engine "$repo_dir" rw none configure "$@" ;;
  --check) run_engine "$repo_dir" ro none check ;;
  --check-rollback) run_engine "$repo_dir" ro none check --rollback ;;
  --preflight | --migrate) run_configuration_contract "$@" ;;
esac
