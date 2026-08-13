#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

readonly environment_file=".env-orbit"
readonly environment_example=".env-orbit.example"
readonly secrets_directory=".orbit-secrets"
readonly oidc_secret_file="$secrets_directory/oidc-client-secret"
readonly oidc_secret_file_path="/run/orbit-secrets/orbit-oidc-client-secret"
readonly maximum_secret_bytes=65536
temporary_file=""
terminal_fd=""
terminal_echo_disabled=0
installer_ui_input_loaded=0
installer_ui_path="$repo_dir/scripts/installer-ui.sh"
if [[ -f "$installer_ui_path" && ! -L "$installer_ui_path" ]]; then
  # shellcheck source=/dev/null
  source "$installer_ui_path"
  if declare -F installer_ui_read_text >/dev/null &&
    declare -F installer_ui_read_secret >/dev/null; then
    installer_ui_input_loaded=1
  fi
fi

# docs/engine-events.md "Machine prompts (v0)". Opt-in only: byte-identical
# to today's TTY prompting unless the caller sets this exact value. The
# duplicated descriptor is opened here, before any command substitution, so
# that machine_prompt_collect (invoked as `var="$(machine_prompt_collect ...)"`
# below) can still write protocol lines to the real stdout from inside a
# subshell whose own stdout is being captured by that substitution.
machine_prompts=0
if [[ "${ORBIT_CONFIGURE_PROMPTS:-}" == machine ]]; then
  machine_prompts=1
fi
machine_prompt_fd=""
if [[ "$machine_prompts" == 1 ]]; then
  exec {machine_prompt_fd}>&1
fi

run_configuration_preflight() {
  [[ -f scripts/configuration.sh ]] || return 0
  [[ ! -e "$environment_file" ]] && return 0
  local preflight_status=0 preflight_output=""
  preflight_output="$(bash scripts/configuration.sh --preflight --file "$environment_file" 2>/dev/null)" || preflight_status=$?
  [[ "$preflight_status" == 0 ]] || fail "Configuration preflight failed; restoring the previous deployment."
  if grep -q '^safely_migratable ORBIT_CONFIG_SCHEMA_VERSION$' <<< "$preflight_output"; then
    fail "configuration_migration_required"
  fi
}

fail() {
  printf 'Orbit configuration: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'Usage: %s [--check|--init|--set-oidc-secret|--set-deployment-profile PRESET [MODEL]]\n' "$0" >&2
}

cleanup() {
  if [[ "$terminal_echo_disabled" == 1 && -n "$terminal_fd" ]]; then
    stty echo <&"$terminal_fd" 2>/dev/null || true
    terminal_echo_disabled=0
  fi
  if [[ -n "$terminal_fd" ]]; then
    exec {terminal_fd}>&-
    terminal_fd=""
  fi
  if [[ -n "$machine_prompt_fd" ]]; then
    exec {machine_prompt_fd}>&-
    machine_prompt_fd=""
  fi
  [[ -z "$temporary_file" ]] || rm -f -- "$temporary_file"
}

trap cleanup EXIT

open_controlling_terminal() {
  [[ -n "$terminal_fd" ]] && return 0
  if ! { exec {terminal_fd}<>/dev/tty; } 2>/dev/null; then
    terminal_fd=""
    return 1
  fi
}

read_guided_line() {
  local prompt="$1" input

  if [[ -n "$terminal_fd" ]]; then
    if [[ "$installer_ui_input_loaded" == 1 ]]; then
      input="$(installer_ui_read_text "$terminal_fd" "$prompt" 2048)" || return $?
    else
      printf '%s' "$prompt" >&"$terminal_fd"
      IFS= read -r -u "$terminal_fd" input || return 1
    fi
  else
    IFS= read -r -p "$prompt" input || return 1
  fi
  printf '%s' "$input"
}

disable_terminal_echo() {
  stty -echo <&"$terminal_fd" 2>/dev/null ||
    fail "Could not secure hidden terminal input."
  terminal_echo_disabled=1
}

restore_terminal_echo() {
  if [[ "$terminal_echo_disabled" == 1 ]]; then
    stty echo <&"$terminal_fd" 2>/dev/null ||
      fail "Could not restore terminal input."
    terminal_echo_disabled=0
  fi
}

generate_hex_secret() {
  local secret

  if command -v openssl >/dev/null 2>&1; then
    secret="$(openssl rand -hex 32)"
  elif [[ -r /dev/urandom ]] && command -v od >/dev/null 2>&1; then
    secret="$(od -An -N32 -tx1 /dev/urandom | tr -d '[:space:]')"
  else
    fail "OpenSSL or a readable /dev/urandom with od is required to generate secrets."
  fi

  [[ "$secret" =~ ^[0-9a-fA-F]{64}$ ]] || fail "Secure secret generation failed."
  printf '%s\n' "${secret,,}"
}

example_active_value() {
  local requested_key="$1" line value="" found=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "${requested_key}="* ]]; then
      value="${line#*=}"
      found=$((found + 1))
    fi
  done < "$environment_example"
  [[ "$found" == 1 ]] || return 1
  printf '%s' "$value"
}

