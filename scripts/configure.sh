#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

readonly environment_file=".env-orbit"
readonly environment_example=".env-orbit.example"
readonly secrets_directory=".orbit-secrets"
temporary_file=""

fail() {
  printf 'Orbit configuration: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'Usage: %s [--check|--init]\n' "$0" >&2
}

cleanup() {
  [[ -z "$temporary_file" ]] || rm -f -- "$temporary_file"
}

trap cleanup EXIT

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
  cp -- "$environment_example" "$temporary_file"
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
  local temp line key found
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

  {
    while IFS= read -r line || [[ -n "$line" ]]; do
      found=0
      for key in "${order[@]}"; do
        if [[ "$line" == "${key}="* ]]; then
          found=1
          if [[ -z "${written[$key]:-}" ]]; then
            printf '%s=%s\n' "$key" "${pending[$key]}"
            written["$key"]=1
          fi
          break
        fi
      done
      [[ "$found" == 1 ]] || printf '%s\n' "$line"
    done < "$environment_file"
    for key in "${order[@]}"; do
      [[ -n "${written[$key]:-}" ]] || printf '%s=%s\n' "$key" "${pending[$key]}"
    done
  } > "$temp"

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
    if ! IFS= read -r -p 'Public Orbit origin (e.g. https://orbit.your-domain.tld): ' input; then
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
    if ! IFS= read -r -p 'OIDC issuer URL (e.g. https://sso.your-domain.tld/application/o/orbit/): ' input; then
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
    if ! IFS= read -r -p 'OIDC client ID: ' input; then
      return 1
    fi
    if is_valid_client_id "$input"; then
      printf '%s' "$input"
      return 0
    fi
    printf 'Enter a non-empty OIDC client ID with no whitespace or control characters.\n' >&2
  done
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
  elif [[ -t 0 && -t 1 ]]; then
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
    fail "Guided configuration needs an interactive terminal, or the complete ORBIT_CONFIGURE_APP_URL, ORBIT_CONFIGURE_OIDC_ISSUER and ORBIT_CONFIGURE_OIDC_CLIENT_ID environment set for non-interactive use."
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
    docker build --target runner --tag "$bootstrap_image" . >/dev/null || fail "Could not build the Orbit bootstrap image."
    generated="$(docker run --rm --entrypoint node "$bootstrap_image" /opt/orbit/scripts/generate-vapid.mjs)" || fail "Could not generate VAPID keys."
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

  report_required() {
    local label="$1"
    shift
    if exactly_one_set "$@"; then
      printf 'ready %s\n' "$label"
    else
      printf 'missing %s\n' "$label"
      overall_status=1
    fi
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

  report_required_bool APP_URL "$app_url_ready"
  report_required_bool ORBIT_IMAGE "$image_ready"
  report_required_bool OIDC_ISSUER "$issuer_ready"
  report_required_bool OIDC_CLIENT_ID "$client_id_ready"
  report_required OIDC_CLIENT_SECRET OIDC_CLIENT_SECRET OIDC_CLIENT_SECRET_FILE
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
  *)
    usage
    exit 2
    ;;
esac

ensure_environment_file
persist_orbit_image
ensure_secrets_directory
ensure_secret_file "$secrets_directory/session-secret"
ensure_secret_file "$secrets_directory/postgres-password"
# A 32-byte hexadecimal KEK is generated only when absent and is never printed.
ensure_secret_file "$secrets_directory/document-kek"
ensure_vapid_keys

printf 'Orbit configuration is ready. Existing values were preserved.\n'
