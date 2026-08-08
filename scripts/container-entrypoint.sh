#!/bin/sh
set -eu

readonly source_directory="/run/secrets"
readonly runtime_directory="/run/orbit-secrets"
readonly maximum_secret_bytes=65536
readonly script_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
readonly application_directory="$(dirname -- "$script_directory")"
readonly version_path="${application_directory}/VERSION"
readonly revision_path="${application_directory}/REVISION"

fail() {
  printf 'Orbit container startup: %s\n' "$*" >&2
  exit 1
}

[ -f "$version_path" ] && [ ! -L "$version_path" ] ||
  fail "the embedded version identity is unavailable"
[ -f "$revision_path" ] && [ ! -L "$revision_path" ] ||
  fail "the embedded revision identity is unavailable"

orbit_version="$(cat -- "$version_path")"
orbit_revision="$(cat -- "$revision_path")"
printf '%s\n' "$orbit_version" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' ||
  fail "the embedded version identity is invalid"
printf '%s\n' "$orbit_revision" | grep -Eq '^[0-9a-f]{40}$' ||
  fail "the embedded revision identity is invalid"

if [ "${1:-}" = "--version" ]; then
  printf "Orbit %s\n" "$orbit_version"
  exit 0
fi

printf "Orbit startup: version=%s revision=%s\n" "$orbit_version" "$orbit_revision"

# Docker Compose implements file-backed secrets as bind mounts. Their host
# ownership is therefore retained and cannot be remapped with Compose uid/gid
# options. Copy each secret into a private tmpfs before dropping privileges.
[ "$(id -u)" = "0" ] ||
  fail "the secret bootstrap must start as root"
[ -d "$source_directory" ] ||
  fail "the Docker secrets directory is unavailable"
[ -d "$runtime_directory" ] ||
  fail "the private runtime secrets tmpfs is unavailable"

chown root:orbit "$runtime_directory"
chmod 0750 "$runtime_directory"

secret_count=0
for source_path in "$source_directory"/*; do
  [ -e "$source_path" ] || continue
  [ ! -L "$source_path" ] ||
    fail "refusing a symbolic-link secret"
  [ -f "$source_path" ] ||
    fail "refusing a non-regular secret"

  secret_name="${source_path##*/}"
  case "$secret_name" in
    ""|"."|".."|*[!A-Za-z0-9._-]*)
      fail "refusing a secret with an unsafe name"
      ;;
  esac

  secret_size="$(wc -c < "$source_path" | tr -d '[:space:]')"
  case "$secret_size" in
    ""|*[!0-9]*)
      fail "could not determine a secret's size"
      ;;
  esac
  # The protected Compose secret declaration requires a host source for
  # orbit-oidc-client-secret even when the operator has not run
  # `configure.sh --set-oidc-secret`, so configure.sh leaves a zero-byte
  # placeholder in that case. Skip only that exact placeholder, and only when
  # OIDC_CLIENT_SECRET_FILE does not select it; once that variable selects the
  # file, an empty secret is a startup failure like any other.
  if [ "$secret_name" = "orbit-oidc-client-secret" ] && [ "$secret_size" -eq 0 ] &&
    [ -z "${OIDC_CLIENT_SECRET_FILE:-}" ]; then
    continue
  fi
  [ "$secret_size" -gt 0 ] ||
    fail "refusing an empty secret"
  [ "$secret_size" -le "$maximum_secret_bytes" ] ||
    fail "refusing an unexpectedly large secret"

  destination_path="$runtime_directory/$secret_name"
  rm -f -- "$destination_path"
  cp -- "$source_path" "$destination_path"
  chown orbit:orbit "$destination_path"
  chmod 0400 "$destination_path"
  secret_count=$((secret_count + 1))
done

[ "$secret_count" -gt 0 ] ||
  fail "no Docker secrets were supplied"

# Replace the bootstrap process so signals reach Node directly and the
# application, including PID 1, has no root privileges.
exec su-exec orbit:orbit "$@"
