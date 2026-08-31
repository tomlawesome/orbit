#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

fail() {
  printf 'Orbit preview preflight: %s\n' "$1" >&2
  exit 1
}

[[ -f .env-orbit ]] || fail "missing .env-orbit"
command -v docker >/dev/null 2>&1 || fail "Docker is required"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
command -v jq >/dev/null 2>&1 || fail "jq is required"
[[ "${ORBIT_IMAGE:-}" != "" ]] || fail "missing ORBIT_IMAGE"
[[ "${ORBIT_VERSION:-}" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
  fail "invalid ORBIT_VERSION"
[[ "${ORBIT_REVISION:-}" =~ ^[0-9a-f]{40}$ ]] || fail "invalid ORBIT_REVISION"
[[ "${ORBIT_CHANNEL:-}" =~ ^(ci|preview|dev)$ ]] ||
  fail "invalid ORBIT_CHANNEL"

selection_env=""
cleanup() {
  [[ -z "$selection_env" || ! -e "$selection_env" ]] || rm -f -- "$selection_env"
}
trap cleanup EXIT

docker compose --env-file .env-orbit config --quiet
docker compose --env-file .env-orbit -f docker-compose.yml -f docker-compose.build.yml config --quiet
docker compose --env-file .env-orbit -f docker-compose.yml -f docker-compose.acceptance.yml config --quiet
docker compose --env-file .env-orbit -f docker-compose.yml -f docker-compose.mail.yml config --quiet
docker compose --env-file .env-orbit -f docker-compose.yml -f docker-compose.mail.yml -f docker-compose.mail-alias-rotation.yml config --quiet
docker compose --env-file .env-orbit --profile processing --profile ai config --quiet

selection_env="$(mktemp)"
cp .env-orbit "$selection_env"
docker compose --env-file "$selection_env" config --format json \
  | jq --exit-status '(.services | has("orbit-ollama") or has("orbit-tika")) | not' > /dev/null
printf 'COMPOSE_PROFILES=processing,ai\n' >> "$selection_env"
docker compose --env-file "$selection_env" config --format json \
  | jq --exit-status '.services | has("orbit-ollama") and has("orbit-tika")' > /dev/null

processing_config="$(docker compose --env-file .env-orbit \
  --profile processing config --format json)"
jq --exit-status '
  .networks["orbit-document-processing"].internal == true
  and (.services["orbit-tika"].networks | keys == ["orbit-document-processing"])
  and .services["orbit-tika"].user == "35002:35002"
  and .services["orbit-tika"].read_only == true
  and .services["orbit-tika"].command == ["-c", "/etc/orbit/tika-config.json"]
  and (.services["orbit-tika"].cap_drop == ["ALL"])
  and (.services["orbit-tika"].configs | any(.source == "orbit-tika-config" and .target == "/etc/orbit/tika-config.json"))
  and ((.services["orbit-tika"].volumes // []) | length == 0)
  and ((.services["orbit-tika"].secrets // []) | length == 0)
  and (.services["orbit-app"].networks | has("default") and has("orbit-document-processing"))
  and (.services["orbit-db"].networks | has("default") and (has("orbit-document-processing") | not))
  and (.services["orbit-clamav"].networks | keys == ["orbit-document-processing", "orbit-malware-signature-updates"])
  and ((.services["orbit-clamav"].networks | has("default")) | not)
' <<< "$processing_config" > /dev/null

printf 'Orbit preview preflight: Compose configuration valid for %s at %s.\n' \
  "$ORBIT_VERSION" "$ORBIT_REVISION"
