#!/usr/bin/env bash
# The demo / acceptance test bed (#1241): the full Orbit stack with the mail
# sidecar, the disposable login provider and a throwaway HTTPS front, reachable
# from the owner's LAN. For our own demos and acceptance runs only. It is not
# shipped to anyone (scripts/dev/ is not in the Dockerfile's script list);
# scripts/deploy-container.sh is the real-install path and is not used here.
#
#   bash scripts/dev/test-bed.sh up --image REF --host ADDR   REF is a registry digest (...@sha256:<64 hex>)
#   bash scripts/dev/test-bed.sh up --build --host ADDR       build this checkout first (scripts/build-container.sh)
#   bash scripts/dev/test-bed.sh restart [--host ADDR]        stop, then start the whole bed again
#   bash scripts/dev/test-bed.sh run [--project P] -- CMD...  run CMD (e.g. bash scripts/backup.sh) against the running bed
#   bash scripts/dev/test-bed.sh status                       what is running
#   bash scripts/dev/test-bed.sh down [--include-ollama]      remove everything, test data included
#
# Options: --host ADDR   the LAN address of this machine (or set DEMO_HOST);
#                        `run` reads it from the running app container if not given
#          --project P   Compose project name (default: orbit, which is what
#                        scripts/backup.sh and scripts/restore.sh address)
#
# .env-orbit (made by scripts/configure.sh) is read, never changed. A bed that
# fails to come up is torn down completely after its logs are saved. `down`
# removes every container (profile ones too), volume, network and the image
# `up --build` tagged, then checks by Compose label that nothing is left. The
# orbit-ollama service, its model volume and the networks it is attached to are
# kept (the model download is large) unless --include-ollama is given.
# `run` is for the operator scripts: they call docker compose with .env-orbit
# alone, which has no image or demo address, so `run` exports ORBIT_IMAGE (read
# from the running orbit-app container), DEMO_HOST, ORBIT_BIND_ADDRESS,
# ORBIT_PORT and COMPOSE_PROJECT_NAME for CMD, then execs it unchanged.
# Only one bed can run at a time: docker-compose.yml fixes container names.
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_dir"

readonly env_file=".env-orbit"
readonly project_label="com.docker.compose.project"
readonly default_project="orbit"
readonly backups_dir="${ORBIT_TEST_BED_BACKUPS:-$HOME/projects/.backups/orbit}"
readonly compose_files=(
  docker-compose.yml
  docker-compose.mail.yml
  compose/docker-compose.acceptance.yml
  compose/docker-compose.demo.yml
)

usage() {
  sed -n '2,/^set -Eeuo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

die() {
  printf 'Test bed: %s\n' "$*" >&2
  exit 1
}

command_name=""
project="$default_project"
image=""
host="${DEMO_HOST:-}"
build=false
run_args=()

# The one place the project, file list and overrides are written down, so up,
# restart, status and down cannot drift apart. Extra arguments go after the
# file list, so `--profile '*'` (global) and the subcommand both fit.
bed_vars=()
bed_overrides() {
  bed_vars=(
    "ORBIT_IMAGE=${image:-orbit-local:test-bed-teardown}"
    "DEMO_HOST=${host:-127.0.0.1}"
    ORBIT_BIND_ADDRESS=127.0.0.1
    ORBIT_PORT=3001
  )
}

compose() {
  local args=(-p "$project" --env-file "$env_file")
  local file
  for file in "${compose_files[@]}"; do
    args+=(-f "$file")
  done
  bed_overrides
  env "${bed_vars[@]}" docker compose "${args[@]}" "$@"
}

readonly ollama_service="orbit-ollama"
include_ollama=false

# One row per container of the project: id|name|image|service|networks. Found
# by label, so a stopped container counts.
project_rows() {
  docker ps -a --filter "label=${project_label}=${project}" "$@" \
    --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Label "com.docker.compose.service"}}|{{.Networks}}'
}

project_volumes() {
  docker volume ls --filter "label=${project_label}=${project}" --format '{{.Name}}'
}

project_networks() {
  docker network ls --filter "label=${project_label}=${project}" --format '{{.Name}}'
}

# The language model service and its model volume share the bed's project but
# outlive it: the model download is large and the extraction experiments need
# it (same rule as scripts/cleanup-stacks.sh). Kept unless --include-ollama.
is_ollama_volume() { [[ "$1" == *ollama-data ]]; }

# Comma-separated networks the kept model container is attached to; they cannot
# go while it runs, so they stay with it.
kept_networks() {
  [[ "$include_ollama" != true ]] || return 0
  local id name image service nets
  while IFS='|' read -r id name image service nets; do
    [[ "$service" == "$ollama_service" ]] && printf ',%s,' "$nets"
  done <<<"$1"
  return 0
}

