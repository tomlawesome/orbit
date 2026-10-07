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
# Inputs: ORBIT_IMAGE, the loaded image under test: configure.sh runs inside
# it (#1210). Writes .env-orbit and .orbit-secrets/ in the repository root.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root
cd "${repo_root}"

: "${ORBIT_IMAGE:?ORBIT_IMAGE must name the loaded image under test; configure.sh runs inside it}"
# configure.sh accepts only a digest or an orbit-local:<12 hex> tag, the two
# shapes an operator's deployment can carry. A CI tag (orbit-ci:<commit>) is
# given the second shape first, naming the same image by its own ID.
engine_image="${ORBIT_IMAGE}"
if [[ ! "${engine_image}" =~ ^orbit-local:[0-9a-f]{12}$ && ! "${engine_image}" =~ @sha256:[0-9a-f]{64}$ ]]; then
  image_id="$(docker image inspect --format '{{.Id}}' "${engine_image}")"
  image_id="${image_id#sha256:}"
  engine_image="orbit-local:${image_id:0:12}"
  docker tag "${ORBIT_IMAGE}" "${engine_image}"
fi
ORBIT_IMAGE="${engine_image}" bash scripts/configure.sh
# #1258: whatever configure created belongs to whoever ran it.
not_owned="$(find .env-orbit .orbit-secrets \( ! -uid "$(id -u)" -o ! -gid "$(id -g)" \) -print)"
[[ -z "${not_owned}" ]] || { printf 'configure.sh left paths not owned by %s:%s:\n%s\n' "$(id -u)" "$(id -g)" "${not_owned}" >&2; exit 1; }
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
#
# #838: the smoke stack turns the document parser on too, so the journey
# that uploads a real PDF through the product (tests/e2e/v19-document-
# extraction.spec.ts) has a real orbit-tika to reach, not an absent one.
# TIKA_URL is docker-compose.yml's fixed in-network address for the
# orbit-tika service (README.md:392); scripts/ci/validate-compose.sh forces
# COMPOSE_PROFILES empty for its own "off by default" assertion rather than
# relying on this file staying profile-free.
{
  printf '%s\n' \
    'SMTP_HOST=smtp.example.invalid' \
    'SMTP_USER=orbit@example.invalid' \
    'OIDC_CLIENT_ID=orbit-smoke' \
    'OIDC_CLIENT_SECRET=orbit-smoke-only-secret' \
    'COMPOSE_PROFILES=processing' \
    'TIKA_URL=http://orbit-tika:9998'
} >> .env-orbit
