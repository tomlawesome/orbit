#!/usr/bin/env bash
#
# ADR-0028 section 6, "Proof before trust", is the acceptance test for slice 2
# of #1060, and this is it, verbatim:
#
#   "Slice 2 is accepted only when two builds of the same tree on different
#   commits give the same content ID, and a one-file change under `src/` gives
#   a different one."
#
# So three builds of this checkout:
#
#   1  revision A, exporting a BuildKit cache        -> content ID 1
#   2  revision B, same tree, importing that cache   -> must equal 1
#   3  revision C, one file under src/ changed       -> must differ from 1
#
# Builds 2 and 3 run on a builder created from scratch, so the only thing they
# can inherit from build 1 is the exported cache. That is the fact under test:
# a second runner, on a later commit, importing the cache a delivery push left
# behind must land on the same bytes and therefore the same ID. Without it the
# whole of ADR-0028's artefact axis is a guess.
#
# Not wired into the pipeline: three image builds is far more than any pipeline
# should pay every run, and the claim is about the design, proved once, not
# about a given commit. Run it by hand on a host with Docker, or as a manual
# job, and record the output on #1060.
#
# Usage:
#   bash scripts/ci/prove-content-id.sh
#
# Inputs (environment):
#   ORBIT_PROOF_CACHE_REF   a registry cache reference to use instead of a
#                           local cache directory -- the real article, e.g.
#                           $CI_REGISTRY_IMAGE/build-cache:proof. Requires a
#                           `docker login` first. Defaults to a throwaway
#                           local cache, which exercises the same BuildKit
#                           import path without needing a credential.
#   ORBIT_PROOF_KEEP        `true` leaves the images and the cache behind.
#
# Exit status: 0 when both assertions hold, 1 when either fails. It changes one
# tracked file under src/ while it runs and puts it back afterwards, so it
# refuses to start unless that file is clean.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root
cd "${repo_root}"

readonly changed_file="src/cli/orbit.ts"
readonly builder="orbit-content-id-proof"
readonly tag_prefix="orbit-content-id-proof"

# A real change rather than a comment: esbuild drops comments, so a commented
# line would leave the CLI bundle byte-identical and the image unchanged --
# which ADR-0028 expects ("a `web/**` or `src/**` change that leaves the image
# bytes unchanged (a comment, a type, a test file) reuses every image job").
# An exported constant survives the bundler and reaches /opt/orbit/cli/orbit.js.
readonly source_change='export const ORBIT_CONTENT_ID_PROOF = "one file changed";'

command -v docker > /dev/null 2>&1 || { printf 'docker is required.\n' >&2; exit 1; }
docker buildx version > /dev/null 2>&1 || { printf 'docker buildx is required.\n' >&2; exit 1; }
git diff --quiet -- "${changed_file}" \
  || { printf '%s has uncommitted changes; this script edits it and puts it back.\n' "${changed_file}" >&2; exit 1; }

backup="$(mktemp)"
cp -p "${changed_file}" "${backup}"
cache_dir=""
if [[ -z "${ORBIT_PROOF_CACHE_REF:-}" ]]; then
  cache_dir="$(mktemp -d)"
fi

cleanup() {
  cp -p "${backup}" "${changed_file}"
  rm -f "${backup}"
  docker buildx rm "${builder}" > /dev/null 2>&1 || true
  if [[ "${ORBIT_PROOF_KEEP:-}" != "true" ]]; then
    docker image rm -f "${tag_prefix}:1" "${tag_prefix}:2" "${tag_prefix}:3" > /dev/null 2>&1 || true
    if [[ -n "${cache_dir}" ]]; then rm -rf "${cache_dir}"; fi
  fi
}
trap cleanup EXIT

# A builder with no state of its own, so an import is the only way a later
# build can reach an earlier build's layers.
fresh_builder() {
  docker buildx rm "${builder}" > /dev/null 2>&1 || true
  docker buildx create --name "${builder}" --driver docker-container > /dev/null
}

cache_from() {
  if [[ -n "${ORBIT_PROOF_CACHE_REF:-}" ]]; then
    printf 'type=registry,ref=%s' "${ORBIT_PROOF_CACHE_REF}"
  else
    printf 'type=local,src=%s' "${cache_dir}"
  fi
}

cache_to() {
  if [[ -n "${ORBIT_PROOF_CACHE_REF:-}" ]]; then
    printf 'type=registry,ref=%s,mode=max' "${ORBIT_PROOF_CACHE_REF}"
  else
    printf 'type=local,dest=%s,mode=max' "${cache_dir}"
  fi
}

# `$1` is the tag suffix, `$2` the revision this build pretends to be, `$3`
# `export` when this build is the one that writes the cache. The arguments are
# otherwise exactly the ones .gitlab-ci.yml's build_image passes.
build() {
  local suffix="$1" revision="$2" export_cache="${3:-}"
  local -a cache_args=(--cache-from "$(cache_from)")
  if [[ "${export_cache}" == "export" ]]; then cache_args+=(--cache-to "$(cache_to)"); fi
  printf '\n== build %s (revision %s) ==\n' "${suffix}" "${revision}"
  docker buildx build \
    --builder "${builder}" \
    --file ./Dockerfile \
    --load \
    "${cache_args[@]}" \
    --build-arg "ORBIT_VERSION=v0.0.0" \
    --build-arg "ORBIT_REVISION=${revision}" \
    --build-arg "ORBIT_CHANNEL=ci" \
    --tag "${tag_prefix}:${suffix}" \
    .
}

content_id() {
  ORBIT_IMAGE_REF="${tag_prefix}:$1" bash scripts/ci/image-content-id.sh
}

fresh_builder
build 1 "$(printf 'a%.0s' $(seq 40))" export
first="$(content_id 1)"

fresh_builder
build 2 "$(printf 'b%.0s' $(seq 40))"
second="$(content_id 2)"

printf '%s\n' "${source_change}" >> "${changed_file}"
fresh_builder
build 3 "$(printf 'c%.0s' $(seq 40))"
third="$(content_id 3)"
cp -p "${backup}" "${changed_file}"

printf '\n== ADR-0028 section 6 ==\n'
printf 'build 1, tree as committed          %s\n' "${first}"
printf 'build 2, same tree, later commit    %s\n' "${second}"
printf 'build 3, one file changed in src/   %s\n' "${third}"

status=0
if [[ "${second}" == "${first}" ]]; then
  printf 'PASS  two builds of the same tree on different commits agree.\n'
else
  printf 'FAIL  the same tree gave two content IDs; the stamp is not the only thing varying.\n' >&2
  status=1
fi
if [[ "${third}" != "${first}" ]]; then
  printf 'PASS  a one-file change under src/ moves the content ID.\n'
else
  printf 'FAIL  a changed src/ file left the content ID alone; it is not naming the bytes under test.\n' >&2
  status=1
fi
exit "${status}"
