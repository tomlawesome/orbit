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
# SMTP only: the inbound mailbox credential is app-managed since ADR-0017
# slice 2, set through the administration screen and stored encrypted in the
# database, so there is no host secret file for it or for the alias key.
openssl rand -hex 32 > .orbit-secrets/smtp-password
chmod 600 .orbit-secrets/smtp-password
# Ephemeral fixture overrides are appended deliberately: dotenv uses
# the final assignment, so this remains valid whether an operator
# setting is active, commented, or omitted from the example file.
{
  printf '%s\n' \
    'SMTP_HOST=smtp.example.invalid' \
    'SMTP_USER=orbit@example.invalid' \
    'OIDC_CLIENT_ID=orbit-smoke' \
    'OIDC_CLIENT_SECRET=orbit-smoke-only-secret'
} >> .env-orbit
