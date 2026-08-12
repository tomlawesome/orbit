#!/usr/bin/env bash
set -Eeuo pipefail

# Orbit repair mode — safe diagnostic slice (issue #261, first slice).
#
# Supported invocation for this slice: `bash scripts/repair.sh --check`
# (also tolerates `--check --plain`/`--plain --check`). There is no
# interactive planner or executor yet; that is later slices layered on top
# of this read-only diagnosis contract.
#
# This script is deliberately standalone and source-less: it never sources
# install.sh, configure.sh or installer-ui.sh, and it copies only the
# minimal filesystem-recognition CONCEPTS it needs from install.sh
# (is_regular_non_symlink_file / is_real_non_symlink_directory / has_mode /
# managed-file and secrets-directory recognition, Compose project-name
# derivation). Configuration syntax/schema/secret readiness is NOT
# reimplemented here: it is delegated to `bash scripts/configure.sh --check`
# and its output/exit status is mapped onto this script's reason classes.
#
# READ-ONLY BY CONSTRUCTION
# --------------------------
# This script must never write, create, chmod, start, stop, or delete
# anything. It never uses mktemp inside the installation directory. Every
# `docker` invocation is one of: `docker inspect`, `docker ps`,
# `docker volume ls`/`inspect`, `docker compose config` — never a command
# that mutates containers, volumes, or images. Each docker read is
# optional: if the `docker` CLI is unavailable or the daemon cannot be
# reached, the affected checks are reported as `class=docker-unavailable`
# and diagnosis continues with everything else that can still be checked
# read-only.
#
# This slice adds exactly two more read-only primitives, both narrowly
# scoped: `docker exec -T <this deployment's orbit-db container> pg_isready`
# and `docker exec -T <same container> psql -c 'SELECT 1'`. Neither mutates
# anything server-side (`pg_isready` opens and immediately closes a
# connection; `SELECT 1` reads no table and touches no data) and both only
# ever target the orbit-db container whose Compose project/service labels
# were already proved to belong to this deployment (the same label proof
# Step 10 uses). This is still within the read-only contract: it is a
# client-side probe of reachability and authentication, not a database
# mutation, a schema inspection, or an application-data query. The
# PostgreSQL password never appears in argv or output — see "Database
# credential handling" below.
#
# Database credential handling
# ------------------------------
# `psql`'s password must never be observable via `ps`, this script's own
# stdout/stderr, or any docker/shell logging. It is passed with
# `docker exec -e PGPASSWORD` (no `=value`): this form makes the Docker CLI
# forward the value from its own inherited process environment rather than
# placing it on the command line, so it never appears in argv. The password
# is read from the `postgres-password` secret file into a `local` shell
# variable scoped to a single function invocation, attached only as a
# same-line prefix assignment on the `docker exec` command itself (so it is
# never `export`ed into the rest of this script's environment), and is
# reset to an empty string immediately after use. `set -x` is never enabled
# anywhere in this script. The captured `psql` output is inspected only
# in-process to classify success/auth-failure/other-failure; it is never
# printed, logged, or included in any finding.
#
# OUTPUT CONTRACT
# ----------------
# One finding per line:
#   finding class=<reason-class> target=<target-class> severity=<info|warn|fail>
# Enums only — stdout never contains a path, a configured value, or a
# secret. A final line always follows:
#   diagnosis result=<healthy|attention|failed> checked=<n> skipped=<n>
# Output is always plain deterministic text: no ANSI, no cursor control,
# regardless of terminal or the (accepted but inert) --plain flag. Findings
# are grouped in a fixed class order (see `class_order` below) so that the
# same on-disk/daemon state always produces byte-identical output.
#
# EXIT CODES
# -----------
#   0  healthy    — no findings at all
#   3  attention  — only warn-severity findings (no fail-severity finding)
#   4  failed     — at least one fail-severity finding
#   2  usage error
#   5  not-an-orbit-installation — the target directory carries no
#      recognizable Orbit installation evidence at all; every other check
#      is skipped because there is nothing safe to reason about.
#
# REASON CLASSES (this slice)
# -----------------------------
#   not-orbit-directory          — no Orbit installation evidence found at all.
#   managed-file-missing         — .env-orbit or docker-compose.yml absent
#                                   (or present as the wrong type).
#   managed-file-symlink         — .env-orbit or docker-compose.yml is a symlink.
#   managed-file-permissions     — .env-orbit exists but is not mode 600.
#   secrets-directory-invalid    — .orbit-secrets missing, symlinked, the
#                                   wrong type, or not mode 700 (any one
#                                   reason collapses to this single class).
#   secret-missing                — a managed secret file is absent or empty.
#   secret-permissions            — a managed secret file is a symlink, the
#                                   wrong type, or not mode 600.
#   configuration-incomplete      — `configure.sh --check` exited non-zero
#                                   with only readiness output on stdout
#                                   (required fields not yet ready).
#   configuration-invalid          — `configure.sh --check` exited non-zero
#                                   and also wrote to stderr (a structural
#                                   problem: unreadable/unsafe .env-orbit or
#                                   a missing .env-orbit.example template).
#   staging-evidence-present       — a leftover `.orbit-install-staging.*`
#                                   directory from an interrupted installer
#                                   transaction (see issue #291 comment on #261).
#   compose-interpolation-failed   — `docker compose config --quiet` failed
#                                   against the managed files.
#   docker-unavailable              — the `docker` CLI/daemon could not be
#                                   used for the affected check(s).
#   container-foreign-owner         — a container carries this deployment's
#                                   Compose project label but not a known
#                                   Orbit service label.
#   volume-retained-without-credentials — the #261 fixed-project collision:
#                                   the retained `orbit-db-data` volume for
#                                   this project exists while the database
#                                   password secret file is missing — the
#                                   SQLSTATE 28P01 precursor, detected
#                                   without ever touching the database.
#   unrelated-resource-present      — a database volume matching Orbit's
#                                   naming pattern exists under a different
#                                   Compose project than this deployment's.
#   database-unreachable            — this deployment's orbit-db container is
#                                   absent/not running, or is running but
#                                   `pg_isready` did not succeed within the
#                                   bounded probe.
#   database-credential-mismatch    — `pg_isready` succeeded (the server is
#                                   accepting connections) but authenticating
#                                   with the managed `postgres-password`
#                                   secret failed with a password/SQLSTATE
#                                   28P01-style error — the motivating
#                                   failure of issue #261.
#   stale-container                 — this deployment's orbit-app container
#                                   is running an image identity that does
#                                   not match `ORBIT_IMAGE` in `.env-orbit`
#                                   (the configuration was updated but the
#                                   container was never recreated).
#   application-unhealthy           — this deployment's orbit-app container
#                                   exists but Docker reports its health
#                                   status as `unhealthy`.
#
# RESERVED CLASSES (explicitly out of scope for this slice — next slice)
# --------------------------------------------------------------------------
#   unsupported-schema, migration-failed, image-identity-mismatch
# This slice still never inspects schema/migration state or a container's
# registry-side image identity (as opposed to the locally pinned
# `ORBIT_IMAGE` value, which stale-container above does check); those
# remain reserved for the executor slice that can safely pair them with
# repair actions.

