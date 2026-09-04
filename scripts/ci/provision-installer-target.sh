#!/usr/bin/env bash
#
# Pre-provisions the installer target the way an operator would before an
# unattended run: the shipped example environment file with the required
# fields filled in, and a real OIDC client secret in a private secrets
# directory. Every permission and file-type assertion here is the point --
# the installer is about to be trusted with these, and a mode 0644 secret or
# a symlinked environment file must fail loudly rather than quietly work.
#
# Extracted verbatim from the "Pre-provision unattended installer target"
# step of the &container_validation_steps anchor in
# .github/workflows/publish-container.yml (#801).
#
# Inputs (environment):
#   INSTALL_TARGET    the empty directory prepared earlier
#   GITHUB_WORKSPACE  optional; defaults to the repository root
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root

: "${INSTALL_TARGET:?the installer target is required}"

workspace="${GITHUB_WORKSPACE:-${repo_root}}"
readonly workspace

install_target="${INSTALL_TARGET}"
env_file="${install_target}/.env-orbit"
secrets_directory="${install_target}/.orbit-secrets"
[[ -d "${install_target}" && ! -L "${install_target}" ]] || {
  printf 'The installer target is missing or unsafe before provisioning.\n' >&2
  exit 1
}
shopt -s nullglob dotglob
entries=("${install_target}"/*)
shopt -u nullglob dotglob
[[ "${#entries[@]}" -eq 0 ]] || {
  printf 'The installer target was not restored to empty before provisioning.\n' >&2
  exit 1
}

cp -- "${workspace}/.env-orbit.example" "${env_file}"
chmod 600 "${env_file}"
sed -i \
  -e 's|^APP_URL=.*$|APP_URL=https://orbit.install-test.invalid|' \
  -e 's|^OIDC_ISSUER=.*$|OIDC_ISSUER=https://accounts.google.com|' \
  -e 's|^OIDC_CLIENT_ID=.*$|OIDC_CLIENT_ID=orbit-install-test-client|' \
  -e 's|^OIDC_CLIENT_SECRET=.*$|OIDC_CLIENT_SECRET=|' \
  -e 's|^# OIDC_CLIENT_SECRET_FILE=.*$|OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret|' \
  -e 's|^OIDC_CALLBACK_URL=.*$|OIDC_CALLBACK_URL=https://orbit.install-test.invalid/api/auth/callback|' \
  "${env_file}"

for expected_line in \
  'ORBIT_CONFIG_SCHEMA_VERSION=1' \
  'APP_URL=https://orbit.install-test.invalid' \
  'OIDC_ISSUER=https://accounts.google.com' \
  'OIDC_CLIENT_ID=orbit-install-test-client' \
  'OIDC_CLIENT_SECRET=' \
  'OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret' \
  'OIDC_CALLBACK_URL=https://orbit.install-test.invalid/api/auth/callback'; do
  grep --fixed-strings --line-regexp --quiet "${expected_line}" "${env_file}" || {
    printf 'The pre-provisioned environment file is missing a required bootstrap field.\n' >&2
    exit 1
  }
done

umask 077
mkdir -- "${secrets_directory}"
chmod 700 "${secrets_directory}"
openssl rand -hex 32 > "${secrets_directory}/oidc-client-secret"
chmod 600 "${secrets_directory}/oidc-client-secret"

[[ -f "${env_file}" && ! -L "${env_file}" ]] || {
  printf 'The pre-provisioned environment file is not a regular non-symlink file.\n' >&2
  exit 1
}
[[ "$(stat -c '%a' -- "${env_file}")" == 600 ]] || {
  printf 'The pre-provisioned environment file is not mode 0600.\n' >&2
  exit 1
}
[[ -d "${secrets_directory}" && ! -L "${secrets_directory}" ]] || {
  printf 'The pre-provisioned secrets directory is not a real non-symlink directory.\n' >&2
  exit 1
}
[[ "$(stat -c '%a' -- "${secrets_directory}")" == 700 ]] || {
  printf 'The pre-provisioned secrets directory is not mode 0700.\n' >&2
  exit 1
}
secret_file="${secrets_directory}/oidc-client-secret"
[[ -f "${secret_file}" && ! -L "${secret_file}" && -s "${secret_file}" ]] || {
  printf 'The pre-provisioned OIDC client secret file is missing or empty.\n' >&2
  exit 1
}
[[ "$(stat -c '%a' -- "${secret_file}")" == 600 ]] || {
  printf 'The pre-provisioned OIDC client secret file is not mode 0600.\n' >&2
  exit 1
}

shopt -s nullglob dotglob
entries=("${install_target}"/*)
shopt -u nullglob dotglob
[[ "${#entries[@]}" -eq 2 ]] || {
  printf 'The pre-provisioned target does not contain exactly .env-orbit and .orbit-secrets.\n' >&2
  exit 1
}
for marker in .git Dockerfile src package.json package-lock.json pnpm-lock.yaml yarn.lock; do
  [[ ! -e "${install_target}/${marker}" ]] || {
    printf 'The pre-provisioned target unexpectedly contains %s.\n' "${marker}" >&2
    exit 1
  }
done
