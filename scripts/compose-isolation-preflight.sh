#!/usr/bin/env bash
# Shared preflight (#536): stops a disposable test or acceptance Compose run
# from silently attaching to a project that is already running.
#
# AGENTS.md's "Compose commands attach to whatever project .env-orbit names"
# trap is exactly this: `docker compose --env-file .env-orbit ...` with no
# explicit `-p` adopts whichever project `COMPOSE_PROJECT_NAME` names --
# environment variable, else the value in that file, else the current
# directory's name -- and therefore that project's named volumes, from any
# checkout or worktree. The fixed `container_name` pins in docker-compose.yml
# then stop a second stack coexisting under its own name, so the failure mode
# is silent data sharing rather than a loud refusal. A session that believed
# it was running an isolated acceptance profile from a separate worktree hit
# this directly: it migrated a real deployment's database and created a user
# record in it, with every container reporting healthy throughout.
#
# Usage: source this file, then:
#
#   project="$(resolve_compose_project .env-orbit -f docker-compose.yml ...)" || exit 1
#   compose_isolation_preflight "$project" \
#     "docker compose -p ${project}-<unique> --env-file .env-orbit ... up ..." || exit 1
#
# Skip both calls entirely when the caller already generates its own per-run
# unique project name deliberately (as scripts/test-e2e-local.sh has since
# #875) -- that is the "explicit isolating project name" the acceptance
# criteria for #536 exempts, because the caller has already taken
# responsibility for not colliding with anything real.
#
# Deliberately does not `set -Eeuo pipefail`: this file only defines
# functions and is sourced into a caller that has already set its own shell
# options, which this must not override.

# resolve_compose_project <env-file> [compose-file-and-other-args...]
#
# Prints the Compose project name `docker compose --env-file <env-file>
# [compose-file-and-other-args...] ...` would resolve to if invoked right now
# with no explicit `-p`. Delegates to `docker compose ... config --format
# json`, a read-only render that needs no daemon, so this uses Compose's own
# precedence and project-name normalization exactly rather than
# reimplementing them and risking a computed name that does not match what
# Compose would actually use -- a mismatch here would be a false-negative
# preflight, the same failure this exists to prevent.
resolve_compose_project() {
  local env_file="$1"
  shift
  local json
  json="$(docker compose --env-file "$env_file" "$@" config --format json 2>/dev/null)" || return 1
  printf '%s' "$json" | jq -r '.name // empty'
}

# compose_isolation_preflight <project> <safe-alternative-command>
#
# Refuses -- prints to stderr and returns 1 -- when containers are already
# running under Compose project label <project>. <safe-alternative-command>
# is the exact command to print as the way to run an isolated stack instead;
# callers should build it with a unique `-p` (e.g. a worktree hash and PID,
# in the style of scripts/test-e2e-local.sh since #875).
compose_isolation_preflight() {
  local project="$1" safe_alternative="$2" running

  if [[ -z "$project" ]]; then
    printf 'compose-isolation-preflight: could not resolve a Compose project name; refusing rather than guessing.\n' >&2
    return 1
  fi

  running="$(docker ps --filter "label=com.docker.compose.project=${project}" --format '{{.Names}}' 2>/dev/null || true)"
  if [[ -n "$running" ]]; then
    printf 'compose-isolation-preflight: refusing to run against project '\''%s'\'' -- containers are already running under it (%s), and this run did not choose an isolating project name of its own.\n' \
      "$project" "$(printf '%s' "$running" | tr '\n' ' ' | sed 's/ *$//')" >&2
    printf 'compose-isolation-preflight: if that project is a real deployment, leave it alone. To run an isolated stack instead:\n  %s\n' \
      "$safe_alternative" >&2
    return 1
  fi

  return 0
}
