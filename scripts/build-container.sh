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
for spec in "ORBIT_VERSION:^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$" \
            "ORBIT_REVISION:^[0-9a-f]{40}$" \
            "ORBIT_CHANNEL:^(ci|preview|dev)$"; do
  name="${spec%%:*}"
  pattern="${spec#*:}"
  if ! printf '%s\n' "${!name}" | grep -Eq "$pattern"; then
    printf 'Orbit build: %s is %s, which does not match %s\n' "$name" "${!name:-empty}" "$pattern" >&2
    exit 1
  fi
done

# The build needs the package registry. BuildKit resolves DNS in its own
# network namespace, which can fail where the host and ordinary containers
# succeed (#436) — and the resulting failure is a corepack stack trace about a
# tarball URL, which points at nothing useful. Say so up front instead.
if ! docker run --rm "$(grep -m1 -oE 'node:[0-9]+-alpine@sha256:[a-f0-9]+' "$repo_dir/Dockerfile")" \
     node -e "fetch('https://registry.npmjs.org/pnpm').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
     >/dev/null 2>&1; then
  printf 'Orbit build: a container on this host cannot reach https://registry.npmjs.org.\n' >&2
  printf 'Orbit build: the image build installs dependencies, so it will fail.\n' >&2
  printf 'Orbit build: check Docker DNS and proxy configuration before retrying.\n' >&2
  exit 1
fi

# The build context lives in an overlay, because the base compose file
# describes a deployment that has no source tree.
readonly build_files=(-f docker-compose.yml -f docker-compose.build.yml)

if [[ -n "$pull_option" ]]; then
  docker compose --env-file "$environment_file" "${build_files[@]}" build --pull orbit-app
else
  docker compose --env-file "$environment_file" "${build_files[@]}" build orbit-app
fi
