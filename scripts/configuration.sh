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
applied_version_present=0
applied_digest_present=0
compose_project_present=0
schema_value=""
orbit_image_value=""
applied_version_value=""
applied_digest_value=""
compose_project_value=""

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
readonly allowed_keys='APP_URL OIDC_ISSUER OIDC_CLIENT_ID OIDC_CLIENT_SECRET OIDC_CLIENT_SECRET_FILE OIDC_CALLBACK_URL ORBIT_IMAGE ORBIT_CONFIG_APPLIED_VERSION ORBIT_CONFIG_APPLIED_DIGEST COMPOSE_PROJECT_NAME SESSION_SECRET SESSION_SECRET_FILE DOCUMENT_KEK DOCUMENT_KEK_FILE POSTGRES_PASSWORD POSTGRES_PASSWORD_FILE VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY VAPID_PRIVATE_KEY_FILE ORBIT_BIND_ADDRESS ORBIT_PORT ORBIT_LOG_LEVEL ORBIT_LOG_FORMAT COMPOSE_PROFILES POSTGRES_DB POSTGRES_USER POSTGRES_HOST POSTGRES_PORT DATABASE_URL DATABASE_URL_FILE DOCUMENTS_ROOT DOCUMENTS_QUARANTINE_ROOT DOCUMENT_MAX_BYTES DOCUMENT_HOUSEHOLD_QUOTA_BYTES DOCUMENT_INSTANCE_QUOTA_BYTES DOCUMENT_RETENTION_DAYS DOCUMENT_SCAN_RECOVERY_RETENTION_HOURS DOCUMENT_SCAN_MODE CLAMAV_HOST CLAMAV_PORT CLAMAV_TIMEOUT_MS CLAMAV_MEMORY_LIMIT TIKA_URL TIKA_TIMEOUT_MS TIKA_MEMORY_LIMIT OLLAMA_MODEL OLLAMA_MEMORY_LIMIT OLLAMA_CPUS OLLAMA_MAX_QUEUE OLLAMA_KEEP_ALIVE IMAP_ENABLED SMTP_HOST SMTP_PORT SMTP_SECURITY SMTP_USER SMTP_PASSWORD SMTP_PASSWORD_FILE SMTP_FROM SMTP_URL SMTP_URL_FILE IMAP_HOST IMAP_PORT IMAP_USER IMAP_PASSWORD IMAP_PASSWORD_FILE IMAP_MAILBOX IMAP_TLS_SERVER_NAME IMAP_RECIPIENT_DOMAIN IMAP_TRUSTED_RECIPIENT_HEADER IMAP_POLL_SECONDS IMAP_ALIAS_CURRENT_GENERATION IMAP_ALIAS_CURRENT_SECRET IMAP_ALIAS_CURRENT_SECRET_FILE IMAP_ALIAS_PREVIOUS_GENERATION IMAP_ALIAS_PREVIOUS_SECRET IMAP_ALIAS_PREVIOUS_SECRET_FILE IMAP_ALIAS_PREVIOUS_EXPIRES_AT IMAP_ALIAS_GENERATION IMAP_ALIAS_CURRENT_KEY IMAP_ALIAS_CURRENT_KEY_FILE IMAP_ALIAS_SECRET IMAP_ALIAS_SECRET_FILE IMAP_ALIAS_PREVIOUS_KEY IMAP_ALIAS_PREVIOUS_KEY_FILE IMAP_ALIAS_PREVIOUS_EXPIRY VAPID_SUBJECT SESSION_TTL_SECONDS OIDC_SCOPES OIDC_EMAIL_CLAIM OIDC_EMAIL_VERIFIED_CLAIM OIDC_NAME_CLAIM OIDC_AVATAR_CLAIM WORKER_POLL_SECONDS MAINTENANCE_TICK_SECONDS NOTIFICATION_MAX_ATTEMPTS MIGRATE_ON_START WORKER_ENABLED DRIZZLE_MIGRATIONS_PATH ORBIT_SECRETS_DIR ORBIT_CONFIG_SCHEMA_VERSION'

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
  # $ and ` are ambiguous to Compose's env-file parser in any position: `$`
  # triggers ${VAR}/$VAR interpolation, and there is no escape (a preceding
  # backslash does not suppress it — confirmed against `docker compose
  # config`).
  [[ "$value" != *'$'* && "$value" != *'`'* ]] || return 1
  # A value that itself begins with a quote is the real hazard: Compose
  # treats a leading quote as opening a value that runs on, potentially
  # consuming following lines verbatim, until a matching quote is found. A
  # quote anywhere else in the value is passed through literally, as is a
  # backslash — real deployments' .env-orbit values (e.g. a mail provider's
  # generated SMTP_PASSWORD) commonly contain either and were previously
  # rejected unconditionally, blocking --preflight/--migrate on an already-
  # working deployment (#383).
  [[ "$value" != \'* && "$value" != \"* ]] || return 1
  # A `#` is only a comment marker to Compose when preceded by whitespace;
  # elsewhere in the value it is literal (also confirmed against `docker
  # compose config`).
  [[ "$value" != *[[:space:]]'#'* ]] || return 1
}

is_valid_applied_version() {
  [[ "$1" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
}

is_valid_applied_digest() {
  [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]]
}

is_valid_immutable_image() {
  [[ "$1" =~ ^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$ ]]
}

is_valid_compose_project_name() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9_-]*$ ]]
}

