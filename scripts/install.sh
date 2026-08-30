#!/usr/bin/env bash
set -Eeuo pipefail

# Orbit installer.
#
# Deploys a published, digest-pinned image. First installs can collect core
# configuration from a controlling terminal; unattended runs require a safe
# pre-provisioned configuration shape. It does not clone the repository: a
# deployment needs compose assets and a published image, not source or tests.
#
# Building from source is a separate developer workflow; see the README.

readonly repository="${ORBIT_REPOSITORY:-tomlawesome/orbit}"
readonly registry="${ORBIT_REGISTRY:-ghcr.io}"
readonly channel="${ORBIT_CHANNEL:-latest}"
readonly environment_file=".env-orbit"
readonly compose_file="docker-compose.yml"
readonly secrets_directory=".orbit-secrets"
readonly database_volume_key="orbit-db-data"
readonly image_repository="${registry}/${repository}"
readonly oidc_discovery_max_bytes=1048576
readonly installer_process_started_at="$SECONDS"
readonly oidc_discovery_parser='const fs = require("node:fs");
const maximumInputBytes = 1048576 + 8192;
const input = fs.readFileSync(0, "utf8");
if (Buffer.byteLength(input, "utf8") > maximumInputBytes) process.exit(1);
const separator = input.indexOf("\n");
if (separator <= 0) process.exit(1);
const issuer = input.slice(0, separator);
let document;
try {
  document = JSON.parse(input.slice(separator + 1));
} catch {
  process.exit(1);
}
if (document === null || typeof document !== "object" || Array.isArray(document)) process.exit(1);
if (document.issuer !== issuer) process.exit(1);
for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
  if (typeof document[field] !== "string") process.exit(1);
  let endpoint;
  try {
    endpoint = new URL(document[field]);
  } catch {
    process.exit(1);
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) process.exit(1);
}'
readonly app_readiness_probe='fetch("http://127.0.0.1:3000/api/health", { cache: "no-store", signal: AbortSignal.timeout(3000) })
  .then(async (response) => {
    let body;
    try { body = await response.json(); } catch { process.exit(1); }
    process.exit(response.status === 200 && body !== null && typeof body === "object" &&
      body.status === "ready" && body.service === "orbit" ? 0 : 1);
  })
  .catch(() => process.exit(1));'
readonly tika_readiness_probe='fetch("http://orbit-tika:9998/version", { cache: "no-store", signal: AbortSignal.timeout(3000) })
  .then((response) => process.exit(response.status === 200 ? 0 : 1))
  .catch(() => process.exit(1));'

plain_mode=0
simulate_mode=0
requested_action=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --plain)
      plain_mode=1
      shift
      ;;
    --simulate)
      simulate_mode=1
      shift
      ;;
    --install|--update|--repair)
      [[ -z "$requested_action" ]] || {
        printf 'Usage: %s [--plain] [--install|--update|--repair] | [--plain] --simulate\n' "$0" >&2
        exit 2
      }
      requested_action="${1#--}"
      shift
      ;;
    --)
      shift
      break
      ;;
    *)
      printf 'Usage: %s [--plain] [--install|--update|--repair] | [--plain] --simulate\n' "$0" >&2
      exit 2
      ;;
  esac
done
[[ $# -eq 0 ]] || {
  printf 'Usage: %s [--plain] [--install|--update|--repair] | [--plain] --simulate\n' "$0" >&2
  exit 2
}
if [[ "$simulate_mode" == 1 && -n "$requested_action" ]]; then
  printf 'Usage: %s [--plain] [--install|--update|--repair] | [--plain] --simulate\n' "$0" >&2
  printf 'Orbit installer: --simulate cannot be combined with --install, --update or --repair.\n' >&2
  exit 2
fi
if [[ "$plain_mode" == 1 ]]; then
  export ORBIT_INSTALLER_PLAIN=1
fi

# Simulation dispatches immediately after safe argument parsing and before
# any target, deployment-environment, Docker/curl/timeout, registry/image/
# OIDC, staging or transaction step. It only ever invokes the fixed sibling
# simulation script (never a fetched, caller-supplied or symlinked path),
# which in turn may only source the fixed sibling installer-ui.sh.
if [[ "$simulate_mode" == 1 ]]; then
  installer_script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd -P)" ||
    { printf 'Orbit installer: could not resolve the installer script directory for simulation.\n' >&2; exit 1; }
  simulation_script="$installer_script_dir/installer-simulation.sh"
  simulation_ui_script="$installer_script_dir/installer-ui.sh"
  [[ -f "$simulation_script" && ! -L "$simulation_script" ]] ||
    { printf 'Orbit installer: the simulation helper is missing or unsafe.\n' >&2; exit 1; }
  [[ -f "$simulation_ui_script" && ! -L "$simulation_ui_script" ]] ||
    { printf 'Orbit installer: the simulation UI helper is missing or unsafe.\n' >&2; exit 1; }
  simulate_args=()
  [[ "$plain_mode" == 1 ]] && simulate_args+=(--plain)
  exec bash "$simulation_script" "${simulate_args[@]}"
fi

readiness_timeout_seconds="${ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS:-180}"
readiness_poll_seconds="${ORBIT_INSTALLER_POLL_INTERVAL_SECONDS:-2}"
if [[ ! "$readiness_timeout_seconds" =~ ^[1-9][0-9]{0,2}$ ]] ||
  ((10#$readiness_timeout_seconds > 900)); then
  printf 'Orbit installer: ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS must be between 1 and 900.\n' >&2
  exit 2
fi
if [[ ! "$readiness_poll_seconds" =~ ^[1-9]$ ]]; then
  printf 'Orbit installer: ORBIT_INSTALLER_POLL_INTERVAL_SECONDS must be between 1 and 9.\n' >&2
  exit 2
fi
[[ "$channel" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || {
  printf 'Orbit installer: ORBIT_CHANNEL is invalid.\n' >&2
  exit 2
}
[[ "$repository" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$ ]] || {
  printf 'Orbit installer: ORBIT_REPOSITORY is invalid.\n' >&2
  exit 2
}
[[ "$registry" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?$ ]] || {
  printf 'Orbit installer: ORBIT_REGISTRY is invalid.\n' >&2
  exit 2
}

staging_dir=""
rollback_dir=""
file_transaction_active=0
file_transaction_committed=0
target_was_empty=0
database_volume_seen=0
database_volume_checked=0
compose_project_name=""
compose_project_name_explicit=0
database_volume_name=""
configuration_migration_completed=0
installer_ui_loaded=0
installer_ui_phase=host
installer_ui_component=host
installer_failure_reason=""
installer_failure_action=""
installer_action=""
selected_profile=""
selected_model=""
profile_change=0
model_pull_requested=0
model_pull_value=""
guided_configuration_staged=0
declare -a created_directories=()
declare -A managed_was_present=()
declare -a pending_ui_events=()

load_installer_ui() {
  local candidate

  [[ -n "$staging_dir" ]] || return 1
  candidate="$staging_dir/scripts/installer-ui.sh"
  is_regular_non_symlink_file "$candidate" || return 1
  # The caller has fetched this helper from the resolved image's immutable
  # revision and completed bash -n before it can be sourced. Never source an
  # existing deployment copy before those checks.
  # shellcheck source=/dev/null
  source "$candidate"
  declare -F installer_ui_init >/dev/null || return 1
  declare -F installer_ui_emit >/dev/null || return 1
  declare -F installer_ui_resume_clock >/dev/null || return 1
  if [[ "$plain_mode" == 1 ]]; then
    installer_ui_init --plain
  else
    installer_ui_init
  fi
  installer_ui_resume_clock "$installer_process_started_at" || return 1
  installer_ui_loaded=1
  local pending phase component state reason action elapsed
  for pending in "${pending_ui_events[@]}"; do
    IFS='|' read -r phase component state reason action elapsed <<< "$pending"
    installer_ui_emit "$phase" "$component" "$state" "$reason" "$action" "$elapsed"
  done
  pending_ui_events=()
}

installer_ui_event() {
  if [[ "$installer_ui_loaded" == 1 ]]; then
    installer_ui_emit "$@"
  else
    pending_ui_events+=("$1|$2|$3|$4|$5|$((SECONDS - installer_process_started_at))")
  fi
}

default_failure_reason() {
  case "${installer_ui_phase:-host}" in
    host) printf 'docker-host' ;;
    identity|assets|preparation) printf 'image-registry' ;;
    configuration|compose) printf 'configuration-failure' ;;
    oidc) printf 'provider-unavailable' ;;
    database) printf 'database-auth-migration' ;;
    application) printf 'health-timeout' ;;
    optional) printf 'optional-unavailable' ;;
    *) printf 'failure' ;;
  esac
}

