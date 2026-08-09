#!/usr/bin/env bash
# shellcheck disable=SC1003,SC2016
set -Eeuo pipefail

# Host-side configuration contract. This file is deliberately independent of
# Node and never sources the operator's environment file.
readonly schema_version=1
readonly environment_file_default=".env-orbit"
readonly rollback_suffix=".orbit-config.rollback"
readonly removed_keys=''
parsed_keys=()
schema_present=0

fail_code() {
  printf '%s\n' "$1" >&2
  exit 1
}

usage() {
  printf 'configuration_usage\n' >&2
}

# This is the accepted deployment contract. Direct secret forms remain
# accepted for upgrades, but their _FILE counterparts are the preferred form.
# The alias compatibility names are retained because the runtime getter still
# reads them for pre-rotation installations; they are not documented defaults.
readonly allowed_keys='APP_URL OIDC_ISSUER OIDC_CLIENT_ID OIDC_CLIENT_SECRET OIDC_CLIENT_SECRET_FILE OIDC_CALLBACK_URL ORBIT_IMAGE SESSION_SECRET SESSION_SECRET_FILE DOCUMENT_KEK DOCUMENT_KEK_FILE POSTGRES_PASSWORD POSTGRES_PASSWORD_FILE VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY VAPID_PRIVATE_KEY_FILE ORBIT_BIND_ADDRESS ORBIT_PORT ORBIT_LOG_LEVEL COMPOSE_PROFILES POSTGRES_DB POSTGRES_USER POSTGRES_HOST POSTGRES_PORT DATABASE_URL DATABASE_URL_FILE DOCUMENTS_ROOT DOCUMENTS_QUARANTINE_ROOT DOCUMENT_MAX_BYTES DOCUMENT_HOUSEHOLD_QUOTA_BYTES DOCUMENT_INSTANCE_QUOTA_BYTES DOCUMENT_RETENTION_DAYS DOCUMENT_SCAN_RECOVERY_RETENTION_HOURS DOCUMENT_SCAN_MODE CLAMAV_HOST CLAMAV_PORT CLAMAV_TIMEOUT_MS CLAMAV_MEMORY_LIMIT TIKA_URL TIKA_TIMEOUT_MS TIKA_MEMORY_LIMIT OLLAMA_MODEL OLLAMA_MEMORY_LIMIT OLLAMA_CPUS OLLAMA_MAX_QUEUE OLLAMA_KEEP_ALIVE IMAP_ENABLED SMTP_HOST SMTP_PORT SMTP_SECURITY SMTP_USER SMTP_PASSWORD SMTP_PASSWORD_FILE SMTP_FROM SMTP_URL SMTP_URL_FILE IMAP_HOST IMAP_PORT IMAP_USER IMAP_PASSWORD IMAP_PASSWORD_FILE IMAP_MAILBOX IMAP_TLS_SERVER_NAME IMAP_RECIPIENT_DOMAIN IMAP_TRUSTED_RECIPIENT_HEADER IMAP_POLL_SECONDS IMAP_ALIAS_CURRENT_GENERATION IMAP_ALIAS_CURRENT_SECRET IMAP_ALIAS_CURRENT_SECRET_FILE IMAP_ALIAS_PREVIOUS_GENERATION IMAP_ALIAS_PREVIOUS_SECRET IMAP_ALIAS_PREVIOUS_SECRET_FILE IMAP_ALIAS_PREVIOUS_EXPIRES_AT IMAP_ALIAS_GENERATION IMAP_ALIAS_CURRENT_KEY IMAP_ALIAS_CURRENT_KEY_FILE IMAP_ALIAS_SECRET IMAP_ALIAS_SECRET_FILE IMAP_ALIAS_PREVIOUS_KEY IMAP_ALIAS_PREVIOUS_KEY_FILE IMAP_ALIAS_PREVIOUS_EXPIRY VAPID_SUBJECT SESSION_TTL_SECONDS OIDC_SCOPES OIDC_EMAIL_CLAIM OIDC_EMAIL_VERIFIED_CLAIM OIDC_NAME_CLAIM OIDC_AVATAR_CLAIM WORKER_POLL_SECONDS NOTIFICATION_MAX_ATTEMPTS MIGRATE_ON_START WORKER_ENABLED DRIZZLE_MIGRATIONS_PATH ORBIT_SECRETS_DIR ORBIT_CONFIG_SCHEMA_VERSION'