validate_provenance() {
  if [[ "$applied_version_present" != "$applied_digest_present" ]]; then
    fail_code configuration_provenance
  fi
  [[ "$applied_version_present" == 1 ]] || return 0
  is_valid_applied_version "$applied_version_value" || fail_code configuration_provenance
  is_valid_applied_digest "$applied_digest_value" || fail_code configuration_provenance
  is_valid_immutable_image "$orbit_image_value" || fail_code configuration_provenance
  [[ "${orbit_image_value##*@}" == "$applied_digest_value" ]] || fail_code configuration_provenance
}

check_file_safety() {
  local file="$1"
  [[ -f "$file" && ! -L "$file" ]] || fail_code configuration_syntax
  [[ "$(stat -c '%a' -- "$file" 2>/dev/null)" == 600 ]] || fail_code configuration_syntax
}

parse_file() {
  local file="$1" line key value line_number=0 assignment_count=0
  local -A seen=()
  parsed_keys=(); schema_present=0; applied_version_present=0; applied_digest_present=0; compose_project_present=0
  schema_value=""; orbit_image_value=""; applied_version_value=""; applied_digest_value=""; compose_project_value=""
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
    case "$key" in
      ORBIT_CONFIG_SCHEMA_VERSION) schema_value="$value"; schema_present=1;;
      ORBIT_IMAGE) orbit_image_value="$value";;
      ORBIT_CONFIG_APPLIED_VERSION) applied_version_value="$value"; applied_version_present=1;;
      ORBIT_CONFIG_APPLIED_DIGEST) applied_digest_value="$value"; applied_digest_present=1;;
      COMPOSE_PROJECT_NAME)
        is_valid_compose_project_name "$value" || fail_code configuration_project
        compose_project_value="$value"; compose_project_present=1;;
    esac
  done < "$file"
  [[ "$assignment_count" -gt 0 ]] || fail_code configuration_syntax
  if [[ -n "$schema_value" && "$schema_value" != "$schema_version" ]]; then
    [[ "$schema_value" =~ ^[0-9]+$ && "$schema_value" -gt "$schema_version" ]] && fail_code configuration_version
    fail_code configuration_version
  fi
  validate_provenance
  [[ "$schema_present" == 0 ]] && return 2
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
  if [[ "$applied_version_present" == 0 && "$applied_digest_present" == 0 ]]; then
    printf 'safely_migratable ORBIT_CONFIG_APPLIED_VERSION\n'
    printf 'safely_migratable ORBIT_CONFIG_APPLIED_DIGEST\n'
  fi
  [[ "$compose_project_present" == 1 ]] || printf 'safely_migratable COMPOSE_PROJECT_NAME\n'
}

