#!/usr/bin/env bash
#
# The image content ID (ADR-0028, slice 2 of #1060).
#
# ADR-0028 §1 defines it verbatim:
#
#   "the *image content ID*: SHA-256 over the ordered layer content hashes
#   (`RootFS.Layers` in `docker image inspect`, the hashes of the uncompressed
#   filesystem layers) of the runner image, excluding the final stamp layer.
#   Labels live in the image config, not in layers, so they do not count."
#
# The final stamp layer is the Dockerfile's last RUN -- the one that writes
# /opt/orbit/VERSION, REVISION and CHANNEL. It is deliberately the last layer
# the runner stage produces (see "The stamp" in the Dockerfile), so "excluding
# the final stamp layer" is exactly "drop the last entry of RootFS.Layers".
#
# Two images built from the same tree on different commits differ in that layer
# and in their labels alone, so they share a content ID; anything that reaches
# a file the image ships changes an earlier layer and so changes the ID. A
# cache miss rebuilds earlier layers with fresh timestamps and changes the ID
# too: a needless rerun, which is the safe direction (ADR-0028 §6).
#
# Serialisation, which the ADR leaves open: the retained layer digests in
# order, one per line, each newline-terminated, hashed as those bytes. Any
# deterministic encoding satisfies the ADR; this one is pinned here and in
# scripts/ci/image-content-id.test.mjs so two callers cannot disagree.
#
# Inputs (environment):
#   ORBIT_IMAGE_REF   the image to read: a tag or an image ID
#
# Outputs: the 64-character hex content ID on stdout, and `content_id=<id>`
# appended to $GITHUB_OUTPUT when that variable is set -- the same shape
# scripts/ci/verify-image-identity.sh uses.
#
# Fails rather than guessing: an image with fewer than two layers, or a
# RootFS.Layers entry that is not a sha256 digest, means `docker image inspect`
# did not answer what this script assumes, and a plausible-looking hash over a
# misread answer is worse than a red job.
set -Eeuo pipefail

: "${ORBIT_IMAGE_REF:?the image to read is required}"

mapfile -t layers < <(
  docker image inspect --format '{{range .RootFS.Layers}}{{println .}}{{end}}' "${ORBIT_IMAGE_REF}" \
    | sed '/^[[:space:]]*$/d'
)

if [[ "${#layers[@]}" -lt 2 ]]; then
  printf 'image-content-id: %s reports %s layer(s); the stamp plus at least one content layer is expected.\n' \
    "${ORBIT_IMAGE_REF}" "${#layers[@]}" >&2
  exit 1
fi

for layer in "${layers[@]}"; do
  [[ "${layer}" =~ ^sha256:[0-9a-f]{64}$ ]] || {
    printf 'image-content-id: %s is not a layer digest.\n' "${layer}" >&2
    exit 1
  }
done

stamp="${layers[-1]}"
unset 'layers[-1]'

content_id="$(printf '%s\n' "${layers[@]}" | sha256sum | cut -d' ' -f1)"

printf 'image-content-id: %s over %s content layer(s), stamp %s excluded.\n' \
  "${content_id}" "${#layers[@]}" "${stamp}" >&2

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'content_id=%s\n' "${content_id}" >> "${GITHUB_OUTPUT}"
fi

printf '%s\n' "${content_id}"
