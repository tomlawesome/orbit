#!/usr/bin/env bash
#
# Proves the document processor really is confined the way the compose file
# claims: unprivileged uid 35002, read-only root filesystem, every capability
# dropped, one internal network with no route out, only the config file and
# /tmp mounted -- and that it still extracts text from the hostile-document
# corpus when reached from inside that network by the image under test.
#
# Extracted verbatim from the "Verify exact hostile-document processor" step
# of the &container_validation_steps anchor in
# .github/workflows/publish-container.yml (#801).
#
# Inputs (environment):
#   TESTED_IMAGE_TAG  the image under test; the corpus runs inside it
#   GITHUB_WORKSPACE  optional; defaults to the repository root
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root
cd "${repo_root}"

: "${TESTED_IMAGE_TAG:?the tested image tag is required}"

workspace="${GITHUB_WORKSPACE:-${repo_root}}"
readonly workspace

docker compose --env-file .env-orbit --profile processing pull orbit-tika
docker compose --env-file .env-orbit --profile processing up --detach orbit-tika
tika_id="$(docker compose --env-file .env-orbit --profile processing ps --quiet orbit-tika)"
test -n "${tika_id}"
tika_user="$(docker inspect --format '{{.Config.User}}' "${tika_id}")"
tika_read_only="$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "${tika_id}")"
tika_network="$(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}' "${tika_id}")"
test "${tika_user}" = "35002:35002"
test "${tika_read_only}" = "true"
test "$(docker inspect --format '{{json .HostConfig.CapDrop}}' "${tika_id}")" = '["ALL"]'
test "$(docker network inspect --format '{{.Internal}}' "${tika_network}")" = "true"
docker inspect "${tika_id}" | jq --exit-status '
  .[0].Mounts
  | length >= 1
  and any(.Destination == "/etc/orbit/tika-config.json" and .RW == false)
  and all(.Destination == "/etc/orbit/tika-config.json" or .Destination == "/tmp")
'
docker compose --env-file .env-orbit --profile processing exec -T orbit-tika \
  sh -c 'test -r /etc/orbit/tika-config.json && test -w /tmp'
tika_uid="$(docker compose --env-file .env-orbit --profile processing exec -T orbit-tika \
  sh -c "awk '/^Uid:/{print \$2}' /proc/1/status")"
test "${tika_uid}" = "35002"
docker run --rm \
  --network "${tika_network}" \
  --entrypoint node \
  --env TIKA_TEST_URL=http://orbit-tika:9998 \
  --volume "${workspace}/scripts/test-tika-processor.mjs:/tmp/test-tika-processor.mjs:ro" \
  "${TESTED_IMAGE_TAG}" \
  /tmp/test-tika-processor.mjs
