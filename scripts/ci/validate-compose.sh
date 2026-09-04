#!/usr/bin/env bash
#
# Proves every supported compose file combination still resolves, that the
# optional services are selectable by configuration alone, and that the
# document-processing boundary is what the design says it is: an internal
# network, an unprivileged read-only Tika with no volumes or secrets, and a
# database that cannot reach it.
#
# Extracted verbatim from the "Validate Compose configuration" step of the
# &container_validation_steps anchor in
# .github/workflows/publish-container.yml (#801). scripts/validate-compose-
# config.sh covers the same ground for the operator-facing preview preflight
# and additionally validates the shape of its inputs; this one is the CI gate
# and is deliberately left byte-for-byte as the workflow ran it.
#
# Inputs (environment):
#   ORBIT_VERSION, ORBIT_REVISION, ORBIT_CHANNEL, ORBIT_IMAGE
#     the identity the compose files interpolate.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root
cd "${repo_root}"

docker compose --env-file .env-orbit config --quiet
docker compose --env-file .env-orbit -f docker-compose.yml -f docker-compose.build.yml config --quiet
docker compose --env-file .env-orbit -f docker-compose.yml -f docker-compose.acceptance.yml config --quiet
docker compose --env-file .env-orbit -f docker-compose.yml -f docker-compose.mail.yml config --quiet
docker compose --env-file .env-orbit -f docker-compose.yml -f docker-compose.mail.yml -f docker-compose.mail-alias-rotation.yml config --quiet
docker compose --env-file .env-orbit --profile processing --profile ai config --quiet

# Optional services must be selectable by configuration alone, so
# that an operator never needs a different compose command. This
# proves Compose honours COMPOSE_PROFILES from the environment file:
# without it the optional services are absent, with it they appear.
selection_env="$(mktemp)"
cp .env-orbit "${selection_env}"
docker compose --env-file "${selection_env}" config --format json \
  | jq --exit-status '(.services | has("orbit-ollama") or has("orbit-tika")) | not' > /dev/null
printf 'COMPOSE_PROFILES=processing,ai\n' >> "${selection_env}"
docker compose --env-file "${selection_env}" config --format json \
  | jq --exit-status '.services | has("orbit-ollama") and has("orbit-tika")' > /dev/null
rm -f "${selection_env}"

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
' <<< "${processing_config}"
