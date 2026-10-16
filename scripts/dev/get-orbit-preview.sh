#!/usr/bin/env bash
set -Eeuo pipefail
#
# get-orbit.sh for a preview build (release acceptance, #1153). Dev tooling:
# not shipped, not for users.
#
# get-orbit.sh refuses previews because a preview's signed release manifest
# lives only on GitLab (docs/releasing.md). This script does get-orbit.sh's
# part for a preview and nothing else: download the manifest, its signature,
# the launcher archive and install.sh from a place you name, check the
# signature against Orbit's key, check every file against the manifest, then
# hand off to the launcher exactly as get-orbit.sh does. From there it is the
# real user experience: the launcher's TUI, then the installer.
#
#   curl -fsSL <BASE>/get-orbit-preview.sh | ORBIT_PREVIEW_BASE_URL=<BASE> ORBIT_PREVIEW_DIGEST=sha256:<...> bash
#
# Env:
#   ORBIT_PREVIEW_BASE_URL  Required. A URL (http or https) or a local
#                           directory holding orbit-release-manifest.json,
#                           orbit-release-manifest.json.sig,
#                           orbit-launcher_linux_<arch>.tar.gz and install.sh.
#                           Where the files come from does not matter: the
#                           signature and checksums are what is trusted.
#   ORBIT_PREVIEW_DIGEST    Required: the image digest recorded on #1152. A
#                           validly signed manifest for a different build is
#                           refused, so a stale mirror cannot hand a tester an
#                           older signed preview.
#
# docs/installing-preview.md has the manual steps this replaces.
fail() { printf 'get-orbit-preview: %s\n' "$1" >&2; exit 1; }

# Byte-identical to cosign.pub and to get-orbit.sh's embedded key.
embedded_public_key='-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEz/p19d5ZrSimfOQ80OCeSG8s32dm
k91OtCbfzOoGPhJnnXIynC5JDfyBoZiS59rCFb2hSiERGWQmLH1i8XV4nQ==
-----END PUBLIC KEY-----'

for tool in curl openssl tar sha256sum base64; do
  command -v "$tool" >/dev/null 2>&1 || fail "${tool} is required."
done

case "$(uname -s)" in
  Linux) ;;
  *) fail "only Linux is supported." ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "unsupported architecture: $(uname -m) (only amd64 and arm64 are supported)." ;;
esac

base="${ORBIT_PREVIEW_BASE_URL:-}"
[[ -n "$base" ]] || fail "set ORBIT_PREVIEW_BASE_URL to where the preview's files are (a URL or a directory)."
base="${base%/}"
expected_digest="${ORBIT_PREVIEW_DIGEST:-}"
[[ -n "$expected_digest" ]] || fail "set ORBIT_PREVIEW_DIGEST to the preview's image digest recorded on #1152."
if [[ ! "$expected_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  fail "ORBIT_PREVIEW_DIGEST must look like sha256:<64 hex characters>."
fi

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

fetch() {
  if [[ "$base" =~ ^https?:// ]]; then
    curl --silent --show-error --fail --location --connect-timeout 10 --max-time 300 -o "$2" "${base}/$1" ||
      fail "could not download ${base}/$1."
  else
    [[ -f "${base}/$1" ]] || fail "${base}/$1 is not there."
    cp "${base}/$1" "$2"
  fi
}

key_file="$work_dir/cosign.pub"
printf '%s\n' "$embedded_public_key" > "$key_file"

manifest_json="$work_dir/orbit-release-manifest.json"
manifest_sig="$work_dir/orbit-release-manifest.json.sig"
fetch orbit-release-manifest.json "$manifest_json"
fetch orbit-release-manifest.json.sig "$manifest_sig"

der_file="$work_dir/manifest.sig.der"
if ! base64 -d < "$manifest_sig" > "$der_file" 2>/dev/null || [[ ! -s "$der_file" ]]; then
  fail "the manifest signature is not valid base64; refusing an unverifiable manifest."
fi
openssl dgst -sha256 -verify "$key_file" -signature "$der_file" "$manifest_json" > /dev/null 2>&1 ||
  fail "could not verify the release manifest's signature against Orbit's key."
printf 'get-orbit-preview: the release manifest is signed by Orbit'"'"'s key.\n' >&2

# Same literal-key extraction as get-orbit.sh (one field per line).
manifest_value() { grep -F "\"$2\":" "$1" | sed -n 's/.*: *"\([^"]*\)".*/\1/p' | head -n1; }
version="$(manifest_value "$manifest_json" version)"
[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "the manifest has no valid version."
channel="$(manifest_value "$manifest_json" channel)"
[[ "$channel" == "preview" ]] || fail "the signed manifest is for channel '${channel}', not preview; use get-orbit.sh for a stable release."
digest="$(manifest_value "$manifest_json" digest)"
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "the manifest names no valid image digest."
if [[ "$digest" != "$expected_digest" ]]; then
  fail "asked for ${expected_digest} but the signed manifest names ${digest}; refusing."
fi
commit="$(manifest_value "$manifest_json" commit)"

archive_name="orbit-launcher_linux_${arch}.tar.gz"
archive_sha="$(manifest_value "$manifest_json" "$archive_name")"
install_sha="$(manifest_value "$manifest_json" install.sh)"
[[ "$archive_sha" == sha256:* && "$install_sha" == sha256:* ]] || fail "the manifest is missing a file checksum."

archive_file="$work_dir/$archive_name"
install_file="$work_dir/install.sh"
fetch "$archive_name" "$archive_file"
fetch install.sh "$install_file"
printf '%s  %s\n' "${archive_sha#sha256:}" "$archive_file" | sha256sum -c - > /dev/null 2>&1 ||
  fail "the launcher archive does not match the manifest's checksum."
printf '%s  %s\n' "${install_sha#sha256:}" "$install_file" | sha256sum -c - > /dev/null 2>&1 ||
  fail "install.sh does not match the manifest's checksum."

printf 'get-orbit-preview: Orbit %s preview, commit %s, image %s. Launcher and installer match the manifest.\n' \
  "$version" "${commit:0:12}" "$digest" >&2

# Same cache layout and hand-off as get-orbit.sh, under a preview name so it
# never mixes with a stable release's cache.
install_dir="${XDG_CACHE_HOME:-$HOME/.cache}/orbit/${version#v}-preview"
mkdir -p "$install_dir" || fail "could not create ${install_dir}."
tar -xzf "$archive_file" -C "$install_dir" || fail "could not extract the launcher archive."
launcher="$install_dir/orbit-launcher"
[[ -x "$launcher" ]] || fail "the launcher archive did not contain an executable orbit-launcher binary."
cp "$manifest_json" "$install_dir/orbit-release-manifest.json"
cp "$install_file" "$install_dir/install.sh"
chmod +x "$install_dir/install.sh"

trap - EXIT
rm -rf "$work_dir"
# ORBIT_CHANNEL=preview is the one addition: install.sh tolerates a missing
# countersignature only on the preview channel (previews never get one).
exec env \
  ORBIT_CHANNEL=preview \
  ORBIT_LAUNCHER_INSTALL_SCRIPT_PATH="$install_dir/install.sh" \
  ORBIT_RELEASE_MANIFEST="$install_dir/orbit-release-manifest.json" \
  "$launcher"
