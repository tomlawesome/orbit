#!/usr/bin/env bash
# Refuse to build on a stale base image (#651).
#
# Runs before anything is built, because that is the only placement that costs
# nothing when it trips: a run that stops after a few seconds is a different
# proposition from one that discovers staleness after a long compile, or worse,
# rebuilds the base in the middle of somebody's build.
#
# Two ways a base can be behind, and the message says which:
#
#   1. The tag has moved. Our Dockerfile pins a digest; the tag it came from
#      now resolves to a different one. Somebody rebuilt and published, and we
#      have not adopted it.
#   2. The pinned image itself has stale packages. The digest is still current
#      but its Alpine release has published fixes since it was built. This is
#      the one that mattered: #646 shipped a fixed-in-Alpine OpenSSL flaw for a
#      month with the pin perfectly up to date.
#
# Neither is fixed here. This reports and exits non-zero; a person updates the
# pin, or triggers a base rebuild, and starts the run again. Nothing is
# rebuilt automatically and nothing is committed automatically (owner
# decision, 2026-08-29).
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dockerfile="${1:-$repo_dir/Dockerfile}"

fail() { printf 'base image: %s\n' "$1" >&2; }

# The first FROM, wherever it sits. This used to read line 1 literally, which
# held only while the Dockerfile opened with its FROM; a comment block above it
# made the check report an unpinned base and refuse to run (#651). A Dockerfile
# may legally open with comments, so find the directive rather than assume its
# line number.
#
# `q` inside the match, not `| head -1`. Our Dockerfile is multi-stage, so sed
# emitted seven references and kept reading the remaining ~120 lines after
# head -1 had exited; sed then took SIGPIPE, and `pipefail` turned that into a
# 141 that `set -e` aborted on before anything was printed. Whether it lost the
# race depended on the machine, which is why it passed on GitHub's runner for
# months and failed on the busybox base_image job here (GitLab pipeline 169).
# One process reading only as far as it needs cannot lose that race at all.
#
# A function, not inlined, because the moved-tag check below needs the same
# extraction applied to `dev`'s Dockerfile as well as this branch's.
first_pinned_reference() {
  sed -n '/^FROM[[:space:]]/{s/^FROM[[:space:]]\{1,\}\([^[:space:]]*\).*/\1/p;q;}'
}

pinned_reference="$(first_pinned_reference < "$dockerfile")"
if [[ -z "$pinned_reference" || "$pinned_reference" != *@sha256:* ]]; then
  fail "the first FROM in $dockerfile is not a digest-pinned reference: '${pinned_reference:-<none>}'"
  fail "this check cannot verify an unpinned base, and an unpinned base must not ship."
  exit 2
fi

pinned_tag="${pinned_reference%@*}"
pinned_digest="${pinned_reference##*@}"

printf 'base image: pinned %s\n' "$pinned_reference"

# --- Axis 1: has the tag moved on? -------------------------------------------
#
# The pin is a platform manifest digest, not the multi-architecture index
# digest, so comparing against the index would always differ. Resolve the
# linux/amd64 manifest -- the only platform Orbit deploys -- and compare that.
# A single-architecture image has no index at all, so handle both shapes.
manifest_json=""
if ! manifest_json="$(docker manifest inspect "$pinned_tag" 2>/dev/null)"; then
  fail "could not resolve '$pinned_tag' from its registry."
  fail "if this is a private registry, the workflow needs to log in before this step."
  exit 2
fi

current_digest="$(
  printf '%s' "$manifest_json" | python3 -c '
import json, sys
doc = json.load(sys.stdin)
manifests = doc.get("manifests")
if not manifests:
    # Single-architecture image: docker reports the manifest itself, whose own
    # digest is not in the payload. Nothing to compare; treated as current.
    print("")
    raise SystemExit
for entry in manifests:
    platform = entry.get("platform") or {}
    if platform.get("os") == "linux" and platform.get("architecture") == "amd64":
        print(entry["digest"])
        raise SystemExit
print("")
'
)"

if [[ -z "$current_digest" ]]; then
  printf 'base image: tag %s has no linux/amd64 entry to compare; skipping the moved-tag check\n' "$pinned_tag"
