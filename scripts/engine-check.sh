#!/usr/bin/env bash
set -Eeuo pipefail

# scripts/engine-check.sh — first delegation point for issue #295's
# engine-delivery architecture (owner decision, 2026-08-13, recorded across
# comments on issue #295): host bash scripts remain the only thing that ever
# runs `docker` commands, explicitly and occasionally, at operator
# invocation; the TypeScript engine ships INSIDE the app image and is
# invoked as a disposable `docker compose run --rm --no-deps` one-off — the
# exact pattern scripts/repair.sh already uses to call
# scripts/recovery-crypto.mjs (see repair.sh's "Passphrase — the
# checkpoint" section). The engine container is never handed the Docker
# socket and never manages containers; this script is the only thing here
# that ever invokes `docker`, and only when explicitly opted into below. See
# docs/engine-events.md, "In-container engine invocation (v0)", for the full
# contract this composes and the fail-closed guarantee the bundled CLI
# itself enforces if this were ever pointed at a Docker-backed command.
#
# This is a NEW, standalone script — scripts/configure.sh, scripts/
# install.sh, and scripts/repair.sh are all unmodified by this slice.
#
# Usage: bash scripts/engine-check.sh [--plain]
#
# Default (ORBIT_ENGINE_CHECK unset, or set to anything other than
# "container"): a thin, behavior-preserving proxy onto the existing
# readiness check — `bash scripts/configure.sh --check` — run with this
# script's own exit code and stdio passed straight through. Running this
# script with no environment changes is a no-op relative to the operator's
# existing workflow.
#
# ORBIT_ENGINE_CHECK=container: runs the SAME readiness check inside the
# bundled orbit CLI (/opt/orbit/cli/orbit.js) shipped inside the already-
# resolved orbit-app image, via a disposable one-off:
#
#   docker compose --project-name "$project" --env-file "$environment_file" \
#     run --rm --no-deps -T --entrypoint node \
#     --volume "$repo_dir:/orbit-deploy:ro" \
#     orbit-app /opt/orbit/cli/orbit.js check --dir /orbit-deploy
#
# `--plain` is accepted for interface parity with configure.sh/repair.sh's
# own `--check` surfaces; it is currently inert (both the bash and
# containerized paths already print plain, deterministic text) and is never
# forwarded to either invocation. No secret ever appears in this script's
# own argv or the composed `docker compose` argv above — the readiness
# check reads no secret value, only enum-only field/severity output.

usage() {
  printf 'Usage: %s [--plain]\n' "${BASH_SOURCE[0]}" >&2
}

for arg in "$@"; do
  case "$arg" in
    --plain) ;;
    *)
      usage
      exit 2
      ;;
  esac
done

# Force cwd to this script's own containing installation directory, exactly
# like configure.sh/repair.sh, so `bash scripts/engine-check.sh` is safe
# regardless of the caller's working directory.
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

readonly environment_file=".env-orbit"

if [[ "${ORBIT_ENGINE_CHECK:-}" != container ]]; then
  exec bash "$repo_dir/scripts/configure.sh" --check
fi

if ! command -v docker >/dev/null 2>&1; then
  printf 'orbit engine-check: docker is unavailable\n' >&2
  exit 5
fi

if [[ ! -f "$environment_file" || -L "$environment_file" ]]; then
  printf 'orbit engine-check: %s is missing\n' "$environment_file" >&2
  exit 5
fi

# Reads a single KEY=value line out of $environment_file — the same
# concept scripts/repair.sh's own read_environment_value copies from
# install.sh, reimplemented here rather than sourced (this script is
# deliberately standalone and source-less, like repair.sh).
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

# Compose project-name derivation, mirroring scripts/repair.sh's own "Step
# 6: Compose project name derivation (read-only)" precedence exactly:
# .env-orbit's own COMPOSE_PROJECT_NAME, then the caller's environment, then
# a sanitized fallback from the current directory's own basename.
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
  printf 'orbit engine-check: could not derive a Compose project name\n' >&2
  exit 5
fi

exit_code=0
docker compose --project-name "$project" --env-file "$environment_file" \
  run --rm --no-deps -T --entrypoint node \
  --volume "$repo_dir:/orbit-deploy:ro" \
  orbit-app /opt/orbit/cli/orbit.js check --dir /orbit-deploy || exit_code=$?

exit "$exit_code"
