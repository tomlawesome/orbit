#!/bin/sh
# shellcheck disable=SC2034
# Single source of truth for the shape of Orbit's release metadata (#435) and
# of the digests and image references it carries (#1363).
#
# ORBIT_VERSION, ORBIT_REVISION and ORBIT_CHANNEL are validated in two
# places that cannot share a Node or Docker toolchain with each other:
# scripts/build-container.sh (a host Bash script, checked before Docker is
# even invoked) and the Dockerfile's runner stage (a container RUN step,
# checked immediately after the ARG declarations, in case a builder does not
# use the script at all). Both `source` this file rather than each holding
# its own copy of the three patterns, so the two checks cannot drift apart.
#
# The digest and image-reference patterns are defined here once for Bash and
# once, as the same expressions, in release-metadata-patterns.mjs for Node.
# All are POSIX extended regular expressions for `[[ =~ ]]` and `grep -E`, and
# are anchored unless the name says otherwise. A trailing `$` in `[[ =~ ]]`
# matches only at the very end of the string, so a trailing newline is refused.
#
# The file is POSIX sh, not Bash: the Dockerfile's RUN step runs under /bin/sh
# (dash) and sources it, and Bash sources it too. Keep it free of Bash-only
# syntax ([[ ]], declare, arrays); scripts/release-metadata-patterns-sh.test.mjs
# sources it under both.
#
# Not sourced by anything that ships on its own (install.sh, repair.sh,
# configure.sh, get-orbit-preview.sh keep their own copies): this is a
# repository file, and it stays tiny so it can be COPYed into a build stage
# that has no other host script available.
# Sourcing this file a second time in one shell (a script that sources a
# helper which sources it again) must leave the values as they are: they are
# read-only after the first source, so redefining them would fail.
# `readonly -p` prints `readonly NAME='...'` under dash and `declare -r NAME=...`
# under Bash; both carry " NAME=" for a read-only variable. Matched with
# `case` rather than a pipe into `grep -q`, so a caller's `pipefail` cannot
# turn an early grep exit into a failed check.
case "$(readonly -p 2> /dev/null)" in
  *" ORBIT_VERSION_PATTERN="*) return 0 ;;
esac

readonly ORBIT_VERSION_PATTERN='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
readonly ORBIT_REVISION_PATTERN='^[0-9a-f]{40}$'
readonly ORBIT_CHANNEL_PATTERN='^(ci|preview|dev)$'

# sha256: and exactly 64 lowercase hex characters, with no anchors: the part
# the other patterns are built from, for grep -o, jq and node -e.
readonly ORBIT_DIGEST_TOKEN_PATTERN='sha256:[0-9a-f]{64}'
# The whole string is one digest: sha256:<64 lowercase hex>, nothing else.
readonly ORBIT_DIGEST_PATTERN="^${ORBIT_DIGEST_TOKEN_PATTERN}\$"
# The same for awk, which on the node image's mawk has no `{64}` interval
# expressions (pipeline 317, job 2114): use it only together with
# `length($2) == 71`, as scripts/ci/lib-digest.sh does.
readonly ORBIT_DIGEST_AWK_PATTERN='^sha256:[0-9a-f]+$'
# Anything at all that ends in @sha256:<64 lowercase hex>; what comes before
# the @ is not checked.
readonly ORBIT_DIGEST_SUFFIX_PATTERN="@${ORBIT_DIGEST_TOKEN_PATTERN}\$"

# Loose image reference: one or more characters that are neither @ nor
# whitespace, then @ and a digest. Accepts a tag before the @ and any registry.
readonly ORBIT_IMAGE_REFERENCE_PATTERN="^[^@[:space:]]+@${ORBIT_DIGEST_TOKEN_PATTERN}\$"
# Image reference as a deployment records it (ORBIT_IMAGE): only letters,
# digits and . _ : / - before the @, then a digest. Narrower than the loose
# pattern (no other punctuation) and wider than the registry one.
readonly ORBIT_DEPLOYMENT_IMAGE_REFERENCE_PATTERN="^[A-Za-z0-9._:/-]+@${ORBIT_DIGEST_TOKEN_PATTERN}\$"
# Strict registry reference, for evidence: host[:port]/path[/path...]@digest,
# no tag, every segment of letters, digits and . _ -.
readonly ORBIT_REGISTRY_REFERENCE_PATTERN="^[A-Za-z0-9._-]+(:[0-9]+)?(/[A-Za-z0-9._-]+)+@${ORBIT_DIGEST_TOKEN_PATTERN}\$"