default_failure_action() {
  case "${installer_ui_phase:-host}" in
    database|application|optional) printf 'repair' ;;
    *) printf 'retry' ;;
  esac
}

fail() {
  local reason action phase component elapsed
  reason="${installer_failure_reason:-$(default_failure_reason)}"
  action="${installer_failure_action:-$(default_failure_action)}"
  phase="${installer_ui_phase:-host}"
  component="${installer_ui_component:-host}"
  elapsed="$((SECONDS - installer_process_started_at))"
  if [[ "$installer_ui_loaded" == 1 ]]; then
    installer_ui_emit "$phase" "$component" failed "$reason" "$action" "$elapsed" || true
  else
    printf 'phase=%s component=%s state=failed reason=%s action=%s elapsed=%ss\n' \
      "$phase" "$component" "$reason" "$action" "$elapsed"
  fi
  printf 'Orbit installer: %s\n' "$*" >&2
  if [[ "$action" == repair ]]; then
    printf 'Orbit installer: next action is the bounded Repair path; no deletion or credential reset is recommended.\n' >&2
  fi
  exit 1
}

fail_with() {
  installer_failure_reason="$1"
  installer_failure_action="$2"
  shift 2
  fail "$@"
}

compose() {
  docker compose --project-name "$compose_project_name" --env-file "$environment_file" "$@"
}

is_regular_non_symlink_file() {
  [[ -f "$1" && ! -L "$1" ]]
}

is_real_non_symlink_directory() {
  [[ -d "$1" && ! -L "$1" ]]
}

