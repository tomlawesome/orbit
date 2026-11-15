#!/usr/bin/env bash
# Warn when the pinned signing image is two weeks old or more (#1830).
#
# ORBIT_SIGNING_IMAGE carries the tools the release signing job runs with. It is
# pinned by digest and rebuilt by orbit-base-image, so it ages quietly: nothing
# fails, the pin just falls behind its own packages. This reports that early.
#
# It warns and never blocks. Exit codes:
#   0  the image is younger than the limit
#   3  a warning: the image is at or past the limit, or its age could not be
#      read. The job's `allow_failure: exit_codes: 3` tolerates exactly this.
#
# An unreadable age is a warning, not a pass: a check that cannot see is not an
# all-clear. A person re-pins (orbit-base-image #33) and the warning clears.
#
# Overrides, for tests and for a different limit:
#   SIGNING_IMAGE_NOW            ISO 8601 clock
#   SIGNING_IMAGE_MAX_AGE_DAYS   limit in days (default 14)
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ci_file="${1:-$repo_dir/.gitlab-ci.yml}"
max_age_days="${SIGNING_IMAGE_MAX_AGE_DAYS:-14}"
warning_exit=3

# A registry answer is a few KiB of JSON; anything past this is not one.
max_answer_bytes=1048576
lookup_seconds=60

warn() { printf 'signing image: warning: %s\n' "$1" >&2; }

if [[ ! "$max_age_days" =~ ^[0-9]+$ ]]; then
  warn "SIGNING_IMAGE_MAX_AGE_DAYS must be a whole number of days, got '$max_age_days'"
  exit "$warning_exit"
fi

# Read the pin with one process that stops at the first match; no `| head`, so
# nothing can take SIGPIPE under pipefail.
pinned_reference=""
if [[ -r "$ci_file" ]]; then
  pinned_reference="$(awk '
    /^[[:space:]]*ORBIT_SIGNING_IMAGE:[[:space:]]/ && !done { print $2; done = 1 }
  ' "$ci_file")"
fi
if [[ -z "$pinned_reference" || "$pinned_reference" != *@sha256:* ]]; then
  warn "no digest-pinned ORBIT_SIGNING_IMAGE in $ci_file: '${pinned_reference:-<none>}'; its age cannot be read."
  warn "see orbit-base-image #33."
  exit "$warning_exit"
fi
pinned_digest="${pinned_reference##*@}"

printf 'signing image: pinned %s\n' "$pinned_reference"

unreadable() {
  warn "the age of $pinned_digest could not be read ($1)."
  warn "a check that cannot see is not a pass; re-pin the signing image, see orbit-base-image #33."
  exit "$warning_exit"
}

# The signing image sits in orbit-base-image's private registry, so the lookup
# needs the same read-only deploy login build_image uses (ORBIT_BASE_IMAGE_PULL_*,
# password on stdin, never on a command line). Without it the registry answers
# 401, which would read as an unreadable age and look like a stale pin; say what
# is actually wrong instead. The lookup is still tried, because a registry that
# needs no login should not be refused on our account.
registry_host="${pinned_reference%%/*}"
if [[ -n "${ORBIT_BASE_IMAGE_PULL_USER:-}" && -n "${ORBIT_BASE_IMAGE_PULL_TOKEN:-}" ]]; then
  if ! printf '%s\n' "$ORBIT_BASE_IMAGE_PULL_TOKEN" \
      | docker login "$registry_host" --username "$ORBIT_BASE_IMAGE_PULL_USER" --password-stdin >/dev/null; then
    warn "the registry $registry_host refused the login with ORBIT_BASE_IMAGE_PULL_USER/ORBIT_BASE_IMAGE_PULL_TOKEN;"
    warn "the age of $pinned_digest cannot be read. Check the read-only deploy token; see orbit-base-image #33."
    exit "$warning_exit"
  fi
else
  warn "no credentials: ORBIT_BASE_IMAGE_PULL_USER/ORBIT_BASE_IMAGE_PULL_TOKEN are not set, so the private registry may refuse the lookup."
fi

# Bounded read: a time limit on the lookup and a size cap on what comes back.
# The registry's own error stays on stderr. An answer over the cap is cut short and then fails to parse, which is the
# right outcome for it.
config_json=""
if ! config_json="$(
  set -o pipefail
  timeout "$lookup_seconds" docker buildx imagetools inspect "$pinned_reference" --format '{{json .Image}}' \
    | head -c "$max_answer_bytes"
)"; then
  unreadable "the registry lookup failed or timed out"
fi

age_days=""
if ! age_days="$(
  printf '%s' "$config_json" | python3 -c '
import json, os, re, sys
from datetime import datetime, timezone

def parse(text):
    # RFC 3339 with up to nanoseconds; Python reads six fractional digits.
    match = re.fullmatch(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d:\d\d)", text.strip())
    if not match:
        raise ValueError(text)
    base, fraction, zone = match.groups()
    fraction = (fraction or "")[:7]
    zone = "+00:00" if zone == "Z" else zone
    return datetime.fromisoformat(base + fraction + zone).astimezone(timezone.utc)

try:
    created = parse(json.load(sys.stdin)["created"])
    now_text = os.environ.get("SIGNING_IMAGE_NOW")
    now = parse(now_text) if now_text else datetime.now(timezone.utc)
    seconds = (now - created).total_seconds()
except Exception:
    raise SystemExit(1)
if seconds < 0:
    raise SystemExit(1)
print(int(seconds // 86400))
'
)"; then
  unreadable "no usable created timestamp in the image config"
fi

if (( age_days >= max_age_days )); then
  warn "the signing image $pinned_digest is $age_days days old (limit $max_age_days)."
  warn "re-pin it to a fresh build; see orbit-base-image #33."
  exit "$warning_exit"
fi

printf 'signing image: %s is %s days old (limit %s)\n' "$pinned_digest" "$age_days" "$max_age_days"