write_minimal_environment() {
  local heading key value
  while [[ $# -gt 0 ]]; do
    heading="$1"
    shift
    printf '# --- %s ---\n' "$heading"
    while [[ $# -gt 0 && "$1" != --section ]]; do
      key="$1"
      shift
      if [[ "$key" == managed:* ]]; then
        key="${key#managed:}"
        if [[ "$key" == OIDC_CLIENT_SECRET_FILE ]]; then
          printf '# %s=%s\n' "$key" "$oidc_secret_file_path"
        else
          printf '# %s=\n' "$key"
        fi
      else
        value="$(example_active_value "$key")" || return 1
        printf '%s=%s\n' "$key" "$value"
      fi
    done
    [[ $# -eq 0 ]] || shift
    printf '\n'
  done
}

ensure_environment_file() {
  [[ -f "$environment_example" ]] ||
    fail "${environment_example} is missing."

  if [[ -e "$environment_file" ]]; then
    [[ -f "$environment_file" && ! -L "$environment_file" ]] ||
      fail "Refusing to use ${environment_file} because it is not a regular file."
    chmod 600 "$environment_file" ||
      fail "Could not restrict ${environment_file} permissions."
    return
  fi

  temporary_file="$(mktemp "$PWD/.env-orbit.installing.XXXXXX")" ||
    fail "Could not create a temporary Orbit environment file."
  chmod 600 "$temporary_file" ||
    fail "Could not secure the temporary Orbit environment file."
  write_minimal_environment \
    'Core' ORBIT_CONFIG_SCHEMA_VERSION APP_URL ORBIT_IMAGE managed:ORBIT_CONFIG_APPLIED_VERSION managed:ORBIT_CONFIG_APPLIED_DIGEST --section \
    'Authentication' OIDC_ISSUER OIDC_CLIENT_ID OIDC_CLIENT_SECRET managed:OIDC_CLIENT_SECRET_FILE OIDC_CALLBACK_URL --section \
    'Generated secrets and keys' SESSION_SECRET_FILE DOCUMENT_KEK_FILE POSTGRES_PASSWORD_FILE VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY_FILE --section \
    'Deployment' managed:COMPOSE_PROJECT_NAME ORBIT_BIND_ADDRESS ORBIT_PORT COMPOSE_PROFILES POSTGRES_DB POSTGRES_USER --section \
    'Optional services' TIKA_URL OLLAMA_MODEL IMAP_ENABLED --section \
    'Observability' ORBIT_LOG_LEVEL ORBIT_LOG_FORMAT > "$temporary_file" ||
    fail "Could not create a concise Orbit environment file from the supported defaults."
  mv -- "$temporary_file" "$environment_file"
  temporary_file=""
  printf 'Created %s from %s.\n' "$environment_file" "$environment_example"
}

ensure_secrets_directory() {
  if [[ -e "$secrets_directory" ]]; then
    [[ -d "$secrets_directory" && ! -L "$secrets_directory" ]] ||
      fail "Refusing to use ${secrets_directory} because it is not a regular directory."
  else
    mkdir -- "$secrets_directory"
  fi
  chmod 700 "$secrets_directory" ||
    fail "Could not restrict ${secrets_directory} permissions."
}

# Reusable atomic updater for installer-managed keys in $environment_file. It
# accepts one or more KEY VALUE pairs, rewrites the first active "KEY=..."
# assignment for each in place, drops any further duplicate active
# assignments for the same key, and appends each assignment at the end of
# the file when none was present, in the order given. Every other line,
# including comments, is copied through byte-for-byte. All pairs are applied
# in a single atomic rewrite.
update_managed_keys() {
  local temp line key found final_newline=1 output_line index last_byte=""
  local -a input_lines=() output_lines=()
  local -A pending=() written=()
  local -a order=()

  while [[ $# -gt 0 ]]; do
    key="$1"
    pending["$key"]="$2"
    order+=("$key")
    shift 2
  done

  temp="$(mktemp "$PWD/.env-orbit.updating.XXXXXX")" ||
    fail "Could not create a temporary Orbit environment file."
  temporary_file="$temp"
  chmod 600 "$temp" ||
    fail "Could not secure the temporary Orbit environment file."

  mapfile -t input_lines < "$environment_file" ||
    fail "Could not read ${environment_file} for an atomic update."
  if [[ -s "$environment_file" ]]; then
    # Command substitution strips trailing newlines, so inspect the final byte
    # as hex when preserving the source file's exact newline convention.
    last_byte="$(tail -c 1 -- "$environment_file" | od -An -t x1 | tr -d '[:space:]')"
    [[ "$last_byte" == 0a ]] || final_newline=0
  fi

  for line in "${input_lines[@]}"; do
    found=0

    # Keep the file-backed OIDC selector beside its authentication
    # documentation. Active managed lines are the only lines eligible for
    # relocation. The obsolete commented selector itself is replaced so a
    # valid file-backed secret does not still look disabled. Other comments
    # and unmanaged operator lines pass through unchanged.
    if [[ -n "${pending[OIDC_CLIENT_SECRET_FILE]+present}" &&
      "$line" == "# OIDC_CLIENT_SECRET_FILE="* ]]; then
      if [[ -z "${written[OIDC_CLIENT_SECRET_FILE]:-}" ]]; then
        output_lines+=("OIDC_CLIENT_SECRET_FILE=${pending[OIDC_CLIENT_SECRET_FILE]}")
        written[OIDC_CLIENT_SECRET_FILE]=1
      fi
      continue
    fi

    for key in "${order[@]}"; do
      if [[ "$line" == "${key}="* ]]; then
        found=1
        if [[ "$key" == OIDC_CLIENT_SECRET_FILE ]]; then
          # The canonical location is emitted at the documented selector or
          # immediately after OIDC_CLIENT_SECRET below. Do not retain an
          # older active copy in an arbitrary location.
          break
        elif [[ -z "${written[$key]:-}" ]]; then
          output_lines+=("$key=${pending[$key]}")
          written["$key"]=1
        fi
        break
      fi
    done

    if [[ "$found" == 0 ]]; then
      output_lines+=("$line")
    fi
    if [[ -n "${pending[OIDC_CLIENT_SECRET_FILE]+present}" &&
      -z "${written[OIDC_CLIENT_SECRET_FILE]:-}" &&
      "$line" == OIDC_CLIENT_SECRET=* ]]; then
      output_lines+=("OIDC_CLIENT_SECRET_FILE=${pending[OIDC_CLIENT_SECRET_FILE]}")
      written[OIDC_CLIENT_SECRET_FILE]=1
    fi
  done
  for key in "${order[@]}"; do
    if [[ -z "${written[$key]:-}" ]]; then
      output_lines+=("$key=${pending[$key]}")
      # Adding a new assignment requires a line boundary after the value,
      # even when the source file ended without one.
      final_newline=1
    fi
  done

  for index in "${!output_lines[@]}"; do
    output_line="${output_lines[index]}"
    if ((index == ${#output_lines[@]} - 1 && final_newline == 0)); then
      printf '%s' "$output_line"
    else
      printf '%s\n' "$output_line"
    fi
  done > "$temp"

  mv -- "$temp" "$environment_file" ||
    fail "Could not persist configuration in ${environment_file}."
  temporary_file=""
}

persist_orbit_image() {
  local orbit_image="${ORBIT_IMAGE:-}"
  [[ -n "$orbit_image" ]] || return 0
  if ! is_valid_orbit_image "$orbit_image"; then
    fail "ORBIT_IMAGE must be an immutable registry digest or the installer-generated local build tag."
  fi
  update_managed_keys ORBIT_IMAGE "$orbit_image"
}

is_valid_local_model() {
  local value="$1"
  [[ ${#value} -ge 1 && ${#value} -le 128 ]] || return 1
  [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9][A-Za-z0-9._-]*)?$ ]]
}

set_deployment_profile() {
  local preset="$1" model="${2:-}" profiles="" tika_url=""

  case "$preset" in
    standard)
      [[ -z "$model" ]] || return 2
      ;;
    processing)
      [[ -z "$model" ]] || return 2
      profiles="processing"
      tika_url="http://orbit-tika:9998"
      ;;
    ai)
      is_valid_local_model "$model" || return 2
      profiles="ai"
      ;;
    full)
      is_valid_local_model "$model" || return 2
      profiles="processing,ai"
      tika_url="http://orbit-tika:9998"
      ;;
    *) return 2 ;;
  esac

  ensure_environment_file
  update_managed_keys \
    COMPOSE_PROFILES "$profiles" \
    TIKA_URL "$tika_url" \
    OLLAMA_MODEL "$model"
  printf 'Orbit deployment profile saved: %s.\n' "$preset"
}

# --- Guided configuration (--init) validation -------------------------------
#
# Shared by the guided prompts below and by --check readiness, so both agree
# on what counts as a deployment-ready public origin or issuer URL.

readonly hostname_pattern='^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$'

is_valid_orbit_image() {
  [[ "$1" =~ ^orbit-local:[0-9a-f]{12}$ || "$1" =~ ^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$ ]]
}

contains_forbidden_characters() {
  [[ "$1" =~ [[:cntrl:][:space:]] ]]
}

is_forbidden_host() {
  local host="$1"
  case "$host" in
    127.0.0.1 | 127.0.0.1:* | localhost | localhost:* | 0.0.0.0 | 0.0.0.0:* | ::1 | ::1:*)
      return 0
      ;;
    127.*)
      return 0
      ;;
    example.com | example.com:* | *.example.com | *.example.com:*)
      return 0
      ;;
  esac
  return 1
}

validate_authority() {
  local authority="$1" host="$1" port=""
  if [[ "$authority" == *:* ]]; then
    host="${authority%:*}"
    port="${authority##*:}"
    [[ "$port" =~ ^[0-9]{1,5}$ ]] || return 1
    (( 10#$port >= 1 && 10#$port <= 65535 )) || return 1
  fi
  [[ "$host" =~ $hostname_pattern ]] || return 1
  ! is_forbidden_host "$host"
}

is_valid_client_id() {
  [[ -n "$1" ]] && ! contains_forbidden_characters "$1"
}

# Validates a complete public origin (scheme + host, no credentials, path,
# query or fragment) and prints its lowercase-normalised form on success.
normalize_public_origin() {
  local value="$1" host lower

  if contains_forbidden_characters "$value"; then
    return 1
  fi
  case "$value" in
    https://*) ;;
    *) return 1 ;;
  esac
  case "$value" in
    *@*) return 1 ;;
  esac
  case "$value" in
    *'?'*) return 1 ;;
  esac
  case "$value" in
    *'#'*) return 1 ;;
  esac

  value="${value%/}"
  host="${value#https://}"
  case "$host" in
    */*) return 1 ;;
  esac
  [[ -n "$host" ]] || return 1

  lower="${host,,}"
  validate_authority "$lower" || return 1

  printf 'https://%s' "$lower"
}

# Validates an OIDC issuer URL. A path is allowed because the issuer is
# provider-specific; credentials, query and fragment are still rejected.
validate_oidc_issuer() {
  local value="$1" authority lower

  if contains_forbidden_characters "$value"; then
    return 1
  fi
  case "$value" in
    https://*) ;;
    *) return 1 ;;
  esac
  case "$value" in
    *@*) return 1 ;;
  esac
  case "$value" in
    *'?'*) return 1 ;;
  esac
  case "$value" in
    *'#'*) return 1 ;;
  esac

  authority="${value#https://}"
  authority="${authority%%/*}"
  [[ -n "$authority" ]] || return 1

  lower="${authority,,}"
  validate_authority "$lower" || return 1
  return 0
}

prompt_app_url() {
  local input normalized
  while true; do
    if ! input="$(read_guided_line 'Public Orbit origin (e.g. https://orbit.your-domain.tld): ')"; then
      return 1
    fi
    if normalized="$(normalize_public_origin "$input")"; then
      printf '%s' "$normalized"
      return 0
    fi
    printf 'Enter a complete https:// public origin with no credentials, path, query, fragment, loopback address or example.com placeholder.\n' >&2
  done
}

prompt_oidc_issuer() {
  local input
  while true; do
    if ! input="$(read_guided_line 'OIDC issuer URL (e.g. https://sso.your-domain.tld/application/o/orbit/): ')"; then
      return 1
    fi
    if validate_oidc_issuer "$input"; then
      printf '%s' "$input"
      return 0
    fi
    printf 'Enter a complete https:// issuer URL with no credentials, query, fragment, loopback address or example.com placeholder.\n' >&2
  done
}

prompt_oidc_client_id() {
  local input
  while true; do
    if ! input="$(read_guided_line 'OIDC client ID: ')"; then
      return 1
    fi
    if is_valid_client_id "$input"; then
      printf '%s' "$input"
      return 0
    fi
    printf 'Enter a non-empty OIDC client ID with no whitespace or control characters.\n' >&2
  done
}

# --- Machine prompt mode (ORBIT_CONFIGURE_PROMPTS=machine) -------------------
#
# docs/engine-events.md "Machine prompts (v0)" documents the exact line
# grammar and field/kind/reason vocabulary emitted here. Acceptance is
# decided solely by the same validators the TTY prompts above call
# (normalize_public_origin, validate_oidc_issuer, is_valid_client_id, and the
# OIDC client secret's existing non-empty/size checks below); the
# classify_*_rejection helpers only pick a reason label for an answer already
# known to be rejected and never themselves gate acceptance.

machine_prompt_field_kind() {
  case "$1" in
    APP_URL) printf 'url' ;;
    OIDC_ISSUER) printf 'url' ;;
    OIDC_CALLBACK_URL) printf 'url' ;;
    OIDC_CLIENT_ID) printf 'text' ;;
    OIDC_CLIENT_SECRET) printf 'secret' ;;
    *) return 1 ;;
  esac
}

# --- reason vocabulary (docs/engine-events.md "Machine prompts (v0)") -------

# Classifies a rejected URL-kind answer exactly the way normalize_public_origin
# (allow_path=0, APP_URL) and validate_oidc_issuer (allow_path=1, OIDC_ISSUER)
# parse one, using the same primitives those validators use.
classify_url_rejection() {
  local value="$1" allow_path="$2" host
  if [[ -z "$value" ]]; then
    printf 'empty'
    return
  fi
  if contains_forbidden_characters "$value"; then
    printf 'invalid-characters'
    return
  fi
  case "$value" in
    https://*) ;;
    *)
      printf 'not-https'
      return
      ;;
  esac
  case "$value" in
    *@*)
      printf 'not-absolute-url'
      return
      ;;
  esac
  case "$value" in
    *'?'*)
      printf 'not-absolute-url'
      return
      ;;
  esac
  case "$value" in
    *'#'*)
      printf 'not-absolute-url'
      return
      ;;
  esac
  host="${value#https://}"
  if [[ "$allow_path" == 1 ]]; then
    host="${host%%/*}"
  else
    host="${host%/}"
    case "$host" in
      */*)
        printf 'not-absolute-url'
        return
        ;;
    esac
  fi
  if [[ -z "$host" ]]; then
    printf 'not-absolute-url'
    return
  fi
  if is_forbidden_host "${host,,}"; then
    printf 'forbidden-host'
    return
  fi
  printf 'not-absolute-url'
}

