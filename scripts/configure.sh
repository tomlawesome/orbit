#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

readonly environment_file=".env-orbit"
readonly environment_example=".env-orbit.example"
readonly secrets_directory=".orbit-secrets"
temporary_file=""

fail() {
  printf 'Orbit configuration: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  [[ -z "$temporary_file" ]] || rm -f -- "$temporary_file"
}

trap cleanup EXIT

generate_hex_secret() {
  local secret

  if command -v openssl >/dev/null 2>&1; then
    secret="$(openssl rand -hex 32)"
  elif [[ -r /dev/urandom ]] && command -v od >/dev/null 2>&1; then
    secret="$(od -An -N32 -tx1 /dev/urandom | tr -d '[:space:]')"
  else
    fail "OpenSSL or a readable /dev/urandom with od is required to generate secrets."
  fi

  [[ "$secret" =~ ^[0-9a-fA-F]{64}$ ]] || fail "Secure secret generation failed."
  printf '%s\n' "${secret,,}"
}

ensure_environment_file() {
  [[ -f "$environment_example" ]] ||
    fail "${environment_example} is missing."

  if [[ -e "$environment_file" ]]; then
    [[ -f "$environment_file" && ! -L "$environment_file" ]] ||
      fail "Refusing to use ${environment_file} because it is not a regular file."
    chmod 600 "$environment_file" ||
      fail "Could not restrict ${environment_file} permissions."
    return
  fi

  temporary_file="$(mktemp "$PWD/.env-orbit.installing.XXXXXX")" ||
    fail "Could not create a temporary Orbit environment file."
  chmod 600 "$temporary_file" ||
    fail "Could not secure the temporary Orbit environment file."
  cp -- "$environment_example" "$temporary_file"
  mv -- "$temporary_file" "$environment_file"
  temporary_file=""
  printf 'Created %s from %s.\n' "$environment_file" "$environment_example"
}

ensure_secrets_directory() {
  if [[ -e "$secrets_directory" ]]; then
    [[ -d "$secrets_directory" && ! -L "$secrets_directory" ]] ||
      fail "Refusing to use ${secrets_directory} because it is not a regular directory."
  else
    mkdir -- "$secrets_directory"
  fi
  chmod 700 "$secrets_directory" ||
    fail "Could not restrict ${secrets_directory} permissions."
}

ensure_secret_file() {
  local path="$1" existing_value secret

  if [[ -e "$path" ]]; then
    [[ -f "$path" && ! -L "$path" ]] ||
      fail "Refusing to use ${path} because it is not a regular file."
    existing_value="$(tr -d '\r\n' < "$path")"
    [[ "$existing_value" =~ ^[0-9a-fA-F]{64}$ ]] ||
      fail "${path} does not contain a valid 256-bit hexadecimal secret."
    chmod 600 "$path" ||
      fail "Could not restrict permissions on ${path}."
    unset existing_value
    return
  fi

  secret="$(generate_hex_secret)"
  temporary_file="$(mktemp "$secrets_directory/.installing.XXXXXX")" ||
    fail "Could not create a temporary Orbit secret file."
  printf '%s\n' "$secret" > "$temporary_file"
  chmod 600 "$temporary_file" ||
    fail "Could not restrict permissions on the Orbit secret."
  mv -- "$temporary_file" "$path"
  temporary_file=""
  unset secret
  printf 'Generated %s.\n' "$path"
}

ensure_vapid_keys() {
  local private_key_file="$secrets_directory/vapid-private-key" generated public_key private_key orbit_image
  if [[ -s "$private_key_file" ]]; then
    chmod 600 "$private_key_file"
    return
  fi
  command -v docker >/dev/null 2>&1 || fail "Docker is required to generate VAPID keys."
  orbit_image="${ORBIT_IMAGE:-ghcr.io/tomlawesome/orbit:latest}"
  docker image inspect "$orbit_image" >/dev/null 2>&1 || docker pull "$orbit_image" >/dev/null || fail "Could not pull ${orbit_image} to generate VAPID keys."
  if ! generated="$(docker run --rm --entrypoint node "$orbit_image" /opt/orbit/scripts/generate-vapid.mjs 2>/dev/null)"; then
    printf 'Building the Orbit bootstrap image to generate VAPID keys.\n'
    docker build --target runner --tag orbit-vapid-bootstrap . >/dev/null || fail "Could not build the Orbit bootstrap image."
    generated="$(docker run --rm --entrypoint node orbit-vapid-bootstrap /opt/orbit/scripts/generate-vapid.mjs)" || fail "Could not generate VAPID keys."
  fi
  public_key="$(printf '%s\n' "$generated" | sed -n 's/^public=//p')"
  private_key="$(printf '%s\n' "$generated" | sed -n 's/^private=//p')"
  [[ -n "$public_key" && -n "$private_key" ]] || fail "VAPID key generation returned invalid values."
  temporary_file="$(mktemp "$secrets_directory/.vapid.installing.XXXXXX")"
  printf '%s\n' "$private_key" > "$temporary_file"
  chmod 600 "$temporary_file"
  mv -- "$temporary_file" "$private_key_file"
  temporary_file=""
  sed -i "s|^VAPID_PUBLIC_KEY=.*|VAPID_PUBLIC_KEY=$public_key|" "$environment_file"
  sed -i "s|^VAPID_PRIVATE_KEY_FILE=.*|VAPID_PRIVATE_KEY_FILE=/run/orbit-secrets/orbit-vapid-private-key|" "$environment_file"
  printf 'Generated VAPID push keys.\n'
}

ensure_environment_file
ensure_secrets_directory
ensure_secret_file "$secrets_directory/session-secret"
ensure_secret_file "$secrets_directory/postgres-password"
# A 32-byte hexadecimal KEK is generated only when absent and is never printed.
ensure_secret_file "$secrets_directory/document-kek"
ensure_vapid_keys

printf 'Orbit configuration is ready. Existing values were preserved.\n'
