#!/usr/bin/env bash
# Detects the Orbit base image pin being behind and, when it is, proposes a
# merge request re-pinning it, rather than leaving the freshness gate red
# until a person notices and edits digests by hand (#708).
#
# Two owner rulings bound this script and are not revisited here: nothing is
# rebuilt or committed straight to a branch history someone else owns
# (2026-08-29), and a bot-opened merge request is an acceptable way to
# propose a fix, since the required checks on it are what actually carry the
# safety (2026-09-01). So this script never pushes to `dev`, `preview` or
# `main`, and it never merges anything.
#
# scripts/check-base-image-current.sh already answers "is the build allowed
# to proceed" by resolving the mutable :latest tag itself. That is right for
# refusing a build, but wrong for deciding what to re-pin TO: this script
# instead trusts ai/orbit-base-image's own `published-digest.txt` artifact,
# written by that project's `publish` job the moment its push succeeds.
# Resolving :latest independently here would adopt whatever the tag happens
# to point at right now, which is the exact property pinning exists to
# remove.
#
# Two axes, sourced this way:
#
#   1. Tag moved: the artifact's digest differs from what Dockerfile pins.
#      Re-pin every location that holds the digest, in one commit, to the
#      artifact's digest, and open (or refresh) a merge request.
#   2. Packages stale: `apk upgrade --simulate` reports pending upgrades
#      inside the image this run would end up pinning. If the tag also
#      moved, this is noted in the merge request body -- the new build
#      already reflects Alpine's release at build time, so it is
#      informational rather than a reason to hold the pin. If the tag did
#      NOT move, there is nothing to re-pin to: this is logged and the run
#      exits 0. Nothing opens. (Waiting on a rebuild is
#      ai/orbit-base-image's scripts/rebuild-and-publish.sh, not this
#      script's job.)
#
# A failure to *check* -- an unreachable registry, a malformed artifact, a
# corroboration mismatch -- exits 2 and fails the job. Finding the pin stale
# is not a failure: it is the merge request.
#
# Usage:
#   scripts/ci/repin-base-image.sh [--dry-run] [--red]
#
#   --dry-run   Do everything except push a branch or call the merge-request
#               API. Prints the diff it would have committed.
#   --red       Self-test only: proves the digest comparison fires both ways,
#               using a digest rotated in memory. Touches no file, no
#               network, no docker, no git, and needs no token.
#
# Inputs (environment):
#   BASE_REPIN_TOKEN         Required for a real run (not --red). A token
#                             with read access to ai/orbit-base-image's job
#                             artifacts and the `api` scope plus Developer
#                             role on ai/orbit. See .gitlab-ci.yml for the
#                             exact grant this needs. Never printed; passed
#                             to curl and git only via header file / URL
#                             embedding, never logged.
#   CI_API_V4_URL             GitLab predefined; the API base URL.
#   CI_PROJECT_ID             GitLab predefined; this project's numeric id.
#   CI_PROJECT_PATH           GitLab predefined; e.g. ai/orbit.
#   CI_SERVER_HOST            GitLab predefined; used to build the push URL.
#   CI_PIPELINE_URL           GitLab predefined; recorded in the merge
#                             request body.
#   BASE_IMAGE_PROJECT        ai/orbit-base-image's API project reference
#                             (URL-encoded path or numeric id). Defaults to
#                             the URL-encoded path.
#   BASE_IMAGE_REF            The ref whose latest `publish` job artifact is
#                             read. Defaults to `primary` (that project's
#                             protected default branch).
#   BASE_IMAGE_JOB            The job name that produced the artifact.
#                             Defaults to `publish`.
#   BASE_IMAGE_DIGEST_FILE    Testing seam: a local file holding the trusted
#                             `image@sha256:...` reference, used instead of
#                             fetching the artifact over the network. Lets
#                             this script be exercised without a token.
#   BASE_IMAGE_PACKAGES_SIMULATION
#                             Testing seam: canned `apk upgrade --simulate`
#                             output, used instead of running docker. Lets
#                             the packages axis be exercised without a real
#                             stale image, which is not something that can be
#                             fabricated to order.
#   BASE_REPIN_BRANCH         The branch this script pushes and opens a
#                             merge request from. Defaults to
#                             chore/base-image-repin -- fixed, not per-run,
#                             so a second finding updates the same merge
#                             request instead of opening a duplicate.
#   BASE_REPIN_TARGET_BRANCH  The merge request's target. Defaults to `dev`.
set -Eeuo pipefail
# Belt and braces on top of never putting the token in argv below: forced off
# regardless of how this script is invoked (a stray `bash -x`, an inherited
# `SHELLOPTS`), because xtrace prints each command after expansion and would
# otherwise echo BASE_REPIN_TOKEN's value the moment it is read into a
# variable or a file.
set +x

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dockerfile="${DOCKERFILE:-$repo_dir/Dockerfile}"
policy_path="${POLICY_PATH:-$repo_dir/.github/supply-chain-policy.json}"
check_script="${CHECK_SCRIPT:-$repo_dir/scripts/check-base-image-current.sh}"

