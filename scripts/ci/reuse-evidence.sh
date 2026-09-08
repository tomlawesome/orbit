#!/usr/bin/env bash
#
# The proof that a job really ran, and on which inputs (#898).
#
# Written as the last line of a candidate job's `script:`, so it exists only
# when everything before it passed -- never in `after_script`, which runs
# whatever the job did. `classify` in the next pipeline reads it back through
# the artefacts API: evidence naming the same input hash is what lets that
# pipeline stand on this run instead of repeating it.
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
#   ORBIT_REUSE_ENV_FILE        where classify left the input hashes
#
# Never fails the job: a missing hash means the next pipeline reruns, which is
# the safe direction, and no evidence file is worth a red pipeline.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root
cd "${repo_root}"

job="${1:?the job name is required}"
stands_on="${2:-}"
stands_on_pipeline="${3:-}"

reuse_env="${ORBIT_REUSE_ENV_FILE:-.orbit-reuse/reuse.env}"
evidence_dir="${ORBIT_REUSE_EVIDENCE_DIR:-ci-evidence}"

suffix="$(printf '%s' "${job}" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_')"
inputs=""
if [[ -f "${reuse_env}" ]]; then
  inputs="$(sed -n "s/^ORBIT_INPUTS_${suffix}=//p" "${reuse_env}" | tail -1)"
fi
if [[ -z "${inputs}" ]]; then
  # The variable itself, for a job reading it from the environment rather than
  # from classify's artefact.
  inputs="$(printenv "ORBIT_INPUTS_${suffix}" || true)"
fi

if [[ -z "${inputs}" ]]; then
  printf 'no input hash for %s, so this run records no reuse evidence and the next pipeline repeats it\n' "${job}"
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

printf 'recorded %s/%s.json: inputs %s\n' "${evidence_dir}" "${job}" "${inputs}"