usage() {
  printf 'Usage: %s --check [--plain]\n' "$0" >&2
}

plain_mode=0
check_mode=0
for arg in "$@"; do
  case "$arg" in
    --check) check_mode=1 ;;
    --plain) plain_mode=1 ;;
    *)
      usage
      exit 2
      ;;
  esac
done
[[ "$check_mode" == 1 ]] || {
  usage
  exit 2
}
# plain_mode is accepted for command-line compatibility with install.sh and
# installer-simulation.sh; output is unconditionally plain regardless of it.
: "$plain_mode"

# Force cwd to this script's own containing installation directory, exactly
# like configure.sh, so `bash scripts/repair.sh --check` is safe regardless
# of the caller's working directory.
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

readonly environment_file=".env-orbit"
readonly compose_file="docker-compose.yml"
readonly secrets_directory=".orbit-secrets"
readonly database_volume_key="orbit-db-data"
readonly -a secret_names=(session-secret postgres-password document-kek oidc-client-secret)
readonly -a known_orbit_services=(orbit-app orbit-db orbit-clamav orbit-tika orbit-ollama)
readonly total_checks=15
readonly docker_probe_timeout=5s

readonly -a class_order=(
  not-orbit-directory
  managed-file-missing
  managed-file-symlink
  managed-file-permissions
  secrets-directory-invalid
  secret-missing
  secret-permissions
  configuration-incomplete
  configuration-invalid
  staging-evidence-present
  compose-interpolation-failed
  docker-unavailable
  container-foreign-owner
  volume-retained-without-credentials
  unrelated-resource-present
  database-unreachable
  database-credential-mismatch
  stale-container
  application-unhealthy
)

