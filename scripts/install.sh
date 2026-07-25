#!/usr/bin/env bash
set -Eeuo pipefail

readonly repository_url="${ORBIT_REPOSITORY_URL:-https://github.com/tomlawesome/orbit.git}"
export ORBIT_IMAGE="${ORBIT_IMAGE:-ghcr.io/tomlawesome/orbit:latest}"

fail() {
  printf 'Orbit installer: %s\n' "$*" >&2
  exit 1
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

if [[ ! -f .env ]]; then
  cp .env.example .env
  printf 'Created .env from .env.example. Review it before exposing Orbit beyond this host.\n'
fi

while true; do
  read -r -p "Build the Orbit application container locally? [Y/n] " build_choice </dev/tty ||
    fail "An interactive terminal is required."

  case "${build_choice,,}" in
    "" | y | yes)
      docker compose pull orbit-db
      docker compose build --pull orbit-app
      break
      ;;
    n | no)
      printf 'Pulling %s from GitHub Container Registry...\n' "$ORBIT_IMAGE"
      docker compose pull orbit-db
      docker compose pull orbit-app ||
        fail "Could not pull $ORBIT_IMAGE. If it is private, authenticate with: docker login ghcr.io"
      break
      ;;
    *)
      printf 'Please answer Y/Yes or N/No.\n'
      ;;
  esac
done

docker compose up -d --no-build --remove-orphans
docker compose ps