base_image_project="${BASE_IMAGE_PROJECT:-ai%2Forbit-base-image}"
base_image_ref="${BASE_IMAGE_REF:-primary}"
base_image_job="${BASE_IMAGE_JOB:-publish}"
branch_name="${BASE_REPIN_BRANCH:-chore/base-image-repin}"
target_branch="${BASE_REPIN_TARGET_BRANCH:-dev}"

dry_run=false
red=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=true ;;
    --red) red=true ;;
    *)
      printf 'repin-base-image: unknown argument %s\n' "$arg" >&2
      exit 64
      ;;
  esac
done

log() { printf 'repin-base-image: %s\n' "$1"; }
fail() { printf 'repin-base-image: %s\n' "$1" >&2; exit 2; }

# Every file this script writes a credential or a token into goes through
# here, so there is exactly one cleanup path and it cannot be forgotten on a
# new call site. Registered before anything that could fail, so the trap
# covers every exit this script can take -- success, `fail`'s exit 2, an
# unhandled error under `set -e`, or a signal -- not just the tidy one.
_secret_files=()
_cleanup_secret_files() { [[ ${#_secret_files[@]} -eq 0 ]] || rm -f "${_secret_files[@]}"; }
trap _cleanup_secret_files EXIT INT TERM

# A mode-600 temp file, tracked for cleanup. Never the token itself: callers
# write the secret into the file with a builtin (`printf ... > "$file"`,
# never `command printf` or an external process), so the value is never an
# argv of anything a process listing could show, and `set +x` above keeps it
# out of a trace too.
new_secret_file() {
  local f
  f="$(mktemp)"
  chmod 600 "$f"
  _secret_files+=("$f")
  printf '%s' "$f"
}

DIGEST_PATTERN='^sha256:[0-9a-f]{64}$'

# Mirrors scripts/sidecar-pins.mjs's rotateDigest exactly: the last eight hex
# characters each move one place along. A syntactically valid digest that is
# deliberately not the one it started from.
rotate_digest() {
  node -e '
    const HEX = "0123456789abcdef";
    const digest = process.argv[1];
    const head = digest.slice(0, -8);
    const tail = [...digest.slice(-8)]
      .map((c) => HEX[(HEX.indexOf(c) + 1) % HEX.length])
      .join("");
    process.stdout.write(head + tail);
  ' "$1"
}

# The first FROM, wherever it sits -- same extraction as
# scripts/check-base-image-current.sh, for the same reason (#651): a
# Dockerfile may open with comments.
extract_pinned_reference() {
  sed -n '/^FROM[[:space:]]/{s/^FROM[[:space:]]\{1,\}\([^[:space:]]*\).*/\1/p;q;}' "$1"
}

axis1_status() {
  local pinned="$1" trusted="$2"
  if [[ "$pinned" == "$trusted" ]]; then
    printf 'current\n'
  else
    printf 'moved\n'
  fi
}

if $red; then
  pinned_reference="$(extract_pinned_reference "$dockerfile")"
  pinned_digest="${pinned_reference##*@}"
  if [[ ! "$pinned_digest" =~ $DIGEST_PATTERN ]]; then
    fail "the first FROM in $dockerfile is not a digest-pinned reference; cannot self-test against it"
  fi
  rotated_digest="$(rotate_digest "$pinned_digest")"
  ok=true
  status_same="$(axis1_status "$pinned_digest" "$pinned_digest")"
  if [[ "$status_same" != "current" ]]; then
    printf 'repin-base-image: red self-test: expected "current" for a matching digest, got "%s"\n' "$status_same" >&2
    ok=false
  fi
  status_diff="$(axis1_status "$pinned_digest" "$rotated_digest")"
  if [[ "$status_diff" != "moved" ]]; then
    printf 'repin-base-image: red self-test: expected "moved" for a rotated digest, got "%s"\n' "$status_diff" >&2
    ok=false
  fi
  if ! $ok; then
    fail "the comparison did not fire both ways; see above"
  fi
  log "red self-test passed -- the comparison reports current and moved correctly"
  exit 0
fi

# --- Read the current pin ----------------------------------------------------

pinned_reference="$(extract_pinned_reference "$dockerfile")"
if [[ -z "$pinned_reference" || "$pinned_reference" != *@sha256:* ]]; then
  fail "the first FROM in $dockerfile is not a digest-pinned reference: '${pinned_reference:-<none>}'"
fi
pinned_tag="${pinned_reference%@*}"
pinned_digest="${pinned_reference##*@}"
image_name="${pinned_tag%%:*}"

log "pinned reference: $pinned_reference"

# --- Read the trusted digest --------------------------------------------------

if [[ -n "${BASE_IMAGE_DIGEST_FILE:-}" ]]; then
  trusted_reference="$(cat "$BASE_IMAGE_DIGEST_FILE")"
else
  : "${BASE_REPIN_TOKEN:?BASE_REPIN_TOKEN is not set. See the base_image_repin job in .gitlab-ci.yml for the exact grant this needs.}"
  : "${CI_API_V4_URL:?CI_API_V4_URL is not set; this must run inside a GitLab CI job}"
  artifact_url="${CI_API_V4_URL%/}/projects/${base_image_project}/jobs/artifacts/${base_image_ref}/raw/published-digest.txt?job=${base_image_job}"
  # The token goes in a header file, never on curl's command line: `-H
  # "PRIVATE-TOKEN: $TOKEN"` would put it in this process's argv, which a
  # process listing on the shared runner can read for as long as curl runs.
  # `--header @file` is curl's own way to read a header's value from a file.
  artifact_header_file="$(new_secret_file)"
  printf 'PRIVATE-TOKEN: %s\n' "$BASE_REPIN_TOKEN" > "$artifact_header_file"
  if ! trusted_reference="$(curl --silent --show-error --fail --location --max-time 60 \
      --header @"$artifact_header_file" "$artifact_url")"; then
    fail "could not fetch published-digest.txt from ai/orbit-base-image (project ${base_image_project}, ref ${base_image_ref}, job ${base_image_job})"
  fi
fi
trusted_reference="$(printf '%s' "$trusted_reference" | tr -d '[:space:]')"

if [[ "$trusted_reference" != "${image_name}@sha256:"* ]]; then
  fail "published-digest.txt did not hold a reference to ${image_name}: got '${trusted_reference:-<empty>}'"
fi
trusted_digest="${trusted_reference##*@}"
if [[ ! "$trusted_digest" =~ $DIGEST_PATTERN ]]; then
  fail "published-digest.txt's digest is not a full sha256 digest: '${trusted_digest}'"
fi

log "trusted reference (from ai/orbit-base-image's publish job): $trusted_reference"

# --- Axis 1: has the tag moved on? -------------------------------------------

axis1="$(axis1_status "$pinned_digest" "$trusted_digest")"
tag_moved=false
[[ "$axis1" == "moved" ]] && tag_moved=true

if $tag_moved; then
  log "axis 1: tag moved. pinned $pinned_digest, artifact reports $trusted_digest."
else
  log "axis 1: pinned digest matches the artifact; nothing to re-pin on this axis."
fi

# The reference axis 2 checks: the new one if the tag moved, the existing pin
# otherwise. Either way this is what the resulting Dockerfile would pin.
check_reference="${image_name}@${trusted_digest}"

# --- Axis 2: are the pinned image's own packages behind? ---------------------

if [[ -n "${BASE_IMAGE_PACKAGES_SIMULATION:-}" ]]; then
  simulation="$BASE_IMAGE_PACKAGES_SIMULATION"
else
  if ! simulation="$(
    docker run --rm --entrypoint sh "$check_reference" -c '
      apk update >/dev/null 2>&1 || exit 3
      apk upgrade --simulate 2>&1
    ' 2>&1
  )"; then
    fail "could not query packages inside ${check_reference}; treating that as a failure rather than an all-clear: ${simulation}"
  fi
fi

pending="$(printf '%s\n' "$simulation" | grep -E '^\([0-9]+/[0-9]+\) Upgrading ' || true)"
packages_stale=false
[[ -n "$pending" ]] && packages_stale=true

if $packages_stale; then
  log "axis 2: packages behind inside ${check_reference}:"
  printf '%s\n' "$pending" | while IFS= read -r line; do printf 'repin-base-image:   %s\n' "$line"; done
else
  log "axis 2: packages are current inside ${check_reference}."
fi

# --- Decide --------------------------------------------------------------

if ! $tag_moved && $packages_stale; then
  log "the tag has not moved, so there is nothing to re-pin to. Trigger a base image"
  log "rebuild (ai/orbit-base-image's scripts/rebuild-and-publish.sh) and this will"
  log "find a moved tag on its next scheduled run. See #706. Not opening a merge request."
  exit 0
fi

if ! $tag_moved && ! $packages_stale; then
  log "the pin is current on both axes. Nothing to do."
  exit 0
fi

# --- tag_moved is true from here: corroborate, then propose the re-pin ------

log "corroborating the artifact against the live tag before trusting it..."
manifest_json=""
if ! manifest_json="$(docker buildx imagetools inspect "$pinned_tag" --format '{{json .Manifest}}' 2>/dev/null)"; then
  fail "could not resolve ${pinned_tag} to corroborate the artifact's digest"
fi

read -r live_platform_digest new_index_digest <<EOF
$(printf '%s' "$manifest_json" | node -e '
  let input = "";
  process.stdin.on("data", (c) => (input += c)).on("end", () => {
    const doc = JSON.parse(input);
    const manifests = Array.isArray(doc.manifests) ? doc.manifests : [];
    const platform = manifests.find(
      (m) => m?.platform?.os === "linux" && m?.platform?.architecture === "amd64",
    );
    process.stdout.write(`${platform?.digest ?? "none"} ${doc.digest ?? "none"}`);
  });
')
EOF

if [[ "$live_platform_digest" != "$trusted_digest" ]]; then
  fail "the artifact's digest (${trusted_digest}) does not match what ${pinned_tag} currently resolves to (${live_platform_digest}). This can happen if the tag published again after the artifact this run read. Re-run once it settles; not guessing."
fi
log "corroborated: ${pinned_tag} currently resolves to the artifact's digest."

new_reference="${pinned_tag}@${trusted_digest}"

# --- Edit every location that holds the digest, together ---------------------

sed -i "s#${pinned_reference}#${new_reference}#g" "$dockerfile"

today="$(date -u +%Y-%m-%d)"
node -e '
  const fs = require("fs");
  const [policyPath, imageNamePrefix, newReference, newIndexDigest, today] = process.argv.slice(1);
  const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  const entry = (policy.containerImages || []).find((e) => e.tag && e.tag.startsWith(imageNamePrefix));
  if (!entry) {
    console.error(`repin-base-image: no containerImages entry starts with ${imageNamePrefix}`);
    process.exit(1);
  }
  entry.reference = newReference;
  entry.indexDigest = newIndexDigest;
  entry.resolvedOn = today;
  fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2) + "\n", "utf8");
' "$policy_path" "$image_name" "$new_reference" "$new_index_digest" "$today"

log "re-pinned Dockerfile and .github/supply-chain-policy.json to ${new_reference}"

# --- Verify: the freshness gate must pass on the result ----------------------

log "verifying scripts/check-base-image-current.sh now passes..."
if ! bash "$check_script" "$dockerfile"; then
  fail "the re-pinned Dockerfile still fails its own freshness gate; not committing"
fi

if $dry_run; then
  log "--dry-run: stopping before any commit, push or merge-request call. Diff:"
  git -C "$repo_dir" --no-pager diff -- "$dockerfile" "$policy_path" || true
  exit 0
fi

# --- Commit, push, and open or refresh the merge request ---------------------

: "${CI_PROJECT_ID:?CI_PROJECT_ID is not set; this must run inside a GitLab CI job}"
: "${CI_PROJECT_PATH:?CI_PROJECT_PATH is not set; this must run inside a GitLab CI job}"
: "${CI_SERVER_HOST:?CI_SERVER_HOST is not set; this must run inside a GitLab CI job}"

commit_message="Re-pin the Orbit base image to ${trusted_digest}

ai/orbit-base-image's ${base_image_job} job (ref ${base_image_ref}) recorded
this digest the moment its push succeeded. scripts/check-base-image-current.sh
passes against it.
$($packages_stale && printf '\nPackages inside the new image were still reported behind at build time; see #706.\n')
Opened automatically by the base_image_repin schedule (#708). Nothing here
merges itself.
"

git -C "$repo_dir" config user.email "base-image-repin@ci.local"
git -C "$repo_dir" config user.name "base-image-repin"
git -C "$repo_dir" checkout -B "$branch_name"
git -C "$repo_dir" add -- "$dockerfile" "$policy_path"
git -C "$repo_dir" commit -m "$commit_message"

# The token never goes in the push URL: `https://oauth2:$TOKEN@host/...` as an
# argument to `git push` would sit in this process's argv for the life of the
# push, readable by anything else on the shared runner via a process listing,
# and would be echoed verbatim if xtrace were ever on. A mode-600
# credential-store file plays the same role for git that the header files
# above and below play for curl: git reads the secret from a file, and the
# command it execs never contains it. `-c credential.helper=` first clears
# any helper already configured (same defensive shape as AGENTS.md's
# documented push pattern) so only the one named here is consulted.
credential_file="$(new_secret_file)"
printf 'https://oauth2:%s@%s\n' "$BASE_REPIN_TOKEN" "$CI_SERVER_HOST" > "$credential_file"
push_url="https://${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git"
git -C "$repo_dir" \
  -c credential.helper= \
  -c "credential.helper=store --file=${credential_file}" \
  push --force "$push_url" "HEAD:refs/heads/${branch_name}"

header_file="$(new_secret_file)"
body_file="$(new_secret_file)"
printf 'PRIVATE-TOKEN: %s\n' "$BASE_REPIN_TOKEN" > "$header_file"
api_call() { curl --silent --show-error --fail --location --max-time 60 --header @"$header_file" "$@"; }
api="${CI_API_V4_URL%/}/projects/${CI_PROJECT_ID}"

json_field() {
  node -e 'let input = ""; process.stdin.on("data", (chunk) => { input += chunk; }).on("end", () => { const value = new Function("input", process.argv[2])(input); process.stdout.write(String(value ?? "")); });' -- "$1" "$2"
}

existing_iid="$(
  api_call -G --data-urlencode "state=opened" --data-urlencode "source_branch=${branch_name}" "${api}/merge_requests" |
    json_field '' 'const [first] = JSON.parse(input); return first ? first.iid : "";'
)"

if [[ -n "$existing_iid" ]]; then
  log "merge request !${existing_iid} is already open from ${branch_name}; the push above updated it."
  exit 0
fi

{
  printf 'Reported by the weekly `base_image_repin` GitLab job.\n'
  printf 'Run: %s\n\n' "${CI_PIPELINE_URL:-<unknown>}"
  printf 'Re-pins the Orbit base image from `%s` to `%s`, sourced from\n' "$pinned_digest" "$trusted_digest"
  printf 'ai/orbit-base-image'"'"'s own %s job artifact rather than an independently\n' "$base_image_job"
  printf 'resolved tag.\n\n'
  if $packages_stale; then
    printf 'Packages inside the new image were still reported behind at build time (see #706):\n\n'
    printf '%s\n\n' "$pending"
  fi
  printf '`scripts/check-base-image-current.sh` passes on this branch.\n\n'
  printf 'Nothing here merges itself. The normal required checks still gate this merge request.\n\n'
  printf 'Cut: risk -- a base image re-pin is a dependency change and belongs on its own.\n'
} > "$body_file"

created_iid="$(
  api_call -X POST \
    --data-urlencode "source_branch=${branch_name}" \
    --data-urlencode "target_branch=${target_branch}" \
    --data-urlencode "title=Re-pin the Orbit base image to ${trusted_digest}" \
    --data-urlencode "description@${body_file}" \
    --data-urlencode "labels=security,dependencies" \
    --data-urlencode "remove_source_branch=true" \
    "${api}/merge_requests" |
    json_field '' 'return JSON.parse(input).iid ?? "";'
)"
[[ -n "$created_iid" ]] || fail "merge request creation did not return an iid"
log "opened merge request !${created_iid}"
