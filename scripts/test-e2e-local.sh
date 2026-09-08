#!/usr/bin/env bash
# Brings up the acceptance stack (application, PostgreSQL, ClamAV, and the
# disposable OIDC and GreenMail sidecars) under an isolated Compose project,
# waits for health, runs the Playwright end-to-end suite against it, and
# tears down only what it created -- so a layout or behaviour regression can
# be caught locally in minutes instead of by promoting to `preview` and
# waiting on CI.
#
# Mirrors the &container_validation_steps sequence in
# .github/workflows/publish-container.yml (the "Create isolated test
# configuration" through "Run browser and accessibility checks" steps):
# same compose files, same order, same health and OIDC/mail setup. It
# deliberately does not reproduce that job's image-scanning, installer or
# publication steps -- this script is for fast local iteration, not release
# validation.
#
# Usage:
#   bash scripts/test-e2e-local.sh [--spec PATH] [--project NAME]
#
#   --spec PATH     Playwright spec file or glob, e.g.
#                    tests/e2e/v19-mail-review.spec.ts
#   --project NAME  Playwright project from tests/e2e/playwright.config.ts:
#                    desktop-chromium or mobile-chromium. Default: both.
#   --keep          Leave the stack up on exit instead of tearing it down, so a
#                    failed run can be inspected: query the database, read the
#                    container logs, open the app. The run logs its own
#                    project name and app port at startup ("starting the
#                    acceptance stack (project ..., app on ...)"); tear that
#                    project down afterwards with:
#                      docker compose -p <project> --env-file .env-orbit \
#                        -f docker-compose.yml -f docker-compose.mail.yml \
#                        -f compose/docker-compose.acceptance.yml \
#                        -f compose/docker-compose.local-e2e.yml down --volumes
#
# #875: the Compose project name and app port used to be fixed
# ("orbit-e2e-local" on 13777), so two concurrent runs -- two worktrees, two
# agent sessions -- fought over one stack, and whichever run finished first
# tore the other's database down mid-test while the survivor kept running
# against an empty stack. Both are now derived per run instead: the project
# name from this worktree's path and this process's PID (below), the app
# port from whatever the kernel hands out. Set COMPOSE_PROJECT_NAME or
# ORBIT_PORT in the environment to override either.
#
# Test fixtures left behind by a spec show up as a household count above zero
# after a run (#730), which is the cheap way to find a spec that does not clean
# up after itself -- substitute this run's own project name, logged at
# startup, for <project>:
#   docker exec <project>-db sh -c \
#     'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select name from households"'
#
# AGENTS.md "Traps when running things locally" applies here directly: this
# script always passes an explicit Compose `-p` project name (below, per-run
# rather than fixed since #875) so it can never attach to whatever project a
# real deployment's .env-orbit happens to name, it checks that name against
# the running container's own label before tearing anything down, and it
# only ever tears down that same project. docker-compose.yml also pins
# container_name for orbit-app/orbit-db/orbit-clamav, which would block a
# second stack under those names regardless of project;
# compose/docker-compose.local-e2e.yml renames them to `${COMPOSE_PROJECT_NAME}-*`
# for this script only, so a per-run project name also gives per-run
# container names. Never runs `pnpm db:generate` (also an AGENTS.md trap) and
# never writes to .env-orbit or an existing file under .orbit-secrets/ --
# scripts/configure.sh and the secret generation below only fill in what is
# missing.
#
# #876: the dependency step below is `pnpm install --frozen-lockfile`. In
# this repo a worktree's root node_modules is a directory symlink onto the
# main checkout's, and its web/node_modules is a real directory of per-
# package symlinks into the main checkout's web/node_modules -- so a
# worktree that has been set up this way shares the main checkout's install
# rather than owning one (AGENTS.md's worktree-install trap, #784, diagnosed
# twice). An install run with a worktree as the working directory writes
# through that symlink and rewires the main checkout -- invisibly, until the
# worktree is later removed and the main checkout's own build breaks. Three
# cases, handled where the install used to be unconditional:
#   1. Main checkout: installs as before.
#   2. Worktree, dependencies unchanged: root node_modules already mirrors
#      the main checkout's, and this branch's pnpm-lock.yaml matches
#      node_modules/.pnpm/lock.yaml there -- pnpm's own record of the
#      lockfile it last installed from, a stronger signal than diffing the
#      two committed pnpm-lock.yaml files, which could in principle be ahead
#      of what the main checkout actually has installed. Nothing to do:
#      skip the install and proceed. (web/node_modules isn't re-checked
#      here -- this script never reads it on the host; the container build
#      installs its own copy.)
#   3. Worktree, no shared node_modules to check, or dependencies differ:
#      refuse, naming the trap, rather than install here or trust an
#      unverified workaround.
#
# #858: the two remaining pnpm calls -- install-test-browser.sh's browser
# download and the Playwright suite run below -- go through `pnpm exec`,
# which re-verifies node_modules against the lockfile before running and, in
# a worktree, can try to repair a node_modules it does not own
# (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY outside a TTY). Both now call
# node_modules/@playwright/test/cli.js directly with `node` -- the same binary
# `pnpm exec playwright` would have run.
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

