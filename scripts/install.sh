#!/usr/bin/env bash
set -Eeuo pipefail

# Orbit installer: the bootstrap shell around the install engine (#1212).
#
# Deploys a published, digest-pinned image. It does not clone the
# repository: a deployment needs compose assets and a published image, not
# source or tests. Building from source is a separate developer workflow;
# see the README.
#
# Three phases, two owners (#1212 build note F1). This script does what
# touches Docker or the network before an image exists: tool checks, the
# release manifest and its signatures, the pull, the image's labels and
# banner, and the Docker facts the engine needs (gather_host_facts). It then
# runs the install engine once, from the image it has just verified, as a
# disposable `docker run --rm` one-off with the deployment directory
# mounted (run_engine). The engine (src/lib/install-orchestrator.ts) does
# everything between: target validation, the install/update menu and the
# profile wizard on the terminal passed through to it, database-volume
# safety, the deployment assets out of its own image, guided configuration,
# the configuration migration, OIDC discovery, and the file transaction,
# which it commits or rolls back. The engine never touches Docker (#295):
# what Docker must do afterwards comes back in its outcome file, and this
# script starts Compose, waits for readiness and prints the completion
# screen. Nothing here writes a deployment file.
#
# Environment (besides the settings read below):
#   ORBIT_LAUNCHER_CONFIG_TREE  set by orbit-launcher to an empty directory it
#     created, mode 0700 and owned by the running user. On any exit whose
#     event reason is configuration-failure the engine copies
#     scripts/configure.sh, scripts/installer-ui.sh and .env-orbit.example,
#     from its own image, and .orbit-image, the resolved digest reference on
#     one line, into it before rolling back, owner-only (0600/0700), all or
#     nothing. It writes nothing, and says so in one stderr line, if the
#     directory is missing, not a directory, a symlink, not mode 0700, not
#     empty or not owned by the current user (#1225, docs/engine-events.md).
#     This script only mounts the directory into the engine.

readonly repository="${ORBIT_REPOSITORY:-tomlawesome/orbit}"
readonly registry="${ORBIT_REGISTRY:-ghcr.io}"
readonly channel="${ORBIT_CHANNEL:-latest}"
readonly environment_file=".env-orbit"
readonly launcher_config_tree="${ORBIT_LAUNCHER_CONFIG_TREE:-}"
readonly database_volume_key="orbit-db-data"
readonly image_repository="${registry}/${repository}"
# ADR-0031 #7: byte-identical to cosign.pub (scripts/get-orbit.test.mjs also
# checks this, and the copy embedded in scripts/get-orbit.sh, against the
# same file). Rotation: docs/releasing.md.
readonly embedded_public_key='-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEz/p19d5ZrSimfOQ80OCeSG8s32dm
k91OtCbfzOoGPhJnnXIynC5JDfyBoZiS59rCFb2hSiERGWQmLH1i8XV4nQ==
-----END PUBLIC KEY-----'
# The identity countersign.yml signs the image and the release manifest
# bundle under (ADR-0031 #4, #7; .github/workflows/countersign.yml).
readonly countersign_identity_regexp='^https://github.com/tomlawesome/orbit/'
readonly countersign_oidc_issuer='https://token.actions.githubusercontent.com'
# Test-only: overrides where the release manifest is fetched from when
# ORBIT_RELEASE_MANIFEST is not set. Never for user environments.
readonly release_manifest_base_url="${ORBIT_INSTALL_TEST_MANIFEST_BASE_URL:-https://github.com/tomlawesome/orbit}"
readonly installer_process_started_at="$SECONDS"
# Where the engine one-off sees what this script hands it (run_engine).
readonly engine_cli="/opt/orbit/cli/orbit.js"
readonly engine_mount="/orbit-deploy"
readonly engine_result_mount="/orbit-install-result"
readonly engine_launcher_tree_mount="/orbit-launcher-config-tree"
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
# ADR-0031 #7: preview is for testing, not for trusting -- a missing
# countersignature is tolerated only there; every other channel (latest, or
# a pinned version tag) is treated as stable.
if [[ "$channel" == "preview" ]]; then
  readonly release_manifest_stable=0
else
  readonly release_manifest_stable=1
fi

release_manifest_work_dir=""
engine_work_dir=""
cosign_usable=0
compose_project_name=""
installer_ui_loaded=0
installer_ui_phase=host
installer_ui_component=host
installer_failure_reason=""
installer_failure_action=""
selected_profile=""
model_pull_requested=0
model_pull_value=""
target_was_empty=0
declare -a pending_ui_events=()

