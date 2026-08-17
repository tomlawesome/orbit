#!/usr/bin/env bash
# shellcheck disable=SC2034
# Single source of truth for the shape of Orbit's release metadata (#435).
#
# ORBIT_VERSION, ORBIT_REVISION and ORBIT_CHANNEL are validated in two
# places that cannot share a Node or Docker toolchain with each other:
# scripts/build-container.sh (a host Bash script, checked before Docker is
# even invoked) and the Dockerfile's runner stage (a container RUN step,
# checked immediately after the ARG declarations, in case a builder does not
# use the script at all). Both `source` this file rather than each holding
# its own copy of the three patterns, so the two checks cannot drift apart.
#
# Not sourced by anything else: this is intentionally the smallest possible
# file, containing nothing but the three patterns, so it stays trivial to
# COPY into a build stage that has no other host script available.
readonly ORBIT_VERSION_PATTERN='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
readonly ORBIT_REVISION_PATTERN='^[0-9a-f]{40}$'
readonly ORBIT_CHANNEL_PATTERN='^(ci|preview|dev)$'
