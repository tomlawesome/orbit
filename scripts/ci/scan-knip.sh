#!/usr/bin/env bash
#
# Report-only knip scan for unused files, exports and dependencies (#1596;
# owner decision 106a, 2026-11-25). Exits 0 whatever knip finds; exits
# non-zero when the tools cannot be installed and verified
# (scripts/ci/ensure-knip.sh) or knip leaves no readable report, so a missing,
# tampered or broken tool is never silent.
#
# knip loads the app's config files, so it is the one scanner that runs
# package code. It runs only in a nested container, never in the job itself:
#   --network none, --read-only, --cap-drop ALL, no-new-privileges, the
#   image's non-root `node` user, no --privileged and no docker socket;
#   an environment of PATH, HOME and NODE_OPTIONS only -- nothing of the job's
#   is passed in;
#   the checkout and the installed tools copied into image layers by
#   `docker build` (COPY only, no RUN), so the root filesystem holding them is
#   read-only. Not a bind mount: under the dind service the daemon cannot see
#   the job's workspace, and a bind mount of it comes up empty;
#   every writable place a --tmpfs with a size cap (/tmp, HOME and the two
#   below) and no volumes of any kind, so nothing knip runs can fill the
#   runner's disk;
#   `svelte-kit sync` run inside the container, never in the job (it loads
#   svelte.config.js and vite.config.js, which are app code), so knip can
#   resolve $lib, $app and ./$types. It writes web/.svelte-kit, and Vite
#   bundles its config into web/node_modules/.vite-temp: each is a capped tmpfs.
#   web/.svelte-kit is left out of the image, so a local run matches CI.
# The report leaves on stdout (knip's json reporter) through
# `docker start --attach`, read with a size cap into
# ${ORBIT_CODE_SCAN_DIR:-.orbit-code-scan}/knip.json; everything else the
# container prints goes to stderr, the job log. The base image is $NODE_IMAGE, read from
# .gitlab-ci.yml when unset, so the pin lives in one place.
#
# ORBIT_KNIP_ENSURE names another ensure script (tests). Run from anywhere.
set -Eeuo pipefail

repo_root="$(CDPATH="" cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$repo_root"

tools="$(bash "${ORBIT_KNIP_ENSURE:-scripts/ci/ensure-knip.sh}")" || {
  printf 'scan-knip: knip could not be installed and verified; failing.\n' >&2
  exit 1
}

image="${NODE_IMAGE:-$(sed -n '/^  NODE_IMAGE: */{s///p;q;}' .gitlab-ci.yml)}"
[[ -n "$image" ]] || { printf 'scan-knip: no NODE_IMAGE to run knip in; failing.\n' >&2; exit 1; }

out_dir="${ORBIT_CODE_SCAN_DIR:-.orbit-code-scan}"
mkdir -p "$out_dir"
work="$(mktemp -d)"
tag="orbit-knip-scan:$$-${RANDOM}"
cid=""
# shellcheck disable=SC2329 # run by the EXIT trap below
cleanup() {
  [[ -n "$cid" ]] && docker rm -f -v "$cid" > /dev/null 2>&1
  docker image rm -f "$tag" > /dev/null 2>&1
  rm -rf "$work"
}
trap cleanup EXIT

# The Dockerfile-specific ignore file replaces the repository's .dockerignore,
# which leaves out node_modules -- exactly what knip needs here.
cat > "${work}/knip.Dockerfile" << EOF
FROM ${image}
COPY --from=knip . /opt/knip/
COPY . /work/
EOF
cat > "${work}/knip.Dockerfile.dockerignore" << 'EOF'
.git
.worktrees
.claude
.pnpm-store
.orbit-code-scan
.orbit-tools
.orbit-docker-data
tmp
tools/knip/node_modules
web/.svelte-kit
web/node_modules/.vite-temp
EOF

start="$(date +%s)"
printf 'scan-knip: copying the checkout and tools into a scan image\n' >&2
docker build --quiet --pull=false --network none -t "$tag" \
  -f "${work}/knip.Dockerfile" --build-context "knip=${tools}" . > /dev/null || {
  printf 'scan-knip: could not build the scan image; failing.\n' >&2
  exit 1
}

cid="$(docker create \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --user 1000:1000 \
  --pids-limit 1024 \
  --log-driver none \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --tmpfs /home/node:rw,nosuid,nodev,size=64m,uid=1000,gid=1000 \
  --tmpfs /work/web/.svelte-kit:rw,nosuid,nodev,size=64m,uid=1000,gid=1000 \
  --tmpfs /work/web/node_modules/.vite-temp:rw,nosuid,nodev,size=16m,uid=1000,gid=1000 \
  -e PATH=/usr/local/bin:/usr/bin:/bin \
  -e HOME=/home/node \
  -e NODE_OPTIONS=--max-old-space-size=4096 \
  --workdir /work \
  "$tag" \
  sh -c 'cd web && node node_modules/@sveltejs/kit/svelte-kit.js sync >&2 && cd /work &&
    exec node /opt/knip/node_modules/knip/bin/knip.js --reporter json --no-progress')" || {
  printf 'scan-knip: could not create the scan container; failing.\n' >&2
  exit 1
}

# knip exits 1 when it finds something; its stderr streams to the job log.
# The report is read with a cap: one byte over it means a runaway or hostile
# stream, which fails the scan rather than filling the job's disk.
readonly report_cap=$((8 * 1024 * 1024))
# --log-driver none keeps the daemon from storing that stream a second time.
docker start --attach "$cid" | head -c "$((report_cap + 1))" > "${work}/knip.json" || :

# Once the read ends, never wait without a limit: over the cap the container
# is killed at once; otherwise its stdout has closed, so knip has finished or
# is about to, and a container still running after the grace period is
# killed. A kill of an already-exited container fails harmlessly. The EXIT
# trap removes the container either way.
stop_container() { docker kill "$cid" > /dev/null 2>&1 || :; }
if (($(wc -c < "${work}/knip.json") > report_cap)); then
  stop_container
  printf 'scan-knip: knip report over the %s-byte cap; container killed; failing.\n' "$report_cap" >&2
  exit 1
fi
if ! knip_rc="$(timeout 20 docker wait "$cid" 2> /dev/null)" || [[ -z "$knip_rc" ]]; then
  stop_container
  knip_rc='?'
fi
elapsed=$(($(date +%s) - start))
if ! node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
if (!r || !(Array.isArray(r.issues) || Array.isArray(r.files))) process.exit(1);
' "${work}/knip.json" 2> /dev/null; then
  printf 'scan-knip: knip exit %s and no readable report; failing. Findings never fail this scan, a broken run does.\n' "$knip_rc" >&2
  exit 1
fi
report="${out_dir}/knip.json"
cp "${work}/knip.json" "$report"

printf 'scan-knip: knip exit %s, %ss, report %s\n' "$knip_rc" "$elapsed" "$report"
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const c = {};
if (Array.isArray(r.files) && r.files.length) c.files = r.files.length;
for (const i of r.issues || []) for (const [k, v] of Object.entries(i)) if (Array.isArray(v) && v.length) c[k] = (c[k] || 0) + v.length;
console.log("findings by type: " + (Object.entries(c).map(([k, v]) => k + "=" + v).join(" ") || "none"));
' "$report" || printf 'scan-knip: could not summarise the report (see %s)\n' "$report"
exit 0
