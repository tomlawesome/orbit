#!/usr/bin/env bash
#
# Serves the installer's deployment assets from a checkout instead of GitHub.
#
# The installer downloads docker-compose.yml and friends from
# raw.githubusercontent.com at the revision the image was built from. On
# GitHub that revision is always there. On the GitLab pipeline a merge-request
# commit reaches GitHub only after it merges and mirrors, so the two steps
# that run the real installer (verify-installer-refusal.sh, run-installer.sh)
# would fail for want of a download, not a defect. Whether GitHub really has
# the files at that revision is GitHub's own pipeline's question, asked once
# the merge is mirrored (owner decision 2026-09-04, #801). Real installs never
# see this: the shim exists only on the calling script's PATH.
#
# Usage, from a script that already has ORBIT_REPOSITORY set:
#
#   source scripts/ci/assets-from-tree.sh
#   PATH="$(assets_from_tree_path)${PATH}"
#
# assets_from_tree_path prints "<shim dir>:" when ORBIT_ASSETS_FROM_TREE names
# a checkout, and nothing at all when it is unset, so the GitHub steps are
# unchanged. The shim is a `curl` that serves any file under the checkout for
# any revision of the repository; every other request -- the OIDC discovery
# document, for one -- goes to the real curl exactly as given, so the rest of
# the installer still exercises the network it would in a real install.

assets_from_tree_path() {
  [[ -n "${ORBIT_ASSETS_FROM_TREE:-}" ]] || return 0
  : "${ORBIT_REPOSITORY:?ORBIT_REPOSITORY is required to shim the asset URL}"
  local assets_tree shim_dir
  assets_tree="$(CDPATH= cd -- "${ORBIT_ASSETS_FROM_TREE}" && pwd -P)"
  local real_curl
  real_curl="$(command -v curl)" || {
    printf 'curl is required to shim the asset URL\n' >&2
    return 1
  }
  shim_dir="$(mktemp -d "${TMPDIR:-/tmp}/orbit-assets-shim.XXXXXX")"
  cat > "${shim_dir}/curl" <<SHIM
#!/usr/bin/env bash
set -Eeuo pipefail
asset_prefix="https://raw.githubusercontent.com/${ORBIT_REPOSITORY}/"
url=""
for arg in "\$@"; do
  case "\$arg" in
    "\$asset_prefix"*) url="\$arg" ;;
  esac
done
[[ -n "\$url" ]] || exec "${real_curl}" "\$@"
# The installer's asset fetch: --fail --silent --show-error --location
# --output <file> <url>. Copy the file where the download would have gone.
output=""
args=("\$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  [[ "\${args[i]}" == --output ]] && output="\${args[i+1]}"
done
asset="\${url#"\$asset_prefix"}"
asset="\${asset#*/}"
[[ -f "${assets_tree}/\$asset" ]] || exit 22
[[ -z "\$output" ]] || cp -- "${assets_tree}/\$asset" "\$output"
SHIM
  chmod 755 "${shim_dir}/curl"
  printf '%s:' "${shim_dir}"
}