classify_app_url_rejection() {
  classify_url_rejection "$1" 0
}

classify_oidc_issuer_rejection() {
  classify_url_rejection "$1" 1
}

classify_oidc_client_id_rejection() {
  if [[ -z "$1" ]]; then
    printf 'empty'
  else
    printf 'invalid-characters'
  fi
}

# Mirrors, and never replaces, the non-empty/size checks set_oidc_secret
# applies below after reading its answer; kept separate rather than shared so
# machine mode can never change that function's existing default-path
# behaviour.
classify_oidc_secret_rejection() {
  if [[ -z "$1" ]]; then
    printf 'empty'
  else
    printf 'too-large'
  fi
}

# --- end reason vocabulary ---------------------------------------------

# validate_oidc_issuer and is_valid_client_id are plain predicates; wrap them
# so machine_prompt_collect's validator callback can use the same "print the
# accepted value, or print nothing and fail" contract normalize_public_origin
# already implements directly.
machine_validate_oidc_issuer() {
  validate_oidc_issuer "$1" && printf '%s' "$1"
}

machine_validate_oidc_client_id() {
  is_valid_client_id "$1" && printf '%s' "$1"
}

machine_validate_oidc_secret() {
  local value="$1" bytes
  [[ -n "$value" ]] || return 1
  bytes="$(printf '%s' "$value" | wc -c | tr -d '[:space:]')"
  [[ "$bytes" =~ ^[0-9]+$ ]] || return 1
  [[ "$bytes" -le "$maximum_secret_bytes" ]] || return 1
  printf '%s' "$value"
}

