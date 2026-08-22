#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

readonly environment_file=".env-orbit"
pull_option="--pull"

[[ "$#" -le 1 && ( "$#" -eq 0 || "$1" == "--no-pull" ) ]] || {
  printf 'Orbit build: usage: bash scripts/build-container.sh [--no-pull]\n' >&2
  exit 1
}
[[ "${1:-}" != "--no-pull" ]] || pull_option=""
[[ -f "$environment_file" ]] || {
  printf 'Orbit build: missing %s; run bash scripts/configure.sh first.\n' "$environment_file" >&2
  exit 1
}
command -v docker >/dev/null 2>&1 || {
  printf 'Orbit build: Docker is required.\n' >&2
  exit 1
}
command -v node >/dev/null 2>&1 || {
  printf 'Orbit build: Node.js is required to calculate the release-train version.\n' >&2
  exit 1
}
docker compose version >/dev/null 2>&1 || {
  printf 'Orbit build: Docker Compose v2 is required.\n' >&2
  exit 1
}
export ORBIT_IMAGE="orbit-local:$(git rev-parse --short=12 HEAD)"
export ORBIT_VERSION="$(node scripts/calculate-version.mjs --channel preview)"
export ORBIT_REVISION="$(git rev-parse HEAD)"
export ORBIT_CHANNEL="preview"

# Fail before Docker is invoked at all (#435). The Dockerfile validates these
# too, because an image must refuse metadata it cannot substantiate whoever
# builds it — but that check costs a container start, and this one is free.
# The three patterns live in one shared file (#435) so this script and the
# Dockerfile cannot drift apart on what counts as valid.
# shellcheck source=./release-metadata-patterns.sh
source "$repo_dir/scripts/release-metadata-patterns.sh"
for spec in "ORBIT_VERSION:$ORBIT_VERSION_PATTERN" \
            "ORBIT_REVISION:$ORBIT_REVISION_PATTERN" \
            "ORBIT_CHANNEL:$ORBIT_CHANNEL_PATTERN"; do
  name="${spec%%:*}"
  pattern="${spec#*:}"
  if ! printf '%s\n' "${!name}" | grep -Eq "$pattern"; then
    printf 'Orbit build: %s is %s, which does not match %s\n' "$name" "${!name:-empty}" "$pattern" >&2
    exit 1
  fi
done

# The build needs the package registry. BuildKit resolves DNS in its own
# network namespace, which can fail where the host and ordinary containers
# succeed (#436) — measured on one machine: host 200, `docker run` 200,
# BuildKit EAI_AGAIN. The resulting failure is a corepack stack trace about a
# pnpm tarball URL, which points at nothing useful — so when a build fails,
# say what actually went wrong, using an ordinary `docker run` (not a
# BuildKit build) so this diagnosis itself is not subject to the isolation it
# is checking for. Run AFTER a failed build rather than before every build:
# as a preflight it taxed each green build with a container spin-up and a
# network round trip to answer a question the build was about to answer
# anyway (#448).
#
# Decision (#436): Orbit does not pin off BuildKit by default. BuildKit is the
# supported, current builder — CI, most local Docker installs, and the digest-
# pinned base images this build depends on are all exercised against it daily
# (see scripts/exact-image-workflow.test.mjs). The isolation seen here is a
# property of some hosts' Docker network configuration, not of BuildKit in
# general, so pinning every build to the deprecated legacy builder to work
# around a minority of hosts would be the wrong trade for everyone else.
# Where it does happen, `DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0` builds
# through the same Dockerfile with the legacy builder and produces an
# equivalent image: same digest-pinned base images, same ORBIT_VERSION /
# ORBIT_REVISION / ORBIT_CHANNEL contract, because only the engine executing
# the Dockerfile's instructions changes, not the instructions themselves. That
# builder is deprecated upstream, so this is offered as a documented escape
# hatch for this specific failure, not as Orbit's default.
diagnose_registry_reachability() {
  if ! docker run --rm "$(grep -m1 -oE 'node:[0-9]+-alpine@sha256:[a-f0-9]+' "$repo_dir/Dockerfile")" \
       node -e "fetch('https://registry.npmjs.org/pnpm').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
       >/dev/null 2>&1; then
    printf 'Orbit build: a container on this host cannot reach https://registry.npmjs.org.\n' >&2
    printf 'Orbit build: the image build installs dependencies, so that is likely the failure above.\n' >&2
    printf 'Orbit build: this usually means BuildKit resolves DNS in its own network namespace\n' >&2
    printf 'Orbit build: and that namespace cannot reach the registry, even though the host and\n' >&2
    printf 'Orbit build: plain containers on this machine can. Check Docker DNS and proxy\n' >&2
    printf 'Orbit build: configuration first.\n' >&2
    printf 'Orbit build: if this is BuildKit network isolation and you cannot fix the network,\n' >&2
    printf 'Orbit build: retry with the legacy builder as a workaround:\n' >&2
    printf 'Orbit build:   DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 bash scripts/build-container.sh\n' >&2
  fi
}

# The build context lives in an overlay, because the base compose file
# describes a deployment that has no source tree.
readonly build_files=(-f docker-compose.yml -f docker-compose.build.yml)

if [[ -n "$pull_option" ]]; then
  docker compose --env-file "$environment_file" "${build_files[@]}" build --pull orbit-app \
    || { diagnose_registry_reachability; exit 1; }
else
  docker compose --env-file "$environment_file" "${build_files[@]}" build orbit-app \
    || { diagnose_registry_reachability; exit 1; }
fi