target_is_empty() {
  local entries
  shopt -s nullglob dotglob
  entries=(*)
  shopt -u nullglob dotglob
  [[ ${#entries[@]} -eq 0 ]]
}

has_mode() {
  [[ "$(stat -c '%a' -- "$1" 2>/dev/null)" == "$2" ]]
}

is_preprovisioned_input() {
  local child
  local -a entries=() children=()

  is_regular_non_symlink_file "$environment_file" && has_mode "$environment_file" 600 || return 1
  is_real_non_symlink_directory "$secrets_directory" && has_mode "$secrets_directory" 700 || return 1

  shopt -s nullglob dotglob
  entries=(*)
  children=("$secrets_directory"/*)
  shopt -u nullglob dotglob
  [[ ${#entries[@]} -eq 2 ]] || return 1
  [[ -e "$environment_file" && -e "$secrets_directory" ]] || return 1

  for child in "${children[@]}"; do
    [[ -f "$child" && ! -L "$child" ]] || return 1
    [[ -s "$child" ]] || return 1
    has_mode "$child" 600 || return 1
  done

  is_regular_non_symlink_file "$secrets_directory/oidc-client-secret" || return 1
  [[ -s "$secrets_directory/oidc-client-secret" ]] || return 1
}

remove_target_path() {
  local path="$1"

  if [[ -L "$path" || -f "$path" ]]; then
    rm -f -- "$path"
  elif [[ -d "$path" ]]; then
    rm -rf -- "$path"
  elif [[ -e "$path" ]]; then
    rm -f -- "$path"
  fi
}

rollback_transaction() {
  local rollback_status=0
  local path backup_path parent index

  printf 'Orbit installer: restoring the previous file state.\n' >&2

  # Remove paths that did not exist before the transaction. Never operate on a
  # child through a parent symlink: configuration is untrusted input even
  # though it was fetched from the image's recorded source revision.
  for ((index = ${#managed_paths[@]} - 1; index >= 0; index--)); do
    path="${managed_paths[index]}"
    [[ "${managed_was_present[$path]:-0}" == 1 ]] && continue
    parent="$(dirname -- "$path")"
    if [[ "$parent" != "." && -L "$parent" ]]; then
      printf 'Orbit installer: rollback refused to follow symlinked parent %s.\n' "$parent" >&2
      rollback_status=1
      continue
    fi
    if ! remove_target_path "$path"; then
      printf 'Orbit installer: could not remove newly created %s during rollback.\n' "$path" >&2
      rollback_status=1
    fi
  done

  # Restore every backed-up path with a same-filesystem rename. The backup was
  # made with cp -a, so this restores content, permissions and directory
  # entries rather than reconstructing only the files the installer knows.
  for path in "${managed_paths[@]}"; do
    [[ "${managed_was_present[$path]:-0}" == 1 ]] || continue
    parent="$(dirname -- "$path")"
    if [[ "$parent" != "." ]] && ! is_real_non_symlink_directory "$parent"; then
      printf 'Orbit installer: rollback cannot restore %s because its parent is missing or unsafe.\n' "$path" >&2
      rollback_status=1
      continue
    fi
    backup_path="$rollback_dir/original/$path"
    if ! remove_target_path "$path"; then
      printf 'Orbit installer: could not clear %s before rollback.\n' "$path" >&2
      rollback_status=1
      continue
    fi
    if ! mv -- "$backup_path" "$path"; then
      printf 'Orbit installer: could not restore %s during rollback.\n' "$path" >&2
      rollback_status=1
    fi
  done

  # Only remove directories created by this invocation. Existing directories
  # are deliberately left alone, even if they are empty after restoration.
  for ((index = ${#created_directories[@]} - 1; index >= 0; index--)); do
    path="${created_directories[index]}"
    if [[ -L "$path" || -f "$path" ]]; then
      if ! rm -f -- "$path"; then
        printf 'Orbit installer: could not remove created directory path %s during rollback.\n' "$path" >&2
        rollback_status=1
      fi
    elif [[ -d "$path" ]]; then
      if ! rmdir -- "$path"; then
        printf 'Orbit installer: could not remove created directory %s during rollback.\n' "$path" >&2
        rollback_status=1
      fi
    elif [[ -e "$path" ]]; then
      printf 'Orbit installer: created directory path %s became an unsupported file type during rollback.\n' "$path" >&2
      rollback_status=1
    fi
  done

  return "$rollback_status"
}

cleanup() {
  local exit_status=$?

  if [[ "$file_transaction_active" == 1 && "$file_transaction_committed" == 0 ]]; then
    if rollback_transaction; then
      file_transaction_active=0
    else
      printf 'Orbit installer: rollback incomplete; recovery staging preserved at %s.\n' "$staging_dir" >&2
      exit 1
    fi
  fi

  if [[ -n "$staging_dir" ]] && ! rm -rf -- "$staging_dir"; then
    printf 'Orbit installer: could not remove staging; recovery files remain at %s.\n' "$staging_dir" >&2
    exit_status=1
  fi

  exit "$exit_status"
}

trap cleanup EXIT

# A non-empty target must already be a recognizable Orbit deployment, never an
# arbitrary directory: the installer must not overwrite unrelated user files,
# and a symlinked marker could redirect the install at attacker-controlled
# paths. This runs before any pull or download.
validate_target() {
  if target_is_empty; then
    target_was_empty=1
    return
  fi
  if is_regular_non_symlink_file "$environment_file" &&
    is_regular_non_symlink_file "$compose_file" &&
    is_real_non_symlink_directory "$secrets_directory"; then
    return
  fi
  if is_preprovisioned_input; then
    target_was_empty=1
    return
  fi
  # A leftover `.orbit-install-staging.*` directory here means an earlier
  # install attempt was interrupted hard enough (SIGKILL, OOM, power loss)
  # that the EXIT trap's own `rm -rf -- "$staging_dir"` never ran — an
  # ordinary Ctrl-C/SIGTERM already cleans this up via `cleanup` above.
  # Left in place, it makes an otherwise-empty target fail every one of the
  # checks above (issue #383, install.sh:270 finding). Name it explicitly
  # here instead of folding it into the generic refusal below, so the
  # operator is not left doing filesystem archaeology to find what is
  # blocking a retry; deliberately never auto-removed by this script, since
  # only a human can confirm no other install is concurrently in progress.
  local -a leftover_staging=()
  shopt -s nullglob dotglob
  leftover_staging=(.orbit-install-staging.*)
  shopt -u nullglob dotglob
  if [[ ${#leftover_staging[@]} -gt 0 ]]; then
    fail "A previous install attempt was interrupted and left ${leftover_staging[*]} behind in this directory. Review its contents, then remove it (safe once you have confirmed no install is still in progress) and retry."
  fi
  fail "The installation directory is not empty and is not a recognizable Orbit deployment or safe pre-provisioned bootstrap. Refusing to install here."
}

derive_compose_project_name() {
  local requested_name="" configured_name=""
  if is_regular_non_symlink_file "$environment_file" &&
    configured_name="$(read_environment_value COMPOSE_PROJECT_NAME 2>/dev/null)"; then
    [[ "$configured_name" =~ ^[a-z0-9][a-z0-9_-]*$ ]] ||
      fail "Could not verify the configured Docker Compose project name; refusing to start Compose."
    compose_project_name="$configured_name"
    compose_project_name_explicit=1
  fi

  if [[ -n "${COMPOSE_PROJECT_NAME:-}" ]]; then
    requested_name="$COMPOSE_PROJECT_NAME"
    [[ "$requested_name" =~ ^[a-z0-9][a-z0-9_-]*$ ]] ||
      fail "Could not determine a safe Docker Compose project name; refusing to start Compose."
    if [[ "$compose_project_name_explicit" == 1 && "$compose_project_name" != "$requested_name" ]]; then
      fail "The configured Docker Compose project name does not match the requested project; refusing to start Compose."
    fi
    compose_project_name="$requested_name"
    compose_project_name_explicit=1
  elif [[ "$compose_project_name_explicit" == 1 ]]; then
    return
  else
    requested_name="$(basename -- "$(pwd -P)")" ||
      fail "Could not determine a safe Docker Compose project name; refusing to start Compose."
    requested_name="$(printf '%s' "$requested_name" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-')" ||
      fail "Could not determine a safe Docker Compose project name; refusing to start Compose."
    while [[ "$requested_name" == [-_]* ]]; do requested_name="${requested_name:1}"; done
    [[ -n "$requested_name" && "$requested_name" =~ ^[a-z0-9][a-z0-9_-]*$ ]] ||
      fail "Could not determine a safe Docker Compose project name; refusing to start Compose."
    compose_project_name="$requested_name"
  fi
}

volume_belongs_to_deployment() {
  local candidate_volume="$1" expected_image="$2"
  local volume_labels="" volume_project="" volume_key="" extra=""
  local db_containers="" app_containers=""
  local db_id="" db_project="" db_service="" app_id="" app_project="" app_service="" app_image=""
  local discovered_project=""
  local db_count=0 app_count=0

  # Docker's Go-template formatter does not guarantee shell-style escape
  # interpretation. Use a literal delimiter and reject any extra field.
  if ! volume_labels="$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.volume"}}' "$candidate_volume" 2>/dev/null)"; then
    return 2
  fi
  [[ ${#volume_labels} -le 256 ]] || return 2
  [[ "$volume_labels" != *$'\n'* ]] || return 2
  IFS='|' read -r volume_project volume_key extra <<< "$volume_labels"
  [[ -n "$volume_project" && "$volume_project" =~ ^[a-z0-9][a-z0-9_-]*$ &&
    "$volume_key" == "$database_volume_key" &&
    "$candidate_volume" == "${volume_project}_${database_volume_key}" && -z "$extra" ]] || return 2

  if ! db_containers="$(docker ps -a --filter "volume=$candidate_volume" \
    --format '{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}' 2>/dev/null)"; then
    return 2
  fi
  [[ ${#db_containers} -le 65536 ]] || return 2
  while IFS='|' read -r db_id db_project db_service extra ||
    [[ -n "$db_id" || -n "$db_project" || -n "$db_service" || -n "$extra" ]]; do
    [[ -z "$db_id" && -z "$db_project" && -z "$db_service" && -z "$extra" ]] && continue
    [[ "$db_id" =~ ^[0-9a-f]{12,64}$ && "$db_project" == "$volume_project" && -z "$extra" ]] ||
      return 2
    [[ "$db_service" == "orbit-db" ]] || return 1
    db_count=$((db_count + 1))
  done <<< "$db_containers"
  [[ "$db_count" == 1 ]] || return 1

  if ! app_containers="$(docker ps -a --filter "label=com.docker.compose.project=$volume_project" \
    --format '{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}' 2>/dev/null)"; then
    return 2
  fi
  [[ ${#app_containers} -le 65536 ]] || return 2
  while IFS='|' read -r app_id app_project app_service extra ||
    [[ -n "$app_id" || -n "$app_project" || -n "$app_service" || -n "$extra" ]]; do
    [[ -z "$app_id" && -z "$app_project" && -z "$app_service" && -z "$extra" ]] && continue
    [[ "$app_id" =~ ^[0-9a-f]{12,64}$ && "$app_project" == "$volume_project" && -z "$extra" ]] ||
      return 2
    [[ "$app_service" == "orbit-app" ]] || continue
    app_count=$((app_count + 1))
    [[ "$app_count" == 1 ]] || return 1
    if ! app_image="$(docker inspect --format '{{.Config.Image}}' "$app_id" 2>/dev/null)"; then
      return 2
    fi
    [[ ${#app_image} -le 4096 ]] || return 2
    [[ "$app_image" =~ ^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$ ]] || return 2
    [[ "$app_image" == "$expected_image" ]] || return 1
  done <<< "$app_containers"
  [[ "$app_count" == 1 ]] || return 1
}

verify_database_volume_safety() {
  local volume_list="" volume="" old_image="" status=0
  local -a candidates=()

  if [[ "$database_volume_checked" == 1 ]]; then
    [[ "$database_volume_seen" == 1 ]] || return 0
    volume_list="$(docker volume ls --filter "name=^$database_volume_name\$" --format '{{.Name}}' 2>/dev/null)" ||
      fail "Could not verify the existing Orbit database volume; refusing to start Compose."
    [[ "$volume_list" == "$database_volume_name" && "$volume_list" != *$'\n'* ]] ||
      fail "The existing Orbit database volume changed during installation; refusing to start Compose."
    return 0
  fi

  derive_compose_project_name
  volume_list="$(docker volume ls --filter "name=$database_volume_key" --format '{{.Name}}' 2>/dev/null)" ||
    fail "Could not verify the existing Orbit database volume; refusing to start Compose."
  [[ ${#volume_list} -le 1048576 ]] ||
    fail "Could not verify the existing Orbit database volume; refusing to start Compose."
  while IFS= read -r volume || [[ -n "$volume" ]]; do
    [[ -z "$volume" ]] && continue
    [[ "$volume" == *"$database_volume_key" ]] || continue
    [[ "$volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ && "$volume" =~ (^|_)orbit-db-data$ ]] ||
      fail "Could not verify the existing Orbit database volume; refusing to start Compose."
    candidates+=("$volume")
  done <<< "$volume_list"

  if [[ "${#candidates[@]}" == 0 ]]; then
    database_volume_checked=1
    return 0
  fi
  if [[ "$target_was_empty" == 1 ]]; then
    fail "An existing Orbit database volume requires a recognized deployment with its preserved database credentials; refusing to start Compose."
  fi
  [[ "${#candidates[@]}" == 1 ]] ||
    fail "Multiple Orbit database volumes were found; refusing to start Compose until exactly one recognized deployment can be proven."
  old_image="$(read_environment_value ORBIT_IMAGE 2>/dev/null)" ||
    fail "Could not verify the existing Orbit database volume ownership; refusing to start Compose."
  [[ "$old_image" =~ ^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$ ]] ||
    fail "Could not verify the existing Orbit database volume ownership; refusing to start Compose."

  if volume_belongs_to_deployment "${candidates[0]}" "$old_image"; then
    database_volume_name="${candidates[0]}"
    database_volume_seen=1
    discovered_project="$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' \
      "$database_volume_name" 2>/dev/null)" ||
      fail "Could not verify the existing Orbit database volume ownership; refusing to start Compose."
    [[ "$discovered_project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] ||
      fail "Could not verify the existing Orbit database volume ownership; refusing to start Compose."
    if [[ "$compose_project_name_explicit" == 1 && "$compose_project_name" != "$discovered_project" ]]; then
      fail "The configured Docker Compose project does not match the recognized database volume; refusing to start Compose."
    fi
    compose_project_name="$discovered_project"
    if ! is_regular_non_symlink_file "$secrets_directory/postgres-password" ||
      ! has_mode "$secrets_directory/postgres-password" 600; then
      fail "An existing Orbit database volume requires the preserved POSTGRES_PASSWORD_FILE; refusing to start Compose."
    fi
  else
    status=$?
    case "$status" in
      1) fail "Could not prove that the existing Orbit database volume belongs to this Orbit deployment; refusing to start Compose." ;;
      *) fail "Could not verify the existing Orbit database volume ownership; refusing to start Compose." ;;
    esac
  fi
  database_volume_checked=1
}

verify_database_password_preserved() {
  local previous_password="$rollback_dir/original/$secrets_directory/postgres-password"
  [[ "$database_volume_seen" == 1 ]] || return 0
  if ! cmp -s "$previous_password" "$secrets_directory/postgres-password" ||
    ! has_mode "$secrets_directory/postgres-password" 600; then
    fail "The existing POSTGRES_PASSWORD_FILE changed during configuration; refusing to start Compose."
  fi
}

has_controlling_terminal() {
  local terminal_fd=""
  if ! { exec {terminal_fd}<>/dev/tty; } 2>/dev/null; then
    return 1
  fi
  exec {terminal_fd}>&-
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

is_valid_local_model() {
  local value="$1"
  [[ ${#value} -ge 1 && ${#value} -le 128 ]] || return 1
  [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9][A-Za-z0-9._-]*)?$ ]]
}

check_local_ai_capacity() {
  local cpu_count="" memory_kib="" available_kib=""
  cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)"
  memory_kib="$(awk '/^MemTotal:/ { print $2; exit }' /proc/meminfo 2>/dev/null || true)"
  available_kib="$(df -Pk . 2>/dev/null | awk 'NR == 2 { print $4; exit }')"
  [[ "$cpu_count" =~ ^[0-9]+$ && "$memory_kib" =~ ^[0-9]+$ && "$available_kib" =~ ^[0-9]+$ ]] || return 2
  ((10#$cpu_count >= 2 && 10#$memory_kib >= 6291456 && 10#$available_kib > 0))
}

current_deployment_profile() {
  local profiles="" tika_url="" model=""
  [[ -f "$environment_file" ]] || {
    printf 'standard'
    return 0
  }
  profiles="$(read_environment_value COMPOSE_PROFILES 2>/dev/null || true)"
  tika_url="$(read_environment_value TIKA_URL 2>/dev/null || true)"
  model="$(read_environment_value OLLAMA_MODEL 2>/dev/null || true)"
  case "$profiles" in
    "")
      [[ -z "$tika_url" && -z "$model" ]] || return 1
      printf 'standard'
      ;;
    processing)
      [[ "$tika_url" == "http://orbit-tika:9998" && -z "$model" ]] || return 1
      printf 'processing'
      ;;
    ai)
      [[ -z "$tika_url" ]] && is_valid_local_model "$model" || return 1
      printf 'ai'
      ;;
    processing,ai)
      [[ "$tika_url" == "http://orbit-tika:9998" ]] && is_valid_local_model "$model" || return 1
      printf 'full'
      ;;
    *) return 1 ;;
  esac
}

show_update_identity() {
  local terminal_fd="$1" existing_profile="$2"
  local current_schema="legacy/unknown" current_version="legacy/unknown" current_digest="legacy/unknown" value=""

  value="$(read_environment_value ORBIT_CONFIG_SCHEMA_VERSION 2>/dev/null || true)"
  [[ "$value" == 1 ]] && current_schema="v1"
  value="$(read_environment_value ORBIT_CONFIG_APPLIED_VERSION 2>/dev/null || true)"
  [[ "$value" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] && current_version="$value"
  value="$(read_environment_value ORBIT_CONFIG_APPLIED_DIGEST 2>/dev/null || true)"
  if [[ "$value" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    current_digest="$value"
  else
    value="$(read_environment_value ORBIT_IMAGE 2>/dev/null || true)"
    [[ "$value" =~ @((sha256:)[0-9a-f]{64})$ ]] && current_digest="${BASH_REMATCH[1]}"
  fi

  printf '\nCurrent: schema=%s version=%s digest=%s optional-profile=%s\n' \
    "$current_schema" "$current_version" "$current_digest" "$existing_profile" >&"$terminal_fd"
  printf 'Target: schema=v1 version=%s digest=%s channel=%s\n\n' \
    "$image_version" "$applied_digest" "$channel" >&"$terminal_fd"
}

choose_deployment_profile() {
  local terminal_fd="$1" existing_profile="$2" choice status=0

  if [[ "$installer_action" == update ]]; then
    show_update_identity "$terminal_fd" "$existing_profile"
    printf '\nCurrent optional-service configuration is valid. Preserve it unless you deliberately choose to change it.\n\n' >&"$terminal_fd"
    choice="$(installer_ui_select "$terminal_fd" \
      'Optional services' preserve \
      preserve 'Preserve current profile (recommended)' \
      change 'Choose a different supported profile' \
      back 'Back')" || status=$?
    [[ "$status" == 0 ]] || return "$status"
    case "$choice" in
      preserve)
        selected_profile="$existing_profile"
        profile_change=0
        choice="$(installer_ui_select "$terminal_fd" \
          "Review: preserve the current ${existing_profile} profile and OIDC configuration." apply \
          apply 'Continue without changing optional-service choices' \
          cancel 'Cancel without changing files or services')" || status=$?
        [[ "$status" == 0 ]] || return "$status"
        [[ "$choice" == apply ]] || return 130
        return 0
        ;;
      back) return 130 ;;
    esac
  fi

  printf '\nProfiles keep data inside the private Compose network. Resource classes are fixed relative labels: standard, medium, and high; they are not hardware guarantees.\n' >&"$terminal_fd"
  printf 'Required Orbit core and private scanning stay enabled; document processing and local AI are optional services.\n' >&"$terminal_fd"
  printf 'OIDC is the only supported authentication path today; these choices do not add local-only sign-in.\n' >&"$terminal_fd"
  printf 'Ollama is optional local infrastructure and is not yet consumed by Orbit product workflows.\n\n' >&"$terminal_fd"
  choice="$(installer_ui_select "$terminal_fd" \
    'Choose a deployment profile' standard \
    standard 'Standard Orbit - required core and private scanning; standard relative resources' \
    processing 'Document processing - optional local Tika; medium relative resources' \
    full 'Full local stack - optional Tika and local Ollama; high relative resources' \
    custom 'Custom - choose one fixed supported optional-service combination' \
    back 'Back')" || status=$?
  [[ "$status" == 0 ]] || return "$status"
  [[ "$choice" != back ]] || return 130

  if [[ "$choice" == custom ]]; then
    choice="$(installer_ui_select "$terminal_fd" \
      'Custom optional services' standard \
      standard 'No optional service' \
      processing 'Document processing only' \
      ai 'Local Ollama infrastructure only' \
      full 'Document processing and local Ollama infrastructure' \
      back 'Back')" || status=$?
    [[ "$status" == 0 ]] || return "$status"
    [[ "$choice" != back ]] || return 130
  fi

  selected_profile="$choice"
  selected_model=""
  if [[ "$selected_profile" == ai || "$selected_profile" == full ]]; then
    printf '\nA model choice is saved now. Model preparation will require a separate confirmation before any large download.\n' >&"$terminal_fd"
    selected_model="$(installer_ui_read_text "$terminal_fd" 'Bounded local model identifier: ' 128)" || return $?
    is_valid_local_model "$selected_model" || return 2
    status=0
    if check_local_ai_capacity; then
      printf 'Host capacity check: the configured local-service CPU and memory envelope is available; model storage remains model-dependent.\n\n' >&"$terminal_fd"
    else
      status=$?
      if [[ "$status" == 1 ]]; then
        printf 'Host capacity check: this host is below the configured local-service CPU or memory envelope; model preparation may fail.\n\n' >&"$terminal_fd"
      else
        printf 'Host capacity check: CPU, memory or available storage could not be verified; model preparation remains operator-controlled.\n\n' >&"$terminal_fd"
      fi
    fi
    status=0
    choice="$(installer_ui_select "$terminal_fd" \
      'Prepare the selected local model after Ollama becomes healthy? This can be a large download.' skip \
      skip 'Save the model choice without downloading it now' \
      pull 'Confirm the separate model download step' \
      cancel 'Cancel without changing files or services')" || status=$?
    [[ "$status" == 0 ]] || return "$status"
    [[ "$choice" != cancel ]] || return 130
    if [[ "$choice" == pull ]]; then
      model_pull_requested=1
      model_pull_value="$selected_model"
    fi
  fi

  choice="$(installer_ui_select "$terminal_fd" \
    'Review: OIDC remains required; discovery does not prove client authentication or a completed sign-in.' apply \
    apply "Continue with the selected ${selected_profile} profile" \
    cancel 'Cancel without changing files or services')" || status=$?
  [[ "$status" == 0 ]] || return "$status"
  [[ "$choice" == apply ]] || return 130
  profile_change=1
}

resolve_installer_action() {
  local terminal_fd="" choice status=0 default_action existing_profile

  default_action=install
  [[ "$target_was_empty" == 1 ]] || default_action=update
  installer_action="${requested_action:-$default_action}"

  if [[ -z "$requested_action" && "$plain_mode" == 0 ]] && has_controlling_terminal; then
    exec {terminal_fd}<>/dev/tty
    choice="$(installer_ui_select "$terminal_fd" \
      'Greetings, what can we do for you today?' "$default_action" \
      install Install \
      update Update \
      repair Repair \
      exit Exit)" || status=$?
    if [[ "$status" != 0 ]]; then
      exec {terminal_fd}>&-
      return "$status"
    fi
    installer_action="$choice"
  fi

  case "$installer_action" in
    install)
      [[ "$target_was_empty" == 1 ]] || {
        [[ -z "$terminal_fd" ]] || exec {terminal_fd}>&-
        fail "Install requires an empty target or safe pre-provisioned bootstrap; use Update for a recognized deployment."
      }
      ;;
    update)
      [[ "$target_was_empty" == 0 ]] || {
        [[ -z "$terminal_fd" ]] || exec {terminal_fd}>&-
        fail "Update requires a recognized existing Orbit deployment."
      }
      ;;
    repair)
      # Signposts repair; never dispatches into it. The two scripts' exit-code
      # vocabularies collide — install's 3 is "blocked", repair's 3 is
      # "attention" (docs/engine-events.md, "Repair stream") — so a caller that
      # received one script's code through the other would misread the outcome
      # precisely when it matters. The operator runs repair themselves (#533).
      # The reason enum stays `repair-unavailable`: it is an allowlisted value
      # in installer-ui.sh and part of the interface consumers pin to, so
      # renaming it belongs in its own documented change, not here. What
      # changes is the prose, which was a dead end — it named an issue number
      # rather than the command that does the job.
      installer_ui_emit rollback installer blocked repair-unavailable repair || true
      printf 'Orbit installer: repair_unavailable; this installer does not perform repair. Run "bash scripts/repair.sh --check" from this directory to diagnose, then "--plan" to see what it would do. No deployment files or services were changed.\n' >&2
      [[ -z "$terminal_fd" ]] || exec {terminal_fd}>&-
      return 3
      ;;
    exit)
      [[ -z "$terminal_fd" ]] || exec {terminal_fd}>&-
      return 130
      ;;
    *) return 2 ;;
  esac

  existing_profile="$(current_deployment_profile)" || {
    [[ -z "$terminal_fd" ]] || exec {terminal_fd}>&-
    fail "The existing optional-service configuration is unsupported or ambiguous."
  }
  if [[ -n "$terminal_fd" ]]; then
    choose_deployment_profile "$terminal_fd" "$existing_profile" || status=$?
    exec {terminal_fd}>&-
    return "$status"
  fi

  selected_profile="$existing_profile"
  if [[ "$installer_action" == install ]]; then
    selected_profile=standard
    profile_change=1
  fi
}

missing_required_fields() {
  local readiness="$1" field missing=""
  local -a required_fields=(APP_URL ORBIT_IMAGE OIDC_ISSUER OIDC_CLIENT_ID OIDC_CLIENT_SECRET OIDC_CALLBACK_URL)
  for field in "${required_fields[@]}"; do
    if grep -q "^missing ${field}$" <<< "$readiness"; then
      [[ -z "$missing" ]] || missing+=" "
      missing+="$field"
    fi
  done
  printf '%s' "$missing"
}

missing_guided_fields() {
  local readiness="$1" field missing=""
  local -a guided_fields=(APP_URL OIDC_ISSUER OIDC_CLIENT_ID OIDC_CALLBACK_URL)
  for field in "${guided_fields[@]}"; do
    if grep -q "^missing ${field}$" <<< "$readiness"; then
      [[ -z "$missing" ]] || missing+=" "
      missing+="$field"
    fi
  done
  printf '%s' "$missing"
}

missing_configuration_fields() {
  local readiness="$1" field missing=""
  local -a fields=(APP_URL ORBIT_IMAGE OIDC_ISSUER OIDC_CLIENT_ID OIDC_CLIENT_SECRET OIDC_CALLBACK_URL processing ai mail imap push)
  for field in "${fields[@]}"; do
    if grep -q "^missing ${field}$" <<< "$readiness"; then
      [[ -z "$missing" ]] || missing+=" "
      missing+="$field"
    fi
  done
  printf '%s' "$missing"
}

print_noninteractive_configuration_guidance() {
  local missing="$1"
  printf 'Orbit installer: configuration fields requiring attention: %s.\n' "$missing" >&2
  printf 'Orbit installer: non-interactive use requires a complete .env-orbit and an existing owner-only .orbit-secrets/oidc-client-secret file.\n' >&2
  printf 'Orbit installer: safe next command in a controlling terminal: curl -fsSL https://raw.githubusercontent.com/tomlawesome/orbit/main/scripts/install.sh | bash\n' >&2
  printf 'Orbit installer: configure with --init, provide the secret with --set-oidc-secret, then verify with --check before rerunning automation.\n' >&2
}

verify_oidc_discovery() {
  local issuer discovery_url response_status curl_status discovery_size
  local discovery_file="$staging_dir/oidc-discovery.json"

  issuer="$(read_environment_value OIDC_ISSUER)" ||
    fail_with configuration-failure retry "OIDC_ISSUER requires attention; run the guided configuration and rerun the installer."
  if [[ "$issuer" == */ ]]; then
    discovery_url="${issuer}.well-known/openid-configuration"
  else
    discovery_url="${issuer}/.well-known/openid-configuration"
  fi

  curl_status=0
  response_status="$(curl --silent --show-error --location --connect-timeout 5 --max-time 10 \
    --max-filesize "$oidc_discovery_max_bytes" \
    --header 'Accept: application/json' \
    --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --output "$discovery_file" --write-out '%{http_code}' "$discovery_url" 2>/dev/null)" ||
    curl_status=$?
  if [[ "$curl_status" -ne 0 ]]; then
    if [[ "$curl_status" == 3 || "$curl_status" == 63 ]]; then
      fail_with configuration-failure retry "OIDC provider configuration could not be validated; review the OIDC discovery response."
    fi
    fail_with provider-unavailable retry "OIDC provider is unavailable; retry without changing the configuration."
  fi

  case "$response_status" in
    2[0-9][0-9]) ;;
    000) fail_with provider-unavailable retry "OIDC provider is unavailable; retry without changing the configuration." ;;
    *) fail_with configuration-failure retry "OIDC provider configuration could not be validated; review the OIDC discovery response." ;;
  esac

  is_regular_non_symlink_file "$discovery_file" ||
    fail_with configuration-failure retry "OIDC provider configuration could not be validated; review the OIDC discovery response."
  chmod 600 "$discovery_file" 2>/dev/null ||
    fail_with configuration-failure retry "OIDC provider configuration could not be validated; review the OIDC discovery response."
  discovery_size="$(stat -c '%s' -- "$discovery_file" 2>/dev/null)"
  [[ "$discovery_size" =~ ^[0-9]+$ && "$discovery_size" -le "$oidc_discovery_max_bytes" ]] ||
    fail_with configuration-failure retry "OIDC provider configuration could not be validated; review the OIDC discovery response."

  if ! {
    printf '%s\n' "$issuer"
    cat -- "$discovery_file"
  } | docker run --rm \
    --interactive \
    --entrypoint node \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --user 1001:1001 \
    --pids-limit 64 \
    --memory 64m \
    --cpus 0.5 \
    "$resolved_reference" \
    --input-type=commonjs -e "$oidc_discovery_parser" >/dev/null 2>&1; then
    fail_with configuration-failure retry "OIDC provider configuration could not be validated; review the OIDC discovery response."
  fi
}

