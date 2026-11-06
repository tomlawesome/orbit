#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/ci/upgrade-shapes/lib.sh disable=SC2034
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# Every key the old example documents, except those that cannot coexist with
# what is already set (direct secrets, *_FILE forms, DATABASE_URL, installer-managed).
shape_provision() {
  local skip='_FILE$|_NEXT$|^DATABASE_URL|^COMPOSE_|^ORBIT_PREVIOUS_IMAGE$|^ORBIT_CONFIG_APPLIED_'
  local k line
  while IFS= read -r line; do
    k=${line%%=*}
    [[ $k =~ $skip || $k =~ $SECRET_KEY ]] && continue
    grep -q "^$k=" "$ENV_FILE" || printf '%s\n' "$line" >>"$ENV_FILE"
  done < <(sed -n 's/^# \([A-Z][A-Z0-9_]*=\)/\1/p' "$OLD_TREE/.env-orbit.example")
  # SMTP_HOST is set, so the old release wants a complete mail group (#1748).
  grep -q '^SMTP_USER=' "$ENV_FILE" || set_key SMTP_USER orbit-upgrade-matrix
  secret_file smtp-password
  set_key SMTP_PASSWORD_FILE .orbit-secrets/smtp-password
}
shape_main "$@"
