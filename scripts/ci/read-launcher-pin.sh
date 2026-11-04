#!/usr/bin/env bash
# Print a top-level string field of launcher/pin.json (#1362).
# Usage: read-launcher-pin.sh <field> [pin-file]   (default launcher/pin.json)
#
# Reads the pin without node or jq, as the build_launcher job's golang image
# has neither. Safe only because pin.json's shape is fixed: scripts/bump-
# launcher-pin.sh is its one writer and always emits a flat object with string
# "tag" and "commit" fields. It extracts whatever string is present and leaves
# the strict tag/commit checks to the caller.
# `;T;q`, not `| head -1` (#809): a head exiting while sed still had more of
# the file to write would hand sed a SIGPIPE and turn its real answer into a
# 141 under `set -e pipefail`. T branches past `q` only when the preceding
# `s///` just failed, so the one intended match stops sed immediately, with no
# pipe at all to race.
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: read-launcher-pin.sh <field> [pin-file]" >&2
  exit 2
fi
field="$1"
pin_file="${2:-launcher/pin.json}"
if [[ ! -f "$pin_file" ]]; then
  echo "read-launcher-pin: no pin file at ${pin_file}" >&2
  exit 1
fi
value="$(sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p;T;q" "$pin_file")"
if [[ -z "$value" ]]; then
  echo "read-launcher-pin: no \"${field}\" field in ${pin_file}" >&2
  exit 1
fi
printf '%s\n' "$value"