declare -a findings=()
checked=0

add_finding() {
  findings+=("$1|$2|$3")
}

is_regular_non_symlink_file() {
  [[ -f "$1" && ! -L "$1" ]]
}

is_real_non_symlink_directory() {
  [[ -d "$1" && ! -L "$1" ]]
}

has_mode() {
  [[ "$(stat -c '%a' -- "$1" 2>/dev/null)" == "$2" ]]
}

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

# $1: "early" forces exit 5 (not-an-orbit-installation) regardless of
# finding severity; anything else auto-derives the exit code from the
# worst finding severity (0 healthy / 3 attention / 4 failed).
print_output_and_exit() {
  local forced_exit="$1"
  local class entry fclass ftarget fseverity worst=healthy

  for class in "${class_order[@]}"; do
    for entry in "${findings[@]:-}"; do
      [[ -n "$entry" ]] || continue
      IFS='|' read -r fclass ftarget fseverity <<< "$entry"
      [[ "$fclass" == "$class" ]] || continue
      printf 'finding class=%s target=%s severity=%s\n' "$fclass" "$ftarget" "$fseverity"
      if [[ "$fseverity" == fail ]]; then
        worst=failed
      elif [[ "$fseverity" == warn && "$worst" != failed ]]; then
        worst=attention
      fi
    done
  done

  local skipped=$((total_checks - checked))
  printf 'diagnosis result=%s checked=%s skipped=%s\n' "$worst" "$checked" "$skipped"

  if [[ "$forced_exit" == early ]]; then
    exit 5
  fi
  case "$worst" in
    healthy) exit 0 ;;
    attention) exit 3 ;;
    failed) exit 4 ;;
  esac
}

