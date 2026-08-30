#!/usr/bin/env bash
# Run one Trivy invocation, retrying only vulnerability-DB download failures.
#
#   trivy-db-retry.sh <command> [args...]
#
# One refused HTTP request from the DB registry must not read as a policy
# verdict (#673). So: the wrapped command's exit status and output pass
# through untouched, except that a nonzero exit whose stderr carries Trivy's
# DB-download signature is retried with linear backoff. Exhausted retries
# still fail the job, prefixed as infrastructure so the log cannot be
# mistaken for a scan finding. Nothing here retries a policy failure: a
# verdict from --exit-code carries no download signature and returns on the
# first attempt.
set -uo pipefail

max_attempts="${TRIVY_DB_RETRY_ATTEMPTS:-3}"
backoff_seconds="${TRIVY_DB_RETRY_BACKOFF_SECONDS:-15}"

# The two signatures Trivy 0.72 prints when a DB pull fails: the main
# vulnerability DB (the #673 403) and the Java DB image scans may also fetch.
db_signature='failed to download vulnerability DB|failed to download Java DB'

attempt=1
while true; do
  stderr_capture="$(mktemp)" || exit 70
  status=0
  "$@" 2> "$stderr_capture" || status=$?
  cat "$stderr_capture" >&2
  if [[ "$status" -eq 0 ]] ||
    ! grep -qE "$db_signature" "$stderr_capture"; then
    rm -f -- "$stderr_capture"
    exit "$status"
  fi
  rm -f -- "$stderr_capture"
  if [[ "$attempt" -ge "$max_attempts" ]]; then
    printf 'trivy-db-retry: infrastructure failure: the vulnerability DB download failed on all %s attempts. This is registry availability, not a scan verdict; the scan never ran (#673).\n' \
      "$max_attempts" >&2
    exit "$status"
  fi
  printf 'trivy-db-retry: DB download failed (attempt %s of %s); retrying in %ss.\n' \
    "$attempt" "$max_attempts" "$((backoff_seconds * attempt))" >&2
  sleep "$((backoff_seconds * attempt))"
  attempt=$((attempt + 1))
done
