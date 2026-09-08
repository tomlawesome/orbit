#!/usr/bin/env bash
#
# Stand on an earlier run of this same job rather than repeating it (#898).
#
# `classify` has already decided: it hashed what each job reads, looked through
# this merge request's earlier pipelines for a successful run of the job on the
# same hash, and wrote the verdict into the reuse env file it hands on as an
# artefact. This is the job-side half -- it reads that verdict, leaves behind
# everything the job's own artefacts promise, and says the job may stop.
#
# Usage: reuse-gate.sh <job name>
#
# Exit status is the whole interface, because the caller is a `script:` line:
#   0   stand on the earlier run; the job's gate then exits 0
#   10  nothing to stand on, or something went wrong -- run for real
#
# A missed reuse is never a failure. Every fault here -- no verdict, no token,
# an artefact that expired, a network that did not answer -- falls through to
# the real work, which is the answer that can only cost time.
#
# Inputs (environment):
#   ORBIT_REUSE_ENV_FILE   where classify left the verdict (default
#                          .orbit-reuse/reuse.env)
#   ORBIT_REUSE_API_URL    API base, defaulting to CI_API_V4_URL; injectable so
#                          a test can point it at a local server
#   BASE_REPIN_TOKEN       the one credential an unprotected merge-request
#                          pipeline can read. Sent through a curl config file,
#                          never on a command line, and never printed.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root
cd "${repo_root}"

readonly RUN_FOR_REAL=10

job="${1:?the job name is required}"
reuse_env="${ORBIT_REUSE_ENV_FILE:-.orbit-reuse/reuse.env}"

suffix="$(printf '%s' "${job}" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_')"

reuse_value() {
  local name="$1"
  if [[ -f "${reuse_env}" ]]; then
    sed -n "s/^${name}=//p" "${reuse_env}" | tail -1
    return 0
  fi
  printenv "${name}" || true
}

stands_on="$(reuse_value "ORBIT_REUSE_${suffix}")"
stands_on_pipeline="$(reuse_value "ORBIT_REUSE_${suffix}_PIPELINE")"
inputs="$(reuse_value "ORBIT_INPUTS_${suffix}")"

if [[ -z "${stands_on}" ]]; then
  printf '%s: no earlier run to stand on; running.\n' "${job}"
  exit "${RUN_FOR_REAL}"
fi

# What the job's own `artifacts:` promises the jobs after it. A reused run must
# leave these behind, or a `needs:` on it hands the next job nothing.
artifacts_for() {
  case "$1" in
    build_image) printf '%s\n' image.tar build.env ;;
    *) : ;;
  esac
}

# The artefacts API, with the token in a mode-600 config file rather than in the
# argument list, where `ps` and the job log would both see it.
fetch_artifact() {
  local from_job="$1" path="$2" destination="$3"
  local base="${ORBIT_REUSE_API_URL:-${CI_API_V4_URL:-}}"
  [[ -n "${base}" && -n "${CI_PROJECT_ID:-}" ]] \
    || { printf '%s: no API URL or project, so %s cannot be fetched\n' "${job}" "${path}"; return 1; }
  [[ -n "${BASE_REPIN_TOKEN:-}" ]] || { printf '%s: no token, so %s cannot be fetched\n' "${job}" "${path}"; return 1; }
  command -v curl > /dev/null 2>&1 || { printf '%s: curl is not installed, so %s cannot be fetched\n' "${job}" "${path}"; return 1; }

  local config status=0
  config="$(mktemp)"
  chmod 600 "${config}"
  {
    printf 'header = "PRIVATE-TOKEN: %s"\n' "${BASE_REPIN_TOKEN}"
    printf 'fail\nsilent\nshow-error\nlocation\n'
  } > "${config}"
  curl --config "${config}" --output "${destination}" \
    "${base%/}/projects/${CI_PROJECT_ID}/jobs/${from_job}/artifacts/${path}" || status=$?
  rm -f "${config}"
  return "${status}"
}

wanted="$(artifacts_for "${job}")"
if [[ -n "${wanted}" ]]; then
  staged="$(mktemp -d)"
  while read -r path; do
    [[ -n "${path}" ]] || continue
    if ! fetch_artifact "${stands_on}" "${path}" "${staged}/$(basename "${path}")"; then
      printf '%s: job %s no longer has %s (artefacts expire after four hours); building instead.\n' \
        "${job}" "${stands_on}" "${path}"
      rm -rf "${staged}"
      exit "${RUN_FOR_REAL}"
    fi
  done <<< "${wanted}"
  while read -r path; do
    [[ -n "${path}" ]] || continue
    mkdir -p "$(dirname "${path}")"
    mv "${staged}/$(basename "${path}")" "${path}"
  done <<< "${wanted}"
  rm -rf "${staged}"
  printf '%s: took %s from job %s.\n' "${job}" "${wanted//$'\n'/, }" "${stands_on}"
fi

printf 'Standing on job %s from pipeline %s: inputs %s unchanged\n' \
  "${stands_on}" "${stands_on_pipeline:-unknown}" "${inputs:-unknown}"

bash scripts/ci/reuse-evidence.sh "${job}" "${stands_on}" "${stands_on_pipeline:-null}"
exit 0
