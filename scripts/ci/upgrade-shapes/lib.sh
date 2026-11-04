#!/usr/bin/env bash
# Shared helpers for the upgrade-matrix configuration shapes (#1662, #1647).
# A shape script sources this, optionally overrides shape_provision,
# shape_after_install and SHAPE_ASSERTS, then calls shape_main "$@".
# Usage: <shape>.sh provision|after_install|assert <target-dir> <old-tree-dir>
# Nothing here prints a secret value: only key names and fixed text.
set -euo pipefail

SHAPE_ASSERTS=(env-file-intact)
APP_HOST=https://orbit.example.invalid
# Keys the installer rewrites at an update; the only ones allowed to differ.
MANAGED_KEYS='ORBIT_IMAGE|ORBIT_CONFIG_APPLIED_VERSION|ORBIT_CONFIG_APPLIED_DIGEST|ORBIT_PREVIOUS_IMAGE'
SECRET_KEY='(SECRET|PASSWORD|KEK|TOKEN|PRIVATE_KEY)$'

shape_provision() { :; }
shape_after_install() { :; }

# set_key KEY VALUE: replace or append a line in $ENV_FILE.
set_key() {
  { grep -v "^$1=" "$ENV_FILE" || true; } >"$ENV_FILE.tmp" # tmp is renamed over, so mode is reset below
  printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE.tmp"
  chmod 600 "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
}

# secret_file NAME: a 64-hex secret (what the installer accepts) at mode 600.
secret_file() {
  mkdir -p "$TARGET/.orbit-secrets"
  chmod 700 "$TARGET/.orbit-secrets"
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$TARGET/.orbit-secrets/$1"
  chmod 600 "$TARGET/.orbit-secrets/$1"
}

# uncomment KEY...: turn the old example's commented "# KEY=value" into a setting.
uncomment() {
  local k line
  for k in "$@"; do
    line=$(grep -m1 -E "^# $k=" "$OLD_TREE/.env-orbit.example") || continue
    set_key "$k" "${line#"# $k="}"
  done
}

provision_base() {
  ENV_FILE=$TARGET/.env-orbit
  (umask 077 && grep -E '^[A-Z][A-Z0-9_]*=' "$OLD_TREE/.env-orbit.example" >"$ENV_FILE")
  chmod 600 "$ENV_FILE"
  set_key APP_URL "$APP_HOST"
  set_key OIDC_CALLBACK_URL "$APP_HOST/api/auth/callback"
  set_key ORBIT_BIND_ADDRESS 127.0.0.1
  secret_file session-secret
  secret_file document-kek
  secret_file postgres-password
}

# env_names: names (never values) of the running orbit-app container's environment.
env_names() { docker exec orbit env | cut -d= -f1 | sort -u; }

# normalise FILE: drop managed keys; replace secret-named values by their hash so
# drift still shows but no value is ever kept or printed.
normalise() {
  local line key
  grep -Ev "^($MANAGED_KEYS)=" "$1" | while IFS= read -r line; do
    key=${line%%=*}
    if [[ $line == *=* && $key =~ $SECRET_KEY ]]; then
      printf '%s=sha256:%s\n' "$key" "$(printf '%s' "${line#*=}" | sha256sum | cut -c1-64)"
    else
      printf '%s\n' "$line"
    fi
  done
}

fail() {
  printf 'assertion=%s detail="%s"\n' "$1" "$(printf '%s' "$2" | tr -d '"\r' | tr '\n' ' ')"
  exit 1
}

# Names of the keys that differ: the stored (normalised) snapshot against a live file.
changed_keys() {
  diff "$1" <(normalise "$2") | sed -n 's/^[<>] \([^=]*\).*/\1/p' | sort -u | tr '\n' ' ' || true
}

assert_env-file-intact() {
  local keys
  keys=$(changed_keys "$SNAP/env-orbit" "$ENV_FILE")
  [[ -z $keys ]] || fail env-file-intact ".env-orbit differs from the snapshot in: $keys"
}

assert_overlay-composed() {
  local running
  running=$(cd "$TARGET" && docker compose --env-file .env-orbit ps --services 2>/dev/null) || true
  grep -qx orbit-app <<<"$running" ||
    fail overlay-composed "orbit-app is not running with the mail overlay"
  # A running orbit-app alone does not prove the overlay was composed: only
  # docker-compose.mail.yml sets SMTP_PASSWORD_FILE in its environment (#1665).
  grep -qx SMTP_PASSWORD_FILE <<<"$(env_names 2>/dev/null || true)" ||
    fail overlay-composed "orbit-app's environment has no SMTP_PASSWORD_FILE, so the mail overlay was not composed"
}

assert_secret-file-referenced() {
  local name path names
  names=$(env_names 2>/dev/null) || fail secret-file-referenced "orbit container environment unavailable"
  while IFS= read -r name; do
    [[ $name == *_FILE ]] || continue
    grep -qx "$name" <<<"$names" || fail secret-file-referenced "$name is no longer in the container environment"
  done <"$SNAP/env-names"
  while IFS='=' read -r name path; do
    [[ -n $path && $path != /* ]] || continue
    [[ -f $TARGET/$path ]] || fail secret-file-referenced "file for $name is missing"
  done < <(grep -E '^[A-Z0-9_]+_FILE=' "$ENV_FILE" | grep -v '^COMPOSE_FILE=')
}

assert_oidc-intact() {
  diff -q <(grep '^OIDC_' "$SNAP/env-orbit" || true) <(normalise "$ENV_FILE" | grep '^OIDC_' || true) >/dev/null ||
    fail oidc-intact "OIDC keys in .env-orbit changed"
}

shape_main() {
  local verb=${1:?verb} id
  TARGET=$(cd "${2:?target dir}" && pwd)
  OLD_TREE=${3:?old tree dir}
  ENV_FILE=$TARGET/.env-orbit
  SNAP=$TARGET/.upgrade-snapshot
  case $verb in
    provision)
      provision_base
      shape_provision
      ;;
    after_install)
      shape_after_install
      mkdir -p "$SNAP"
      chmod 700 "$SNAP"
      # Stored normalised, so the snapshot holds no secret value.
      normalise "$ENV_FILE" >"$SNAP/env-orbit"
      env_names >"$SNAP/env-names"
      ;;
    assert)
      for id in "${SHAPE_ASSERTS[@]}"; do "assert_$id"; done
      ;;
    *)
      echo "unknown verb: $verb" >&2
      exit 2
      ;;
  esac
}
