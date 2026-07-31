#!/usr/bin/env bash
set -Eeuo pipefail

# Orbit installer.
#
# Deploys a published, digest-pinned image. It takes no interactive input, so
# it works under CI, non-TTY SSH and cloud-init as well as a terminal, and it
# does not clone the repository: a deployment needs compose assets and a
# published image, not source or tests.
#
# Building from source is a separate developer workflow; see the README.

readonly repository="${ORBIT_REPOSITORY:-tomlawesome/orbit}"
readonly registry="${ORBIT_REGISTRY:-ghcr.io}"
readonly channel="${ORBIT_CHANNEL:-latest}"
readonly environment_file=".env-orbit"
readonly image_repository="${registry}/${repository}"

fail() {
  printf 'Orbit installer: %s\n' "$*" >&2
  exit 1
}

compose() {
  docker compose --env-file "$environment_file" "$@"
}

command -v docker >/dev/null 2>&1 || fail "Docker is required."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
command -v curl >/dev/null 2>&1 || fail "curl is required."

# Resolve the requested channel to an immutable digest. The channel tag is only
# ever read; the digest is what is recorded and deployed, so a tag that moves
# later cannot change this deployment.
printf 'Resolving %s:%s...\n' "$image_repository" "$channel"
docker pull --quiet "${image_repository}:${channel}" >/dev/null ||
  fail "Could not pull ${image_repository}:${channel}. If the image is private, authenticate with ${registry} first."

resolved_reference="$(
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "${image_repository}:${channel}" |
    grep -F "${image_repository}@sha256:" |
    head -n 1
)"
[[ "$resolved_reference" =~ ^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$ ]] ||
  fail "The registry did not return an immutable digest for ${image_repository}:${channel}."

# The image records the exact source revision that produced it, so deployment
# assets are fetched from that revision rather than from a moving branch. A
# compose file therefore cannot drift from the image it configures.
revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$resolved_reference")"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] ||
  fail "The published image does not record the source revision that produced it."

printf 'Resolved %s\n' "$resolved_reference"

readonly asset_base="https://raw.githubusercontent.com/${repository}/${revision}"
readonly deployment_assets=(
  "docker-compose.yml"
  "docker-compose.mail.yml"
  "docker-compose.mail-alias-rotation.yml"
  ".env-orbit.example"
  "config/tika-config.xml"
  "scripts/configure.sh"
)

printf 'Fetching deployment assets from %s...\n' "${revision:0:12}"
for asset in "${deployment_assets[@]}"; do
  mkdir -p "$(dirname "$asset")"
  curl --fail --silent --show-error --location --output "$asset" "${asset_base}/${asset}" ||
    fail "Could not fetch ${asset} from the published revision."
done

bash scripts/configure.sh

# Record the resolved digest as the deployment reference. The channel tag is
# never written here: what runs must be an immutable, attested artifact.
if grep -q '^ORBIT_IMAGE=' "$environment_file"; then
  orbit_image_line="ORBIT_IMAGE=${resolved_reference}"
  tmp_environment="$(mktemp)"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == ORBIT_IMAGE=* ]]; then
      printf '%s\n' "$orbit_image_line"
    else
      printf '%s\n' "$line"
    fi
  done < "$environment_file" > "$tmp_environment"
  mv "$tmp_environment" "$environment_file"
else
  printf 'ORBIT_IMAGE=%s\n' "$resolved_reference" >> "$environment_file"
fi

export ORBIT_IMAGE="$resolved_reference"

compose pull orbit-db
compose up -d --no-build --remove-orphans
compose ps

printf '\nOrbit is deployed from %s\n' "$resolved_reference"
printf 'Optional services are selected with COMPOSE_PROFILES in %s\n' "$environment_file"
