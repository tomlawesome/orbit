#!/usr/bin/env bash
set -Eeuo pipefail

# Orbit installer.
#
# Deploys a published, digest-pinned image. It takes no interactive input, so
# it works under CI, non-TTY SSH and cloud-init as well as a terminal, and it
# does not clone the repository: a deployment needs compose assets and a
# published image, not source or tests.
#
# Building from source is a separate developer workflow; see the README.

readonly repository="${ORBIT_REPOSITORY:-tomlawesome/orbit}"
readonly registry="${ORBIT_REGISTRY:-ghcr.io}"
readonly channel="${ORBIT_CHANNEL:-latest}"
readonly environment_file=".env-orbit"
readonly compose_file="docker-compose.yml"
readonly secrets_directory=".orbit-secrets"
readonly image_repository="${registry}/${repository}"

staging_dir=""
rollback_dir=""
file_transaction_active=0
file_transaction_committed=0
declare -a created_directories=()
declare -A managed_was_present=()

fail() {
  printf 'Orbit installer: %s\n' "$*" >&2
  exit 1
}

compose() {
  docker compose --env-file "$environment_file" "$@"
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
  target_is_empty && return
  if is_regular_non_symlink_file "$environment_file" &&
    is_regular_non_symlink_file "$compose_file" &&
    is_real_non_symlink_directory "$secrets_directory"; then
    return
  fi
  fail "The installation directory is not empty and is not a recognizable existing Orbit deployment (expected ${environment_file}, ${compose_file} and ${secrets_directory}/ as regular, non-symlink paths). Refusing to install here."
}

validate_target

command -v docker >/dev/null 2>&1 || fail "Docker is required."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
command -v curl >/dev/null 2>&1 || fail "curl is required."

# Resolve the requested channel to an immutable digest. The channel tag is only
# ever read; the digest is what is recorded and deployed, so a tag that moves
# later cannot change this deployment.
printf 'Resolving %s:%s...\n' "$image_repository" "$channel"
docker pull --quiet "${image_repository}:${channel}" >/dev/null ||
  fail "Could not pull ${image_repository}:${channel}. If the image is private, authenticate with ${registry} first."

if ! inspect_output="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "${image_repository}:${channel}")"; then
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
if ! revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$resolved_reference")"; then
  fail "Could not inspect ${resolved_reference} for its source revision."
fi
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] ||
  fail "The published image does not record the source revision that produced it."

printf 'Resolved %s\n' "$resolved_reference"

readonly asset_base="https://raw.githubusercontent.com/${repository}/${revision}"
readonly deployment_assets=(
  "docker-compose.yml"
  "docker-compose.mail.yml"
  "docker-compose.mail-alias-rotation.yml"
  ".env-orbit.example"
  "config/tika-config.xml"
  "scripts/configure.sh"
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
  curl --fail --silent --show-error --location --output "$staged_path" "${asset_base}/${asset}" ||
    fail "Could not fetch ${asset} from the published revision."
  is_regular_non_symlink_file "$staged_path" ||
    fail "Fetched ${asset} is not a regular file."
  [[ -s "$staged_path" ]] || fail "Fetched ${asset} is empty."
done

bash -n "$staging_dir/scripts/configure.sh" ||
  fail "Fetched scripts/configure.sh failed a syntax check."

# Preflight all final file and parent paths before beginning the transaction.
# No target directory is created until the backups are complete.
preflight_final_paths
prepare_rollback_area
file_transaction_active=1

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
if ! ORBIT_IMAGE="$resolved_reference" bash scripts/configure.sh; then
  fail "Configuration failed; restoring the previous deployment."
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
file_transaction_committed=1

compose pull orbit-db
compose up -d --no-build --remove-orphans
compose ps

printf '\nOrbit is deployed from %s\n' "$resolved_reference"
printf 'Optional services are selected with COMPOSE_PROFILES in %s\n' "$environment_file"
