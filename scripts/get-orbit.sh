#!/usr/bin/env bash
set -Eeuo pipefail
#
# The first command a user runs (ADR-0031 #6):
#   curl -fsSL https://raw.githubusercontent.com/tomlawesome/orbit/main/scripts/get-orbit.sh | bash
#
# Downloads the signed release manifest, verifies it, downloads the launcher
# and install.sh named by it, verifies their sha256s, then hands off to the
# launcher. Never runs anything that has not been verified. Kept short and
# readable on purpose (ADR-0031 #6): install.sh is not extended into this
# role.
#
# Env: ORBIT_CHANNEL (latest|preview, default latest), ORBIT_VERSION
# (vX.Y.Z, pins a specific release; overrides ORBIT_CHANNEL).
#
# Test-only, not for user environments: ORBIT_GET_BASE_URL overrides the
# release base URL; ORBIT_GET_TEST_PUBLIC_KEY_FILE overrides the embedded
# key, but only together with ORBIT_GET_TEST_ALLOW_KEY_OVERRIDE=1 -- a lone
# key-file variable is refused, so a user's environment cannot silently swap
# the trust anchor. See scripts/get-orbit.test.mjs.
fail() { printf 'get-orbit: %s\n' "$1" >&2; exit 1; }

# Byte-identical to cosign.pub (checked by scripts/get-orbit.test.mjs).
# Rotation: docs/releasing.md.
embedded_public_key='-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEz/p19d5ZrSimfOQ80OCeSG8s32dm
k91OtCbfzOoGPhJnnXIynC5JDfyBoZiS59rCFb2hSiERGWQmLH1i8XV4nQ==
-----END PUBLIC KEY-----'

command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v openssl >/dev/null 2>&1 || fail "openssl is required."
command -v tar >/dev/null 2>&1 || fail "tar is required."

case "$(uname -s)" in
  Linux) ;;
  *) fail "only Linux is supported." ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "unsupported architecture: $(uname -m) (only amd64 and arm64 are supported)." ;;
esac