# Drives one machine-mode field to completion: emits a `prompt` line, reads
# exactly one answer line from standard input, and emits `prompt-accept` or
# `prompt-reject` per docs/engine-events.md. Never prints the answer itself.
# Aborts (emits `prompt-abort` and returns failure, for the caller's existing
# refusal path) after a third rejected attempt or on end-of-input.
machine_prompt_collect() {
  local field="$1" validator="$2" classifier="$3"
  local kind attempt=1 input value reason
  kind="$(machine_prompt_field_kind "$field")" || return 2
  while ((attempt <= 3)); do
    printf 'prompt field=%s kind=%s required=true attempt=%d\n' \
      "$field" "$kind" "$attempt" >&"$machine_prompt_fd"
    if ! IFS= read -r input; then
      printf 'prompt-abort field=%s\n' "$field" >&"$machine_prompt_fd"
      return 1
    fi
    if value="$("$validator" "$input")"; then
      printf 'prompt-accept field=%s\n' "$field" >&"$machine_prompt_fd"
      printf '%s' "$value"
      return 0
    fi
    reason="$("$classifier" "$input")"
    printf 'prompt-reject field=%s reason=%s\n' "$field" "$reason" >&"$machine_prompt_fd"
    attempt=$((attempt + 1))
  done
  printf 'prompt-abort field=%s\n' "$field" >&"$machine_prompt_fd"
  return 1
}

