#!/usr/bin/env bash
# The awk digest extractor, shared by the jobs that read an image's manifest
# digest from `docker buildx imagetools inspect` (#1363):
# scripts/ci/promote-stable.sh, publish-channel.sh and publish-image.sh.
# Source it; it runs nothing by itself.
#
# first_inspect_digest <awk-pattern> reads `imagetools inspect` output on stdin
# and prints the first `Digest:` line's value that matches the pattern, or
# nothing. The caller passes ORBIT_DIGEST_AWK_PATTERN from
# scripts/release-metadata-patterns.sh, which this file does not duplicate, and
# validates the answer itself.
#
# The pattern is that awk-safe one, plus `length($2) == 71`, rather than the
# `[0-9a-f]{64}` form: the node image's mawk (1.3.4-20200120) has no interval
# expressions, so `{64}` silently matches nothing there and the unit test read
# every tag as unresolvable (pipeline 317, job 2114). Alpine's awk accepts
# both; this form works on either. 71 is the length of `sha256:` plus 64 hex
# characters.
#
# The first match is taken without exiting awk early. `exit` on the match left
# `imagetools inspect` writing the whole Manifests: block that follows into a
# closed pipe, and under `pipefail` its SIGPIPE (141) becomes the pipeline's
# status and aborts the assignment -- the same race that broke
# check-base-image-current.sh on GitLab pipeline 169. Reading to EOF and
# printing at the end costs a few unread lines and cannot lose that race.
first_inspect_digest() {
  awk -v pattern="$1" '$1 == "Digest:" && length($2) == 71 && $2 ~ pattern && !found { digest = $2; found = 1 }
       END { if (found) print digest }'
}
