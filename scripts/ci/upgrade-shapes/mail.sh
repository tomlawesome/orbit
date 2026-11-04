#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/ci/upgrade-shapes/lib.sh disable=SC2034
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# SMTP settings now; the password file and the overlay come in after_install,
# after seeding, because login returns "pending" once mail is configured.
SHAPE_ASSERTS=(env-file-intact overlay-composed secret-file-referenced)
shape_provision() {
  set_key SMTP_HOST smtp.example.invalid
  uncomment SMTP_PORT SMTP_SECURITY SMTP_USER SMTP_FROM
}
shape_after_install() {
  secret_file smtp-password
  set_key SMTP_PASSWORD_FILE .orbit-secrets/smtp-password
  set_key COMPOSE_FILE docker-compose.yml:docker-compose.mail.yml
  (cd "$TARGET" && docker compose --env-file .env-orbit up -d >/dev/null)
}
shape_main "$@"