# Guided (--init) collection of the non-secret public URL and OIDC values.
# Prompts interactively only when stdin/stdout are terminals; otherwise the
# complete ORBIT_CONFIGURE_APP_URL / ORBIT_CONFIGURE_OIDC_ISSUER /
# ORBIT_CONFIGURE_OIDC_CLIENT_ID environment set is required and a partial
# set is refused. Values are never echoed. Nothing is written until every
# input validates.
guided_init() {
  local env_count=0
  if [[ -n "${ORBIT_CONFIGURE_APP_URL:-}" ]]; then env_count=$((env_count + 1)); fi
  if [[ -n "${ORBIT_CONFIGURE_OIDC_ISSUER:-}" ]]; then env_count=$((env_count + 1)); fi
  if [[ -n "${ORBIT_CONFIGURE_OIDC_CLIENT_ID:-}" ]]; then env_count=$((env_count + 1)); fi

  local app_url issuer client_id

  if [[ "$env_count" -eq 3 ]]; then
    app_url="$ORBIT_CONFIGURE_APP_URL"
    issuer="$ORBIT_CONFIGURE_OIDC_ISSUER"
    client_id="$ORBIT_CONFIGURE_OIDC_CLIENT_ID"
  elif [[ "$env_count" -gt 0 ]]; then
    fail "Guided configuration requires all of ORBIT_CONFIGURE_APP_URL, ORBIT_CONFIGURE_OIDC_ISSUER and ORBIT_CONFIGURE_OIDC_CLIENT_ID together, not a partial set."
  elif [[ "$machine_prompts" == 1 ]]; then
    if ! app_url="$(machine_prompt_collect APP_URL normalize_public_origin classify_app_url_rejection)"; then
      fail "Guided configuration was cancelled."
    fi
    if ! issuer="$(machine_prompt_collect OIDC_ISSUER machine_validate_oidc_issuer classify_oidc_issuer_rejection)"; then
      fail "Guided configuration was cancelled."
    fi
    if ! client_id="$(machine_prompt_collect OIDC_CLIENT_ID machine_validate_oidc_client_id classify_oidc_client_id_rejection)"; then
      fail "Guided configuration was cancelled."
    fi
  elif open_controlling_terminal; then
    if ! app_url="$(prompt_app_url)"; then
      fail "Guided configuration was cancelled."
    fi
    if ! issuer="$(prompt_oidc_issuer)"; then
      fail "Guided configuration was cancelled."
    fi
    if ! client_id="$(prompt_oidc_client_id)"; then
      fail "Guided configuration was cancelled."
    fi
  else
    fail "Guided configuration needs a controlling terminal, or the complete ORBIT_CONFIGURE_APP_URL, ORBIT_CONFIGURE_OIDC_ISSUER and ORBIT_CONFIGURE_OIDC_CLIENT_ID environment set for non-interactive use."
  fi

  local normalized_app_url
  if ! normalized_app_url="$(normalize_public_origin "$app_url")"; then
    fail "APP_URL must be a complete https:// public origin with no credentials, path, query, fragment, loopback address or example.com placeholder."
  fi

  if ! validate_oidc_issuer "$issuer"; then
    fail "OIDC_ISSUER must be a complete https:// issuer URL with no credentials, query, fragment, loopback address or example.com placeholder."
  fi

  if ! is_valid_client_id "$client_id"; then
    fail "OIDC_CLIENT_ID must be a non-empty value with no whitespace or control characters."
  fi

  local callback_url="${normalized_app_url}/api/auth/callback"

  ensure_environment_file
  update_managed_keys \
    APP_URL "$normalized_app_url" \
    OIDC_ISSUER "$issuer" \
    OIDC_CLIENT_ID "$client_id" \
    OIDC_CALLBACK_URL "$callback_url"

  printf 'Orbit guided configuration saved APP_URL, OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CALLBACK_URL.\n'
}

ensure_secret_file() {
  local path="$1" existing_value secret

  if [[ -e "$path" ]]; then
    [[ -f "$path" && ! -L "$path" ]] ||
      fail "Refusing to use ${path} because it is not a regular file."
    existing_value="$(tr -d '\r\n' < "$path")"
    [[ "$existing_value" =~ ^[0-9a-fA-F]{64}$ ]] ||
      fail "${path} does not contain a valid 256-bit hexadecimal secret."
    chmod 600 "$path" ||
      fail "Could not restrict permissions on ${path}."
    unset existing_value
    return
  fi

  secret="$(generate_hex_secret)"
  temporary_file="$(mktemp "$secrets_directory/.installing.XXXXXX")" ||
    fail "Could not create a temporary Orbit secret file."
  printf '%s\n' "$secret" > "$temporary_file"
  chmod 600 "$temporary_file" ||
    fail "Could not restrict permissions on the Orbit secret."
  mv -- "$temporary_file" "$path"
  temporary_file=""
  unset secret
  printf 'Generated %s.\n' "$path"
}