prepare_configuration() {
  local readiness readiness_status missing guided_missing

  installer_ui_phase=configuration
  installer_ui_component=configuration
  installer_ui_event configuration configuration starting configuration-migration configure
  if ! ORBIT_IMAGE="$resolved_reference" bash scripts/configure.sh; then
    fail "Configuration failed; restoring the previous deployment."
  fi
  is_regular_non_symlink_file "$environment_file" ||
    fail "Configuration did not leave a regular, non-symlink ${environment_file}."
  is_real_non_symlink_directory "$secrets_directory" ||
    fail "Configuration did not leave a real, non-symlink ${secrets_directory} directory."
  if [[ "$profile_change" == 1 ]]; then
    if [[ "$selected_profile" == ai || "$selected_profile" == full ]]; then
      ORBIT_IMAGE="$resolved_reference" bash scripts/configure.sh \
        --set-deployment-profile "$selected_profile" "$selected_model" ||
        fail "Deployment profile configuration failed; restoring the previous deployment."
    else
      ORBIT_IMAGE="$resolved_reference" bash scripts/configure.sh \
        --set-deployment-profile "$selected_profile" ||
        fail "Deployment profile configuration failed; restoring the previous deployment."
    fi
    unset selected_model
  fi
  is_regular_non_symlink_file "$environment_file" ||
    fail "Configuration did not leave a regular, non-symlink ${environment_file}."
  is_real_non_symlink_directory "$secrets_directory" ||
    fail "Configuration did not leave a real, non-symlink ${secrets_directory} directory."

  readiness_status=0
  readiness="$(bash scripts/configure.sh --check 2>/dev/null)" || readiness_status=$?
  if [[ "$readiness_status" -ne 0 ]]; then
    missing="$(missing_required_fields "$readiness")"
    if [[ -n "$missing" ]] && has_controlling_terminal; then
      guided_missing="$(missing_guided_fields "$readiness")"
      if [[ -n "$guided_missing" ]]; then
        bash scripts/configure.sh --init ||
          fail "Guided configuration was cancelled or invalid; restoring the previous deployment."
      fi

      readiness="$(bash scripts/configure.sh --check 2>/dev/null)" || true
      if grep -q '^missing OIDC_CLIENT_SECRET$' <<< "$readiness"; then
        ORBIT_CONFIGURE_TTY_INPUT=1 bash scripts/configure.sh --set-oidc-secret ||
          fail "OIDC client secret collection was cancelled or invalid; restoring the previous deployment."
      fi
    elif [[ -n "$missing" ]]; then
      print_noninteractive_configuration_guidance "$missing"
      fail "Required configuration fields require attention; refusing to start Compose."
    fi
  fi

  readiness_status=0
  readiness="$(bash scripts/configure.sh --check 2>/dev/null)" || readiness_status=$?
  if [[ "$readiness_status" -ne 0 ]]; then
    missing="$(missing_configuration_fields "$readiness")"
    [[ -n "$missing" ]] || missing="APP_URL ORBIT_IMAGE OIDC_ISSUER OIDC_CLIENT_ID OIDC_CLIENT_SECRET OIDC_CALLBACK_URL"
    fail "Configuration fields require attention (${missing}); refusing to start Compose."
  fi

  installer_ui_event configuration configuration running configuration-migration verify
}