spec=""
playwright_project=""
keep=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep)
      keep=1
      shift
      ;;
    --spec)
      [[ $# -ge 2 ]] || { printf 'test-e2e-local: --spec requires a value.\n' >&2; exit 2; }
      spec="$2"
      shift 2
      ;;
    --project)
      [[ $# -ge 2 ]] || { printf 'test-e2e-local: --project requires a value.\n' >&2; exit 2; }
      playwright_project="$2"
      shift 2
      ;;
    -h | --help)
      printf 'Usage: %s [--spec PATH] [--project desktop-chromium|mobile-chromium] [--keep]\n' "$0"
      exit 0
      ;;
    *)
      printf 'test-e2e-local: unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

# `--project` is variadic in the pinned Playwright, so `--project NAME SPEC`
# reads SPEC as a second project name instead of a file filter (#731). Using
# `--project=NAME` instead keeps the value tied to the flag regardless of
# argument order or which flags are present, and does not depend on
# Playwright's variadic parsing staying as it is today.
playwright_args=()
[[ -z "$playwright_project" ]] || playwright_args+=("--project=${playwright_project}")
[[ -z "$spec" ]] || playwright_args+=("$spec")

# Assembled before any Docker or network work runs, so
# scripts/test-e2e-local.test.mjs can prove the argument list is correct
# without bringing up the stack.
if [[ -n "${TEST_E2E_LOCAL_DRY_RUN:-}" ]]; then
  printf '%s\n' "${playwright_args[@]}"
  exit 0
fi

orbit_image=""

log() { printf 'test-e2e-local: %s\n' "$*" >&2; }
fail() { log "$*"; exit 1; }

free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();});'
}

# --- Per-run isolation: unique Compose project name and app port ------------
#
# #875: this project name and app port used to be fixed, so two concurrent
# runs of this script -- two worktrees, two agent sessions -- adopted the
# same Compose project and the same published port, and whichever run
# finished first tore the other's database down mid-test. Derive both per
# run instead: the project name from this worktree's path and this process's
# PID (so even two runs from the same worktree cannot collide), the port
# from whatever the kernel hands out (free_port() above, the same bind-then-
# release approach the TEST_SMTP_PORT/TEST_OIDC_PORT/TEST_IMAPS_PORT
# selection below uses). An explicit override already set in the caller's
# environment -- COMPOSE_PROJECT_NAME or ORBIT_PORT -- always wins.
worktree_hash="$(printf '%s' "$repo_dir" | md5sum | cut -c1-8)"
project_name="${COMPOSE_PROJECT_NAME:-orbit-e2e-local-${worktree_hash}-$$}"
readonly project_name
app_port="${ORBIT_PORT:-$(free_port)}"
readonly app_port
# Exported rather than set per-invocation: compose/docker-compose.local-e2e.yml reads
# it to build the application's own APP_URL and OIDC callback URL, so every
# compose call in this script has to agree about the published port. The
# "port already in use" bind-test below (the "${app_port}:the Orbit
# application" entry in the port_check loop) confirms a freshly-picked port
# is still free -- and rejects a bad override -- before anything starts.
export ORBIT_PORT="$app_port"
readonly base_url="http://127.0.0.1:${app_port}"
readonly compose_files=(-f docker-compose.yml -f docker-compose.mail.yml -f compose/docker-compose.acceptance.yml -f compose/docker-compose.local-e2e.yml)