# Names of everything Docker still holds for the project, kept model pieces
# excluded: a stopped container, an empty network or an orphaned volume counts.
leftovers() {
  local rows kept id name image service nets
  rows="$(project_rows)"
  kept="$(kept_networks "$rows")"
  while IFS='|' read -r id name image service nets; do
    [[ -n "$id" ]] || continue
    [[ "$include_ollama" == true || "$service" != "$ollama_service" ]] || continue
    printf 'container %s\n' "$name"
  done <<<"$rows"
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    [[ "$include_ollama" == true ]] || ! is_ollama_volume "$name" || continue
    printf 'volume %s\n' "$name"
  done < <(project_volumes)
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    [[ "$kept" != *",$name,"* ]] || continue
    printf 'network %s\n' "$name"
  done < <(project_networks)
}

# Whole-project removal when there is no model service or volume to spare;
# otherwise the same removal by label, minus the kept pieces.
remove_all_but_ollama() {
  local rows kept id name image service nets
  rows="$(project_rows)"
  kept="$(kept_networks "$rows")"
  while IFS='|' read -r id name image service nets; do
    [[ -n "$id" ]] || continue
    [[ "$service" != "$ollama_service" ]] || continue
    docker rm -f -v "$id" >/dev/null || printf 'Test bed: could not remove container %s\n' "$name" >&2
  done <<<"$rows"
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    ! is_ollama_volume "$name" || continue
    docker volume rm "$name" >/dev/null || printf 'Test bed: could not remove volume %s\n' "$name" >&2
  done < <(project_volumes)
  while IFS= read -r name; do
    [[ -n "$name" && "$kept" != *",$name,"* ]] || continue
    docker network rm "$name" >/dev/null || printf 'Test bed: could not remove network %s\n' "$name" >&2
  done < <(project_networks)
}

teardown() {
  local rows images image_ref left has_ollama=false id name img service nets vol
  rows="$(project_rows)"
  images="$(while IFS='|' read -r id name img service nets; do printf '%s\n' "$img"; done <<<"$rows")"
  while IFS='|' read -r id name img service nets; do
    [[ "$service" == "$ollama_service" ]] && has_ollama=true
  done <<<"$rows"
  while IFS= read -r vol; do
    [[ -n "$vol" ]] && is_ollama_volume "$vol" && has_ollama=true
  done < <(project_volumes)

  if [[ "$has_ollama" == true && "$include_ollama" != true ]]; then
    remove_all_but_ollama
  else
    compose --profile '*' down --volumes --remove-orphans
  fi
  while IFS= read -r image_ref; do
    # Only an image this checkout built; a registry image is not ours to remove.
    [[ "$image_ref" == orbit-local:* ]] || continue
    docker rmi "$image_ref" >/dev/null 2>&1 \
      || printf 'Test bed: kept image %s (another container still uses it).\n' "$image_ref" >&2
  done < <(printf '%s\n' "$images" | sort -u)
  left="$(leftovers)"
  if [[ -n "$left" ]]; then
    printf 'Test bed: FAILED to remove everything for project %s. Still present:\n%s\n' "$project" "$left" >&2
    printf 'Test bed: try bash scripts/cleanup-stacks.sh --remove --project %s\n' "$project" >&2
    return 1
  fi
  if [[ "$has_ollama" == true && "$include_ollama" != true ]]; then
    printf 'Kept the orbit-ollama service and its model volume: the language model download is large.\n'
    printf 'Run down --include-ollama to remove them too.\n'
  fi
}

save_diagnostics() {
  local dir
  dir="$backups_dir/test-bed-${project}-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$dir"
  compose logs --no-color --timestamps >"$dir/compose-logs.txt" 2>&1 || true
  compose ps -a >"$dir/ps.txt" 2>&1 || true
  printf 'Test bed: logs and container list saved to %s\n' "$dir" >&2
}

abort_up() {
  trap - INT TERM
  printf 'Test bed: %s. Saving logs, then removing everything this bed created.\n' "$1" >&2
  save_diagnostics
  teardown || true
  exit 1
}