# --- Step 0: directory recognition -----------------------------------------
#
# Loosely-typed on purpose: unlike install.sh's binary validate_target, this
# looks for ANY fingerprint that this directory is (or was) an Orbit
# installation, so a broken/partial deployment can still be diagnosed in
# detail rather than being refused outright.
has_signal=0
[[ -e "$environment_file" || -L "$environment_file" ]] && has_signal=1
[[ -e "$compose_file" || -L "$compose_file" ]] && has_signal=1
[[ -e "$secrets_directory" || -L "$secrets_directory" ]] && has_signal=1
shopt -s nullglob dotglob
staging_entries=(.orbit-install-staging.*)
shopt -u nullglob dotglob
[[ ${#staging_entries[@]} -gt 0 ]] && has_signal=1

checked=$((checked + 1))
if [[ "$has_signal" == 0 ]]; then
  add_finding not-orbit-directory directory fail
  print_output_and_exit early
fi

# --- Step 1: managed files (.env-orbit, docker-compose.yml) ----------------

# Sets the global $managed_file_result rather than returning via command
# substitution, which would run the finding/checked mutations in a subshell
# and silently discard them.
check_managed_file() {
  local path="$1" target="$2" require_mode="${3:-}"
  checked=$((checked + 1))
  if [[ -L "$path" ]]; then
    add_finding managed-file-symlink "$target" fail
    managed_file_result=symlink
    return
  fi
  if [[ ! -e "$path" || ! -f "$path" ]]; then
    add_finding managed-file-missing "$target" fail
    managed_file_result=missing
    return
  fi
  if [[ -n "$require_mode" ]] && ! has_mode "$path" "$require_mode"; then
    add_finding managed-file-permissions "$target" fail
    managed_file_result=permissions
    return
  fi
  managed_file_result=ok
}

managed_file_result=""
check_managed_file "$environment_file" environment-file 600
env_status="$managed_file_result"
check_managed_file "$compose_file" compose-file
compose_status="$managed_file_result"

# --- Step 2: secrets directory ----------------------------------------------

checked=$((checked + 1))
secrets_status=ok
if ! is_real_non_symlink_directory "$secrets_directory"; then
  secrets_status=invalid
elif ! has_mode "$secrets_directory" 700; then
  secrets_status=invalid
fi
[[ "$secrets_status" == ok ]] || add_finding secrets-directory-invalid secrets-directory fail

# --- Step 3: individual managed secret files --------------------------------

declare -A secret_status=()
for name in "${secret_names[@]}"; do
  if [[ "$secrets_status" != ok ]]; then
    secret_status["$name"]=unknown
    continue
  fi
  checked=$((checked + 1))
  path="$secrets_directory/$name"
  if [[ -L "$path" ]]; then
    add_finding secret-permissions "$name" fail
    secret_status["$name"]=bad
  elif [[ ! -e "$path" ]]; then
    add_finding secret-missing "$name" warn
    secret_status["$name"]=missing
  elif [[ ! -f "$path" ]]; then
    add_finding secret-permissions "$name" fail
    secret_status["$name"]=bad
  elif [[ ! -s "$path" ]]; then
    add_finding secret-missing "$name" warn
    secret_status["$name"]=missing
  elif ! has_mode "$path" 600; then
    add_finding secret-permissions "$name" fail
    secret_status["$name"]=bad
  else
    secret_status["$name"]=ok
  fi
done

# --- Step 4: leftover installer staging evidence (issue #291 comment) ------

checked=$((checked + 1))
shopt -s nullglob dotglob
staging_entries=(.orbit-install-staging.*)
shopt -u nullglob dotglob
[[ ${#staging_entries[@]} -gt 0 ]] && add_finding staging-evidence-present staging warn

# --- Step 5: configuration syntax/schema/secret readiness (delegated) ------
#
# configure.sh --check is the single source of truth for configuration
# readiness (src/lib/config-contract.ts keeps it in parity). This script
# never re-implements that logic; it only classifies the outcome:
#   - exit 0                          -> no finding, configuration is ready.
#   - exit non-zero, nothing on stderr -> configuration-incomplete (required
#     fields not yet ready; configure.sh's own `fail()` path always writes
#     to stderr, so a silent non-zero exit means only the readiness report
#     on stdout was involved).
#   - exit non-zero with stderr output -> configuration-invalid (a
#     structural problem such as an unreadable/unsafe .env-orbit or a
#     missing .env-orbit.example template).
if is_regular_non_symlink_file scripts/configure.sh; then
  checked=$((checked + 1))
  configure_check_stderr="$(mktemp "${TMPDIR:-/tmp}/orbit-repair-configure-check.XXXXXX")"
  configure_check_status=0
  bash scripts/configure.sh --check >/dev/null 2>"$configure_check_stderr" || configure_check_status=$?
  if [[ "$configure_check_status" != 0 ]]; then
    if [[ -s "$configure_check_stderr" ]]; then
      add_finding configuration-invalid configuration fail
    else
      add_finding configuration-incomplete configuration fail
    fi
  fi
  rm -f -- "$configure_check_stderr"
fi

# --- Step 6: Compose project name derivation (read-only) -------------------
#
# Mirrors install.sh's derive_compose_project_name precedence, but never
# fails the run: an unresolvable project name just means the docker-backed
# checks below are skipped rather than reported as findings.
project=""
if [[ "$env_status" == ok ]]; then
  candidate="$(read_environment_value COMPOSE_PROJECT_NAME 2>/dev/null || true)"
  [[ "$candidate" =~ ^[a-z0-9][a-z0-9_-]*$ ]] && project="$candidate"
fi
if [[ -z "$project" && -n "${COMPOSE_PROJECT_NAME:-}" ]]; then
  [[ "$COMPOSE_PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]] && project="$COMPOSE_PROJECT_NAME"
fi
if [[ -z "$project" ]]; then
  candidate="$(basename -- "$(pwd -P)" 2>/dev/null || true)"
  candidate="$(printf '%s' "$candidate" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-' 2>/dev/null || true)"
  while [[ "$candidate" == [-_]* ]]; do candidate="${candidate:1}"; done
  [[ -n "$candidate" && "$candidate" =~ ^[a-z0-9][a-z0-9_-]*$ ]] && project="$candidate"
fi

# --- Step 7: docker availability gate ---------------------------------------
#
# One cheap, allowed, read-only probe (`docker ps -a`) decides whether every
# docker-backed check below can run at all. Any failure — missing binary,
# missing `timeout`, unreachable daemon — is treated identically as
# docker-unavailable for every affected check; this script cannot and does
# not distinguish the cause.
docker_available=0
if command -v docker >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1 &&
  timeout "$docker_probe_timeout" docker ps -a >/dev/null 2>&1; then
  docker_available=1
fi

compose_check_eligible=0
[[ "$env_status" == ok && "$compose_status" == ok && -n "$project" ]] && compose_check_eligible=1
resource_check_eligible=0
[[ -n "$project" ]] && resource_check_eligible=1

# --- Step 8: Compose interpolation ------------------------------------------

if [[ "$compose_check_eligible" == 1 ]]; then
  if [[ "$docker_available" == 1 ]]; then
    checked=$((checked + 1))
    if ! timeout "$docker_probe_timeout" docker compose --project-name "$project" \
      --env-file "$environment_file" config --quiet >/dev/null 2>&1; then
      add_finding compose-interpolation-failed compose fail
    fi
  else
    add_finding docker-unavailable compose info
  fi
fi

# --- Step 9: retained database volume vs. credentials ----------------------

if [[ "$resource_check_eligible" == 1 ]]; then
  if [[ "$docker_available" == 1 ]]; then
    checked=$((checked + 1))
    volume_list="$(timeout "$docker_probe_timeout" docker volume ls \
      --filter "name=$database_volume_key" --format '{{.Name}}' 2>/dev/null || true)"
    our_volume="${project}_${database_volume_key}"
    found_ours=0
    found_other=0
    while IFS= read -r volume || [[ -n "$volume" ]]; do
      [[ -z "$volume" ]] && continue
      [[ "$volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ && "$volume" =~ (^|_)orbit-db-data$ ]] || continue
      if [[ "$volume" == "$our_volume" ]]; then
        found_ours=1
      else
        found_other=1
      fi
    done <<< "$volume_list"
    [[ "$found_other" == 1 ]] && add_finding unrelated-resource-present database-volume info
    if [[ "$found_ours" == 1 ]]; then
      if [[ "$secrets_status" != ok || "${secret_status[postgres-password]:-missing}" == missing ]]; then
        add_finding volume-retained-without-credentials database-volume fail
      fi
    fi
  else
    add_finding docker-unavailable database-volume info
  fi
fi

# --- Step 10: container project-label ownership -----------------------------

if [[ "$resource_check_eligible" == 1 ]]; then
  if [[ "$docker_available" == 1 ]]; then
    checked=$((checked + 1))
    container_list="$(timeout "$docker_probe_timeout" docker ps -a \
      --filter "label=com.docker.compose.project=$project" \
      --format '{{.ID}}|{{.Label "com.docker.compose.service"}}' 2>/dev/null || true)"
    foreign=0
    while IFS='|' read -r container_id service extra || [[ -n "$container_id" || -n "$service" || -n "$extra" ]]; do
      [[ -z "$container_id" && -z "$service" && -z "$extra" ]] && continue
      [[ -n "$extra" ]] && { foreign=1; continue; }
      [[ "$container_id" =~ ^[0-9a-f]{12,64}$ ]] || { foreign=1; continue; }
      known=0
      for known_service in "${known_orbit_services[@]}"; do
        [[ "$service" == "$known_service" ]] && { known=1; break; }
      done
      [[ "$known" == 1 ]] || foreign=1
    done <<< "$container_list"
    [[ "$foreign" == 1 ]] && add_finding container-foreign-owner container fail
  else
    add_finding docker-unavailable container info
  fi
fi

# --- Step 11: database reachability and credential match --------------------
#
# See the "READ-ONLY BY CONSTRUCTION" / "Database credential handling" notes
# at the top of this file: only `pg_isready` and `psql -c 'SELECT 1'` are
# ever exec'd, only inside this deployment's own orbit-db container (proved
# by the same Compose project/service label discipline as Step 10), and the
# password is never placed in argv, output, or a finding.
check_database_reachability() {
  local db_ids db_id pg_user=orbit pg_db=orbit candidate
  local pg_password="" psql_output="" psql_status=0

  if [[ "$env_status" == ok ]]; then
    candidate="$(read_environment_value POSTGRES_USER 2>/dev/null || true)"
    [[ "$candidate" =~ ^[A-Za-z0-9_]+$ ]] && pg_user="$candidate"
    candidate="$(read_environment_value POSTGRES_DB 2>/dev/null || true)"
    [[ "$candidate" =~ ^[A-Za-z0-9_]+$ ]] && pg_db="$candidate"
  fi

  db_ids="$(timeout "$docker_probe_timeout" docker ps -a \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=orbit-db" \
    --format '{{.ID}}' 2>/dev/null || true)"
  db_id=""
  if [[ -n "$db_ids" && "$db_ids" != *$'\n'* && "$db_ids" =~ ^[0-9a-f]{12,64}$ ]]; then
    db_id="$db_ids"
  fi

  if [[ -z "$db_id" ]] || ! timeout "$docker_probe_timeout" docker exec -T "$db_id" \
    pg_isready -U "$pg_user" -d "$pg_db" >/dev/null 2>&1; then
    add_finding database-unreachable database fail
    return 0
  fi

  # Without a readable postgres-password secret there is nothing safe to
  # authenticate with; secret-missing/volume-retained-without-credentials
  # already cover that absence, so this check quietly stops here rather
  # than guessing. (Bare `return` would propagate the failing test's exit
  # status as this function's own return value and trip `set -e` at the
  # call site below, so every early exit here is an explicit `return 0`.)
  [[ "${secret_status[postgres-password]:-missing}" == ok ]] || return 0

  pg_password="$(cat -- "$secrets_directory/postgres-password" 2>/dev/null || true)"
  # -h forces a host (TCP) connection so PostgreSQL's password-based
  # authentication is actually exercised; a bare local-socket connection
  # would use "trust" auth inside the official postgres image and could
  # never observe a credential mismatch.
  psql_output="$(PGPASSWORD="$pg_password" timeout "$docker_probe_timeout" \
    docker exec -e PGPASSWORD -T "$db_id" \
    psql -h 127.0.0.1 -U "$pg_user" -d "$pg_db" -c 'SELECT 1' 2>&1)" || psql_status=$?
  pg_password=""
  if [[ "$psql_status" != 0 ]]; then
    if [[ "${psql_output,,}" == *"password authentication failed"* ]]; then
      add_finding database-credential-mismatch database fail
    else
      add_finding database-unreachable database fail
    fi
  fi
  psql_output=""
}

if [[ "$resource_check_eligible" == 1 ]]; then
  if [[ "$docker_available" == 1 ]]; then
    checked=$((checked + 1))
    check_database_reachability
  else
    add_finding docker-unavailable database info
  fi
fi

# --- Step 12: application container image identity and health --------------
#
# Compares this deployment's running orbit-app container against the
# locally pinned ORBIT_IMAGE (stale-container) and reads Docker's own
# computed health status (application-unhealthy, from the HEALTHCHECK baked
# into the published image). Both reads are `docker inspect` only; neither
# execs into the container nor touches the registry (that registry-side
# comparison is the still-reserved image-identity-mismatch class).
check_application_container() {
  local app_ids app_id pinned_image=""
  local inspect_output="" actual_image="" health_status="" extra=""

  if [[ "$env_status" == ok ]]; then
    pinned_image="$(read_environment_value ORBIT_IMAGE 2>/dev/null || true)"
    [[ "$pinned_image" =~ ^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$ ]] || pinned_image=""
  fi

  app_ids="$(timeout "$docker_probe_timeout" docker ps -a \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=orbit-app" \
    --format '{{.ID}}' 2>/dev/null || true)"
  app_id=""
  if [[ -n "$app_ids" && "$app_ids" != *$'\n'* && "$app_ids" =~ ^[0-9a-f]{12,64}$ ]]; then
    app_id="$app_ids"
  fi
  # Every early exit below is an explicit `return 0`, never a bare `return`:
  # a bare `return` propagates the preceding failed test's exit status as
  # this function's own return value, which would trip `set -e` at the
  # call site (a bare `check_application_container` statement) below.
  [[ -n "$app_id" ]] || return 0

  inspect_output="$(timeout "$docker_probe_timeout" docker inspect \
    --format '{{.Config.Image}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
    "$app_id" 2>/dev/null || true)"
  [[ "$inspect_output" != *$'\n'* ]] || return 0
  IFS='|' read -r actual_image health_status extra <<< "$inspect_output"
  [[ -z "$extra" ]] || return 0

  if [[ -n "$pinned_image" && -n "$actual_image" && "$actual_image" != "$pinned_image" ]]; then
    add_finding stale-container container warn
  fi
  if [[ "$health_status" == unhealthy ]]; then
    add_finding application-unhealthy application fail
  fi
}

if [[ "$resource_check_eligible" == 1 ]]; then
  if [[ "$docker_available" == 1 ]]; then
    checked=$((checked + 1))
    check_application_container
  else
    add_finding docker-unavailable application info
  fi
fi

print_output_and_exit final
