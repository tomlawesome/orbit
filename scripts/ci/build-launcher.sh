#!/usr/bin/env bash
#
# Builds orbit-launcher from its pinned tag (ADR-0031 #3, implementation
# slice 2): clones the source the ADR names, refuses unless the checked-out
# tag resolves to launcher/pin.json's commit, and builds linux/amd64 and
# linux/arm64 with CGO_ENABLED=0 and the version ldflags orbit-launcher's own
# (now-deleted) .goreleaser.yml specified -- read back from
# `git show 0da01be:.goreleaser.yml` in the orbit-launcher history, since it
# no longer exists on disk there. Each binary is packed into the exact
# archive layout orbit-launcher's goreleaser config already used and
# scripts/get-orbit.sh (ADR-0031 #6) will extract:
# orbit-launcher_linux_<arch>.tar.gz holding a single executable,
# orbit-launcher, at the archive root -- no directory prefix.
#
# Called by the build_launcher job in .gitlab-ci.yml.
#
# Usage:
#   scripts/ci/build-launcher.sh <output-dir>
#
# Inputs (environment):
#   ORBIT_LAUNCHER_REMOTE    The repository to clone. Defaults to
#                            https://github.com/tomlawesome/orbit-launcher.git,
#                            the public mirror -- fine because the commit
#                            check below is what makes the source
#                            trustworthy (ADR-0031 #3); GitLab
#                            (ai/orbit-launcher) stays the source of truth
#                            for development. Overridable so tests can point
#                            this at a local repository instead of the
#                            network.
#   ORBIT_LAUNCHER_PIN_FILE  Path to the pin file. Defaults to
#                            launcher/pin.json.
#   ORBIT_GO                 The go command to run. Defaults to "go".
#                            Overridable so tests can exercise this against a
#                            stub that never touches the network or a real
#                            Go toolchain.
#
# Output: writes <output-dir>/orbit-launcher_linux_amd64.tar.gz and
# <output-dir>/orbit-launcher_linux_arm64.tar.gz, and prints their paths.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "${repo_root}"

fail() { printf 'build-launcher: %s\n' "$1" >&2; exit 1; }
log() { printf 'build-launcher: %s\n' "$1"; }

output_dir="${1:-}"
[[ -n "$output_dir" ]] || fail 'an output directory is required as the first argument'
mkdir -p "$output_dir"
output_dir="$(CDPATH= cd -- "$output_dir" && pwd -P)"

pin_file="${ORBIT_LAUNCHER_PIN_FILE:-${repo_root}/launcher/pin.json}"
[[ -f "$pin_file" ]] || fail "no pin file at ${pin_file} (ADR-0031 implementation slice 1 not yet landed)"

# pin.json has no node or jq in the build_launcher job's golang image, so
# this reads the pin without either. Safe only because pin.json's shape is
# fixed: scripts/bump-launcher-pin.sh is its one writer, and always emits a
# flat object with a string "tag" and a string "commit" field, each on its
# own line or not -- this tolerates both the pretty-printed file that script
# writes and the compact JSON build-launcher.test.mjs's fixtures use. It
# extracts whatever string is present for the field and hands it to the
# strict tag/commit regexes below, which are what actually decide the value
# is trustworthy; this function never has to be strict itself.
read_pin_field() {
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$pin_file" | head -n1
}
pin_tag="$(read_pin_field tag)"
pin_commit="$(read_pin_field commit)"

