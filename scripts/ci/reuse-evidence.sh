#!/usr/bin/env bash
#
# The proof that a job really ran, and on which key (#898; ADR-0028 rekeyed it,
# #1060 slice 3).
#
# Written as the last line of a candidate job's `script:`, so it exists only
# when everything before it passed -- never in `after_script`, which runs
# whatever the job did. A later pipeline reads it back through the artefacts
# API: evidence naming the same key is what lets that pipeline stand on this
# run instead of repeating it. The key is ADR-0028's composite one -- the
# artefact under test, the checkout minus the job's deny-list, and the pipeline
# definition -- so evidence recorded on any ref, by any branch, is comparable.
#
# A job that gated itself out leaves no evidence, which is the answer wanted:
# "did not really run" must not read as "ran and passed".
#
# Usage:
#   reuse-evidence.sh <job name>                              this job did the work
#   reuse-evidence.sh <job name> <job id> <pipeline id>       it stood on an earlier run
#
# Inputs (environment):
#   CI_PIPELINE_ID, CI_JOB_ID   this run's identity
#   ORBIT_REUSE_ENV_FILE        classify's keys and verdicts
#   ORBIT_REUSE_IMAGE_ENV_FILE  build_image's, for the six image-running jobs
#
# Never fails the job: a missing key means the next pipeline reruns, which is
# the safe direction, and no evidence file is worth a red pipeline.
set -Eeuo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(CDPATH= cd -- "${script_dir}/../.." && pwd -P)"
readonly script_dir repo_root
cd "${repo_root}"

# shellcheck source=scripts/ci/reuse-env.sh
. "${script_dir}/reuse-env.sh"

job="${1:?the job name is required}"
stands_on="${2:-}"
stands_on_pipeline="${3:-}"

evidence_dir="${ORBIT_REUSE_EVIDENCE_DIR:-ci-evidence}"

suffix="$(printf '%s' "${job}" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_')"
inputs="$(orbit_reuse_value "ORBIT_INPUTS_${suffix}")"

if [[ -z "${inputs}" ]]; then
  printf 'no reuse key for %s, so this run records no reuse evidence and the next pipeline repeats it\n' "${job}"
  exit 0
fi

mkdir -p "${evidence_dir}"
{
  printf '{\n'
  printf '  "job": "%s",\n' "${job}"
  printf '  "inputs": "%s",\n' "${inputs}"
  printf '  "pipeline": %s,\n' "${CI_PIPELINE_ID:-0}"
  printf '  "job_id": %s,\n' "${CI_JOB_ID:-0}"
  printf '  "stands_on": %s,\n' "${stands_on:-null}"
  printf '  "stands_on_pipeline": %s\n' "${stands_on_pipeline:-null}"
  printf '}\n'
} > "${evidence_dir}/${job}.json"

printf 'recorded %s/%s.json: key %s\n' "${evidence_dir}" "${job}" "${inputs}"
