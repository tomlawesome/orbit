#!/usr/bin/env bash
#
# Files or updates the one GitLab issue naming which pinned sidecar images are
# behind (#820). Ported from the GitHub `Sidecar pin freshness` workflow's
# `gh issue create` / `gh issue edit` step, which filed to GitHub issues that
# are being switched off (#801).
#
# Called only when `sidecar-pins.mjs check` found something behind (exit 1):
# the `sidecar_pin_freshness` job in .gitlab-ci.yml is what decides that and
# passes the report file this script turns into an issue body.
#
# Usage:
#   scripts/ci/sidecar-freshness-issue.sh <report-file>
#
# Inputs (environment):
#   SIDECAR_ISSUE_TOKEN  a masked CI/CD variable: a project access token with
#                        the `api` scope. Never printed; passed to curl as a
#                        header, never on the command line.
#   CI_API_V4_URL        GitLab's predefined API base URL.
#   CI_PROJECT_ID        GitLab's predefined numeric project id.
#   CI_PIPELINE_URL      GitLab's predefined pipeline URL, recorded in the
#                        issue body so a reader can open the run that found it.
set -Eeuo pipefail

fail() { printf 'sidecar-freshness-issue: %s\n' "$1" >&2; exit 1; }

: "${SIDECAR_ISSUE_TOKEN:?SIDECAR_ISSUE_TOKEN is not set. Create a project access token (scope: api) and set it as a masked CI/CD variable named SIDECAR_ISSUE_TOKEN before this job can file or update an issue.}"
: "${CI_API_V4_URL:?CI_API_V4_URL is not set; this script must run inside a GitLab CI job}"
: "${CI_PROJECT_ID:?CI_PROJECT_ID is not set; this script must run inside a GitLab CI job}"
: "${CI_PIPELINE_URL:?CI_PIPELINE_URL is not set; this script must run inside a GitLab CI job}"

report_file="${1:-}"
[[ -n "$report_file" ]] || fail 'a report file is required as the first argument'
[[ -f "$report_file" ]] || fail "report file does not exist: ${report_file}"

api="${CI_API_V4_URL%/}/projects/${CI_PROJECT_ID}"
title='Sidecar pins are behind'
labels='security,dependencies'
milestone_title='M5 — Supply chain and CI baseline'

# The token travels in a header file, never in argv or a process listing.
header_file="$(mktemp)"
body_file="$(mktemp)"
trap 'rm -f "$header_file" "$body_file"' EXIT
printf 'PRIVATE-TOKEN: %s\n' "$SIDECAR_ISSUE_TOKEN" > "$header_file"
api_call() { curl --silent --show-error --fail --location --max-time 60 --header @"$header_file" "$@"; }

# Reads one value out of a JSON response on stdin with node, which every job
# image here carries; jq is not in $NODE_IMAGE and the unit test's runner image
# does not have it either. First argument is passed through as argv[1].
json_field() {
  node -e 'let input = ""; process.stdin.on("data", (chunk) => { input += chunk; }).on("end", () => { const value = new Function("input", process.argv[2])(input); process.stdout.write(String(value ?? "")); });' -- "$1" "$2"
}

{
  printf 'Reported by the weekly `sidecar_pin_freshness` GitLab job on %s.\n' "$(date -u +%Y-%m-%d)"
  printf 'Run: %s\n\n' "$CI_PIPELINE_URL"
  cat "$report_file"
} > "$body_file"

# GitLab's `search` is a substring match, not an exact one, so the result is
# still checked against the exact title before it is trusted.
existing_iid="$(
  api_call -G \
    --data-urlencode "state=opened" \
    --data-urlencode "search=${title}" \
    --data-urlencode "in=title" \
    --data-urlencode "labels=${labels}" \
    --data-urlencode "per_page=5" \
    "${api}/issues" |
    json_field "$title" 'const hit = JSON.parse(input).find((issue) => issue.title === process.argv[1]); return hit ? hit.iid : "";'
)"

if [[ -n "$existing_iid" ]]; then
  api_call -X PUT \
    --data-urlencode "description@${body_file}" \
    "${api}/issues/${existing_iid}" > /dev/null
  printf 'sidecar-freshness-issue: updated issue #%s\n' "$existing_iid"
  exit 0
fi

# Exact title match: GitLab's milestones `title` filter is exact, unlike issue
# search above. Missing is not fatal -- the issue is still worth filing without
# it -- so this warns rather than failing the run.
milestone_id="$(
  api_call -G --data-urlencode "title=${milestone_title}" "${api}/milestones" |
    json_field '' 'const [first] = JSON.parse(input); return first ? first.id : "";'
)"
if [[ -z "$milestone_id" ]]; then
  printf 'sidecar-freshness-issue: no milestone titled "%s"; creating without one.\n' "$milestone_title" >&2
fi

create_args=(-X POST
  --data-urlencode "title=${title}"
  --data-urlencode "labels=${labels}"
  --data-urlencode "description@${body_file}"
)
if [[ -n "$milestone_id" ]]; then
  create_args+=(--data-urlencode "milestone_id=${milestone_id}")
fi

created_iid="$(api_call "${create_args[@]}" "${api}/issues" | json_field '' 'return JSON.parse(input).iid ?? "";')"
[[ -n "$created_iid" ]] || fail 'issue creation did not return an iid'
printf 'sidecar-freshness-issue: created issue #%s\n' "$created_iid"