is_allowed() {
  local candidate
  for candidate in $allowed_keys; do [[ "$candidate" == "$1" ]] && return 0; done
  return 1
}

is_removed() {
  local candidate
  for candidate in $removed_keys; do [[ "$candidate" == "$1" ]] && return 0; done
  return 1
}

is_deprecated_secret() {
  case "$1" in
    OIDC_CLIENT_SECRET|SESSION_SECRET|DOCUMENT_KEK|POSTGRES_PASSWORD|VAPID_PRIVATE_KEY|SMTP_PASSWORD|IMAP_PASSWORD|IMAP_ALIAS_CURRENT_SECRET|IMAP_ALIAS_PREVIOUS_SECRET|DATABASE_URL|SMTP_URL|IMAP_ALIAS_CURRENT_KEY|IMAP_ALIAS_SECRET|IMAP_ALIAS_PREVIOUS_KEY)
      return 0
      ;;
  esac
  return 1
}

is_control_free() {
  local value="$1" char i
  for ((i=0; i<${#value}; i++)); do
    char="${value:i:1}"
    [[ "$char" == $'\x7f' || "$char" == $'\x1b' || "$char" == $'\x00' ]] && return 1
    [[ "$char" < $'\x20' ]] && return 1
  done
  return 0
}

validate_value() {
  local value="$1"
  [[ ${#value} -le 4096 ]] || return 1
  is_control_free "$value" || return 1
  [[ "$value" != [[:space:]]* && "$value" != *[[:space:]] ]] || return 1
  # These forms are ambiguous to Compose or a shell-like dotenv parser.
  [[ "$value" != *'$'* && "$value" != *'`'* &&
    "$value" != *'"'* && "$value" != *"'"* && "$value" != *'#'* &&
    "$value" != *\\* ]] || return 1
}

check_file_safety() {
  local file="$1"
  [[ -f "$file" && ! -L "$file" ]] || fail_code configuration_syntax
  [[ "$(stat -c '%a' -- "$file" 2>/dev/null)" == 600 ]] || fail_code configuration_syntax
}

parse_file() {
  local file="$1" line key value line_number=0 assignment_count=0
  local -A seen=()
  local schema_marker=""
  parsed_keys=(); schema_present=0
  check_file_safety "$file"
  # A NUL cannot be represented in a dotenv assignment and must fail closed.
  cmp -s "$file" <(tr -d '\000' < "$file") || fail_code configuration_syntax
  while IFS= read -r line || [[ -n "$line" ]]; do
    line_number=$((line_number + 1))
    line="${line%$'\r'}"
    is_control_free "$line" || fail_code configuration_syntax
    [[ "$line" =~ ^[[:space:]]*$ || "$line" =~ ^[[:space:]]*\# ]] && continue
    [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || fail_code configuration_syntax
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    [[ -z "${seen[$key]:-}" ]] || fail_code configuration_syntax
    seen["$key"]=1
    assignment_count=$((assignment_count + 1)); parsed_keys+=("$key")
    if ! is_allowed "$key"; then
      if is_removed "$key"; then
        printf 'removed_incompatible configuration\n'
        fail_code configuration_removed_key
      fi
      printf 'unknown configuration\n'
      fail_code configuration_unknown_key
    fi
    validate_value "$value" || fail_code configuration_syntax
    if [[ "$key" == ORBIT_CONFIG_SCHEMA_VERSION ]]; then schema_marker="$value"; schema_present=1; fi
  done < "$file"
  [[ "$assignment_count" -gt 0 ]] || fail_code configuration_syntax
  if [[ -n "$schema_marker" && "$schema_marker" != "$schema_version" ]]; then
    [[ "$schema_marker" =~ ^[0-9]+$ && "$schema_marker" -gt "$schema_version" ]] && fail_code configuration_version
    fail_code configuration_version
  fi
  [[ -z "$schema_marker" ]] && return 2
  return 0
}

report_classification() {
  local key
  for key in "${parsed_keys[@]}"; do
    if is_deprecated_secret "$key"; then
      printf 'deprecated_supported %s\n' "$key"
    else
      printf 'current %s\n' "$key"
    fi
  done
  [[ "$schema_present" == 1 ]] || printf 'safely_migratable ORBIT_CONFIG_SCHEMA_VERSION\n'
}

migrate_file() {
  local file="$1" state temp newline backup transaction="$2"
  state=0; parse_file "$file" || state=$?
  [[ "$state" == 0 || "$state" == 2 ]] || exit "$state"
  [[ "$state" == 2 ]] || { printf 'status migrated action none\n'; return 0; }

  if [[ "$transaction" != 1 ]]; then
    backup="${file}${rollback_suffix}"
    if [[ -e "$backup" || -L "$backup" ]]; then fail_code configuration_migration; fi
    umask 077
    cp -- "$file" "$backup" 2>/dev/null || fail_code configuration_migration
    chmod 600 "$backup" 2>/dev/null || fail_code configuration_migration
  fi
  temp="$(mktemp "${file}.migrating.XXXXXX" 2>/dev/null)" || fail_code configuration_migration
  chmod 600 "$temp" 2>/dev/null || { rm -f -- "$temp" 2>/dev/null; fail_code configuration_migration; }
  newline=$'\n'
  LC_ALL=C grep -q $'\r' "$file" && newline=$'\r\n'
  last_byte="$(tail -c 1 "$file" 2>/dev/null | od -An -t x1 | tr -d '[:space:]')"
  if [[ -s "$file" ]] && [[ "$last_byte" != 0a && "$last_byte" != 0d ]]; then
    cat -- "$file" > "$temp" 2>/dev/null || { rm -f -- "$temp" 2>/dev/null; fail_code configuration_migration; }
    printf '%s' "$newline" >> "$temp" 2>/dev/null || { rm -f -- "$temp" 2>/dev/null; fail_code configuration_migration; }
  else
    cat -- "$file" > "$temp" 2>/dev/null || { rm -f -- "$temp" 2>/dev/null; fail_code configuration_migration; }
  fi
  printf 'ORBIT_CONFIG_SCHEMA_VERSION=1%s' "$newline" >> "$temp" 2>/dev/null || { rm -f -- "$temp" 2>/dev/null; fail_code configuration_migration; }
  chmod 600 "$temp" 2>/dev/null || { rm -f -- "$temp" 2>/dev/null; fail_code configuration_migration; }
  if ! mv -f -- "$temp" "$file" 2>/dev/null; then
    rm -f -- "$temp" 2>/dev/null
    if [[ "$transaction" != 1 ]]; then cp -- "$backup" "$file" 2>/dev/null || true; fi
    fail_code configuration_migration
  fi
  printf 'status migrated action marker_added\n'
}

file="$environment_file_default"; action=check; transaction=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) action=check; shift;;
    --preflight) action=preflight; shift;;
    --migrate) action=migrate; shift;;
    --transaction) transaction=1; shift;;
    --file) [[ $# -ge 2 ]] || { usage; exit 2; }; file="$2"; shift 2;;
    *) usage; exit 2;;
  esac
done
[[ -n "$file" ]] || fail_code configuration_syntax
[[ "$transaction" == 0 || "$action" == migrate ]] || fail_code configuration_migration

case "$action" in
  check|preflight)
    state=0; parse_file "$file" || state=$?
    case "$state" in
      0)
        report_classification
        ;;
      2)
        report_classification
        ;;
      *) exit "$state";;
    esac
    ;;
  migrate)
    [[ "$transaction" == 1 || "$transaction" == 0 ]] || fail_code configuration_migration
    migrate_file "$file" "$transaction";;
esac