# installer-ui.sh renders this script's own phases (build note F6). It is
# sourced only from the deployment the engine has just committed, which the
# engine copied out of the verified image at the asset's checked mode, and
# only after bash -n: never from a deployment copy before the engine has
# replaced it. Until then events are queued, and replayed here, exactly as
# before; a failure before this point prints them as plain lines.
load_installer_ui() {
  local candidate="scripts/installer-ui.sh"

  is_regular_non_symlink_file "$candidate" || return 1
  bash -n "$candidate" 2>/dev/null || return 1
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

flush_pending_ui_events() {
  local pending phase component state reason action elapsed
  for pending in "${pending_ui_events[@]}"; do
    IFS='|' read -r phase component state reason action elapsed <<< "$pending"
    printf 'phase=%s component=%s state=%s reason=%s action=%s elapsed=%ss\n' \
      "$phase" "$component" "$state" "$reason" "$action" "$elapsed"
  done
  pending_ui_events=()
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
    flush_pending_ui_events
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

cleanup() {
  local exit_status=$?

  if [[ -n "$engine_work_dir" ]] && ! rm -rf -- "$engine_work_dir"; then
    printf 'Orbit installer: could not remove a temporary directory: %s.\n' "$engine_work_dir" >&2
    exit_status=1
  fi
  if [[ -n "$release_manifest_work_dir" ]] && ! rm -rf -- "$release_manifest_work_dir"; then
    printf 'Orbit installer: could not remove a temporary directory: %s.\n' "$release_manifest_work_dir" >&2
    exit_status=1
  fi

  exit "$exit_status"
}

trap cleanup EXIT

# manifest_field <manifest-path> <literal-key>
#
# Extracts a string field from the release manifest (ADR-0031 #1's fixed
# schema, written by scripts/ci/write-release-manifest.sh) by literal key
# match, not a general JSON parser: safe here because write-release-manifest.sh
# always writes one field per line, every key this script reads ("digest") is
# unique in that schema, and every value read back is validated against its
# own pattern before use.
manifest_field() {
  grep -F "\"$2\":" "$1" 2> /dev/null | sed -n 's/.*: *"\([^"]*\)".*/\1/p' | head -n1
}

# check_cosign_usable
#
# A `cosign` on PATH that cannot even answer `cosign version` is treated the
# same as no cosign at all: ADR-0031 only ever asks "is cosign present", and
# a broken binary on PATH is not meaningfully different from an absent one
# for that question.
check_cosign_usable() {
  command -v cosign > /dev/null 2>&1 && cosign version > /dev/null 2>&1
}

# self_fetch_release_manifest
#
# ADR-0031 #7: when install.sh runs on its own -- no manifest handed over by
# get-orbit.sh or the launcher via ORBIT_RELEASE_MANIFEST -- it fetches and
# verifies the manifest for its own channel with the same embedded key, so
# the plain `install.sh | bash` path is also signature-checked and a moving
# tag becomes a lookup, never the identity (ADR-0008).
#
# Only the stable channel shapes get-orbit.sh itself understands -- latest,
# a vX.Y.Z pin -- have a known release-assets location. Preview is refused
# here: a preview install needs a verified release manifest passed in via
# ORBIT_RELEASE_MANIFEST instead. Any other ORBIT_CHANNEL has no self-fetch
# home either; pass ORBIT_RELEASE_MANIFEST instead.
#
# Prints the verified manifest's path on success.
self_fetch_release_manifest() {
  local asset_base key_file manifest_json manifest_sig der_file bundle
  local version_pin_pattern='^v[0-9]+\.[0-9]+\.[0-9]+$'

  if [[ "$channel" == "latest" ]]; then
    asset_base="${release_manifest_base_url}/releases/latest/download"
  elif [[ "$channel" == "preview" ]]; then
    fail "The self-fetch path only installs stable releases (ORBIT_CHANNEL=latest, the default, or a vX.Y.Z pin). A preview install needs a verified release manifest passed in via ORBIT_RELEASE_MANIFEST; see docs/releasing.md."
  elif [[ "$channel" =~ $version_pin_pattern ]]; then
    asset_base="${release_manifest_base_url}/releases/download/${channel}"
  else
    fail "ORBIT_CHANNEL (${channel}) has no known release-manifest location to fetch on its own; set ORBIT_RELEASE_MANIFEST to an already-verified manifest for this channel instead."
  fi

  # The release manifest is the one thing this script still fetches over
  # curl; OIDC discovery moved into the engine (#1212 F5).
  command -v curl >/dev/null 2>&1 || fail "curl is required to fetch the release manifest."

  release_manifest_work_dir="$(mktemp -d "${TMPDIR:-/tmp}/orbit-install-manifest.XXXXXX")" ||
    fail "Could not create a private temporary directory for the release manifest."

  key_file="$release_manifest_work_dir/trusted.pub"
  if [[ -n "${ORBIT_INSTALL_TEST_PUBLIC_KEY_FILE:-}" ]]; then
    [[ "${ORBIT_INSTALL_TEST_ALLOW_KEY_OVERRIDE:-}" == "1" ]] ||
      fail "ORBIT_INSTALL_TEST_PUBLIC_KEY_FILE is set without ORBIT_INSTALL_TEST_ALLOW_KEY_OVERRIDE=1; refusing to swap the trust anchor."
    cp "$ORBIT_INSTALL_TEST_PUBLIC_KEY_FILE" "$key_file"
  else
    printf '%s\n' "$embedded_public_key" > "$key_file"
  fi

  manifest_json="$release_manifest_work_dir/orbit-release-manifest.json"
  manifest_sig="$release_manifest_work_dir/orbit-release-manifest.json.sig"
  curl --silent --show-error --fail --location --connect-timeout 5 --max-time 60 \
    -o "$manifest_json" "${asset_base}/orbit-release-manifest.json" ||
    fail "Could not download the release manifest for channel ${channel}."
  curl --silent --show-error --fail --location --connect-timeout 5 --max-time 60 \
    -o "$manifest_sig" "${asset_base}/orbit-release-manifest.json.sig" ||
    fail "Could not download the release manifest's signature for channel ${channel}."

  der_file="$release_manifest_work_dir/manifest.sig.der"
  if ! base64 -d < "$manifest_sig" > "$der_file" 2>/dev/null || [[ ! -s "$der_file" ]]; then
    fail "The release manifest's signature is not valid base64; refusing an unverifiable manifest."
  fi
  openssl dgst -sha256 -verify "$key_file" -signature "$der_file" "$manifest_json" > /dev/null 2>&1 ||
    fail "Could not verify the release manifest's signature against the trusted key."

  if [[ "$cosign_usable" == 1 ]]; then
    bundle="$release_manifest_work_dir/orbit-release-manifest.json.sigstore.json"
    if curl --silent --show-error --fail --location --connect-timeout 5 --max-time 60 \
      -o "$bundle" "${asset_base}/orbit-release-manifest.json.sigstore.json" 2> /dev/null; then
      cosign verify-blob \
        --bundle "$bundle" \
        --certificate-identity-regexp "$countersign_identity_regexp" \
        --certificate-oidc-issuer "$countersign_oidc_issuer" \
        "$manifest_json" > /dev/null 2>&1 ||
        fail "cosign could not verify the release manifest's countersignature bundle."
    else
      # self_fetch_release_manifest only ever runs for a stable channel
      # (preview is refused above), so a missing bundle always refuses here.
      fail "No countersignature bundle for this release yet; refusing on channel ${channel}."
    fi
  fi

  # A validly signed manifest for a different release must not stand in for
  # the version asked for: an older signed release is still signed.
  if [[ "$channel" =~ $version_pin_pattern ]]; then
    local manifest_version
    manifest_version="$(grep -F '"version":' "$manifest_json" | sed -n 's/.*: *"\([^"]*\)".*/\1/p' | head -n1)"
    [[ "v${manifest_version}" == "$channel" ]] ||
      fail "Asked for ${channel} but the signed release manifest is for v${manifest_version}; refusing."
  fi

  # Set the global directly rather than printing it for a caller to capture
  # via $(...): command substitution runs this whole function in a subshell,
  # so release_manifest_work_dir above would only ever be set in that
  # subshell and cleanup() in the parent shell would never see it -- leaking
  # orbit-install-manifest.* on every self-fetch run (#1151 #1201).
  release_manifest_path="$manifest_json"
}

# --- the engine's Docker facts (build note F3) ------------------------------

# One fact for the engine: the output of a docker call, base64-encoded byte
# for byte as $(...) captured it (so building JSON here needs no escaping),
# or null when the call failed. The engine applies every bound and pattern
# to the decoded text itself (src/lib/host-facts.ts); a gap fails closed.
encoded_fact() {
  local output
  if output="$("$@" 2>/dev/null)"; then
    printf '"%s"' "$(printf '%s' "$output" | base64 | tr -d '\n')"
  else
    printf 'null'
  fi
}

base64_string() {
  printf '"%s"' "$(printf '%s' "$1" | base64 | tr -d '\n')"
}

# gather_host_facts
#
# Runs the docker calls the engine's volume-safety check needs, with the
# argv src/lib/database-volume-safety.ts documents for each, and leaves the
# JSON in ORBIT_INSTALL_HOST_FACTS. Every Orbit database volume on the host
# is described -- its labels, the containers attached to it, the containers
# of the project its labels name and the image of each orbit-app among them
# -- because which of them matters is the engine's decision (#1239, #1261),
# not this script's.
# The facts are JSON, not shell words: their quotes are data for the
# engine's parser.
# shellcheck disable=SC2089,SC2090
gather_host_facts() {
  local volume_list="" volume labels project container_id service
  local volumes_json="" projects_json="" images_json="" volume_list_json
  local -a volume_names=() project_names=() app_containers=()
  local -A project_seen=() container_seen=()

  if volume_list="$(docker volume ls --filter "name=${database_volume_key}" --format '{{.Name}}' 2>/dev/null)"; then
    volume_list_json="$(base64_string "$volume_list")"
    while IFS= read -r volume || [[ -n "$volume" ]]; do
      [[ "$volume" == *"$database_volume_key" ]] || continue
      [[ "$volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || continue
      volume_names+=("$volume")
    done <<< "$volume_list"
  else
    volume_list_json=null
  fi
  ((${#volume_names[@]} <= 256)) ||
    fail "Could not verify the existing Orbit database volume; refusing to start Compose."

  for volume in "${volume_names[@]}"; do
    [[ -z "$volumes_json" ]] || volumes_json+=","
    volumes_json+="{\"name\":$(base64_string "$volume")"
    project=""
    if labels="$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.volume"}}' "$volume" 2>/dev/null)"; then
      volumes_json+=",\"labels\":$(base64_string "$labels")"
      project="${labels%%|*}"
    else
      volumes_json+=",\"labels\":null"
    fi
    volumes_json+=",\"containers\":$(encoded_fact docker ps -a --filter "volume=$volume" --format '{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}')}"
    if [[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ && -z "${project_seen[$project]:-}" ]]; then
      project_seen["$project"]=1
      project_names+=("$project")
    fi
  done

  for project in "${project_names[@]}"; do
    local containers=""
    [[ -z "$projects_json" ]] || projects_json+=","
    if containers="$(docker ps -a --filter "label=com.docker.compose.project=$project" \
      --format '{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}' 2>/dev/null)"; then
      projects_json+="{\"name\":$(base64_string "$project"),\"containers\":$(base64_string "$containers")}"
      while IFS='|' read -r container_id _ service _ || [[ -n "$container_id" ]]; do
        [[ "$service" == orbit-app && "$container_id" =~ ^[0-9a-f]{12,64}$ && -z "${container_seen[$container_id]:-}" ]] || continue
        container_seen["$container_id"]=1
        app_containers+=("$container_id")
      done <<< "$containers"
    else
      projects_json+="{\"name\":$(base64_string "$project"),\"containers\":null}"
    fi
  done

  for container_id in "${app_containers[@]}"; do
    [[ -z "$images_json" ]] || images_json+=","
    images_json+="{\"container\":$(base64_string "$container_id"),\"image\":$(encoded_fact docker inspect --format '{{.Config.Image}}' "$container_id")}"
  done

  local cosign_json=false
  [[ "$cosign_usable" == 1 ]] && cosign_json=true
  ORBIT_INSTALL_HOST_FACTS="{\"targetBasename\":$(base64_string "$(basename -- "$target_dir")")"
  ORBIT_INSTALL_HOST_FACTS+=",\"cosignUsable\":${cosign_json},\"imageVersion\":\"${image_version}\""
  ORBIT_INSTALL_HOST_FACTS+=",\"imageRevision\":\"${revision}\",\"appliedDigest\":\"${applied_digest}\""
  ORBIT_INSTALL_HOST_FACTS+=",\"volumeList\":${volume_list_json}"
  ORBIT_INSTALL_HOST_FACTS+=",\"volumes\":[${volumes_json}],\"projects\":[${projects_json}],\"images\":[${images_json}]}"
  export ORBIT_INSTALL_HOST_FACTS
}

# --- the engine one-off ------------------------------------------------------

# Files the engine writes on the host belong to the operator (#1210 D5).
engine_host_identity() {
  local security_options
  security_options="$(docker info --format '{{.SecurityOptions}}' 2>/dev/null || true)"
  if [[ "$security_options" == *rootless* ]]; then
    host_uid=0
    host_gid=0
  else
    host_uid="$(id -u)"
    host_gid="$(id -g)"
  fi
}

# run_engine
#
# One `docker run --rm` of the verified image's engine (#1210 D1's shape,
# #1212 F1): the deployment directory mounted read-write at /orbit-deploy, a
# private directory for the outcome file, the launcher's directory when it
# gave one. Unlike configure.sh's one-offs it keeps the default network:
# OIDC discovery runs in here, against the same network the application
# will use (F5). `--init` makes the engine an ordinary child of a minimal
# init, so a signal reaches it as a signal. A terminal is passed through
# (D3) when there is one; machine prompts read stdin; otherwise stdin is
# closed, so a piped `curl | bash` never feeds the rest of this script to
# the engine. Sets engine_status.
run_engine() {
  local -a docker_args=(run --rm --init)
  local action="${requested_action:-auto}" tree reason=""
  local input=none

  engine_work_dir="$(mktemp -d "${TMPDIR:-/tmp}/orbit-install-engine.XXXXXX")" ||
    fail "Could not create a private temporary directory for the install engine."
  chmod 700 "$engine_work_dir" || fail "Could not restrict the install engine's temporary directory."

  if [[ "${ORBIT_CONFIGURE_PROMPTS:-}" == machine ]]; then
    input=pipe
    docker_args+=(-i -e ORBIT_INSTALL_INTERACTIVE=1)
  elif has_controlling_terminal; then
    input=terminal
    docker_args+=(-i -t -e ORBIT_INSTALL_INTERACTIVE=1)
  fi
  [[ "$plain_mode" == 1 ]] && docker_args+=(-e ORBIT_INSTALLER_PLAIN=1)
  [[ -n "${COMPOSE_PROJECT_NAME:-}" ]] && docker_args+=(-e COMPOSE_PROJECT_NAME)

  if [[ -n "$launcher_config_tree" ]]; then
    tree="$launcher_config_tree"
    while [[ "$tree" == */ && "$tree" != / ]]; do
      tree="${tree%/}"
    done
    if [[ -L "$tree" ]]; then
      reason="it is a symlink"
    elif [[ ! -e "$tree" ]]; then
      reason="it does not exist"
    elif [[ ! -d "$tree" ]]; then
      reason="it is not a directory"
    elif [[ "$tree" == *:* ]] || ! tree="$(cd -- "$tree" 2>/dev/null && pwd -P)"; then
      reason="it could not be entered"
    fi
    if [[ -n "$reason" ]]; then
      docker_args+=(-e "ORBIT_LAUNCHER_CONFIG_TREE_UNAVAILABLE=${reason}")
    else
      docker_args+=(-v "${tree}:${engine_launcher_tree_mount}:rw" -e "ORBIT_LAUNCHER_CONFIG_TREE=${engine_launcher_tree_mount}")
    fi
  fi

  docker_args+=(
    -e ORBIT_HOST_UID="$host_uid"
    -e ORBIT_HOST_GID="$host_gid"
    -e ORBIT_IMAGE="$resolved_reference"
    -e ORBIT_CHANNEL="$channel"
    -e ORBIT_INSTALLER_ELAPSED="$((SECONDS - installer_process_started_at))"
    -e ORBIT_INSTALL_HOST_FACTS
    -e ORBIT_CONFIGURE_PROMPTS
    -e ORBIT_CONFIGURE_APP_URL
    -e ORBIT_CONFIGURE_OIDC_ISSUER
    -e ORBIT_CONFIGURE_OIDC_CLIENT_ID
    -e ORBIT_CONFIGURE_AUTH_MODE
    -v "${target_dir}:${engine_mount}:rw"
    -v "${engine_work_dir}:${engine_result_mount}:rw"
    --entrypoint node
    "$resolved_reference" "$engine_cli" install --action "$action"
    --dir "$engine_mount" --outcome "${engine_result_mount}/outcome"
  )

  engine_status=0
  case "$input" in
    terminal)
      if [[ -t 0 ]]; then
        docker "${docker_args[@]}" || engine_status=$?
      else
        docker "${docker_args[@]}" </dev/tty || engine_status=$?
      fi
      ;;
    pipe) docker "${docker_args[@]}" || engine_status=$? ;;
    *) docker "${docker_args[@]}" </dev/null || engine_status=$? ;;
  esac
}

# read_engine_outcome
#
# Reads the engine's key=value outcome file into engine_outcome[...]: only
# known keys, each value checked against its own pattern, the file a
# regular one. Returns 1 when there is no usable outcome.
declare -A engine_outcome=()
read_engine_outcome() {
  local file="${engine_work_dir}/outcome" line key value
  engine_outcome=()
  is_regular_non_symlink_file "$file" || return 1
  [[ "$(stat -c '%s' -- "$file" 2>/dev/null)" -le 8192 ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$line" == *=* ]] || return 1
    case "$key" in
      status) [[ "$value" =~ ^(ok|failed|stopped|repair)$ ]] || return 1 ;;
      fresh|model-pull) [[ "$value" =~ ^[01]$ ]] || return 1 ;;
      profile) [[ "$value" =~ ^(standard|processing|ai|full)$ ]] || return 1 ;;
      database-volume) [[ -z "$value" || "$value" =~ ^[a-z0-9][a-z0-9_-]*_orbit-db-data$ ]] || return 1 ;;
      phase|component|reason|action) [[ "$value" =~ ^[a-z][a-z-]{0,63}$ ]] || return 1 ;;
      message) [[ "$value" != *[[:cntrl:]]* && ${#value} -le 4096 ]] || return 1 ;;
      *) return 1 ;;
    esac
    engine_outcome["$key"]="$value"
  done < "$file"
  [[ -n "${engine_outcome[status]:-}" ]]
}

bounded_compose_probe() {
  # stdin is closed on purpose (#836): `timeout` runs the command in its own
  # process group, a background one when the installer has a terminal (the
  # launcher gives it one), and `compose exec` keeps stdin attached even with
  # -T. Its first read of the terminal would stop it with SIGTTIN, TERM cannot
  # wake a stopped process, and every probe would fail at the bound.
  timeout --signal=TERM --kill-after=1s 5s \
    docker compose --project-name "$compose_project_name" --env-file "$environment_file" "$@" </dev/null
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
  # No actual pull call: the application image was already resolved and
  # pulled during the identity phase above. Still emits the same
  # starting/completed pair every sibling component in this phase gets
  # (#1151 O1-Q2), so a UI tracking per-component state never sees a
  # "completed" with no matching "starting".
  installer_ui_event preparation application starting service-preparation pull
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
      # #1151 O1-S3: `compose up` creates the named database volume on first
      # run, and verify_database_volume_safety already refused earlier (see
      # its own "An existing Orbit database volume requires a recognized
      # deployment" check) if one existed before this attempt started -- so
      # on a fresh install (target_was_empty), any matching volume here was
      # created by the attempt that just failed, never a deployment worth
      # protecting. Leaving it behind (compose down has no --volumes) meant
      # every retry failed that exact same check again, forever, with no
      # way out it ever named.
      #
      # #1207: remove only this project's own volume, by its exact name. The
      # first volume that merely ended in orbit-db-data could belong to another
      # Orbit deployment on the same host, whose live database was then
      # removed. No project name means no exact name, so nothing is removed.
      # Twin: removeLeftoverDatabaseVolume in src/lib/install-docker-adapter.ts.
      if [[ -n "$compose_project_name" ]]; then
        local own_volume="${compose_project_name}_${database_volume_key}"
        if docker volume ls --filter "name=$own_volume" --format '{{.Name}}' 2>/dev/null | grep -Fxq -- "$own_volume"; then
          docker volume rm -- "$own_volume" >/dev/null 2>&1 || true
        fi
      else
        printf 'The leftover database volume was not removed because the Compose project name is unknown.\n' >&2
      fi
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
  # The deployment is committed and running by now, so this is the generic
  # failure, never configuration-failure: that reason tells the launcher to
  # reconfigure and hands it the configure tree (#1227).
  public_url="$(read_environment_value APP_URL)" ||
    fail_with failure retry "The validated public URL could not be read for completion."

  printf '\nOrbit is ready.\n'
  printf 'Public URL: %s\n' "$public_url"
  printf 'Version: %s\n' "$image_version"
  printf 'Channel: %s\n' "$channel"
  printf 'Revision: %s\n' "${revision:0:12}"
  printf 'Image digest: %s\n' "$applied_digest"
  printf 'Optional profiles: %s\n' "$selected_profile"
  printf 'Status: docker compose --env-file %s ps\n' "$environment_file"
  printf 'Logs: docker compose --env-file %s logs --tail 200\n' "$environment_file"
  # ADR-0022 section 1: the claim is generated in the running process's
  # memory only and printed once, as the last line of the container's own
  # start-up log -- it has no file, no Compose secret and no installer-visible
  # form, so this is a pointer to where to read it, never the code itself.
  printf 'Claim this instance: run "docker compose --env-file %s logs orbit-app" and open the link on its last line to create the first administrator.\n' "$environment_file"
  # #968 (slice 1 of #966): a hard block here was considered and rejected --
  # it would fail an offline install -- so this is an instruction, not a
  # gate. The administration screen carries its own persistent reminder
  # until a bundle is actually recorded.
  printf 'Export a recovery bundle now: run "bash scripts/backup.sh" then "bash scripts/export-recovery-bundle.sh <backup.tar>" in the deployment directory -- see "Exporting a recovery bundle" in the administrator guide. It is the only way back in if the encryption key is ever lost.\n'
}

# --- the bootstrap ------------------------------------------------------------

installer_ui_event host host starting host-tools check

# repair is signposted, never run, before anything else (#533): the two
# scripts' exit-code vocabularies collide (docs/engine-events.md, "Repair
# stream"). Install and update are the engine's to accept or refuse, since
# only it validates the target.
if [[ "$requested_action" == repair ]]; then
  printf 'phase=rollback component=installer state=blocked reason=repair-unavailable action=repair elapsed=%ss\n' \
    "$((SECONDS - installer_process_started_at))"
  printf 'Orbit installer: repair_unavailable; this installer does not perform repair. Run "bash scripts/repair.sh --check" from this directory to diagnose, then "--plan" to see what it would do. No deployment files or services were changed.\n' >&2
  exit 3
fi

target_dir="$(pwd -P)" || fail "Could not resolve the installation directory."
[[ "$target_dir" != *:* ]] ||
  fail "The installation directory's path contains a character Docker cannot mount; choose a directory without ':'."

command -v docker >/dev/null 2>&1 || fail "Docker is required."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
command -v timeout >/dev/null 2>&1 || fail "GNU timeout is required for bounded health checks."
installer_ui_event host host completed host-tools check

# Resolve the release manifest (ADR-0031 #7) and pin the pull to the digest
# it names, never a moving tag, so `latest`/`preview`/a version pin all
# become a lookup and never the identity itself (ADR-0008 already says this
# of tags).
installer_ui_phase=identity
installer_ui_component=image
installer_ui_event identity image starting image-identity pull
check_cosign_usable && cosign_usable=1 || cosign_usable=0

if [[ -n "${ORBIT_RELEASE_MANIFEST:-}" ]]; then
  # Handed over already verified -- by get-orbit.sh, or by the launcher via
  # ai/orbit-launcher#171's ORBIT_LAUNCHER_INSTALL_SCRIPT_PATH caller.
  [[ -f "$ORBIT_RELEASE_MANIFEST" ]] ||
    fail "ORBIT_RELEASE_MANIFEST does not point at a readable file: ${ORBIT_RELEASE_MANIFEST}."
  release_manifest_path="$ORBIT_RELEASE_MANIFEST"
else
  # Called directly, not via $(...): see the comment at the end of
  # self_fetch_release_manifest for why command substitution here would
  # silently drop its cleanup of release_manifest_work_dir.
  self_fetch_release_manifest
fi

manifest_digest="$(manifest_field "$release_manifest_path" digest)"
[[ "$manifest_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  fail "The release manifest names no valid image digest."

resolved_reference="${image_repository}@${manifest_digest}"
[[ "$resolved_reference" =~ ^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$ ]] ||
  fail "The release manifest's image reference is not an immutable digest reference."
docker pull --quiet "$resolved_reference" >/dev/null 2>&1 ||
  fail "Could not pull ${resolved_reference} named by the release manifest. If the image is private, authenticate with ${registry} first."

if ! inspect_output="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$resolved_reference" 2>/dev/null)"; then
  fail "Could not inspect ${resolved_reference} to confirm its digest."
fi

digest_confirmed=0
while IFS= read -r candidate; do
  if [[ "$candidate" == "$resolved_reference" ]]; then
    digest_confirmed=1
    break
  fi
done <<< "$inspect_output"
[[ "$digest_confirmed" == 1 ]] ||
  fail "The registry did not return an immutable digest matching ${resolved_reference} named by the release manifest."

if [[ "$cosign_usable" == 1 ]]; then
  if ! cosign verify "$resolved_reference" \
    --certificate-identity-regexp "$countersign_identity_regexp" \
    --certificate-oidc-issuer "$countersign_oidc_issuer" \
    > /dev/null 2>&1; then
    if [[ "$release_manifest_stable" == 1 ]]; then
      fail "cosign could not verify the countersignature on ${resolved_reference}; refusing on channel ${channel}."
    fi
    printf 'Orbit installer: no countersignature yet for %s; continuing with the release-manifest check only.\n' "$resolved_reference" >&2
  fi
fi

# The image records the exact source revision that produced it. That revision
# is identity evidence, not a download location: the deployment assets come
# out of this same digest (ADR-0019), so a compose file cannot drift from the
# image it configures and no commit id has to stay resolvable for an install
# to work.
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

# The image says where it keeps the assets it was built from. An image
# without that label predates ADR-0019 and cannot be installed from: there is
# nothing to extract, and the revision it names may no longer resolve. The
# label is read before the image is asked for its banner (#1016): an image
# built before ADR-0019 cannot render the banner either, and that failure
# reports a retryable registry fault, which sends an operator round a loop
# no retry can end. The supportability question is cheap, needs no
# container, and has the accurate answer.
readonly deployment_assets_root="/opt/orbit/deploy"
if ! bundled_assets_root="$(docker image inspect --format '{{index .Config.Labels "io.orbit.deployment-assets"}}' "$resolved_reference" 2>/dev/null)"; then
  fail "Could not inspect ${resolved_reference} for its bundled deployment assets."
fi
# This refusal can never succeed by retrying: the image was built before
# ADR-0019 and no later attempt against the same tag changes that. The
# default action for this phase is "retry" (default_failure_action), which
# would tell a consumer to loop forever (#1038); action=abort marks it
# terminal instead. install_ui is never loaded this early (load_installer_ui
# runs after assets are staged), so this raw fail() line bypasses
# installer-ui.sh's action vocabulary and abort is emitted verbatim — see
# #1038 for the launcher-side change still needed to treat it as terminal.
[[ -n "$bundled_assets_root" ]] ||
  fail_with image-registry abort "The published image was built before Orbit bundled its deployment assets and is not a supported install target (ADR-0016, ADR-0019)."
[[ "$bundled_assets_root" == "$deployment_assets_root" ]] ||
  fail "The published image records deployment assets somewhere other than ${deployment_assets_root}."
readonly bundled_assets_root

installer_ui_event identity image running image-identity inspect
if ! docker run --rm --entrypoint /opt/orbit/scripts/container-entrypoint.sh \
  "$resolved_reference" --banner; then
  fail "The resolved Orbit image could not render its canonical banner."
fi
installer_ui_event identity image completed image-identity verify

gather_host_facts
engine_host_identity

# The engine: everything that reads or writes the deployment (F1). It prints
# its own events and questions; what happened comes back in its outcome.
run_engine
if ! read_engine_outcome; then
  installer_ui_phase=configuration
  installer_ui_component=configuration
  fail_with failure retry "The install engine stopped without reporting a result (docker run exit status ${engine_status}); see the lines above. A hard interruption leaves its staging directory for review: remove it, then rerun."
fi
case "${engine_outcome[status]}" in
  ok)
    [[ "$engine_status" == 0 ]] ||
      fail_with failure retry "The install engine reported success but exited with status ${engine_status}."
    ;;
  failed)
    # The engine has already rolled back, and handed the launcher its tree
    # on a configuration-failure; the terminal event is this script's.
    installer_ui_phase="${engine_outcome[phase]:-configuration}"
    installer_ui_component="${engine_outcome[component]:-configuration}"
    fail_with "${engine_outcome[reason]:-failure}" "${engine_outcome[action]:-retry}" \
      "${engine_outcome[message]:-The install engine failed.}"
    ;;
  stopped)
    # Cancelled (130), the terminal closed (1) or an answer was refused (2);
    # the engine said which, and nothing was changed.
    flush_pending_ui_events
    [[ "$engine_status" =~ ^(1|2|130)$ ]] || engine_status=1
    exit "$engine_status"
    ;;
  repair)
    flush_pending_ui_events
    exit 3
    ;;
