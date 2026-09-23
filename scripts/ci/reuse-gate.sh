#!/usr/bin/env bash
#
# Stand on an earlier run of this same job rather than repeating it (ADR-0028,
# #1060 slice 3; replaces the #898 version).
#
# The verdict has already been taken. `classify` keyed the source-keyed jobs;
# `build_image`, once it had the image content ID, keyed the six that test the
# image. Both wrote what they found into a file this job takes as an artefact.
# This is the job-side half: it reads that verdict and says the job may stop.
#
# Usage: reuse-gate.sh <job name>
#
# Exit status is the whole interface, because the caller is a `script:` line:
#   0   stand on the earlier run; the job's gate then exits 0
#   10  nothing to stand on, or something went wrong -- run for real
#
# A missed reuse is never a failure. Every fault here -- no verdict, no key, a
# file that never arrived -- falls through to the real work, which is the answer
# that can only cost time.
#
# Nothing is fetched here any more. Under #898 this script pulled image.tar and
# build.env back for a reused `build_image`, which was the only job whose
# artefacts the jobs after it read. ADR-0028 ends that: "`build_image` always
# builds; it no longer skips", so there is no reused build to fetch for, and
# with it goes the token and the curl this script needed. The six jobs that
# reuse now do so *after* build_image has handed them a real image.
#
# Inputs (environment):
#   ORBIT_REUSE_ENV_FILE         classify's verdicts (default
#                                .orbit-reuse/reuse.env)
#   ORBIT_REUSE_IMAGE_ENV_FILE   build_image's verdicts (default
#                                .orbit-reuse/image.env)
set -Eeuo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(CDPATH= cd -- "${script_dir}/../.." && pwd -P)"
readonly script_dir repo_root
cd "${repo_root}"

# shellcheck source=scripts/ci/reuse-env.sh
. "${script_dir}/reuse-env.sh"

readonly RUN_FOR_REAL=10

job="${1:?the job name is required}"

suffix="$(printf '%s' "${job}" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_')"

stands_on="$(orbit_reuse_value "ORBIT_REUSE_${suffix}")"
stands_on_pipeline="$(orbit_reuse_value "ORBIT_REUSE_${suffix}_PIPELINE")"
key="$(orbit_reuse_value "ORBIT_INPUTS_${suffix}")"

if [[ -z "${stands_on}" ]]; then
  printf '%s: no earlier run to stand on; running.\n' "${job}"
  exit "${RUN_FOR_REAL}"
fi

# A verdict without the key it was taken on is a verdict this job cannot record
# evidence for, so the next pipeline would have to repeat it anyway. Run.
if [[ -z "${key}" ]]; then
  printf '%s: a verdict arrived with no key beside it; running.\n' "${job}"
  exit "${RUN_FOR_REAL}"
fi

printf 'Standing on job %s from pipeline %s: key %s unchanged\n' \
  "${stands_on}" "${stands_on_pipeline:-unknown}" "${key}"

bash scripts/ci/reuse-evidence.sh "${job}" "${stands_on}" "${stands_on_pipeline:-null}"
exit 0
