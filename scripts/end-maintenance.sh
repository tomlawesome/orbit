#!/usr/bin/env bash
set -Eeuo pipefail

# scripts/end-maintenance.sh — the emergency recovery path of ADR-0013
# decision 4, packaged per ADR-0015 decision 2 (issue #524).
#
# When OIDC is down and no administrator can sign in, this reopens the
# instance. Host bash remains the only thing that runs `docker`; the logic
# itself is the application's own domain function, shipped inside the already
# published image and reached through the bundled CLI — the same in-container
# one-off pattern as scripts/engine-check.sh (see docs/engine-events.md,
# "In-container engine invocation").
#
# Usage: bash scripts/end-maintenance.sh
#
# It is idempotent: running it against an instance that is already open
# changes nothing, writes no audit row, and still exits 0, so an operator who
# is unsure may simply run it again.
#
# Unlike engine-check.sh this does NOT pass `--entrypoint node`. The image's
# own entrypoint is what stages the mounted secrets into /run/orbit-secrets,
# and this command — unlike the readiness check — needs the database
# credentials that staging provides. Overriding the entrypoint would skip it
# and the command could not connect.
#
# `--no-deps` means Compose will not start PostgreSQL for this one-off. That
# is deliberate and safe: maintenance mode only stands between users and a
# running instance, so the database is already up whenever this script is the
# thing an operator needs.
#
# No secret ever appears in this script's argv or in the composed
# `docker compose` argv below: the connection details reach the command
# through the service's own environment and mounted secrets.

usage() {
  printf 'Usage: %s\n' "${BASH_SOURCE[0]}" >&2
}

if [[ $# -gt 0 ]]; then
  usage
  exit 2
fi

# Force cwd to this script's own containing installation directory, exactly
# like configure.sh/repair.sh/engine-check.sh, so the script is safe
# regardless of the caller's working directory.
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

readonly environment_file=".env-orbit"

if ! command -v docker >/dev/null 2>&1; then
  printf 'orbit end-maintenance: docker is unavailable\n' >&2
  exit 5
fi

if [[ ! -f "$environment_file" || -L "$environment_file" ]]; then
  printf 'orbit end-maintenance: %s is missing\n' "$environment_file" >&2
  exit 5
fi

# Reads a single KEY=value line out of $environment_file, like
# engine-check.sh's own copy: this script is deliberately standalone and
# source-less, as repair.sh is.
read_environment_value() {
  local requested_key="$1" line value="" found=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "${requested_key}="* ]]; then
      value="${line#*=}"
      found=1
    fi
  done < "$environment_file"
  [[ "$found" == 1 ]] || return 1
  printf '%s' "$value"
}

# Compose project-name derivation, mirroring engine-check.sh and repair.sh
# precedence exactly: .env-orbit's own COMPOSE_PROJECT_NAME, then the
# caller's environment, then a sanitized fallback from the current
# directory's basename.
project=""
candidate="$(read_environment_value COMPOSE_PROJECT_NAME 2>/dev/null || true)"
if [[ "$candidate" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  project="$candidate"
fi
if [[ -z "$project" && -n "${COMPOSE_PROJECT_NAME:-}" ]]; then
  if [[ "$COMPOSE_PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
    project="$COMPOSE_PROJECT_NAME"
  fi
fi
if [[ -z "$project" ]]; then
  candidate="$(basename -- "$(pwd -P)" 2>/dev/null || true)"
  candidate="$(printf '%s' "$candidate" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-' 2>/dev/null || true)"
  while [[ "$candidate" == [-_]* ]]; do
    candidate="${candidate:1}"
  done
  if [[ -n "$candidate" && "$candidate" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
    project="$candidate"
  fi
fi

if [[ -z "$project" ]]; then
  printf 'orbit end-maintenance: could not derive a Compose project name\n' >&2
  exit 5
fi

exit_code=0
docker compose --project-name "$project" --env-file "$environment_file" \
  run --rm --no-deps -T \
  orbit-app node /opt/orbit/cli/orbit.js end-maintenance || exit_code=$?

exit "$exit_code"