run_configuration_migration() {
  local configuration_script="$1" migration_output="" migration_status=0

  migration_output="$(bash "$configuration_script" \
    --migrate --transaction --file "$environment_file" \
    --orbit-image "$resolved_reference" \
    --applied-version "$image_version" \
    --compose-project-name "$compose_project_name" \
    --applied-digest "$applied_digest" 2>/dev/null)" || migration_status=$?
  [[ "$migration_status" == 0 ]] ||
    fail "Configuration migration failed; restoring the previous deployment."
  case "$migration_output" in
    "Orbit configuration: already current schema v1 version "*|"Orbit configuration: migrated from schema "*)
      printf '%s\n' "$migration_output"
      ;;
    *)
      fail "Configuration migration returned an unexpected result; restoring the previous deployment."
      ;;
  esac
}

stage_guided_install_configuration() {
  local terminal_fd="" choice="" status=0 readiness=""
  [[ "$installer_action" == install && "$plain_mode" == 0 ]] || return 0
  [[ ! -e "$environment_file" && ! -L "$environment_file" &&
    ! -e "$secrets_directory" && ! -L "$secrets_directory" ]] || return 0
  has_controlling_terminal || return 0

  installer_ui_phase=configuration
  installer_ui_component=configuration
  installer_ui_event configuration configuration starting configuration-migration configure
  ORBIT_IMAGE="$resolved_reference" bash "$staging_dir/scripts/configure.sh" --init ||
    fail_with configuration-failure retry "Guided configuration was cancelled or invalid; the target remains unchanged."
  ORBIT_IMAGE="$resolved_reference" bash "$staging_dir/scripts/configure.sh" ||
    fail_with configuration-failure retry "Secret generation failed; the target remains unchanged."
  ORBIT_CONFIGURE_TTY_INPUT=1 bash "$staging_dir/scripts/configure.sh" --set-oidc-secret ||
    fail_with configuration-failure retry "OIDC client secret collection was cancelled or invalid; the target remains unchanged."

  if [[ "$profile_change" == 1 ]]; then
    if [[ "$selected_profile" == ai || "$selected_profile" == full ]]; then
      ORBIT_IMAGE="$resolved_reference" bash "$staging_dir/scripts/configure.sh" \
        --set-deployment-profile "$selected_profile" "$selected_model" ||
        fail_with configuration-failure retry "Deployment profile configuration failed; the target remains unchanged."
    else
      ORBIT_IMAGE="$resolved_reference" bash "$staging_dir/scripts/configure.sh" \
        --set-deployment-profile "$selected_profile" ||
        fail_with configuration-failure retry "Deployment profile configuration failed; the target remains unchanged."
    fi
  fi
  readiness="$(bash "$staging_dir/scripts/configure.sh" --check 2>/dev/null)" ||
    fail_with configuration-failure retry "Guided configuration is incomplete; the target remains unchanged."
  [[ -n "$readiness" ]] ||
    fail_with configuration-failure retry "Guided configuration did not return a readiness summary; the target remains unchanged."

  exec {terminal_fd}<>/dev/tty
  choice="$(installer_ui_select "$terminal_fd" \
    "Final review: apply the collected core settings and selected ${selected_profile} profile." apply \
    apply 'Install the reviewed configuration' \
    cancel 'Cancel without changing files or services')" || status=$?
  exec {terminal_fd}>&-
  [[ "$status" == 0 ]] || return "$status"
  [[ "$choice" == apply ]] || return 130

  guided_configuration_staged=1
  profile_change=0
  unset selected_model
  installer_ui_event configuration configuration running configuration-migration verify
}

