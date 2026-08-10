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
declare -a created_directories=()
declare -A managed_was_present=()

fail() {
  printf 'Orbit installer: %s\n' "$*" >&2
  exit 1
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
    fail "OIDC_ISSUER requires attention; run the guided configuration and rerun the installer."
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
      fail "OIDC provider configuration could not be validated; review the OIDC discovery response."
    fi
    fail "OIDC provider is unavailable; retry without changing the configuration."
  fi

  case "$response_status" in
    2[0-9][0-9]) ;;
    000) fail "OIDC provider is unavailable; retry without changing the configuration." ;;
    *) fail "OIDC provider configuration could not be validated; review the OIDC discovery response." ;;
  esac

  is_regular_non_symlink_file "$discovery_file" ||
    fail "OIDC provider configuration could not be validated; review the OIDC discovery response."
  chmod 600 "$discovery_file" 2>/dev/null ||
    fail "OIDC provider configuration could not be validated; review the OIDC discovery response."
  discovery_size="$(stat -c '%s' -- "$discovery_file" 2>/dev/null)"
  [[ "$discovery_size" =~ ^[0-9]+$ && "$discovery_size" -le "$oidc_discovery_max_bytes" ]] ||
    fail "OIDC provider configuration could not be validated; review the OIDC discovery response."

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
    fail "OIDC provider configuration could not be validated; review the OIDC discovery response."
  fi
}

prepare_configuration() {
  local readiness readiness_status missing guided_missing

  if ! ORBIT_IMAGE="$resolved_reference" bash scripts/configure.sh; then
    fail "Configuration failed; restoring the previous deployment."
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

  verify_oidc_discovery
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

validate_target

command -v docker >/dev/null 2>&1 || fail "Docker is required."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
command -v curl >/dev/null 2>&1 || fail "curl is required."
verify_database_volume_safety

# Resolve the requested channel to an immutable digest. The channel tag is only
# ever read; the digest is what is recorded and deployed, so a tag that moves
# later cannot change this deployment.
printf 'Resolving %s:%s...\n' "$image_repository" "$channel"
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
[[ "$image_version" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
  fail "The published image does not record a valid semantic version."
readonly applied_digest="${resolved_reference##*@}"

printf 'Resolved %s\n' "$resolved_reference"

readonly asset_base="https://raw.githubusercontent.com/${repository}/${revision}"
readonly deployment_assets=(
  "docker-compose.yml"
  "docker-compose.mail.yml"
  "docker-compose.mail-alias-rotation.yml"
  ".env-orbit.example"
  "config/tika-config.xml"
  "scripts/configure.sh"
  "scripts/configuration.sh"
  "scripts/backup.sh"
  "scripts/restore.sh"
)
readonly deployment_scripts=(
  "scripts/configure.sh"
  "scripts/configuration.sh"
  "scripts/backup.sh"
  "scripts/restore.sh"
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

printf 'Fetching deployment assets from %s...\n' "${revision:0:12}"
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

is_regular_non_symlink_file "$environment_file" ||
  fail "Configuration did not leave a regular, non-symlink ${environment_file}."
is_real_non_symlink_directory "$secrets_directory" ||
  fail "Configuration did not leave a real, non-symlink ${secrets_directory} directory."

# Record the resolved digest as the deployment reference. The channel tag is
# never written here: what runs must be an immutable, attested artifact. This
# repeats persistence as defence in depth: scripts/configure.sh already
# persists ORBIT_IMAGE from the environment above.
orbit_image_line="ORBIT_IMAGE=${resolved_reference}"
tmp_environment="$(mktemp "$staging_dir/.env-orbit.persist.XXXXXX")" ||
  fail "Could not create the staged environment file."
chmod 600 "$tmp_environment" || fail "Could not restrict the staged environment file."
if grep -q '^ORBIT_IMAGE=' "$environment_file"; then
  if ! {
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" == ORBIT_IMAGE=* ]]; then
        printf '%s\n' "$orbit_image_line"
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

printf 'Orbit installer: configuration, OIDC discovery, and Docker Compose preflight passed; starting services.\n'

file_transaction_committed=1

if ! compose pull orbit-db >/dev/null 2>&1; then
  fail "Could not prepare the Orbit database image."
fi
if ! compose up -d --no-build --remove-orphans >/dev/null 2>&1; then
  if [[ "$target_was_empty" == 1 ]]; then
    compose down --remove-orphans >/dev/null 2>&1 || true
  fi
  fail "Orbit could not start; review the verified configuration and rerun."
fi
if ! compose ps >/dev/null 2>&1; then
  if [[ "$target_was_empty" == 1 ]]; then
    compose down --remove-orphans >/dev/null 2>&1 || true
  fi
  fail "Orbit started but its status could not be verified."
fi

printf '\nOrbit is deployed from %s\n' "$resolved_reference"
printf 'Optional services are selected with COMPOSE_PROFILES in %s\n' "$environment_file"
