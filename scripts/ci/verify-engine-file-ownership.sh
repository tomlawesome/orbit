#!/usr/bin/env bash
#
# #1258 (#1210 build note D5): on rootful Docker the configure engine runs as
# the image's root, so every file it writes into a deployment directory is
# root-owned unless it hands it to the operator. This runs the engine's bare
# configure the way scripts/configure.sh does, against a scratch deployment
# directory, telling it the operator is ORBIT_TEST_OPERATOR_UID:GID (default
# 1000:1000), and fails if anything it created is owned by anyone else.
#
# Meaningful only on a rootful daemon (the CI docker-in-job): under rootless
# Docker configure.sh passes 0:0 and container root already is the operator.
#
# Inputs: ORBIT_IMAGE, the loaded image under test.
set -Eeuo pipefail

: "${ORBIT_IMAGE:?ORBIT_IMAGE must name the loaded image under test}"
readonly operator_uid="${ORBIT_TEST_OPERATOR_UID:-1000}"
readonly operator_gid="${ORBIT_TEST_OPERATOR_GID:-1000}"

repo_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root

security_options="$(docker info --format '{{.SecurityOptions}}' 2>/dev/null || true)"
if [[ "$security_options" == *rootless* ]]; then
  printf 'verify-engine-file-ownership: rootless Docker; nothing to prove here.\n'
  exit 0
fi

# The engine accepts only a digest or an orbit-local:<12 hex> tag, as
# create-test-configuration.sh notes; a CI tag (orbit-ci:<commit>) is given
# the second shape, naming the same image by its own ID.
if [[ ! "$ORBIT_IMAGE" =~ ^orbit-local:[0-9a-f]{12}$ && ! "$ORBIT_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]]; then
  image_id="$(docker image inspect --format '{{.Id}}' "$ORBIT_IMAGE")"
  image_id="${image_id#sha256:}"
  docker tag "$ORBIT_IMAGE" "orbit-local:${image_id:0:12}"
  ORBIT_IMAGE="orbit-local:${image_id:0:12}"
fi
export ORBIT_IMAGE

scratch="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/orbit-ownership.XXXXXX")"
cleanup() {
  # Whatever the engine left may not be ours to delete without root's help.
  docker run --rm -v "${scratch}:/scratch" --entrypoint sh "$ORBIT_IMAGE" -c 'rm -rf /scratch/* /scratch/.[!.]*' >/dev/null 2>&1 || true
  rm -rf -- "$scratch" 2>/dev/null || true
}
trap cleanup EXIT
cp -- "${repo_root}/.env-orbit.example" "${scratch}/.env-orbit.example"
chown "${operator_uid}:${operator_gid}" "$scratch" "${scratch}/.env-orbit.example" 2>/dev/null || true

docker run --rm --network none \
  -e ORBIT_HOST_UID="$operator_uid" -e ORBIT_HOST_GID="$operator_gid" \
  -e ORBIT_IMAGE \
  -v "${scratch}:/orbit-deploy:rw" \
  --entrypoint node "$ORBIT_IMAGE" /opt/orbit/cli/orbit.js configure --dir /orbit-deploy

[[ -f "${scratch}/.env-orbit" && -d "${scratch}/.orbit-secrets" ]] ||
  { printf 'verify-engine-file-ownership: the engine did not create .env-orbit and .orbit-secrets\n' >&2; exit 1; }
wrong="$(find "$scratch" -mindepth 1 \( ! -uid "$operator_uid" -o ! -gid "$operator_gid" \) -printf '%u:%g %P\n')"
if [[ -n "$wrong" ]]; then
  printf 'verify-engine-file-ownership: the engine left paths not owned by %s:%s (#1258):\n%s\n' \
    "$operator_uid" "$operator_gid" "$wrong" >&2
  exit 1
fi
printf 'verify-engine-file-ownership: every path the engine created is owned by %s:%s.\n' "$operator_uid" "$operator_gid"
