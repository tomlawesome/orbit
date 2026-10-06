#!/usr/bin/env bash
#
# Proves every supported compose file combination still resolves, that the
# optional services are selectable by configuration alone, and that the
# document-processing boundary is what the design says it is: an internal
# network, an unprivileged read-only Tika with no volumes or secrets, and a
# database that cannot reach it.
#
# Originally extracted verbatim from the "Validate Compose configuration"
# step of the &container_validation_steps anchor in
# .github/workflows/publish-container.yml (#801), then reunited with
# scripts/validate-compose-config.sh's operator-facing preview-preflight
# copy after the two drifted (#804): this is now the single implementation,
# CI calls it directly, and validate-compose-config.sh is a thin wrapper
# that calls it too and adds its own success banner.
#
# Inputs (environment):
#   ORBIT_IMAGE, ORBIT_VERSION, ORBIT_REVISION, ORBIT_CHANNEL
#     the identity the compose files interpolate.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root
cd "${repo_root}"

fail() {
  printf 'validate-compose: %s\n' "$1" >&2
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
  [[ -z "${selection_env}" || ! -e "${selection_env}" ]] || rm -f -- "${selection_env}"
}
trap cleanup EXIT

docker compose --env-file .env-orbit config --quiet
docker compose --env-file .env-orbit -f docker-compose.yml -f compose/docker-compose.build.yml config --quiet
docker compose --env-file .env-orbit -f docker-compose.yml -f compose/docker-compose.acceptance.yml config --quiet
docker compose --env-file .env-orbit -f docker-compose.yml -f docker-compose.mail.yml config --quiet
docker compose --env-file .env-orbit --profile processing --profile ai config --quiet
docker compose --env-file .env-orbit \
  --profile processing --profile ai --profile ai-model-pull config --quiet

# Optional services must be selectable by configuration alone, so
# that an operator never needs a different compose command. This
# proves Compose honours COMPOSE_PROFILES from the environment file:
# without it the optional services are absent, with it they appear.
#
# #838: the smoke stack's own .env-orbit now sets COMPOSE_PROFILES=processing
# so the acceptance journey has a real Tika to reach, so the "absent by
# default" half of this proof forces the shell's COMPOSE_PROFILES empty --
# a real environment variable outranks an --env-file value -- rather than
# depending on .env-orbit staying profile-free, which it deliberately no
# longer is.
selection_env="$(mktemp)"
cp .env-orbit "${selection_env}"
COMPOSE_PROFILES= docker compose --env-file "${selection_env}" config --format json \
  | jq --exit-status '(.services | has("orbit-ollama") or has("orbit-tika") or has("orbit-ollama-model-pull")) | not' > /dev/null
printf 'COMPOSE_PROFILES=processing,ai\n' >> "${selection_env}"
docker compose --env-file "${selection_env}" config --format json \
  | jq --exit-status '
      .services
      | has("orbit-ollama") and has("orbit-tika")
      # The model pull helper is the one thing in this stack with egress, so
      # selecting the ai profile must never bring it along: an operator asks
      # for a model pull by name or it does not happen (ADR-0025).
      and (has("orbit-ollama-model-pull") | not)
    ' > /dev/null

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
' <<< "${processing_config}" > /dev/null

# ADR-0025 answers "what stops the model server becoming a cloud extraction
# path" with two structural facts. One is that Orbit's endpoint is a
# compile-time constant, asserted in the application's own tests. This is the
# other: the container holding hostile document text has no route out. It fails
# the moment orbit-ollama gains the default network, a second network or a
# published port -- which is the point, because a comment saying "no egress"
# would not.
ai_config="$(docker compose --env-file .env-orbit --profile ai config --format json)"
jq --exit-status '
  .networks["orbit-document-processing"].internal == true
  and (.services["orbit-ollama"].networks | keys == ["orbit-document-processing"])
  and ((.services["orbit-ollama"].ports // []) | length == 0)
  # Defence in depth behind the network, not a substitute for it.
  and .services["orbit-ollama"].environment.OLLAMA_NO_CLOUD == "1"
  # Starting the ai profile must not start anything that can reach the internet.
  and ((.services | has("orbit-ollama-model-pull")) | not)
' <<< "${ai_config}" > /dev/null

# Egress-free means the server cannot fetch its own model, so the deliberate
# pull helper is what gets one in: same image and same volume as the server, on
# the network that does have egress, one-shot, and reachable only by naming it.
model_pull_config="$(docker compose --env-file .env-orbit \
  --profile ai --profile ai-model-pull config --format json)"
jq --exit-status '
  .services["orbit-ollama-model-pull"].image == .services["orbit-ollama"].image
  and (.services["orbit-ollama-model-pull"].networks | keys == ["default"])
  and .services["orbit-ollama-model-pull"].restart == "no"
  and (.services["orbit-ollama-model-pull"].volumes
       | any(.type == "volume"
             and .source == "orbit-ollama-data"
             and .target == "/root/.ollama"))
  # It exists to fetch model data and nothing else: no host port, no
  # application secrets, no document storage.
  and ((.services["orbit-ollama-model-pull"].ports // []) | length == 0)
  and ((.services["orbit-ollama-model-pull"].secrets // []) | length == 0)
  and ((.services["orbit-ollama-model-pull"].volumes | length) == 1)
' <<< "${model_pull_config}" > /dev/null
