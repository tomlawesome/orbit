#!/usr/bin/env bash
#
# Where a job reads its own reuse key and verdict from (ADR-0028, #1060 slice 3).
#
# Sourced by reuse-gate.sh and reuse-evidence.sh, which must agree exactly about
# this: a gate that read one file and an evidence writer that read another would
# record a pass under a key nobody checked.
#
# Two files, because the keys arrive at two different moments (ADR-0028 §2):
#
#   .orbit-reuse/reuse.env    classify's, with a source key for every job and a
#                             finished key and verdict for the source-keyed ones
#   .orbit-reuse/image.env    build_image's, with the finished key and verdict
#                             for each of the six jobs that test the image --
#                             the first place the image content ID exists
#
# Later file wins, then the environment. The environment is the fallback rather
# than the first answer so that a stale dotenv variable from an earlier job
# cannot outrank the file this pipeline just wrote.
#
# Not a dotenv report, for build_image's half: GitLab caps one at twenty
# variables, build.env already spends six, and six image jobs need three lines
# each. classify's half has been a plain file artefact since #898 for the same
# reason.

# shellcheck shell=bash

orbit_reuse_value() {
  local name="$1" value="" found="" file
  for file in \
    "${ORBIT_REUSE_ENV_FILE:-.orbit-reuse/reuse.env}" \
    "${ORBIT_REUSE_IMAGE_ENV_FILE:-.orbit-reuse/image.env}"
  do
    if [ -f "${file}" ]; then
      found="$(sed -n "s/^${name}=//p" "${file}" | tail -1)"
      if [ -n "${found}" ]; then
        value="${found}"
      fi
    fi
  done
  if [ -z "${value}" ]; then
    value="$(printenv "${name}" || true)"
  fi
  printf '%s' "${value}"
}
