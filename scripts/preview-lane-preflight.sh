#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

fail() {
  printf 'Orbit preview preflight: %s\n' "$1" >&2
  exit 1
}

channel="preview"
if [[ "$#" -gt 0 ]]; then
  [[ "$#" -eq 2 && "$1" == "--channel" ]] ||
    fail "usage: bash scripts/preview-lane-preflight.sh [--channel preview|hotfix]"
  channel="$2"
fi
[[ "$channel" == "preview" || "$channel" == "hotfix" ]] || fail "unsupported channel"

for command_name in docker git jq node openssl tar; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"

revision="$(git rev-parse HEAD)"
version="$(node scripts/calculate-version.mjs --channel "$channel")"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || fail "Git returned an invalid revision"
[[ "$version" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
  fail "the version calculator returned an invalid version"

temporary_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
temporary_root="${temporary_root%/}"
sandbox="$(mktemp -d "${temporary_root}/orbit-preview-preflight.XXXXXX")"
cleanup() {
  if [[ -n "${sandbox:-}" && -d "$sandbox" && "$sandbox" == "${temporary_root}/orbit-preview-preflight."* ]]; then
    rm -rf -- "$sandbox"
  fi
}
trap cleanup EXIT

git_directory="$(git rev-parse --absolute-git-dir)"
git ls-files --cached --others --exclude-standard -z \
  | tar --null -T - -cf - \
  | tar -xf - -C "$sandbox"

cd "$sandbox"
GIT_DIR="$git_directory" GIT_WORK_TREE="$sandbox" bash scripts/configure.sh
# SMTP only: the mailbox credential is app-managed since ADR-0017 slice 2.
printf 'preflight-only\n' > .orbit-secrets/smtp-password
chmod 600 .orbit-secrets/smtp-password
{
  printf '%s\n' \
    'SMTP_HOST=smtp.example.invalid' \
    'SMTP_USER=orbit@example.invalid' \
    'OIDC_CLIENT_ID=orbit-smoke' \
    'OIDC_CLIENT_SECRET=orbit-smoke-only-secret'
} >> .env-orbit

export ORBIT_IMAGE="orbit-local:${revision:0:12}"
export ORBIT_VERSION="$version"
export ORBIT_REVISION="$revision"
export ORBIT_CHANNEL="preview"
bash scripts/validate-compose-config.sh

printf 'Orbit preview preflight: isolated configuration and Compose validation passed.\n'