environment_key_is_nonempty() {
  local requested_key="$1" line value="" found=0
  [[ -f "$environment_file" && ! -L "$environment_file" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "${requested_key}="* ]]; then
      value="${line#*=}"
      found=1
    fi
  done < "$environment_file"
  [[ "$found" == 1 && -n "$value" ]]
}

# Creates a zero-byte, mode-0600 placeholder only when no OIDC client secret
# file exists yet: the protected Compose secret declaration requires a host
# source to exist even before an operator runs --set-oidc-secret. An existing
# regular file is preserved byte-for-byte; a symlink or other non-regular path
# is refused rather than silently followed or replaced.
ensure_oidc_secret_placeholder() {
  # Existing direct-value deployments remain valid and must not gain a second
  # active secret form merely because the installer now performs readiness
  # checks. A direct value and a file-backed value remain mutually exclusive.
  if environment_key_is_nonempty OIDC_CLIENT_SECRET &&
    ! environment_key_is_nonempty OIDC_CLIENT_SECRET_FILE; then
    return 0
  fi

  if [[ -e "$oidc_secret_file" ]]; then
    [[ -f "$oidc_secret_file" && ! -L "$oidc_secret_file" ]] ||
      fail "Refusing to use ${oidc_secret_file} because it is not a regular file."
    chmod 600 "$oidc_secret_file" ||
      fail "Could not restrict permissions on ${oidc_secret_file}."
    return
  fi

  temporary_file="$(mktemp "$secrets_directory/.installing.XXXXXX")" ||
    fail "Could not create a temporary Orbit secret file."
  chmod 600 "$temporary_file" ||
    fail "Could not restrict permissions on the OIDC client secret placeholder."
  mv -- "$temporary_file" "$oidc_secret_file"
  temporary_file=""
}

# Reads the OIDC client secret once from standard input, never from an
# argument, and never prints, logs or exports it. The secret is written
# atomically to a mode-0600 file, and only after that write succeeds are the
# matching environment variables persisted; update_managed_keys never
# receives the secret value itself, only the fixed empty direct value and the
# fixed canonical runtime file path.
set_oidc_secret() {
  local secret secret_bytes

  if [[ "$machine_prompts" == 1 ]]; then
    if ! secret="$(machine_prompt_collect OIDC_CLIENT_SECRET machine_validate_oidc_secret classify_oidc_secret_rejection)"; then
      fail "Could not read a complete OIDC client secret from standard input."
    fi
  elif [[ "${ORBIT_CONFIGURE_TTY_INPUT:-}" == 1 ]] &&
    open_controlling_terminal; then
    if [[ "$installer_ui_input_loaded" == 1 ]]; then
      secret="$(installer_ui_read_secret "$terminal_fd" 'OIDC client secret (input hidden): ' "$maximum_secret_bytes")" ||
        fail "Could not read a complete OIDC client secret from the controlling terminal."
    else
      disable_terminal_echo
      printf 'OIDC client secret (input hidden): ' >&"$terminal_fd"
      if ! IFS= read -r -s -u "$terminal_fd" secret; then
        restore_terminal_echo
        printf '\n' >&"$terminal_fd"
        fail "Could not read a complete OIDC client secret from the controlling terminal."
      fi
      restore_terminal_echo
      printf '\n' >&"$terminal_fd"
    fi
  elif [[ -t 0 ]]; then
    if ! IFS= read -r -s -p '' secret; then
      fail "Could not read a complete OIDC client secret from standard input."
    fi
  elif ! IFS= read -r -p '' secret; then
    fail "Could not read a complete OIDC client secret from standard input."
  fi
  [[ -n "$secret" ]] ||
    fail "Could not read a non-empty OIDC client secret from standard input."
  secret_bytes="$(printf '%s' "$secret" | wc -c | tr -d '[:space:]')"
  [[ "$secret_bytes" =~ ^[0-9]+$ ]] ||
    fail "Could not determine the OIDC client secret size."
  [[ "$secret_bytes" -le "$maximum_secret_bytes" ]] ||
    fail "The OIDC client secret exceeds the ${maximum_secret_bytes}-byte maximum."
  unset secret_bytes

  ensure_environment_file
  ensure_secrets_directory

  temporary_file="$(mktemp "$secrets_directory/.installing.XXXXXX")" ||
    fail "Could not create a temporary Orbit secret file."
  printf '%s' "$secret" > "$temporary_file"
  unset secret
  chmod 600 "$temporary_file" ||
    fail "Could not restrict permissions on the OIDC client secret."
  mv -- "$temporary_file" "$oidc_secret_file" ||
    fail "Could not persist the OIDC client secret."
  temporary_file=""

  update_managed_keys \
    OIDC_CLIENT_SECRET "" \
    OIDC_CLIENT_SECRET_FILE "$oidc_secret_file_path"

  printf 'Orbit saved the OIDC client secret to %s.\n' "$oidc_secret_file"
}

