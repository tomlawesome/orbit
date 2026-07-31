#!/usr/bin/env bash
set -Eeuo pipefail

readonly repository_url="${ORBIT_REPOSITORY_URL:-https://github.com/tomlawesome/orbit.git}"
readonly environment_file=".env-orbit"
build_locally=""

fail() {
  printf 'Orbit installer: %s\n' "$*" >&2
  exit 1
}

compose() {
  docker compose --env-file "$environment_file" "$@"
}

command -v git >/dev/null 2>&1 || fail "Git is required."
command -v docker >/dev/null 2>&1 || fail "Docker is required."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."

# Update an Orbit checkout, or clone into an otherwise empty current directory.
if [[ -d .git ]]; then
  origin_url="$(git remote get-url origin 2>/dev/null || true)"
  [[ "$origin_url" =~ github\.com[:/]tomlawesome/orbit(\.git)?$ ]] ||
    fail "The current Git repository is not tomlawesome/orbit."
  git pull --ff-only
elif [[ -n "$(find . -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  fail "The current directory must be empty, or an existing Orbit checkout."
else
  git clone "$repository_url" .
fi

while true; do
  read -r -p "Build the Orbit application container locally? [Y/n] " build_choice </dev/tty ||
    fail "An interactive terminal is required."

  case "${build_choice,,}" in
    "" | y | yes)
      export ORBIT_IMAGE="orbit-local:$(git rev-parse --short=12 HEAD)"
      build_locally="true"
      break
      ;;
    n | no)
      [[ "${ORBIT_IMAGE:-}" =~ ^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$ ]] ||
        fail "Set ORBIT_IMAGE to the exact published registry digest before choosing the pull option."
      build_locally="false"
      break
      ;;
    *)
      printf 'Please answer Y/Yes or N/No.\n'
      ;;
  esac
done

bash scripts/configure.sh
compose pull orbit-db
if [[ "$build_locally" == "true" ]]; then
  # Building needs the source overlay; the base file has no build context.
  compose -f docker-compose.yml -f docker-compose.build.yml build --pull orbit-app
else
  printf 'Pulling %s from the configured registry...\n' "$ORBIT_IMAGE"
  compose pull orbit-app ||
    fail "Could not pull $ORBIT_IMAGE. If it is private, authenticate with its registry first."
fi

compose up -d --no-build --remove-orphans
compose ps