bounded_compose_probe() {
  timeout --signal=TERM --kill-after=1s 5s \
    docker compose --project-name "$compose_project_name" --env-file "$environment_file" "$@"
}

probe_database_health() {
  # These variables expand inside the database container, not in the installer.
  # shellcheck disable=SC2016
  bounded_compose_probe exec -T orbit-db sh -ec \
    'exec pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1
}

probe_application_health() {
  bounded_compose_probe exec -T orbit-app node -e "$app_readiness_probe" >/dev/null 2>&1
}

probe_clamav_health() {
  bounded_compose_probe exec -T orbit-clamav clamdscan --ping 1 >/dev/null 2>&1
}

probe_tika_health() {
  bounded_compose_probe exec -T orbit-app node -e "$tika_readiness_probe" >/dev/null 2>&1
}

probe_ollama_health() {
  bounded_compose_probe exec -T orbit-ollama ollama list >/dev/null 2>&1
}

wait_for_component_health() {
  local phase="$1" component="$2" reason="$3" probe="$4"
  local deadline=$((SECONDS + 10#$readiness_timeout_seconds)) remaining pause
  while true; do
    if "$probe"; then
      installer_ui_event "$phase" "$component" healthy "$reason" health
      return 0
    fi
    installer_ui_event "$phase" "$component" waiting "$reason" wait
    remaining=$((deadline - SECONDS))
    ((remaining > 0)) || return 1
    pause=$((10#$readiness_poll_seconds))
    ((pause <= remaining)) || pause="$remaining"
    sleep "$pause"
    ((SECONDS < deadline)) || return 1
  done
}

prepare_service_images() {
  installer_ui_phase=preparation
  installer_ui_component=database
  installer_ui_event preparation database starting service-preparation pull
  compose pull orbit-db >/dev/null 2>&1 ||
    fail_with image-registry retry "Could not prepare the Orbit database image."
  installer_ui_event preparation database completed service-preparation pull

  installer_ui_component=application
  installer_ui_event preparation application completed service-preparation pull

  installer_ui_component=clamav
  installer_ui_event preparation clamav starting service-preparation pull
  compose pull orbit-clamav >/dev/null 2>&1 ||
    fail_with image-registry retry "Could not prepare the private scanner image."
  installer_ui_event preparation clamav completed service-preparation pull

  case "$selected_profile" in
    processing|full)
      installer_ui_component=tika
      installer_ui_event preparation tika starting service-preparation pull
      compose pull orbit-tika >/dev/null 2>&1 ||
        fail_with image-registry retry "Could not prepare the optional document-processing image."
      installer_ui_event preparation tika completed service-preparation pull
      ;;
    *) installer_ui_event preparation tika skipped service-preparation skip ;;
  esac
  case "$selected_profile" in
    ai|full)
      installer_ui_component=ollama
      installer_ui_event preparation ollama starting service-preparation pull
      compose pull orbit-ollama >/dev/null 2>&1 ||
        fail_with image-registry retry "Could not prepare the optional local-model service image."
      installer_ui_event preparation ollama completed service-preparation pull
      ;;
    *) installer_ui_event preparation ollama skipped service-preparation skip ;;
  esac
}