ensure_vapid_keys() {
  local private_key_file="$secrets_directory/vapid-private-key" generated public_key private_key orbit_image bootstrap_image
  if [[ -s "$private_key_file" ]]; then
    chmod 600 "$private_key_file"
    return
  fi
  command -v docker >/dev/null 2>&1 || fail "Docker is required to generate VAPID keys."
  orbit_image="${ORBIT_IMAGE:-}"
  generated=""
  if [[ -n "$orbit_image" ]]; then
    if [[ ! "$orbit_image" =~ ^orbit-local:[0-9a-f]{12}$ && ! "$orbit_image" =~ ^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$ ]]; then
      fail "ORBIT_IMAGE must be an immutable registry digest or the installer-generated local build tag."
    fi
    if docker image inspect "$orbit_image" >/dev/null 2>&1 ||
      { [[ "$orbit_image" =~ @sha256: ]] && docker pull "$orbit_image" >/dev/null; }; then
      generated="$(docker run --rm --entrypoint node "$orbit_image" /opt/orbit/scripts/generate-vapid.mjs 2>/dev/null || true)"
    fi
  fi
  if [[ -z "$generated" ]]; then
    printf 'Building the Orbit bootstrap image to generate VAPID keys.\n'
    bootstrap_image="orbit-vapid-bootstrap:$(git rev-parse --short=12 HEAD)"
    docker build --target vapid-generator --tag "$bootstrap_image" . >/dev/null || fail "Could not build the Orbit bootstrap image."
    generated="$(docker run --rm "$bootstrap_image")" || fail "Could not generate VAPID keys."
  fi
  public_key="$(printf '%s\n' "$generated" | sed -n 's/^public=//p')"
  private_key="$(printf '%s\n' "$generated" | sed -n 's/^private=//p')"
  [[ -n "$public_key" && -n "$private_key" ]] || fail "VAPID key generation returned invalid values."
  temporary_file="$(mktemp "$secrets_directory/.vapid.installing.XXXXXX")"
  printf '%s\n' "$private_key" > "$temporary_file"
  chmod 600 "$temporary_file"
  mv -- "$temporary_file" "$private_key_file"
  temporary_file=""
  update_managed_keys \
    VAPID_PUBLIC_KEY "$public_key" \
    VAPID_PRIVATE_KEY_FILE "/run/orbit-secrets/orbit-vapid-private-key"
  printf 'Generated VAPID push keys.\n'
}