compose() {
  env ORBIT_IMAGE="$orbit_image" COMPOSE_PROJECT_NAME="$project_name" \
    docker compose -p "$project_name" --env-file .env-orbit "${compose_files[@]}" "$@"
}

# Registered before anything is built or started, so any failure from here
# on -- including one added later by an edit to this script -- attempts
# teardown of project "$project_name" rather than silently leaking
# containers, volumes or networks. Before ".env-orbit" exists or the image is
# built this is a harmless no-op (nothing to tear down; `compose down` itself
# fails cleanly and is swallowed below).
cleaned_up=0
cleanup() {
  [[ "$cleaned_up" == 0 ]] || return 0
  cleaned_up=1
  if [[ "$keep" == 1 ]]; then
    log "leaving project ${project_name} up (--keep); tear it down with the command in this script's usage"
    return 0
  fi
  # AGENTS.md's standing Compose trap ("Compose commands attach to whatever
  # project .env-orbit names") is exactly the failure #875 hit, so confirm
  # this run's own db container still carries the label "$project_name"
  # before running `down --volumes` against it -- the same check AGENTS.md
  # asks for before trusting Compose isolation. A container that does not
  # exist (nothing ever came up) is fine to "tear down" (a no-op below);
  # one that exists under a different project's label means this run's
  # isolation did not hold, and destroying it would be the same bug again,
  # so leave it alone and say so instead.
  db_container="${project_name}-db"
  actual_label="$(docker inspect "$db_container" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
  if [[ -n "$actual_label" && "$actual_label" != "$project_name" ]]; then
    log "refusing to tear down: ${db_container} belongs to project '${actual_label}', not '${project_name}'. Leaving it alone -- investigate manually."
    return 0
  fi
  log "tearing down project ${project_name}"
  compose down --volumes --remove-orphans > /dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# --- Preconditions -----------------------------------------------------------

for tool in docker node git curl jq openssl pnpm; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing prerequisite: $tool"
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 plugin is required."
docker info >/dev/null 2>&1 || fail "Docker daemon is not reachable."
[[ -f .env-orbit.example && -f docker-compose.yml ]] || fail "run from the Orbit repository root."

# #876 / AGENTS.md worktree-install trap (#784): a git worktree's git-dir
# sits under the main checkout's, so the two differ from --git-common-dir
# only in a worktree. Used by the dependency step below -- see the header
# comment for the three cases.
main_common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
main_checkout_dir="$(dirname "$main_common_dir")"
in_worktree=1
[[ "$(git rev-parse --path-format=absolute --git-dir)" != "$main_common_dir" ]] || in_worktree=0
readonly main_checkout_dir in_worktree

port_free() {
  ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# GreenMail's SMTP port and the disposable OIDC provider's port are fixed in
# CI (3025 and 4443: tests/e2e/v19-mail-collection.spec.ts's SMTP_PORT,
# compose/docker-compose.acceptance.yml's host bindings, and
# tests/e2e/playwright.config.ts's host-resolver-rules all default to them
# via TEST_SMTP_PORT/TEST_OIDC_PORT) but that is exactly what a real Orbit
# deployment on this host already holds. Pick free ports instead and export
# them so every one of those readers agrees -- the test and the compose host-binding must always
# resolve to the SAME number, which is why this is one variable each rather
# than two that could diverge. An explicit override from the caller's
# environment is respected as-is. free_port() is defined above, alongside
# the app port selection that uses it first.
export TEST_SMTP_PORT="${TEST_SMTP_PORT:-$(free_port)}"
export TEST_OIDC_PORT="${TEST_OIDC_PORT:-$(free_port)}"
while [[ "$TEST_OIDC_PORT" == "$TEST_SMTP_PORT" ]]; do
  TEST_OIDC_PORT="$(free_port)"
done
export TEST_OIDC_PORT

# The invitation journey (#481) reads its own mail back out of GreenMail over
# IMAPS rather than SMTP-injecting it, so it needs a third host-published
# port alongside the two above -- same reasoning, same pattern.
export TEST_IMAPS_PORT="${TEST_IMAPS_PORT:-$(free_port)}"
while [[ "$TEST_IMAPS_PORT" == "$TEST_SMTP_PORT" || "$TEST_IMAPS_PORT" == "$TEST_OIDC_PORT" ]]; do
  TEST_IMAPS_PORT="$(free_port)"
done
export TEST_IMAPS_PORT

# The app's own port and the three ports just selected must be free before
# anything starts -- refuse clearly rather than fail deep inside
# `compose up` or hang waiting for health. TEST_SMTP_PORT/TEST_OIDC_PORT/
# TEST_IMAPS_PORT are freshly chosen above, so this is normally a formality;
# it still guards an explicit caller override and the narrow race between
# selection and use.
for port_check in "${TEST_SMTP_PORT}:GreenMail SMTP (TEST_SMTP_PORT)" \
  "${TEST_OIDC_PORT}:the disposable OIDC provider (TEST_OIDC_PORT)" \
  "${TEST_IMAPS_PORT}:GreenMail IMAPS (TEST_IMAPS_PORT)" \
  "${app_port}:the Orbit application"; do
  port="${port_check%%:*}"
  label="${port_check#*:}"
  port_free "$port" || fail "port ${port} (${label}) is already in use -- likely a real Orbit deployment on this host. Stop it before running the local acceptance suite."
done
log "using TEST_SMTP_PORT=${TEST_SMTP_PORT} TEST_OIDC_PORT=${TEST_OIDC_PORT} TEST_IMAPS_PORT=${TEST_IMAPS_PORT}"

# The renamed containers (compose/docker-compose.local-e2e.yml) must not already
# exist under a different project; a name collision there would mean this
# script is about to touch something it did not create.
for fixed_name in "${project_name}-app" "${project_name}-db" "${project_name}-clamav"; do
  if docker inspect "$fixed_name" >/dev/null 2>&1; then
    label="$(docker inspect "$fixed_name" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
    [[ "$label" == "$project_name" ]] || fail "container ${fixed_name} already exists and belongs to project '${label}', not '${project_name}'. Refusing to touch it."
  fi
done

# --- Local secrets and TLS material: generate only what is missing ----------

bash scripts/configure.sh
[[ -f .env-orbit ]] || fail "scripts/configure.sh did not create .env-orbit."

# docker-compose.yml's orbit-oidc-client-secret Compose secret always needs a
# host file to bind-mount, whether or not the container reads it.
# configure.sh's ensure_oidc_secret_placeholder deliberately skips creating
# one when .env-orbit already carries a direct-value OIDC_CLIENT_SECRET (a
# real deployment form it must leave alone -- see the comment above that
# function), which a worktree that reuses .env-orbit across runs can already
# have from an earlier session (#857). Fill in the same placeholder the other
# acceptance-style test scripts already write (test-install-acceptance.sh,
# test-install-bootstrap.sh, test-repair-journeys.sh), only when it is
# missing -- this script never overwrites an existing file under
# .orbit-secrets/.
if [[ ! -f .orbit-secrets/oidc-client-secret ]]; then
  log "generating missing secret: .orbit-secrets/oidc-client-secret"
  printf 'e2e-local-client-secret\n' > .orbit-secrets/oidc-client-secret
  chmod 600 .orbit-secrets/oidc-client-secret
fi

if [[ ! -f .orbit-secrets/greenmail.p12 || ! -f .orbit-secrets/greenmail-ca.pem || ! -f .orbit-secrets/greenmail-key.pem ]]; then
  log "generating GreenMail TLS material (missing from .orbit-secrets/)"
  bash scripts/dev-greenmail-cert.sh
fi
for required in .orbit-secrets/greenmail.p12 .orbit-secrets/greenmail-ca.pem; do
  [[ -f "$required" ]] || fail "missing GreenMail TLS material: ${required}"
done

# Only SMTP now: the inbound mailbox credential is set through the
# administration screen and stored encrypted in the database (ADR-0017 slice
# 2), so there is no host secret file for it and no alias key to generate --
# Orbit makes its own. tests/e2e/v19-mail-collection.spec.ts configures the
# mailbox as the administrator before it sends anything.
for secret_file in smtp-password; do
  path=".orbit-secrets/${secret_file}"
  if [[ ! -f "$path" ]]; then
    log "generating missing secret: ${path}"
    (umask 077; openssl rand -hex 32 > "$path")
    chmod 600 "$path"
  fi
done

# --- Dependencies -------------------------------------------------------------

if [[ "$in_worktree" == 0 ]]; then
  pnpm install --frozen-lockfile
else
  # #876: do not install from here (see the header comment for why). Check
  # instead whether the main checkout's shared node_modules already has what
  # this branch needs, and only proceed if so.
  worktree_lock="$repo_dir/pnpm-lock.yaml"
  main_installed_lock="$main_checkout_dir/node_modules/.pnpm/lock.yaml"
  shared_node_modules=0
  if [[ -L "$repo_dir/node_modules" \
     && "$(readlink -f "$repo_dir/node_modules")" == "$main_checkout_dir/node_modules" ]]; then
    shared_node_modules=1
  fi
  if [[ "$shared_node_modules" != 1 || ! -f "$main_installed_lock" ]]; then
    fail "refusing: this worktree has no usable dependencies to run against -- node_modules is either missing or is not the main checkout's shared install -- and installing them here would rewire the main checkout instead (AGENTS.md worktree-install trap, #784/#876). Run this script from the main Orbit checkout."
  fi
  # Compare the PROJECT document, not the whole file. Since pnpm 12 (#882)
  # pnpm-lock.yaml is two YAML documents: first the packageManagerDependencies
  # record for pnpm's own managed install of itself, then the project lockfile.
  # node_modules/.pnpm/lock.yaml is pnpm's record of the dependency graph it
  # installed and only ever holds the second, so `cmp` on the files whole
  # differed by that leading document alone and refused EVERY worktree run --
  # including ones whose dependencies matched perfectly. Each `---` resets the
  # buffer, so this yields the final document, or the whole file when there is
  # only one.
  project_lock_document() {
    awk '/^---$/ { doc = ""; next } { doc = doc $0 "\n" } END { printf "%s", doc }' "$1"
  }
  if ! cmp -s <(project_lock_document "$worktree_lock") "$main_installed_lock"; then
    fail "refusing: this branch's pnpm-lock.yaml differs from what pnpm actually installed in the main checkout (node_modules/.pnpm/lock.yaml) -- this branch changes dependencies, so they must be installed from the main checkout, not from a worktree (AGENTS.md worktree-install trap, #784/#876)."
  fi
  log "worktree dependencies already match the main checkout's installed lockfile; skipping pnpm install (#876)"
fi

# --- Build the application image ---------------------------------------------

orbit_short_sha="$(git rev-parse --short=12 HEAD)"
orbit_revision="$(git rev-parse HEAD)"
orbit_version="$(node scripts/calculate-version.mjs --channel preview)"
readonly orbit_image="orbit-local:${orbit_short_sha}"
readonly orbit_revision
readonly orbit_version
readonly orbit_channel="dev"

log "building ${orbit_image} (version ${orbit_version})"
env ORBIT_IMAGE="$orbit_image" ORBIT_VERSION="$orbit_version" ORBIT_REVISION="$orbit_revision" ORBIT_CHANNEL="$orbit_channel" \
  docker compose -p "$project_name" --env-file .env-orbit -f docker-compose.yml -f compose/docker-compose.build.yml \
  build orbit-app

log "building the disposable OIDC acceptance provider"
compose build orbit-oidc

# --- Bring up the stack ------------------------------------------------------

log "starting the acceptance stack (project ${project_name}, app on ${base_url})"
ORBIT_BIND_ADDRESS=127.0.0.1 ORBIT_PORT="$app_port" \
  compose up --detach --no-build --wait --wait-timeout 180 || {
  log "stack did not become healthy; service status and logs follow"
  compose ps || true
  compose logs --no-color || true
  exit 1
}

response="$(curl --fail --silent --show-error --max-time 10 "${base_url}/api/health")" || fail "health endpoint did not respond at ${base_url}/api/health"
jq --exit-status '.status == "ready" and .service == "orbit"' <<< "$response" > /dev/null || fail "health endpoint did not report ready: ${response}"
log "application is healthy"

# The application hands the OIDC provider its own callback URL, and the browser
# follows it. If that URL names a port this script is not publishing, every
# sign-in dies at chrome-error://chromewebdata/ several minutes from now, with
# nothing in the health check to hint at it (#732). Compare them here instead.
configured_app_url="$(compose config --format json | jq -r '.services["orbit-app"].environment.APP_URL // empty')"
[[ "$configured_app_url" == "$base_url" ]] || fail "the application is configured with APP_URL=${configured_app_url:-<unset>} but this run publishes it on ${base_url}; browser sign-in would fail at the OIDC callback"
log "APP_URL agrees with the published port"

# --- Run the Playwright suite -------------------------------------------------
# playwright_args was assembled right after argument parsing, above.

log "installing Playwright's Chromium build"
# scripts/install-test-browser.sh (README "Local development"): a plain
# --only-shell install, not CI's --with-deps. --with-deps apt-get-installs
# system libraries and needs root; a local checkout is not guaranteed sudo.
bash scripts/install-test-browser.sh

log "running the Playwright suite${spec:+ (spec: $spec)}${playwright_project:+ (project: $playwright_project)}"
suite_status=0
# COMPOSE_PROJECT_NAME is handed to the suite because a spec may need to ask
# the stack's own database a question -- tests/e2e/v19-tour.spec.ts proves the
# tour's example body is never written down, which only the database can
# answer. Every other `compose` call in this script passes an explicit `-p`;
# the suite has no way to know that name, and without it its `docker compose`
# would adopt whatever project .env-orbit happens to name (AGENTS.md, "Compose
# commands attach to whatever project .env-orbit names") -- a different stack,
# or none. CI needs no equivalent: it runs compose without `-p`, so the
# environment there already agrees with .env-orbit.
# node_modules/@playwright/test/cli.js directly, not `pnpm exec playwright`:
# in a worktree `pnpm exec` re-verifies node_modules against the lockfile and
# can abort trying to repair a node_modules it does not own (#858, same
# reasoning as install-test-browser.sh's header comment). Same binary.
PLAYWRIGHT_BASE_URL="$base_url" ORBIT_ACCEPTANCE_OIDC=true COMPOSE_PROJECT_NAME="$project_name" \
  node node_modules/@playwright/test/cli.js test --config tests/e2e/playwright.config.ts \
  "${playwright_args[@]}" || suite_status=$?

if [[ "$keep" == 1 ]]; then
  log "stack still up: ${base_url}"
fi

if [[ "$suite_status" != 0 ]]; then
  log "suite failed; service status and logs follow"
  compose ps || true
  compose logs --no-color || true
fi

exit "$suite_status"