validate_common() {
  [[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] \
    || die "--project must be lowercase letters, digits, - or _ (got: $project)"
  [[ -f "$env_file" ]] || die "missing $env_file; run bash scripts/configure.sh first."
  command -v docker >/dev/null 2>&1 || die "Docker is required."
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required."
}

require_host() {
  [[ -n "$host" ]] || die "give this machine's LAN address with --host ADDR (or set DEMO_HOST)."
  [[ "$host" =~ ^[A-Za-z0-9.:-]+$ ]] || die "--host must be an address or host name (got: $host)"
}

# The bed's HTTPS front needs a throwaway certificate for the host (never
# committed: demo-tls/.gitignore).
make_cert() {
  local san="DNS:$host"
  [[ "$host" =~ ^[0-9.]+$ || "$host" == *:* ]] && san="IP:$host"
  command -v openssl >/dev/null 2>&1 || die "openssl is required to make the bed's temporary certificate."
  openssl req -x509 -newkey rsa:2048 -keyout demo-tls/demo.key -out demo-tls/demo.crt \
    -days 30 -nodes -subj "/CN=$host" -addext "subjectAltName=$san" >/dev/null 2>&1 \
    || die "could not make the temporary certificate."
}

cmd_up() {
  if [[ "$build" == true ]]; then
    [[ -z "$image" ]] || die "give --image or --build, not both."
  else
    [[ -n "$image" ]] || die "give --image <registry digest> or --build."
    [[ "$image" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] \
      || die "--image must be a registry digest (name@sha256:<64 hex>), not a tag that can move (got: $image)"
  fi
  require_host
  validate_common

  local existing
  existing="$(leftovers)"
  if [[ -n "$existing" ]]; then
    printf 'Test bed: project %s already has:\n%s\n' "$project" "$existing" >&2
    die "run 'bash scripts/dev/test-bed.sh down${project_flag}' first."
  fi

  trap 'abort_up "interrupted"' INT TERM
  if [[ "$build" == true ]]; then
    bash scripts/build-container.sh || abort_up "the image build failed"
    image="orbit-local:$(git rev-parse --short=12 HEAD)"
    docker image inspect "$image" >/dev/null 2>&1 || abort_up "the build did not produce $image"
  fi
  make_cert
  compose up -d --wait || abort_up "the stack did not become healthy"
  trap - INT TERM

  printf '\nTest bed is up (project %s).\n' "$project"
  printf '  App:                https://%s:3443/\n' "$host"
  printf '  Identity provider:  https://%s:4443/\n' "$host"
  printf 'The browser warns once on each address (temporary certificate): choose to proceed.\n'
  if [[ "$project" != "$default_project" ]]; then
    printf 'backup.sh / restore.sh need: COMPOSE_PROJECT_NAME=%s bash scripts/backup.sh ...\n' "$project"
  fi
  printf 'Operator scripts against the bed: bash scripts/dev/test-bed.sh run%s -- bash scripts/backup.sh\n' "$project_flag"
  printf 'When finished: bash scripts/dev/test-bed.sh down%s\n' "$project_flag"
}

cmd_restart() {
  require_host
  validate_common
  if [[ -z "$image" ]]; then
    local id name img service nets
    while IFS='|' read -r id name img service nets; do
      [[ "$service" == orbit-app ]] && image="$img"
    done <<<"$(project_rows)"
    [[ -n "$image" ]] || die "project $project has no orbit-app container to restart; use up."
  fi
  make_cert
  compose stop
  compose up -d --wait
  printf 'Test bed restarted (project %s).\n' "$project"
}

# The running orbit-app container of the project: id|image. Empty if none.
running_app_row() {
  local id name img service nets
  while IFS='|' read -r id name img service nets; do
    [[ "$service" == orbit-app ]] && { printf '%s|%s\n' "$id" "$img"; return 0; }
  done <<<"$(project_rows --filter status=running)"
  return 0
}

cmd_run() {
  [[ -z "$image" ]] || die "--image does not apply to run: the image is the one the bed is running."
  [[ "${#run_args[@]}" -gt 0 ]] || die "give the command after --, e.g. run -- bash scripts/backup.sh"
  validate_common
  local row app_id
  row="$(running_app_row)"
  [[ -n "$row" ]] || die "project $project has no running orbit-app container; use up first."
  app_id="${row%%|*}"
  image="${row#*|}"
  if [[ -z "$host" ]]; then
    # APP_URL is https://<DEMO_HOST>:3443 in the bed's app container.
    local line url=""
    while IFS= read -r line; do
      [[ "$line" == APP_URL=* ]] && url="${line#APP_URL=https://}"
    done < <(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$app_id" 2>/dev/null || true)
    host="${url%%:3443*}"
  fi
  require_host
  bed_overrides
  exec env "${bed_vars[@]}" "COMPOSE_PROJECT_NAME=$project" "${run_args[@]}"
}

cmd_status() {
  validate_common
  docker ps -a --filter "label=${project_label}=${project}" \
    --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
  [[ -n "$(leftovers)" ]] || printf 'Nothing exists for project %s (apart from any kept language model service).\n' "$project"
}

cmd_down() {
  validate_common
  teardown
  printf 'Test bed removed: nothing is left for project %s.\n' "$project"
}

[[ "$#" -gt 0 ]] || { usage; exit 1; }
case "$1" in
  -h | --help | help) usage; exit 0 ;;
  up | restart | run | status | down) command_name="$1"; shift ;;
  *) usage >&2; die "unknown command: $1" ;;
esac
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --image) [[ "$#" -ge 2 ]] || die "--image needs a value"; image="$2"; shift 2 ;;
    --host) [[ "$#" -ge 2 ]] || die "--host needs a value"; host="$2"; shift 2 ;;
    --project) [[ "$#" -ge 2 ]] || die "--project needs a value"; project="$2"; shift 2 ;;
    --build) build=true; shift ;;
    --) [[ "$command_name" == run ]] || die "-- only applies to run."; shift; run_args=("$@"); break ;;
    --include-ollama) include_ollama=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
[[ "$include_ollama" != true || "$command_name" == down ]] || die "--include-ollama only applies to down."
project_flag=""
[[ "$project" == "$default_project" ]] || project_flag=" --project $project"

"cmd_${command_name}"