base_url="${ORBIT_GET_BASE_URL:-https://github.com/tomlawesome/orbit}"
channel="${ORBIT_CHANNEL:-latest}"
version_pin="${ORBIT_VERSION:-}"
if [[ -n "$version_pin" ]]; then
  [[ "$version_pin" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "ORBIT_VERSION must look like vX.Y.Z: ${version_pin}"
  asset_base="${base_url}/releases/download/${version_pin}"
  stable=1
elif [[ "$channel" == "latest" ]]; then
  asset_base="${base_url}/releases/latest/download"
  stable=1
elif [[ "$channel" == "preview" ]]; then
  asset_base="${base_url}/releases/download/preview"
  stable=0
else
  fail "ORBIT_CHANNEL must be latest or preview, got: ${channel}"
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/orbit-get.XXXXXX")" || fail "could not create a private temporary directory."
trap 'rm -rf "$work_dir"' EXIT

key_file="$work_dir/trusted.pub"
if [[ -n "${ORBIT_GET_TEST_PUBLIC_KEY_FILE:-}" ]]; then
  [[ "${ORBIT_GET_TEST_ALLOW_KEY_OVERRIDE:-}" == "1" ]] ||
    fail "ORBIT_GET_TEST_PUBLIC_KEY_FILE is set without ORBIT_GET_TEST_ALLOW_KEY_OVERRIDE=1; refusing to swap the trust anchor."
  cp "$ORBIT_GET_TEST_PUBLIC_KEY_FILE" "$key_file"
else
  printf '%s\n' "$embedded_public_key" > "$key_file"
fi

fetch() {
  curl --silent --show-error --fail --location --connect-timeout 5 --max-time 120 \
    -o "$2" "$1" || fail "could not download $1"
}

manifest_json="$work_dir/orbit-release-manifest.json"
manifest_sig="$work_dir/orbit-release-manifest.json.sig"
fetch "${asset_base}/orbit-release-manifest.json" "$manifest_json"
fetch "${asset_base}/orbit-release-manifest.json.sig" "$manifest_sig"

der_file="$work_dir/manifest.sig.der"
if ! base64 -d < "$manifest_sig" > "$der_file" 2>/dev/null || [[ ! -s "$der_file" ]]; then
  fail "the manifest signature is not valid base64; refusing an unverifiable manifest."
fi
openssl dgst -sha256 -verify "$key_file" -signature "$der_file" "$manifest_json" > /dev/null 2>&1 ||
  fail "could not verify the release manifest's signature against the trusted key."

if command -v cosign > /dev/null 2>&1; then
  bundle="$work_dir/orbit-release-manifest.json.sigstore.json"
  if curl --silent --show-error --fail --location --connect-timeout 5 --max-time 60 \
    -o "$bundle" "${asset_base}/orbit-release-manifest.json.sigstore.json" 2> /dev/null; then
    cosign verify-blob \
      --bundle "$bundle" \
      --certificate-identity-regexp '^https://github.com/tomlawesome/orbit/' \
      --certificate-oidc-issuer https://token.actions.githubusercontent.com \
      "$manifest_json" > /dev/null 2>&1 ||
      fail "cosign could not verify the countersignature bundle."
  elif [[ "$stable" == 1 ]]; then
    fail "no countersignature bundle for this release yet; refusing on channel ${channel}."
  else
    printf 'get-orbit: no countersignature bundle yet on preview; continuing with the key-based check only.\n' >&2
  fi
else
  printf 'get-orbit: cosign not found on PATH; only the key-based signature was checked. Install cosign (https://docs.sigstore.dev/system_config/installation/) to also verify the keyless countersignature.\n' >&2
fi

# Literal-key extraction, not a JSON parser: safe because
# scripts/ci/write-release-manifest.sh always writes one field per line, and
# every key read here ("version", a files.* filename) is unique in that
# schema.
manifest_value() { grep -F "\"$2\":" "$1" | sed -n 's/.*: *"\([^"]*\)".*/\1/p' | head -n1; }
version="$(manifest_value "$manifest_json" version)"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] || fail "the manifest has no valid version."
archive_name="orbit-launcher_linux_${arch}.tar.gz"
archive_sha="$(manifest_value "$manifest_json" "$archive_name")"
install_sha="$(manifest_value "$manifest_json" install.sh)"
[[ "$archive_sha" == sha256:* && "$install_sha" == sha256:* ]] || fail "the manifest is missing a file checksum."

archive_file="$work_dir/$archive_name"
install_file="$work_dir/install.sh"
fetch "${asset_base}/${archive_name}" "$archive_file"
fetch "${asset_base}/install.sh" "$install_file"
printf '%s  %s\n' "${archive_sha#sha256:}" "$archive_file" | sha256sum -c - > /dev/null 2>&1 ||
  fail "the launcher archive does not match the manifest's checksum."
printf '%s  %s\n' "${install_sha#sha256:}" "$install_file" | sha256sum -c - > /dev/null 2>&1 ||
  fail "install.sh does not match the manifest's checksum."

install_dir="${XDG_CACHE_HOME:-$HOME/.cache}/orbit/${version}"
mkdir -p "$install_dir" || fail "could not create ${install_dir}."
tar -xzf "$archive_file" -C "$install_dir" || fail "could not extract the launcher archive."
launcher="$install_dir/orbit-launcher"
[[ -x "$launcher" ]] || fail "the launcher archive did not contain an executable orbit-launcher binary."
cp "$manifest_json" "$install_dir/orbit-release-manifest.json"
cp "$install_file" "$install_dir/install.sh"
chmod +x "$install_dir/install.sh"

trap - EXIT
rm -rf "$work_dir"
exec env \
  ORBIT_LAUNCHER_INSTALL_SCRIPT_PATH="$install_dir/install.sh" \
  ORBIT_RELEASE_MANIFEST="$install_dir/orbit-release-manifest.json" \
  "$launcher"
