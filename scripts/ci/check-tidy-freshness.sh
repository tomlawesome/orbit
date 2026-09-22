#!/usr/bin/env bash
#
# Is the runner host's nightly Docker tidy still running? (#1023)
#
# `/usr/local/sbin/runner-docker-tidy.sh` prunes containers, volumes, untagged
# images and the builder cache at 03:15 nightly on the runner host. It failed
# every night from 2026-09-06 to 2026-09-15 with `runuser: not found` and
# nobody noticed until CI stopped with a full disk (#823). The error went to
# `/var/log/runner-docker-tidy.log`, which nothing reads.
#
# The trap this check exists to avoid: the broken run still appended its date
# line to that log, so "the log has recent entries" proved nothing. This keys
# on a marker written ONLY when the tidy exits zero -- the cron line writes it
# after `&&`, so a non-zero exit leaves the previous night's marker in place
# and it ages out. What we assert is "a tidy SUCCEEDED recently", which is the
# claim the disk depends on.
#
# Every way of not seeing a fresh success is a failure here -- a stale marker,
# no marker, no mount, unreadable content. That is deliberate: "we cannot show
# the tidy ran" is the same silence #823 lived in for ten nights, so it must
# be as loud as a stale one. The message says which it was.
#
# ---------------------------------------------------------------------------
# The two host-side changes this needs, both root on `gitlab-runners` and so
# both the owner's (#1023). Until they are made, the `tidy_freshness` job
# fails saying the marker is missing, which is the correct reading of a host
# that cannot show a successful tidy.
#
# 1. Root's crontab writes the marker after a zero exit. Replace the existing
#    03:15 line with:
#
#      15 3 * * * /usr/local/sbin/runner-docker-tidy.sh >> /var/log/runner-docker-tidy.log 2>&1 && mkdir -p /var/lib/orbit-runner-health && date -u +%s > /var/lib/orbit-runner-health/.docker-tidy.new && mv /var/lib/orbit-runner-health/.docker-tidy.new /var/lib/orbit-runner-health/docker-tidy.ok
#
#    The `&&` is the whole point: cron's own exit status decides, so nothing
#    inside the script has to be trusted to report its own failure -- which is
#    what went wrong in #823. The write is a temp file and a rename so a job
#    reading at 03:15 sees either the old marker or the new one, never a
#    half-written file. The directory needs mode 0755 and the marker 0644,
#    which a root umask of 022 gives.
#
# 2. The `orbit-build` runner mounts that directory read-only, so jobs can see
#    it. In /etc/gitlab-runner/config.toml, that runner's [runners.docker]
#    volumes, alongside the entries already there:
#
#      volumes = ["/var/lib/orbit-runner-health:/var/lib/orbit-runner-health:ro", ...]
#
#    then `sudo gitlab-runner restart`. Read-only because a job has no reason
#    to write here and every reason not to be able to forge a pass.
#
#    /var/lib, not /etc: rootless Docker snapshots /etc when its daemon
#    starts, so a directory created under /etc afterwards is invisible to it
#    and the job gets an empty mount with no error -- the trap docs/releasing.md
#    records against /etc/orbit-signing.
# ---------------------------------------------------------------------------
#
# Usage:
#   scripts/ci/check-tidy-freshness.sh          # check the marker
#   scripts/ci/check-tidy-freshness.sh --red    # prove the check can fail
#
# Environment:
#   ORBIT_TIDY_MARKER          marker path
#                              (default /var/lib/orbit-runner-health/docker-tidy.ok)
#   ORBIT_TIDY_MAX_AGE_HOURS   how old a success may be (default 36)
#
# Exit status:
#   0  a tidy succeeded within the window
#   1  the last success is older than the window
#   2  no readable, parseable marker -- mount, cron line or host all suspect
set -Eeuo pipefail

MARKER="${ORBIT_TIDY_MARKER:-/var/lib/orbit-runner-health/docker-tidy.ok}"
MAX_AGE_HOURS="${ORBIT_TIDY_MAX_AGE_HOURS:-36}"

say() { printf 'tidy-freshness: %s\n' "$1"; }
complain() { printf 'tidy-freshness: %s\n' "$1" >&2; }

