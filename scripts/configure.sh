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
  printf 'Usage: %s [--check]\n' "$0" >&2
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
# rewrites the first active "KEY=..." assignment in place, drops any further
# duplicate active assignments for the same key, and appends the assignment
# at the end of the file when none was present. Every other line, including
# comments, is copied through byte-for-byte.
update_managed_key() {
  local key="$1" value="$2" line replaced=0 temp

  temp="$(mktemp "$PWD/.env-orbit.updating.XXXXXX")" ||
    fail "Could not create a temporary Orbit environment file."
  temporary_file="$temp"
  chmod 600 "$temp" ||
    fail "Could not secure the temporary Orbit environment file."

  {
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" == "${key}="* ]]; then
        if [[ "$replaced" == 0 ]]; then
          printf '%s=%s\n' "$key" "$value"
          replaced=1
        fi
        continue
      fi
      printf '%s\n' "$line"
    done < "$environment_file"
    [[ "$replaced" == 1 ]] || printf '%s=%s\n' "$key" "$value"
  } > "$temp"

  mv -- "$temp" "$environment_file" ||
    fail "Could not persist ${key} in ${environment_file}."
  temporary_file=""
}

persist_orbit_image() {
  local orbit_image="${ORBIT_IMAGE:-}"
  [[ -n "$orbit_image" ]] || return 0
  if [[ ! "$orbit_image" =~ ^orbit-local:[0-9a-f]{12}$ && ! "$orbit_image" =~ ^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$ ]]; then
    fail "ORBIT_IMAGE must be an immutable registry digest or the installer-generated local build tag."
  fi
  update_managed_key ORBIT_IMAGE "$orbit_image"
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
  update_managed_key VAPID_PUBLIC_KEY "$public_key"
  update_managed_key VAPID_PRIVATE_KEY_FILE "/run/orbit-secrets/orbit-vapid-private-key"
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
    fi
  }

  report_optional() {
    local label="$1" ready="$2" present="$3"
    if [[ "$ready" == 1 ]]; then
      printf 'ready %s\n' "$label"
    elif [[ "$present" == 1 ]]; then
      printf 'missing %s\n' "$label"
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

  report_required APP_URL APP_URL
  report_required ORBIT_IMAGE ORBIT_IMAGE
  report_required OIDC_ISSUER OIDC_ISSUER
  report_required OIDC_CLIENT_ID OIDC_CLIENT_ID
  report_required OIDC_CLIENT_SECRET OIDC_CLIENT_SECRET OIDC_CLIENT_SECRET_FILE
  report_optional processing "$processing_ready" "$processing_present"
  report_optional ai "$ai_ready" "$ai_present"
  report_optional mail "$mail_ready" "$mail_present"
  report_optional imap "$imap_ready" "$imap_present"
  report_optional push "$push_ready" "$push_present"
}

case "${1:-}" in
  "")
    ;;
  --check)
    if [[ $# -ne 1 ]]; then
      usage
      exit 2
    fi
    run_check
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