elif [[ "$current_digest" != "$pinned_digest" ]]; then
  # A branch that is merely behind the default branch looks identical to a
  # moved tag: if `dev` already re-pinned to the current digest, this branch
  # just has not merged that yet. Telling the reader to hand-edit the FROM
  # line in that case goes green while leaving the branch behind, and writes
  # a second, conflicting re-pin commit against the one already on `dev`
  # (#1027). Ask what `dev` pins before handing out that advice.
  #
  # `BASE_REPIN_TARGET_BRANCH` is the same variable scripts/ci/repin-base-image.sh
  # already reads for this; a remote named anything but `origin` is a local
  # checkout's own naming (this repository's own working copies vary), never
  # what a GitLab CI job sees, so the remote is not read from a branch-name
  # variable but stays independently overridable for the rare non-CI caller.
  dev_branch="${BASE_REPIN_TARGET_BRANCH:-dev}"
  dev_remote="${ORBIT_BASE_IMAGE_DEV_REMOTE:-origin}"
  dockerfile_dir="$(cd "$(dirname "$dockerfile")" && pwd)"

  dev_content=""
  dev_reachable=0
  if dev_content="$(git -C "$dockerfile_dir" show "$dev_remote/$dev_branch:Dockerfile" 2>/dev/null)"; then
    dev_reachable=1
  elif git -C "$dockerfile_dir" fetch --no-tags --quiet "$dev_remote" "$dev_branch" 2>/dev/null \
      && dev_content="$(git -C "$dockerfile_dir" show "FETCH_HEAD:Dockerfile" 2>/dev/null)"; then
    dev_reachable=1
  fi
  # Anything else -- no git repository at all, a shallow clone with neither
  # ref nor a reachable remote, a detached HEAD with no origin configured --
  # leaves dev_reachable at 0 and falls straight through to today's message
  # below. A check that cannot ask `dev` must not guess it is clean.

  if [[ "$dev_reachable" -eq 1 ]]; then
    dev_pinned_reference="$(printf '%s\n' "$dev_content" | first_pinned_reference)"
    dev_pinned_digest="${dev_pinned_reference##*@}"
    if [[ -n "$dev_pinned_reference" && "$dev_pinned_digest" == "$current_digest" ]]; then
      fail "the tag has moved, but '$dev_branch' already pins the current digest:"
      fail "  $current_digest"
      fail ""
      fail "This branch is behind '$dev_branch', not behind the registry. Merge"
      fail "'$dev_branch' into this branch and run again -- do not hand-edit the FROM"
      fail "line here, it would conflict with the re-pin already on '$dev_branch'."
      exit 1
    fi
  fi

  fail "the tag has moved. '$pinned_tag' now resolves to:"
  fail "  $current_digest"
  fail "and this repository pins:"
  fail "  $pinned_digest"
  fail ""
  fail "Update the first FROM in $dockerfile to the new digest and run again."
  exit 1
else
  printf 'base image: pinned digest is the current linux/amd64 manifest of %s\n' "$pinned_tag"
fi

# --- Axis 2: are the pinned image's own packages behind? ---------------------
#
# Alpine ships fixes to its package repository rather than by republishing its
# base image, so a perfectly current pin can still carry a fixed vulnerability.
# `apk upgrade --simulate` answers that in a few seconds without building
# anything.
simulation=""
if ! simulation="$(
  docker run --rm --entrypoint sh "$pinned_reference" -c '
    apk update >/dev/null 2>&1 || exit 3
    apk upgrade --simulate 2>&1
  ' 2>&1
)"; then
  fail "could not query packages inside the pinned image; treating that as a failure"
  fail "rather than as an all-clear, because a check that cannot see is not a pass."
  printf '%s\n' "$simulation" >&2
  exit 2
fi

pending="$(printf '%s\n' "$simulation" | grep -E '^\([0-9]+/[0-9]+\) Upgrading ' || true)"

if [[ -n "$pending" ]]; then
  fail "the pinned image's packages are behind its own Alpine release:"
  printf '%s\n' "$pending" >&2
  fail ""
  fail "The tag has not moved, so there is nothing to re-pin to. Trigger a base"
  fail "image rebuild, publish it, pin the new digest, and run again."
  exit 1
fi

printf 'base image: packages are current for its Alpine release\n'
printf 'base image: nothing stale; the build may proceed\n'