# What to do about it, printed with every failure. A red job that does not say
# where to look is the log nobody reads with extra steps.
remedy() {
  cat >&2 <<'REMEDY'
tidy-freshness: on the runner host, as root:
tidy-freshness:   tail -n 50 /var/log/runner-docker-tidy.log
tidy-freshness:   /usr/local/sbin/runner-docker-tidy.sh; echo "exit $?"
tidy-freshness:   df -h /var/lib/docker
tidy-freshness: the cron line and the mount this reads are in the header of
tidy-freshness: scripts/ci/check-tidy-freshness.sh (#1023).
REMEDY
}

check() {
  if [ ! -e "$MARKER" ]; then
    complain "no marker at ${MARKER}."
    complain 'either no tidy has succeeded since the marker was introduced, or'
    complain "the runner is not mounting the marker directory into the job."
    remedy
    return 2
  fi

  if [ ! -r "$MARKER" ]; then
    complain "${MARKER} exists but this job cannot read it; check the mode and the mount."
    remedy
    return 2
  fi

  local recorded
  recorded="$(head -n 1 -- "$MARKER" | tr -d '[:space:]')"

  # Epoch seconds, written by `date -u +%s`. A strict match rather than
  # `date -d`: anything else in there means the cron line is not the one
  # docs/runner-host.md documents, and guessing at a half-written or
  # reformatted value would let a wrong answer pass for a right one.
  if ! [[ "$recorded" =~ ^[0-9]{9,11}$ ]]; then
    complain "${MARKER} does not hold epoch seconds; check the cron line."
    remedy
    return 2
  fi

  local now age_seconds max_age_seconds
  now="$(date -u +%s)"
  age_seconds=$(( now - recorded ))
  max_age_seconds=$(( MAX_AGE_HOURS * 3600 ))

  # A marker from the future means the host clock moved, not that the tidy is
  # fine. Treat it as unreadable rather than as the freshest possible success.
  if [ "$age_seconds" -lt -3600 ]; then
    complain "${MARKER} is dated in the future ($(( -age_seconds / 3600 ))h); the host clock disagrees with this job's."
    remedy
    return 2
  fi

  local age_hours
  age_hours=$(( age_seconds / 3600 ))

  if [ "$age_seconds" -gt "$max_age_seconds" ]; then
    complain "the last successful tidy was ${age_hours}h ago, over the ${MAX_AGE_HOURS}h limit."
    complain "the nightly run is failing or is not running at all; the disk fills next (#823)."
    remedy
    return 1
  fi

  say "last successful tidy ${age_hours}h ago, within the ${MAX_AGE_HOURS}h limit."
  return 0
}

# Proves the check fires before its pass is believed, the same self-test
# `sidecar_pin_freshness` and `base_image_repin` run. It drives this script
# again with the marker pointed at a scratch directory, so what is exercised
# is the real code path and not a paraphrase of it.
red_test() {
  local scratch status failures=0
  scratch="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand $scratch now, while it still exists
  trap "rm -rf -- '${scratch}'" EXIT

  expect() {
    local label="$1" want="$2" path="$3"
    set +e
    ORBIT_TIDY_MARKER="$path" ORBIT_TIDY_MAX_AGE_HOURS="$MAX_AGE_HOURS" \
      "${BASH_SOURCE[0]}" >/dev/null 2>&1
    status=$?
    set -e
    if [ "$status" -eq "$want" ]; then
      say "--red ${label}: exited ${status} as expected"
    else
      complain "--red ${label}: expected ${want}, got ${status}"
      failures=$(( failures + 1 ))
    fi
  }

  expect 'a missing marker' 2 "${scratch}/absent"

  printf 'not-a-timestamp\n' > "${scratch}/malformed"
  expect 'a malformed marker' 2 "${scratch}/malformed"

  # One hour past the limit, so the case under test is the window and not some
  # arbitrarily old date.
  printf '%s\n' "$(( $(date -u +%s) - (MAX_AGE_HOURS + 1) * 3600 ))" > "${scratch}/stale"
  expect 'a stale marker' 1 "${scratch}/stale"

  printf '%s\n' "$(date -u +%s)" > "${scratch}/fresh"
  expect 'a fresh marker' 0 "${scratch}/fresh"

  if [ "$failures" -ne 0 ]; then
    complain "--red: ${failures} case(s) did not behave as expected; this check cannot be trusted."
    return 1
  fi
  say '--red: the check fires on every failure case and passes on a fresh marker.'
  return 0
}

case "${1:-}" in
  --red) red_test ;;
  '') check ;;
  *)
    complain "unknown argument: $1"
    complain 'usage: scripts/ci/check-tidy-freshness.sh [--red]'
    exit 64
    ;;
esac
