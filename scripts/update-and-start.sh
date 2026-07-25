#!/usr/bin/env bash
set -Eeuo pipefail

# Always operate from the repository root, regardless of the caller's location.
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

command -v git >/dev/null 2>&1 || { echo "Git is required." >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Docker is required." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required." >&2; exit 1; }

if [[ ! -f .env ]]; then
  echo "Missing .env. Copy .env.example to .env, configure it, then run this script again." >&2
  exit 1
fi

git pull --ff-only
docker compose pull homesee-db
docker compose build --pull homesee-fe
docker compose up -d --remove-orphans
docker compose ps