# Non-mutating readiness summary: fixed "ready"/"missing"/"optional" category
# words and variable names only. Values are never read into output.
run_check() {
  [[ -f "$environment_example" && ! -L "$environment_example" ]] ||
    fail "${environment_example} is missing."

  local source_path=""
  if [[ -e "$environment_file" ]]; then
    [[ -f "$environment_file" && ! -L "$environment_file" ]] ||
      fail "Refusing to use ${environment_file} because it is not a regular file."
    [[ "$(stat -c '%a' -- "$environment_file" 2>/dev/null)" == 600 ]] ||
      fail "Refusing to check ${environment_file} because its permissions are not restricted to the owner."
    source_path="$environment_file"
  fi

  local -A values=()
  local line key value
  if [[ -n "$source_path" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      values["$key"]="$value"
    done < "$source_path"
  fi

  local overall_status=0

  is_set() { [[ -n "${values[$1]:-}" ]]; }

  any_set() {
    local name
    for name in "$@"; do
      is_set "$name" && return 0
    done
    return 1
  }

  all_set() {
    local name
    for name in "$@"; do
      is_set "$name" || return 1
    done
    return 0
  }

  exactly_one_set() {
    local name count=0
    for name in "$@"; do
      if is_set "$name"; then
        count=$((count + 1))
      fi
    done
    [[ "$count" == 1 ]]
  }

  profile_enabled() {
    local requested="$1" profile
    local -a configured_profiles=()
    IFS=',' read -r -a configured_profiles <<< "${values[COMPOSE_PROFILES]:-}"
    for profile in "${configured_profiles[@]}"; do
      profile="${profile//[[:space:]]/}"
      [[ "$profile" == "$requested" ]] && return 0
    done
    return 1
  }

  report_required_bool() {
    local label="$1" ready="$2"
    if [[ "$ready" == 1 ]]; then
      printf 'ready %s\n' "$label"
    else
      printf 'missing %s\n' "$label"
      overall_status=1
    fi
  }

  report_optional() {
    local label="$1" ready="$2" present="$3"
    if [[ "$ready" == 1 ]]; then
      printf 'ready %s\n' "$label"
    elif [[ "$present" == 1 ]]; then
      printf 'missing %s\n' "$label"
      overall_status=1
    else
      printf 'optional %s\n' "$label"
    fi
  }

  local processing_present=0 processing_ready=0
  if profile_enabled processing || is_set TIKA_URL; then processing_present=1; fi
  if profile_enabled processing && is_set TIKA_URL; then processing_ready=1; fi

  local ai_present=0 ai_ready=0
  if profile_enabled ai || is_set OLLAMA_MODEL; then ai_present=1; fi
  if profile_enabled ai && is_set OLLAMA_MODEL; then ai_ready=1; fi

  local mail_present=0 mail_ready=0
  if any_set SMTP_HOST SMTP_USER SMTP_PASSWORD SMTP_PASSWORD_FILE SMTP_URL SMTP_URL_FILE; then
    mail_present=1
  fi
  if exactly_one_set SMTP_URL SMTP_URL_FILE && ! any_set SMTP_HOST SMTP_USER SMTP_PASSWORD SMTP_PASSWORD_FILE; then
    mail_ready=1
  elif all_set SMTP_HOST SMTP_USER \
    && exactly_one_set SMTP_PASSWORD SMTP_PASSWORD_FILE \
    && ! any_set SMTP_URL SMTP_URL_FILE; then
    mail_ready=1
  fi

  local imap_present=0 imap_ready=0
  if any_set IMAP_HOST IMAP_USER IMAP_PASSWORD IMAP_PASSWORD_FILE \
    IMAP_RECIPIENT_DOMAIN IMAP_ALIAS_CURRENT_GENERATION \
    IMAP_ALIAS_CURRENT_SECRET IMAP_ALIAS_CURRENT_SECRET_FILE \
    IMAP_TRUSTED_RECIPIENT_HEADER; then
    imap_present=1
  fi
  if [[ "${values[IMAP_ENABLED]:-false}" == true ]]; then imap_present=1; fi
  if [[ "${values[IMAP_ENABLED]:-false}" == true ]] \
    && all_set IMAP_HOST IMAP_USER IMAP_RECIPIENT_DOMAIN \
      IMAP_ALIAS_CURRENT_GENERATION IMAP_TRUSTED_RECIPIENT_HEADER \
    && exactly_one_set IMAP_PASSWORD IMAP_PASSWORD_FILE \
    && exactly_one_set IMAP_ALIAS_CURRENT_SECRET IMAP_ALIAS_CURRENT_SECRET_FILE \
    && [[ "$mail_ready" == 1 ]]; then
    imap_ready=1
  fi

  local push_present=0 push_ready=0
  if is_set VAPID_SUBJECT; then push_present=1; fi
  if is_set VAPID_SUBJECT && is_set VAPID_PUBLIC_KEY \
    && exactly_one_set VAPID_PRIVATE_KEY VAPID_PRIVATE_KEY_FILE; then
    push_ready=1
  fi

  # A ready APP_URL and OIDC_ISSUER must be a deployment-ready HTTPS value,
  # not the historical loopback default or a documented example.com
  # placeholder. OIDC_CALLBACK_URL is ready only when it exactly matches the
  # callback derived from a ready APP_URL.
  local app_url_ready=0 image_ready=0 issuer_ready=0 client_id_ready=0 callback_ready=0
  local normalized_app_url=""
  if is_set APP_URL; then
    normalized_app_url="$(normalize_public_origin "${values[APP_URL]}" || true)"
    if [[ -n "$normalized_app_url" ]]; then
      app_url_ready=1
    fi
  fi
  if is_set OIDC_ISSUER && validate_oidc_issuer "${values[OIDC_ISSUER]}"; then
    issuer_ready=1
  fi
  if is_set ORBIT_IMAGE && is_valid_orbit_image "${values[ORBIT_IMAGE]}"; then
    image_ready=1
  fi
  if is_set OIDC_CLIENT_ID && is_valid_client_id "${values[OIDC_CLIENT_ID]}"; then
    client_id_ready=1
  fi
  if [[ "$app_url_ready" == 1 && "${values[OIDC_CALLBACK_URL]:-}" == "${normalized_app_url}/api/auth/callback" ]]; then
    callback_ready=1
  fi

  # Direct-only stays ready for upgrade compatibility. File-backed is ready
  # only when the configured path is exactly the canonical runtime path and
  # the host file it names is non-empty, regular and not a symlink; direct-
  # plus-file, missing, empty, symlinked or non-canonical settings all report
  # missing without disclosing the configured value.
  local oidc_secret_ready=0
  if is_set OIDC_CLIENT_SECRET && ! is_set OIDC_CLIENT_SECRET_FILE; then
    oidc_secret_ready=1
  elif ! is_set OIDC_CLIENT_SECRET && is_set OIDC_CLIENT_SECRET_FILE \
    && [[ "${values[OIDC_CLIENT_SECRET_FILE]}" == "$oidc_secret_file_path" ]] \
    && [[ -d "$secrets_directory" && ! -L "$secrets_directory" ]] \
    && [[ "$(stat -c '%a' -- "$secrets_directory" 2>/dev/null)" == 700 ]] \
    && [[ -f "$oidc_secret_file" && ! -L "$oidc_secret_file" && -s "$oidc_secret_file" ]] \
    && [[ "$(stat -c '%a' -- "$oidc_secret_file" 2>/dev/null)" == 600 ]]; then
    oidc_secret_ready=1
  fi

  report_required_bool APP_URL "$app_url_ready"
  report_required_bool ORBIT_IMAGE "$image_ready"
  report_required_bool OIDC_ISSUER "$issuer_ready"
  report_required_bool OIDC_CLIENT_ID "$client_id_ready"
  report_required_bool OIDC_CLIENT_SECRET "$oidc_secret_ready"
  report_required_bool OIDC_CALLBACK_URL "$callback_ready"
  report_optional processing "$processing_ready" "$processing_present"
  report_optional ai "$ai_ready" "$ai_present"
  report_optional mail "$mail_ready" "$mail_present"
  report_optional imap "$imap_ready" "$imap_present"
  report_optional push "$push_ready" "$push_present"

  return "$overall_status"
}

case "${1:-}" in
  "")
    ;;
  --check)
    if [[ $# -ne 1 ]]; then
      usage
      exit 2
    fi
    if run_check; then
      exit 0
    else
      exit 1
    fi
    ;;
  --init)
    if [[ $# -ne 1 ]]; then
      usage
      exit 2
    fi
    guided_init
    exit 0
    ;;
  --set-oidc-secret)
    if [[ $# -ne 1 ]]; then
      usage
      exit 2
    fi
    set_oidc_secret
    exit 0
    ;;
  --set-deployment-profile)
    if [[ $# -lt 2 || $# -gt 3 ]]; then
      usage
      exit 2
    fi
    if ! set_deployment_profile "$2" "${3:-}"; then
      usage
      exit 2
    fi
    exit 0
    ;;
  *)
    usage
    exit 2
    ;;
esac

ensure_environment_file
run_configuration_preflight
persist_orbit_image
ensure_secrets_directory
ensure_secret_file "$secrets_directory/session-secret"
ensure_secret_file "$secrets_directory/postgres-password"
# A 32-byte hexadecimal KEK is generated only when absent and is never printed.
ensure_secret_file "$secrets_directory/document-kek"
ensure_oidc_secret_placeholder
ensure_vapid_keys

printf 'Orbit configuration is ready. Existing values were preserved.\n'