migrate_file() {
  local file="$1" state temp newline backup transaction="$2"
  local target_image="$3" target_version="$4" target_digest="$5" target_project="$6"
  local desired_image desired_version desired_digest desired_project prior_schema prior_version prior_digest
  local line_without_cr key replaced
  local -a managed_order=(ORBIT_IMAGE ORBIT_CONFIG_SCHEMA_VERSION ORBIT_CONFIG_APPLIED_VERSION ORBIT_CONFIG_APPLIED_DIGEST COMPOSE_PROJECT_NAME)
  local -A managed_values=() written=()
  state=0; parse_file "$file" || state=$?
  [[ "$state" == 0 || "$state" == 2 ]] || exit "$state"

  if [[ -n "$target_image" || -n "$target_version" || -n "$target_digest" ]]; then
    [[ -n "$target_image" && -n "$target_version" && -n "$target_digest" ]] || fail_code configuration_provenance
    is_valid_immutable_image "$target_image" || fail_code configuration_provenance
    is_valid_applied_version "$target_version" || fail_code configuration_provenance
    is_valid_applied_digest "$target_digest" || fail_code configuration_provenance
    [[ "${target_image##*@}" == "$target_digest" ]] || fail_code configuration_provenance
    desired_image="$target_image"; desired_version="$target_version"; desired_digest="$target_digest"
  else
    [[ "$state" == 0 && "$schema_present" == 1 && "$applied_version_present" == 1 ]] ||
      fail_code configuration_provenance_required
    desired_image="$orbit_image_value"; desired_version="$applied_version_value"; desired_digest="$applied_digest_value"
  fi

  if [[ -n "$target_project" ]]; then
    is_valid_compose_project_name "$target_project" || fail_code configuration_project
  fi
  if [[ "$compose_project_present" == 1 ]]; then
    if [[ -n "$target_project" && "$compose_project_value" != "$target_project" ]]; then
      fail_code configuration_project_mismatch
    fi
    desired_project="$compose_project_value"
  else
    [[ -n "$target_project" ]] || fail_code configuration_project_required
    desired_project="$target_project"
  fi

  if [[ "$state" == 0 && "$schema_present" == 1 && "$applied_version_present" == 1 &&
    "$orbit_image_value" == "$desired_image" && "$applied_version_value" == "$desired_version" &&
    "$applied_digest_value" == "$desired_digest" && "$compose_project_present" == 1 &&
    "$compose_project_value" == "$desired_project" ]]; then
    printf 'Orbit configuration: already current schema v1 version %s digest %s\n' "$desired_version" "$desired_digest"
    return 0
  fi

  prior_schema="v0"; [[ "$schema_present" == 1 ]] && prior_schema="v1"
  prior_version="legacy/unknown"; [[ "$applied_version_present" == 1 ]] && prior_version="$applied_version_value"
  prior_digest="legacy/unknown"; [[ "$applied_digest_present" == 1 ]] && prior_digest="$applied_digest_value"
  managed_values[ORBIT_IMAGE]="$desired_image"
  managed_values[ORBIT_CONFIG_SCHEMA_VERSION]="$schema_version"
  managed_values[ORBIT_CONFIG_APPLIED_VERSION]="$desired_version"
  managed_values[ORBIT_CONFIG_APPLIED_DIGEST]="$desired_digest"
  managed_values[COMPOSE_PROJECT_NAME]="$desired_project"

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
  while IFS= read -r line || [[ -n "$line" ]]; do
    line_without_cr="${line%$'\r'}"
    replaced=0
    for key in "${managed_order[@]}"; do
      if [[ "$line_without_cr" == "${key}="* || "$line_without_cr" == "# ${key}=" ]]; then
        printf '%s=%s%s' "$key" "${managed_values[$key]}" "$newline" >> "$temp" 2>/dev/null || {
          rm -f -- "$temp" 2>/dev/null; fail_code configuration_migration;
        }
        written["$key"]=1
        replaced=1
        break
      fi
    done
    if [[ "$replaced" == 0 ]]; then
      printf '%s\n' "$line" >> "$temp" 2>/dev/null || {
        rm -f -- "$temp" 2>/dev/null; fail_code configuration_migration;
      }
    fi
  done < "$file"
  for key in "${managed_order[@]}"; do
    [[ -n "${written[$key]:-}" ]] && continue
    printf '%s=%s%s' "$key" "${managed_values[$key]}" "$newline" >> "$temp" 2>/dev/null || {
      rm -f -- "$temp" 2>/dev/null; fail_code configuration_migration;
    }
  done
  chmod 600 "$temp" 2>/dev/null || { rm -f -- "$temp" 2>/dev/null; fail_code configuration_migration; }
  if ! mv -f -- "$temp" "$file" 2>/dev/null; then
    rm -f -- "$temp" 2>/dev/null
    if [[ "$transaction" != 1 ]]; then cp -- "$backup" "$file" 2>/dev/null || true; fi
    fail_code configuration_migration
  fi
  printf 'Orbit configuration: migrated from schema %s version %s digest %s to schema v1 version %s digest %s\n' \
    "$prior_schema" "$prior_version" "$prior_digest" "$desired_version" "$desired_digest"
}

file="$environment_file_default"; action=check; transaction=0
target_image=""; target_version=""; target_digest=""
target_project=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) action=check; shift;;
    --preflight) action=preflight; shift;;
    --migrate) action=migrate; shift;;
    --transaction) transaction=1; shift;;
    --orbit-image) [[ $# -ge 2 ]] || { usage; exit 2; }; target_image="$2"; shift 2;;
    --applied-version) [[ $# -ge 2 ]] || { usage; exit 2; }; target_version="$2"; shift 2;;
    --applied-digest) [[ $# -ge 2 ]] || { usage; exit 2; }; target_digest="$2"; shift 2;;
    --compose-project-name) [[ $# -ge 2 ]] || { usage; exit 2; }; target_project="$2"; shift 2;;
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
    migrate_file "$file" "$transaction" "$target_image" "$target_version" "$target_digest" "$target_project";;
esac
