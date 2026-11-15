#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/ci/upgrade-shapes/lib.sh disable=SC2034
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# Any of SMTP_HOST, SMTP_USER or a password makes the old release treat mail
# as configured and demand the whole group, and once mail is configured the
# seed step's login returns "pending". So the old install sees no mail key:
# after_install (after seeding, before the update) adds the group and the
# overlay, and the update runs with mail configured (#1748).
#
# The update's new image imports the SMTP_* lines into Orbit's Mail settings,
# and install.sh --update then retires them (#1817, retire_smtp_lines): the
# SMTP_* keys and the overlay's COMPOSE_FILE entry leave .env-orbit, the
# overlay and .orbit-secrets/smtp-password are deleted and orbit-app is
# recreated without them. The assertions check that end state; everything
# else in .env-orbit must still match the snapshot.
SHAPE_ASSERTS=(smtp-lines-retired env-file-intact overlay-retired secret-file-referenced mail-settings-imported)
RETIRED_FILE_NAMES=(SMTP_PASSWORD_FILE)
SMTP_KEYS='SMTP_(HOST|PORT|SECURITY|USER|PASSWORD|PASSWORD_FILE|FROM)'
OVERLAY_COMPOSE_FILE=docker-compose.yml:docker-compose.mail.yml

shape_provision() {
  uncomment SMTP_PORT SMTP_SECURITY SMTP_FROM
}
shape_after_install() {
  set_key SMTP_HOST smtp.example.invalid
  uncomment SMTP_USER
  grep -q '^SMTP_USER=.' "$ENV_FILE" || set_key SMTP_USER orbit-upgrade-matrix
  secret_file smtp-password
  set_key SMTP_PASSWORD_FILE .orbit-secrets/smtp-password
  set_key COMPOSE_FILE "$OVERLAY_COMPOSE_FILE"
  (cd "$TARGET" && docker compose --env-file .env-orbit up -d >/dev/null)
}

# The snapshot without the SMTP_* lines, and COMPOSE_FILE without the overlay.
shape_expected_env() {
  grep -Ev "^$SMTP_KEYS=" | sed "s/^COMPOSE_FILE=$OVERLAY_COMPOSE_FILE\$/COMPOSE_FILE=docker-compose.yml/" || true
}

assert_smtp-lines-retired() {
  local keys
  keys=$(grep -Eo "^$SMTP_KEYS=" "$ENV_FILE" | tr -d = | sort -u | tr '\n' ' ' || true)
  [[ -z $keys ]] || fail smtp-lines-retired ".env-orbit still has: $keys"
  ! grep -qE '^COMPOSE_FILE=.*docker-compose\.mail\.yml' "$ENV_FILE" ||
    fail smtp-lines-retired "COMPOSE_FILE still lists docker-compose.mail.yml"
}

assert_overlay-retired() {
  local running
  [[ ! -e $TARGET/docker-compose.mail.yml ]] || fail overlay-retired "docker-compose.mail.yml is still in the folder"
  [[ -d $TARGET/.orbit-secrets ]] || fail overlay-retired "the secrets folder is gone; only the SMTP password file should be"
  [[ ! -e $TARGET/.orbit-secrets/smtp-password && ! -L $TARGET/.orbit-secrets/smtp-password ]] ||
    fail overlay-retired ".orbit-secrets/smtp-password is still there"
  [[ ! -e $TARGET/.orbit-smtp-retirement ]] ||
    fail overlay-retired "the retirement's step record is still there, so it did not finish"
  running=$(cd "$TARGET" && docker compose --env-file .env-orbit ps --services 2>/dev/null) || true
  grep -qx orbit-app <<<"$running" || fail overlay-retired "orbit-app is not running"
  # Only docker-compose.mail.yml sets SMTP_PASSWORD_FILE in orbit-app (#1665).
  ! grep -qx SMTP_PASSWORD_FILE <<<"$(env_names 2>/dev/null || true)" ||
    fail overlay-retired "orbit-app's environment still has SMTP_PASSWORD_FILE, so it runs with the mail overlay"
}

# The done-marker the update's gate read (#1817): the SMTP_* lines were imported.
assert_mail-settings-imported() {
  local answer
  answer=$(cd "$TARGET" && timeout 60 docker compose --env-file .env-orbit \
    exec -T orbit-app node /opt/orbit/cli/orbit.js mail-sending-status </dev/null 2>/dev/null) ||
    fail mail-settings-imported "orbit mail-sending-status did not answer"
  [[ $answer == "mail-sending source=imported imported-from-environment=true" ]] ||
    fail mail-settings-imported "orbit mail-sending-status did not report the SMTP lines imported"
}
shape_main "$@"