wait_for_deployment_readiness() {
  installer_ui_phase=database
  installer_ui_component=database
  installer_ui_event database database starting database-health start
  if ! compose up -d --no-build --remove-orphans >/dev/null 2>&1; then
    if [[ "$target_was_empty" == 1 ]]; then
      compose down --remove-orphans >/dev/null 2>&1 || true
    fi
    fail_with docker-host repair "Orbit services could not be created or started."
  fi
  wait_for_component_health database database database-health probe_database_health ||
    fail_with database-auth-migration repair "The database did not become healthy within the bounded startup window."

  installer_ui_phase=application
  installer_ui_component=application
  installer_ui_event application application starting application-health start
  if ! wait_for_component_health application application application-health probe_application_health; then
    if bounded_compose_probe exec -T orbit-app true >/dev/null 2>&1; then
      fail_with health-timeout repair "Orbit did not report ready within the bounded startup window."
    fi
    fail_with application-startup repair "Orbit stopped before it could report ready; the bounded status does not claim an unproven cause."
  fi

  installer_ui_phase=optional
  installer_ui_component=clamav
  installer_ui_event optional clamav starting optional-status health
  wait_for_component_health optional clamav optional-status probe_clamav_health ||
    fail_with optional-unavailable repair "The private scanner did not become healthy within the bounded startup window."

  case "$selected_profile" in
    processing|full)
      installer_ui_component=tika
      installer_ui_event optional tika starting optional-status health
      wait_for_component_health optional tika optional-status probe_tika_health ||
        fail_with optional-unavailable repair "The selected document-processing service did not become healthy within the bounded startup window."
      ;;
    *) installer_ui_event optional tika skipped optional-status skip ;;
  esac

  case "$selected_profile" in
    ai|full)
      installer_ui_component=ollama
      installer_ui_event optional ollama starting optional-status health
      wait_for_component_health optional ollama optional-status probe_ollama_health ||
        fail_with optional-unavailable repair "The selected local-model service did not become healthy within the bounded startup window."
      if [[ "$model_pull_requested" == 1 ]]; then
        installer_ui_event optional ollama running service-preparation pull
        compose exec -T orbit-ollama ollama pull "$model_pull_value" >/dev/null 2>&1 ||
          fail_with optional-unavailable repair "The confirmed local model download did not complete."
        installer_ui_event optional ollama completed service-preparation pull
      fi
      ;;
    *) installer_ui_event optional ollama skipped optional-status skip ;;
  esac
  unset model_pull_value
}

print_completion_screen() {
  local public_url
  public_url="$(read_environment_value APP_URL)" ||
    fail_with configuration-failure retry "The validated public URL could not be read for completion."

  printf '\nOrbit is ready.\n'
  printf 'Public URL: %s\n' "$public_url"
  printf 'Version: %s\n' "$image_version"
  printf 'Channel: %s\n' "$channel"
  printf 'Revision: %s\n' "${revision:0:12}"
  printf 'Image digest: %s\n' "$applied_digest"
  printf 'Optional profiles: %s\n' "$selected_profile"
  printf 'Status: docker compose --env-file %s ps\n' "$environment_file"
  printf 'Logs: docker compose --env-file %s logs --tail 200\n' "$environment_file"
}

installer_ui_event host host starting host-tools check
validate_target

# Explicit modes are automation-facing and can be rejected before any image
# pull or deployment-asset download. Interactive choices occur later, after
# the immutable presentation helper has been verified.
case "$requested_action" in
  install)
    [[ "$target_was_empty" == 1 ]] ||
      fail "Install requires an empty target or safe pre-provisioned bootstrap; use Update for a recognized deployment."
    ;;
  update)
    [[ "$target_was_empty" == 0 ]] ||
      fail "Update requires a recognized existing Orbit deployment."
    ;;
  repair)
    printf 'phase=rollback component=installer state=blocked reason=repair-unavailable action=repair elapsed=%ss\n' \
      "$((SECONDS - installer_process_started_at))"
    printf 'Orbit installer: repair_unavailable; this installer does not perform repair. Run "bash scripts/repair.sh --check" from this directory to diagnose, then "--plan" to see what it would do. No deployment files or services were changed.\n' >&2
    exit 3
    ;;
esac

command -v docker >/dev/null 2>&1 || fail "Docker is required."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v timeout >/dev/null 2>&1 || fail "GNU timeout is required for bounded health checks."
verify_database_volume_safety
installer_ui_event host host completed host-tools check

# Resolve the requested channel to an immutable digest. The channel tag is only
# ever read; the digest is what is recorded and deployed, so a tag that moves
# later cannot change this deployment.
installer_ui_phase=identity
installer_ui_component=image
installer_ui_event identity image starting image-identity pull
docker pull --quiet "${image_repository}:${channel}" >/dev/null 2>&1 ||
  fail "Could not pull ${image_repository}:${channel}. If the image is private, authenticate with ${registry} first."

if ! inspect_output="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "${image_repository}:${channel}" 2>/dev/null)"; then
  fail "Could not inspect ${image_repository}:${channel} to resolve an immutable digest."
fi

resolved_reference=""
while IFS= read -r candidate; do
  if [[ "$candidate" == "${image_repository}@sha256:"* ]]; then
    resolved_reference="$candidate"
    break
  fi
done <<< "$inspect_output"
[[ "$resolved_reference" =~ ^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$ ]] ||
  fail "The registry did not return an immutable digest for ${image_repository}:${channel}."

# The image records the exact source revision that produced it, so deployment
# assets are fetched from that revision rather than from a moving branch. A
# compose file therefore cannot drift from the image it configures.
if ! revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$resolved_reference" 2>/dev/null)"; then
  fail "Could not inspect ${resolved_reference} for its source revision."
fi
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] ||
  fail "The published image does not record the source revision that produced it."

if ! image_version="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$resolved_reference" 2>/dev/null)"; then
  fail "Could not inspect the published image for its semantic version."
fi
semver_pattern='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
[[ "$image_version" =~ $semver_pattern ]] ||
  fail "The published image does not record a valid semantic version."
# A tag can be moved; the label inside a digest cannot. So when the operator
# pins a version tag, require the image's own embedded version to name that
# same release — an image parked at a version tag is not evidence that it is
# that version (ADR-0016).
if [[ "$channel" =~ $semver_pattern && "$image_version" != "$channel" ]]; then
  fail "The published image's embedded version (${image_version}) does not match the requested version tag (${channel})."
fi
readonly applied_digest="${resolved_reference##*@}"

installer_ui_event identity image running image-identity inspect
if ! docker run --rm --entrypoint /opt/orbit/scripts/container-entrypoint.sh \
  "$resolved_reference" --banner; then
  fail "The resolved Orbit image could not render its canonical banner."
fi
installer_ui_event identity image completed image-identity verify

readonly asset_base="https://raw.githubusercontent.com/${repository}/${revision}"
readonly deployment_assets=(
  "docker-compose.yml"
  "docker-compose.mail.yml"
  "docker-compose.mail-alias-rotation.yml"
  ".env-orbit.example"
  "config/tika-config.xml"
  "scripts/configure.sh"
  "scripts/installer-ui.sh"
  "scripts/configuration.sh"
  "scripts/backup.sh"
  "scripts/restore.sh"
  "scripts/repair.sh"
  "scripts/engine-check.sh"
)
readonly deployment_scripts=(
  "scripts/configure.sh"
  "scripts/installer-ui.sh"
  "scripts/configuration.sh"
  "scripts/backup.sh"
  "scripts/restore.sh"
  "scripts/repair.sh"
  "scripts/engine-check.sh"
)
declare -a asset_directories=()
declare -A asset_directory_seen=()
for asset in "${deployment_assets[@]}"; do
  asset_dir="$(dirname -- "$asset")"
  [[ "$asset_dir" == "." ]] && continue
  if [[ -z "${asset_directory_seen[$asset_dir]:-}" ]]; then
    asset_directories+=("$asset_dir")
    asset_directory_seen["$asset_dir"]=1
  fi
done
readonly managed_paths=("${deployment_assets[@]}" "$environment_file" "$secrets_directory")

preflight_final_paths() {
  local asset asset_dir

  if [[ -e "$environment_file" || -L "$environment_file" ]] &&
    ! is_regular_non_symlink_file "$environment_file"; then
    fail "Refusing to use ${environment_file} because it is not a regular, non-symlink file."
  fi
  if [[ -e "$secrets_directory" || -L "$secrets_directory" ]] &&
    ! is_real_non_symlink_directory "$secrets_directory"; then
    fail "Refusing to use ${secrets_directory} because it is not a real, non-symlink directory."
  fi

  for asset_dir in "${asset_directories[@]}"; do
    if [[ -e "$asset_dir" || -L "$asset_dir" ]] &&
      ! is_real_non_symlink_directory "$asset_dir"; then
      fail "Refusing to install into ${asset_dir} because it is not a real directory."
    fi
  done

  for asset in "${deployment_assets[@]}"; do
    if [[ -e "$asset" || -L "$asset" ]] &&
      ! is_regular_non_symlink_file "$asset"; then
      fail "Refusing to overwrite ${asset} because it is not a regular file."
    fi
  done
}

