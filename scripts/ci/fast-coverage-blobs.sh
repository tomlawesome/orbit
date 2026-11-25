#!/usr/bin/env bash
#
# Every `fast` shard's Vitest blob, in .vitest/blob/, before `fast_coverage`
# merges them (#1933 103a, section 3).
#
# A shard that ran in this pipeline left blob-<i>-<count>.json as an artefact.
# A shard that stood on an earlier run (reuse-gate.sh) left none, so its blob
# is fetched from the job that really did the work, whose id the reuse verdict
# names (ORBIT_REUSE_FAST_<i>_<count>). The job token reads this project's job
# artefacts; the reuse lookup's read-only token is never used here (ADR-0028
# kept it out of the job side).
#
# A shard with neither is a failure, not a skip: merging what is there would
# measure the floors on part of the suite. So is a blob count other than
# <count>: `--merge-reports` merges every file in the directory, and two copies
# of one shard would double-count.
#
# Usage: fast-coverage-blobs.sh <count>   (the `parallel:` of `fast`)
set -Eeuo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(CDPATH='' cd -- "${script_dir}/../.." && pwd -P)"
readonly script_dir repo_root
cd "${repo_root}"

# shellcheck source=scripts/ci/reuse-env.sh
. "${script_dir}/reuse-env.sh"

count="${1:?the shard count is required}"
if ! [[ "${count}" =~ ^[1-9][0-9]*$ ]]; then
  printf 'fast-coverage-blobs: the shard count must be a positive number, not "%s"\n' "${count}" >&2
  exit 2
fi

blob_dir=".vitest/blob"
mkdir -p "${blob_dir}"

rerun="rerun the pipeline with the \`ci: rerun\` label or ORBIT_REUSE=off"

for ((i = 1; i <= count; i++)); do
  blob="${blob_dir}/blob-${i}-${count}.json"
  if [[ -f "${blob}" ]]; then
    printf 'shard %s/%s: blob from this pipeline\n' "${i}" "${count}"
    continue
  fi
  job_id="$(orbit_reuse_value "ORBIT_REUSE_FAST_${i}_${count}")"
  if [[ -z "${job_id}" ]]; then
    printf 'fast-coverage-blobs: shard %s/%s left no blob and stood on no earlier run; %s\n' \
      "${i}" "${count}" "${rerun}" >&2
    exit 1
  fi
  printf 'shard %s/%s: stood on job %s; fetching its blob\n' "${i}" "${count}" "${job_id}"
  partial="${blob}.part"
  if ! curl --fail --silent --show-error --location \
    --header "JOB-TOKEN: ${CI_JOB_TOKEN:?CI_JOB_TOKEN is required to fetch a blob}" \
    "${CI_API_V4_URL:?}/projects/${CI_PROJECT_ID:?}/jobs/${job_id}/artifacts/${blob}" \
    -o "${partial}"; then
    rm -f "${partial}"
    printf 'fast-coverage-blobs: shard %s/%s has no blob: job %s'"'"'s artefact could not be fetched (expired?); %s\n' \
      "${i}" "${count}" "${job_id}" "${rerun}" >&2
    exit 1
  fi
  mv "${partial}" "${blob}"
done

found="$(find "${blob_dir}" -maxdepth 1 -type f -name '*.json' | wc -l)"
if [[ "${found}" -ne "${count}" ]]; then
  printf 'fast-coverage-blobs: %s blob files in %s, expected %s; a stray copy would be merged twice:\n' \
    "${found}" "${blob_dir}" "${count}" >&2
  ls -1 "${blob_dir}" >&2
  exit 1
fi
printf 'fast-coverage-blobs: %s blobs ready to merge\n' "${count}"
