#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/ci/upgrade-shapes/lib.sh disable=SC2034
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# Any of SMTP_HOST, SMTP_USER or a password makes the old release treat mail
# as configured and demand the whole group, and once mail is configured the
# seed step's login returns "pending". So the old install sees no mail key:
# after_install (after seeding, before the update) adds the group and the
# overlay, and the update runs with mail configured (#1748).
SHAPE_ASSERTS=(env-file-intact overlay-composed secret-file-referenced)
shape_provision() {
  uncomment SMTP_PORT SMTP_SECURITY SMTP_FROM
}
shape_after_install() {
  set_key SMTP_HOST smtp.example.invalid
  uncomment SMTP_USER
  grep -q '^SMTP_USER=.' "$ENV_FILE" || set_key SMTP_USER orbit-upgrade-matrix
  secret_file smtp-password
  set_key SMTP_PASSWORD_FILE .orbit-secrets/smtp-password
  set_key COMPOSE_FILE docker-compose.yml:docker-compose.mail.yml
  (cd "$TARGET" && docker compose --env-file .env-orbit up -d >/dev/null)
}
shape_main "$@"
