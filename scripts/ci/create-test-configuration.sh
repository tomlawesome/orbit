#!/usr/bin/env bash
#
# Creates the isolated configuration the container validation stack runs on:
# a generated .env-orbit, the GreenMail TLS material the mail sidecar and the
# application's trust anchor are bind-mounted from, and throwaway mail and
# alias secrets.
#
# Extracted verbatim from the "Create isolated test configuration" step of the
# &container_validation_steps anchor in
# .github/workflows/publish-container.yml, so the GitLab pipeline can run the
# same setup rather than a paraphrase of it (#801).
#
# Inputs: none. Writes .env-orbit and .orbit-secrets/ in the repository root.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root
cd "${repo_root}"

bash scripts/configure.sh
# The GreenMail sidecar's imaps listener and the app's trust anchor are
# bind-mounted from these two files. A missing source is silently
# created as a directory, which surfaces 16 minutes later as a mail
# poll timeout rather than as a certificate error, so assert them.
bash scripts/dev-greenmail-cert.sh
for required in .orbit-secrets/greenmail.p12 .orbit-secrets/greenmail-ca.pem; do
  [[ -f "${required}" ]] || { echo "missing GreenMail TLS material: ${required}" >&2; exit 1; }
done
openssl rand -hex 32 > .orbit-secrets/smtp-password
openssl rand -hex 32 > .orbit-secrets/imap-password
openssl rand -hex 32 > .orbit-secrets/imap-alias-current-secret
openssl rand -hex 32 > .orbit-secrets/imap-alias-previous-secret
chmod 600 .orbit-secrets/smtp-password .orbit-secrets/imap-password \
  .orbit-secrets/imap-alias-current-secret \
  .orbit-secrets/imap-alias-previous-secret
# Ephemeral fixture overrides are appended deliberately: dotenv uses
# the final assignment, so this remains valid whether an operator
# setting is active, commented, or omitted from the example file.
{
  printf '%s\n' \
    'SMTP_HOST=smtp.example.invalid' \
    'SMTP_USER=orbit@example.invalid' \
    'IMAP_HOST=imap.example.invalid' \
    'IMAP_USER=orbit@example.invalid' \
    'IMAP_TLS_SERVER_NAME=imap.example.invalid' \
    'IMAP_RECIPIENT_DOMAIN=ingest.example.invalid' \
    'IMAP_ENABLED=false' \
    'OIDC_CLIENT_ID=orbit-smoke' \
    'OIDC_CLIENT_SECRET=orbit-smoke-only-secret'
} >> .env-orbit