[[ "$pin_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] ||
  fail "${pin_file}'s tag is not a plain vX.Y.Z tag: ${pin_tag:-<missing>}"
[[ "$pin_commit" =~ ^[0-9a-f]{40}$ ]] ||
  fail "${pin_file}'s commit is not a 40-hex sha: ${pin_commit:-<missing>}"

remote="${ORBIT_LAUNCHER_REMOTE:-https://github.com/tomlawesome/orbit-launcher.git}"
go_cmd="${ORBIT_GO:-go}"

clone_dir="$(mktemp -d)"
_work_dirs=("$clone_dir")
cleanup() {
  local d
  for d in "${_work_dirs[@]}"; do rm -rf "$d"; done
}
trap cleanup EXIT

git clone --quiet "$remote" "$clone_dir" || fail "could not clone ${remote}"
git -C "$clone_dir" checkout --quiet "$pin_tag" ||
  fail "${remote} has no tag ${pin_tag}"

head_commit="$(git -C "$clone_dir" rev-parse HEAD)"
[[ "$head_commit" == "$pin_commit" ]] ||
  fail "${remote}'s ${pin_tag} resolves to ${head_commit}, not ${pin_file}'s pinned commit ${pin_commit}; refusing to build an unpinned source"
log "verified ${remote}'s ${pin_tag} is commit ${pin_commit}"

[[ -f "$clone_dir/go.mod" ]] || fail "${clone_dir}/go.mod not found; cannot build"
[[ -d "$clone_dir/cmd/orbit-launcher" ]] || fail "${clone_dir}/cmd/orbit-launcher not found; cannot build"

# Captured whole before taking the first line -- not `sed ... | head -1` --
# so a `head` that has already decided it has enough can never SIGPIPE a
# still-writing sed (#809; the same fix scripts/check-base-image-current.sh
# and scripts/ci/publish-image.sh already carry).
module="$(sed -n 's/^module[[:space:]]\{1,\}//p' "$clone_dir/go.mod")"
module="${module%%$'\n'*}"
[[ -n "$module" ]] || fail "${clone_dir}/go.mod names no module"

# The Go version this build actually runs with -- checked from inside the
# module (not the job's bare `go version`), because Go 1.21+'s own
# GOTOOLCHAIN=auto default lets an older installed `go` fetch and switch to
# whatever go.mod's `go` directive requires the moment it is asked anything
# from inside that module tree; checking from outside it would see only the
# job image's base binary and refuse a build Go itself would have satisfied.
# What must not happen silently is GOTOOLCHAIN=local (or an offline runner)
# leaving `go build` itself to fail with Go's own, less specific error, so
# this still fails closed -- just from the same vantage point `go build`
# below will build from.
# Same reason as module's own capture-first read above (#809).
required_go="$(sed -n 's/^go[[:space:]]\{1,\}//p' "$clone_dir/go.mod")"
required_go="${required_go%%$'\n'*}"
if [[ -n "$required_go" ]]; then
  have_go="$(cd "$clone_dir" && "$go_cmd" env GOVERSION 2>/dev/null | sed -n 's/^go//p')"
  [[ -n "$have_go" ]] || fail "could not determine this build's Go toolchain version (\`${go_cmd} env GOVERSION\` from ${clone_dir})"
  if ! printf '%s\n%s\n' "$required_go" "$have_go" | sort -C -V; then
    fail "${clone_dir}/go.mod requires go ${required_go}; this build's toolchain reports go${have_go}. Bump the build_launcher job's pinned golang image in .gitlab-ci.yml alongside this pin, or check GOTOOLCHAIN/network access on the runner."
  fi
  log "toolchain go${have_go} satisfies go.mod's go ${required_go}"
fi

# Matches orbit-launcher's own (now-deleted) .goreleaser.yml build stanza:
# CGO_ENABLED=0, -s -w for a stripped binary, and the two -X version vars
# release.Version/release.Revision embed what `orbit-launcher --version`
# prints. -buildid= is this job's own addition, for a reproducible binary
# across otherwise-identical builds -- goreleaser strips it by default
# through a mechanism this plain `go build` does not have, so it is named
# explicitly here instead.
ldflags="-s -w -buildid= -X ${module}/internal/release.Version=${pin_tag} -X ${module}/internal/release.Revision=${pin_commit}"

build_one() {
  local goarch="$1" work archive
  work="$(mktemp -d)"
  _work_dirs+=("$work")

  log "building linux/${goarch}..."
  (
    cd "$clone_dir"
    CGO_ENABLED=0 GOOS=linux GOARCH="$goarch" "$go_cmd" build \
      -trimpath -ldflags "$ldflags" \
      -o "${work}/orbit-launcher" \
      ./cmd/orbit-launcher
  ) || fail "go build failed for linux/${goarch}"
  [[ -x "${work}/orbit-launcher" ]] || fail "go build reported success but produced no executable for linux/${goarch}"

  archive="${output_dir}/orbit-launcher_linux_${goarch}.tar.gz"
  # A reproducible archive with exactly one member, at the archive root --
  # matching orbit-launcher's own goreleaser layout (archives: files:
  # [none*], name_template "orbit-launcher_{{.Os}}_{{.Arch}}") -- so
  # scripts/get-orbit.sh's extraction needs no directory-stripping logic.
  tar --create --gzip --file "$archive" \
    --owner=0 --group=0 --mtime='UTC 2020-01-01' \
    -C "$work" orbit-launcher
  log "wrote ${archive}"
  printf '%s\n' "$archive"
}

build_one amd64
build_one arm64

log "built ${pin_tag} (${pin_commit}) for linux/amd64 and linux/arm64 into ${output_dir}"