esac

# --- after the commit: Compose (F1's third phase) ---------------------------

# The files are committed by now: a failure from here on never restores
# files, and is never configuration-failure, which tells the launcher to
# reconfigure (#1227).
target_was_empty="${engine_outcome[fresh]}"
selected_profile="${engine_outcome[profile]}"
load_installer_ui || fail_with failure retry "The deployment's installer UI helper is unavailable."

compose_project_name="$(read_environment_value COMPOSE_PROJECT_NAME 2>/dev/null)" ||
  fail_with failure retry "Could not read the deployment's Docker Compose project name; refusing to start Compose."
[[ "$compose_project_name" =~ ^[a-z0-9][a-z0-9_-]*$ ]] ||
  fail_with failure retry "Could not verify the configured Docker Compose project name; refusing to start Compose."

# Guarantee #17: the database volume this update attached to is still the
# one, and the only one, by that exact name.
if [[ -n "${engine_outcome[database-volume]}" ]]; then
  recheck_volume="${engine_outcome[database-volume]}"
  recheck_list="$(docker volume ls --filter "name=^${recheck_volume}\$" --format '{{.Name}}' 2>/dev/null)" ||
    fail_with failure retry "Could not verify the existing Orbit database volume; refusing to start Compose."
  [[ "$recheck_list" == "$recheck_volume" ]] ||
    fail_with failure retry "The existing Orbit database volume changed during installation; refusing to start Compose."
fi

if [[ "${engine_outcome[model-pull]}" == 1 ]]; then
  model_pull_requested=1
  model_pull_value="$(read_environment_value OLLAMA_MODEL 2>/dev/null)" ||
    fail_with failure retry "The confirmed local model could not be read from the configuration."
fi

export ORBIT_IMAGE="$resolved_reference"
installer_ui_phase=compose
installer_ui_component=compose
if ! compose config --quiet >/dev/null 2>&1; then
  fail_with failure retry "Docker Compose configuration is invalid; review the named configuration fields and rerun."
fi
installer_ui_event compose compose completed compose-validation check
printf 'Orbit installer: configuration, OIDC discovery, and Docker Compose preflight passed; starting services.\n'

prepare_service_images
wait_for_deployment_readiness

installer_ui_phase=complete
installer_ui_component=installer
installer_ui_event complete installer completed deployment-ready complete
print_completion_screen