prepare_rollback_area() {
  local path backup_path backup_parent

  rollback_dir="$staging_dir/rollback"
  mkdir -- "$rollback_dir" || fail "Could not create the private rollback area."
  chmod 700 "$rollback_dir" || fail "Could not restrict the rollback area."
  mkdir -- "$rollback_dir/original" || fail "Could not create the rollback backup area."
  chmod 700 "$rollback_dir/original" || fail "Could not restrict the rollback backup area."

  for path in "${managed_paths[@]}"; do
    managed_was_present["$path"]=0
    if [[ -e "$path" || -L "$path" ]]; then
      managed_was_present["$path"]=1
      backup_path="$rollback_dir/original/$path"
      backup_parent="$(dirname -- "$backup_path")"
      mkdir -p -- "$backup_parent" || fail "Could not prepare the rollback backup for ${path}."
      chmod 700 "$backup_parent" || fail "Could not restrict the rollback backup for ${path}."
      cp -a -- "$path" "$backup_path" ||
        fail "Could not securely back up ${path} before installation."
    fi
  done
}

# Every asset is fetched into a private staging directory and fully validated
# before anything in the target is touched, so a fetch or validation failure
# never mutates an existing deployment's files.
staging_dir="$(mktemp -d "./.orbit-install-staging.XXXXXX")" ||
  fail "Could not create a private staging directory."
chmod 700 "$staging_dir" || fail "Could not restrict the staging directory."

installer_ui_phase=assets
installer_ui_component=assets
installer_ui_event assets assets starting assets-verified fetch
for asset in "${deployment_assets[@]}"; do
  staged_path="$staging_dir/$asset"
  mkdir -p -- "$(dirname "$staged_path")"
  curl --fail --silent --show-error --location --output "$staged_path" "${asset_base}/${asset}" 2>/dev/null ||
    fail "Could not fetch ${asset} from the published revision."
  is_regular_non_symlink_file "$staged_path" ||
    fail "Fetched ${asset} is not a regular file."
  [[ -s "$staged_path" ]] || fail "Fetched ${asset} is empty."
done

for script in "${deployment_scripts[@]}"; do
  bash -n "$staging_dir/$script" 2>/dev/null ||
    fail "Fetched ${script} failed a syntax check."
done

load_installer_ui || fail "Fetched installer UI helper is unavailable."
installer_ui_event assets assets completed assets-verified fetch

action_status=0
resolve_installer_action || action_status=$?
if [[ "$action_status" != 0 ]]; then
  exit "$action_status"
fi

action_status=0
stage_guided_install_configuration || action_status=$?
if [[ "$action_status" != 0 ]]; then
  exit "$action_status"
fi

# Preflight all final file and parent paths before beginning the transaction.
# No target directory is created until the backups are complete.
preflight_final_paths
prepare_rollback_area
file_transaction_active=1

# Validate and, for a legacy v0 file, add only the schema marker before any
# fetched asset or configure.sh mutation. The transaction above owns rollback.
if [[ -e "$environment_file" ]]; then
  bash "$staging_dir/scripts/configuration.sh" --preflight --file "$environment_file" >/dev/null ||
    fail "Configuration preflight failed; restoring the previous deployment."
  run_configuration_migration "$staging_dir/scripts/configuration.sh"
  configuration_migration_completed=1
fi

for asset_dir in "${asset_directories[@]}"; do
  if [[ -e "$asset_dir" || -L "$asset_dir" ]]; then
    is_real_non_symlink_directory "$asset_dir" ||
      fail "Refusing to install into ${asset_dir} because it is not a real directory."
  else
    mkdir -- "$asset_dir" || fail "Could not create the ${asset_dir} directory."
    created_directories+=("$asset_dir")
  fi
done

if [[ "$guided_configuration_staged" == 1 ]]; then
  mv -- "$staging_dir/$environment_file" "$environment_file" ||
    fail "Could not install the reviewed configuration; restoring the previous deployment."
  mv -- "$staging_dir/$secrets_directory" "$secrets_directory" ||
    fail "Could not install the reviewed secret files; restoring the previous deployment."
fi

for asset in "${deployment_assets[@]}"; do
  if [[ -e "$asset" || -L "$asset" ]]; then
    is_regular_non_symlink_file "$asset" ||
      fail "Refusing to overwrite ${asset} because it is not a regular file."
  fi
  mv -f -- "$staging_dir/$asset" "$asset" ||
    fail "Could not install ${asset}; restoring the previous deployment."
done

# The resolved digest is exported before configuration runs so VAPID key
# generation and every other configuration step use the immutable published
# image instead of falling back to git rev-parse and a local source build.
prepare_configuration

verify_database_volume_safety
verify_database_password_preserved

if [[ "$configuration_migration_completed" == 0 ]]; then
  run_configuration_migration "scripts/configuration.sh"
  configuration_migration_completed=1
fi
installer_ui_event configuration configuration completed configuration-migration verify

installer_ui_phase=oidc
installer_ui_component=oidc
installer_ui_event oidc oidc starting provider-discovery verify
verify_oidc_discovery
installer_ui_event oidc oidc completed provider-discovery verify

is_regular_non_symlink_file "$environment_file" ||
  fail "Configuration did not leave a regular, non-symlink ${environment_file}."
is_real_non_symlink_directory "$secrets_directory" ||
  fail "Configuration did not leave a real, non-symlink ${secrets_directory} directory."

# Record the resolved digest as the deployment reference. The channel tag is
# never written here: what runs must be an immutable, attested artifact. This
# repeats persistence as defence in depth: scripts/configure.sh already
# persists ORBIT_IMAGE from the environment above.
orbit_image_line="ORBIT_IMAGE=${resolved_reference}"
# An env file that already carried the key twice would otherwise come out
# still carrying it twice, both rewritten to the same value: harmless to
# docker compose, which takes the last, but it leaves a duplicated managed
# key behind for every later reader to disagree about. Emit the resolved
# line once, at the position of the first occurrence, and drop the rest.
orbit_image_line_written=0
tmp_environment="$(mktemp "$staging_dir/.env-orbit.persist.XXXXXX")" ||
  fail "Could not create the staged environment file."
chmod 600 "$tmp_environment" || fail "Could not restrict the staged environment file."
if grep -q '^ORBIT_IMAGE=' "$environment_file"; then
  if ! {
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" == ORBIT_IMAGE=* ]]; then
        if [[ "$orbit_image_line_written" == 0 ]]; then
          printf '%s\n' "$orbit_image_line"
          orbit_image_line_written=1
        fi
      else
        printf '%s\n' "$line"
      fi
    done < "$environment_file" > "$tmp_environment"
  }; then
    fail "Could not stage the resolved image digest in ${environment_file}."
  fi
else
  grep_status=$?
  [[ "$grep_status" -eq 1 ]] || fail "Could not inspect ${environment_file} for its image digest."
  if ! {
    while IFS= read -r line || [[ -n "$line" ]]; do
      printf '%s\n' "$line"
    done < "$environment_file"
    printf 'ORBIT_IMAGE=%s\n' "$resolved_reference"
  } > "$tmp_environment"; then
    fail "Could not stage the resolved image digest in ${environment_file}."
  fi
fi

mv -- "$tmp_environment" "$environment_file" ||
  fail "Could not persist the resolved image digest in ${environment_file}."

export ORBIT_IMAGE="$resolved_reference"

if ! compose config --quiet >/dev/null 2>&1; then
  fail "Docker Compose configuration is invalid; review the named configuration fields and rerun."
fi

installer_ui_phase=compose
installer_ui_component=compose
installer_ui_event compose compose completed compose-validation check
printf 'Orbit installer: configuration, OIDC discovery, and Docker Compose preflight passed; starting services.\n'

file_transaction_committed=1

# Record the commit in the staging directory itself, not just in this
# process's memory. If the host dies during the image-pull/health-wait phase
# below (the longest phase of an install), the EXIT trap's own rollback never
# runs and this staging directory can survive next to a successfully
# installed deployment. repair.sh treats any leftover
# ".orbit-install-staging.*" as evidence of an INTERRUPTED transaction and
# offers to restore from it; without this marker it cannot tell that
# transaction apart from one that already committed, and would silently
# revert a successful install/update back to the pre-update files (issue
# #383 finding 2). repair.sh's do_restore_transaction refuses outright when
# this marker is present.
: > "$staging_dir/committed" || fail "Could not record the installer's commit marker."

prepare_service_images
wait_for_deployment_readiness

installer_ui_phase=complete
installer_ui_component=installer
installer_ui_event complete installer completed deployment-ready complete
print_completion_screen
