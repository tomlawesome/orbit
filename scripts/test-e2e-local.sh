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
#   bash scripts/test-e2e-local.sh [--profile NAME] [--spec PATH] [--project NAME] [--keep] [--ci-cap] [--reuse PROJECT]
#
#   --ci-cap        Apply compose/docker-compose.ci-cap.yml — the cpu/memory
#                    cap CI's acceptance stack always runs under — so local
#                    timing and worker-count measurements transfer to CI
#                    (#1080). Off by default: an uncapped stack is the faster
#                    everyday iteration loop.
#
#   --reuse PROJECT Skip the image build, the OIDC sidecar build and
#                    `compose up`; run Playwright straight against the
#                    already-running stack under Compose project PROJECT --
#                    the project name a prior `--keep` run logged at startup
#                    ("starting the acceptance stack (profile ..., project
#                    ..., app on ...)"). #947, following the owner's ruling on
#                    #923 rec 22/finding 11: this makes a single-spec rerun
#                    after a failure cost only the spec's own time (--spec)
#                    instead of the full build-and-start every time.
#                      bash scripts/test-e2e-local.sh --keep
#                      # ... a spec fails; fix it, then:
#                      bash scripts/test-e2e-local.sh --reuse <project> --spec tests/e2e/v19-mail-review.spec.ts
#                    The stack is identified by Compose's own project/service
#                    labels (`docker ps --filter label=com.docker.compose.project=PROJECT
#                    --filter label=com.docker.compose.service=orbit-app`, and
#                    likewise for orbit-db/orbit-oidc/orbit-greenmail) --
#                    never by a name or port the caller has to remember right
#                    -- then health-checked before anything runs: the
#                    container's own Docker health status must be "healthy"
#                    and its published port must answer `/api/health` with
#                    `{"status":"ready","service":"orbit"}`, exactly the check
#                    a fresh run does. Any of that failing -- no such
#                    container, unhealthy, wrong profile for what's actually
#                    running, health endpoint not answering -- is a loud
#                    failure and a non-zero exit, never a silent fall-through
#                    to starting a new stack or running Playwright against
#                    nothing. The app's, OIDC provider's and GreenMail's
#                    published host ports are read back from the running
#                    containers themselves (never freed and reselected, and
#                    never assumed to be the defaults), so ORBIT_PORT,
#                    TEST_OIDC_PORT, TEST_SMTP_PORT and TEST_IMAPS_PORT need no
#                    caller bookkeeping. A stack reused this way is never torn
#                    down by this run, whatever --keep is set to -- this run
#                    did not create it, so cleanup below leaves it exactly as
#                    found, same as a permanent failure to identify it does.
#   --profile NAME  Which stack to test against (#916). Default: oidc.
#                    oidc        the stack above: a disposable OIDC provider,
#                                GreenMail, and the whole suite.
#                    local-only  an Orbit with no identity provider at all
#                                (compose/docker-compose.local-only.yml,
#                                ORBIT_AUTH_OIDC=false, no provider or mail
#                                sidecar), running the short list in
#                                tests/e2e/local-only-specs.txt. --spec still
#                                overrides that list.
#   --spec PATH     Playwright spec file or glob, e.g.
#                    tests/e2e/v19-mail-review.spec.ts
#   --project NAME  Playwright project from tests/e2e/playwright.config.ts:
#                    desktop-chromium, mobile-chromium, desktop-firefox,
#                    desktop-webkit or mobile-webkit. Default: all of them,
#                    plus the maintenance-* tail. A run that includes WebKit
#                    (either WebKit project, or the default) runs Playwright
#                    inside CI's Playwright image, because WebKit cannot
#                    launch on this host (#1235); see the comment above the
#                    `docker run` below. Chromium and Firefox runs stay on
#                    the host.
#   --keep          The only way to leave anything up. Skips teardown on exit so a
#                    failed run can be inspected: query the database, read the
#                    container logs, open the app. The run logs its own
#                    profile, project name and app port at startup ("starting
#                    the acceptance stack (profile ..., project ..., app on
#                    ...)") and, on exit, prints the exact command that tears
#                    that project down completely -- its containers (profile
#                    services such as orbit-tika included), volumes, networks
#                    and the image this run built.
#
# #1241: every stack this script brings up tears itself down completely, and
# never leaves a stale container behind, whatever ends the run. The EXIT trap
# (and INT/TERM, which exit through it) runs one teardown, exactly once, on
# success, on failure and on interruption:
#   - `docker compose -p <project> --profile '*' down --volumes
#     --remove-orphans --rmi local`: every container of this run's project,
#     profile services included (orbit-tika used to be left running, on the
#     reasoning that Compose ignores a profile it was not told about; the
#     wildcard profile is the fix, not a COMPOSE_PROFILES the caller must
#     remember), its volumes, its networks (orbit-document-processing and
#     the rest are project-scoped) and the sidecar images Compose built for it;
#   - the application image this run built, tagged orbit-local:<12 hex> from
#     the commit and this run's pid, so the tag is this run's alone and
#     removing it can never pull the rug from a concurrent run at the same
#     commit;
#   - the Playwright container of a WebKit run, found by the label this run
#     gave it;
#   - a final sweep of anything still carrying this project's Compose label.
# Nothing outside this run's own project is ever touched, and a stack it did
# not start (--reuse) is never torn down, whatever --keep says.
#
# A failed run keeps its evidence: before anything is removed, `compose logs`,
# `compose ps` and Playwright's test-results/ (the traces) are copied to
# ~/projects/.backups/orbit/e2e-<project>-<timestamp>/ (ORBIT_E2E_ARTIFACT_ROOT
# overrides the root), and the path is printed on exit.
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
# docs/testing.md "Local traps" applies here directly: this
# script always passes an explicit Compose `-p` project name (below, per-run
# rather than fixed since #875) so it can never attach to whatever project a
# real deployment's .env-orbit happens to name, it checks that name against
# the running container's own label before tearing anything down, and it
# only ever tears down that same project. docker-compose.yml also pins
# container_name for orbit-app/orbit-db/orbit-clamav, which would block a
# second stack under those names regardless of project;
# compose/docker-compose.local-e2e.yml renames them to `${COMPOSE_PROJECT_NAME}-*`
# for this script only, so a per-run project name also gives per-run
# container names. Never runs `pnpm db:generate` (also a docs/testing.md "Local traps" entry) and
# never writes to .env-orbit or an existing file under .orbit-secrets/ --
# scripts/configure.sh and the secret generation below only fill in what is
# missing.
#
# #876: the dependency step below is `pnpm install --frozen-lockfile`. In
# this repo a worktree's root node_modules is a directory symlink onto the
# main checkout's, and its web/node_modules is a real directory of per-
# package symlinks into the main checkout's web/node_modules -- so a
# worktree that has been set up this way shares the main checkout's install
# rather than owning one (docs/testing.md's "Local traps" worktree-install entry, #784, diagnosed
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
#   4. Worktree with its own real node_modules directory: installs as case
#      1 does -- the preinstall guard admits it, and nothing it writes can
#      reach the main checkout.
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
profile="oidc"
keep=0
ci_cap=0
reuse_project=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep)
      keep=1
      shift
      ;;
    --ci-cap)
      ci_cap=1
      shift
      ;;
    --reuse)
      [[ $# -ge 2 ]] || { printf 'test-e2e-local: --reuse requires a Compose project name.\n' >&2; exit 2; }
      reuse_project="$2"
      shift 2
      ;;
    --profile)
      [[ $# -ge 2 ]] || { printf 'test-e2e-local: --profile requires a value.\n' >&2; exit 2; }
      case "$2" in
        oidc | local-only) profile="$2" ;;
        *) printf 'test-e2e-local: unknown profile: %s (expected oidc or local-only)\n' "$2" >&2; exit 2 ;;
      esac
      shift 2
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
      printf 'Usage: %s [--profile oidc|local-only] [--spec PATH] [--project desktop-chromium|mobile-chromium|desktop-firefox|desktop-webkit|mobile-webkit] [--keep] [--ci-cap] [--reuse PROJECT]\n' "$0"
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
if [[ -n "$spec" ]]; then
  playwright_args+=("$spec")
elif [[ "$profile" == "local-only" ]]; then
  # The list the local-only profile exists to run (#916), read from the file
  # both callers share so this lane and the `smoke_local_only` job in
  # .gitlab-ci.yml can never drift apart. Same filter on both sides: drop
  # comments and blank lines, keep everything else verbatim.
  local_only_count=0
  while IFS= read -r local_only_spec; do
    playwright_args+=("$local_only_spec")
    local_only_count=$((local_only_count + 1))
  done < <(grep -vE '^[[:space:]]*(#|$)' "${repo_dir}/tests/e2e/local-only-specs.txt")
  [[ "$local_only_count" -gt 0 ]] ||
    { printf 'test-e2e-local: tests/e2e/local-only-specs.txt names no specs.\n' >&2; exit 2; }
fi

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
# environment -- COMPOSE_PROJECT_NAME or ORBIT_PORT -- always wins. --reuse
# names the project outright (#947) and outranks both: it is naming a stack
# that already exists, not asking this run to derive its own.
worktree_hash="$(printf '%s' "$repo_dir" | md5sum | cut -c1-8)"
project_name="${reuse_project:-${COMPOSE_PROJECT_NAME:-orbit-e2e-local-${worktree_hash}-$$}}"
readonly project_name
# app_port (and, for --reuse, base_url) is set below: freshly picked in the
# normal path, or read back from the running container's own published port
# in the --reuse path (#947) -- never guessed and never left at whatever
# ORBIT_PORT happened to default to.
# The two profiles (#916). `local-only` is the acceptance overlay's absence as
# much as its own overlay's presence: that file is what declares the
# disposable `orbit-oidc` sidecar, and a Compose overlay cannot delete a
# service, so the provider goes by not naming the file that brings it. The
# mail sidecar goes for the same reason -- nothing in
# tests/e2e/local-only-specs.txt sends or reads mail.
# compose/docker-compose.local-e2e.yml stays in both: it is the per-run
# container renaming and the published-port agreement, which every local run
# needs whatever it is testing.
if [[ "$profile" == "local-only" ]]; then
  compose_files=(-f docker-compose.yml -f compose/docker-compose.local-only.yml -f compose/docker-compose.local-e2e.yml)
else
  compose_files=(-f docker-compose.yml -f docker-compose.mail.yml -f compose/docker-compose.acceptance.yml -f compose/docker-compose.local-e2e.yml)
fi
# #1080: --ci-cap appends the same cpu/memory cap overlay CI runs the
# acceptance stack under (compose/docker-compose.ci-cap.yml, #801 step 1) —
# for measuring what a change costs where CI will actually pay it. The
# capped app is the bottleneck there, so a worker-count or timing result
# taken on an uncapped stack does not transfer.
[[ "$ci_cap" == 1 ]] && compose_files+=(-f compose/docker-compose.ci-cap.yml)
readonly compose_files

# COMPOSE_PROFILES=processing is what turns the `orbit-tika` document parser
# on (#920). CI gets it from .env-orbit, which
# scripts/ci/create-test-configuration.sh appends it to; this script must
# never write to .env-orbit, so it goes in the environment instead, where
# Compose ranks it above the --env-file's own (empty) value. It is set here,
# on the one wrapper every compose call goes through, rather than on `up`
# alone: `down`, `ps`, `logs` and `config` all have to see the same service
# set, or teardown leaves the parser behind and the diagnostics do not show
# it. compose/docker-compose.local-e2e.yml carries the other half -- the
# TIKA_URL the application reads, and the parser's per-run container name.
compose() {
  # ORBIT_IMAGE is empty until the build step names it; docker-compose.yml's
  # `${ORBIT_IMAGE:?...}` guard would then fail a teardown that has nothing to
  # remove yet, so give the guard a placeholder rather than an empty value.
  env ORBIT_IMAGE="${orbit_image:-not-built-yet:none}" COMPOSE_PROJECT_NAME="$project_name" \
    COMPOSE_PROFILES=processing \
    docker compose -p "$project_name" --env-file .env-orbit "${compose_files[@]}" "$@"
}

# #920: a local harness that claims to run the suite and silently leaves a
# service out is the failure this check exists to stop -- the document
# extraction spec used to be the only thing that noticed, 60 seconds into a
# poll, reporting "the optional document processor" as if that were a
# product answer rather than a harness fault. Assert both halves of what CI
# gives the stack, the same way the APP_URL agreement check (#732) asserts
# the port: the application must be pointed at the parser, and the parser
# must actually be running under this project.
assert_document_parser_ready() {
  local configured_tika running_tika
  configured_tika="$(compose config --format json | jq -r '.services["orbit-app"].environment.TIKA_URL // empty')"
  [[ "$configured_tika" == "http://orbit-tika:9998" ]] ||
    fail "the application is configured with TIKA_URL=${configured_tika:-<unset>}, not http://orbit-tika:9998; tests/e2e/v19-document-extraction.spec.ts would report the document processor as absent instead of testing it (#920)"
  # First name only, by parameter expansion rather than `head` -- the
  # SIGPIPE shape #809 rejects. Labels, not container names: the same
  # identification cleanup() and --reuse trust.
  running_tika=$(docker ps --filter "label=com.docker.compose.project=${project_name}" \
    --filter "label=com.docker.compose.service=orbit-tika" --format '{{.Names}}')
  running_tika="${running_tika%%$'\n'*}"
  [[ -n "$running_tika" ]] ||
    fail "no running orbit-tika container for project ${project_name}: the processing profile did not start the document parser, so the extraction journey would test nothing (#920)"
  log "document parser is up (${running_tika}, TIKA_URL=${configured_tika})"
}

# Registered before anything is built or started, so any failure from here
# on -- including one added later by an edit to this script -- attempts
# teardown of project "$project_name" rather than silently leaking
# containers, volumes or networks. INT and TERM exit (130, 143) so the EXIT
# trap is the one place teardown happens: a handler that merely ran cleanup
# and returned would let the script carry on running the suite after Ctrl-C.
# created_anything is set immediately before the first build, so a run that
# stopped at a precondition has nothing to tear down and does not try.
cleaned_up=0
created_anything=0
orbit_image_built=0
artifact_root="${ORBIT_E2E_ARTIFACT_ROOT:-${HOME}/projects/.backups/orbit}"

# The exact command that removes everything this run created, printed on a
# --keep exit and after a teardown that did not finish. ORBIT_IMAGE has to be
# there because docker-compose.yml refuses to render without it.
teardown_command() {
  local arg
  printf 'cd %q && ORBIT_IMAGE=%q docker compose -p %q --env-file .env-orbit' \
    "$repo_dir" "${orbit_image:-not-built-yet:none}" "$project_name"
  for arg in "${compose_files[@]}"; do printf ' %q' "$arg"; done
  printf ' --profile %q down --volumes --remove-orphans --rmi local' '*'
  [[ -z "$orbit_image" ]] || printf ' && docker image rm %q' "$orbit_image"
  printf '\n'
}

# A failed run's evidence, copied out before the containers that hold it go.
save_failure_artifacts() {
  local dir
  dir="${artifact_root}/e2e-${project_name}-$(date +%Y%m%d-%H%M%S)"
  if ! mkdir -p "$dir" 2>/dev/null; then
    log "could not create ${dir}; the failed run's logs are lost with the stack"
    return 0
  fi
  compose --profile '*' ps --all > "${dir}/compose-ps.txt" 2>&1 || true
  compose --profile '*' logs --no-color > "${dir}/compose-logs.txt" 2>&1 || true
  # Playwright's outputDir (tests/e2e/playwright.config.ts) is test-results/
  # at the repository root: traces, screenshots, page snapshots.
  if [[ -d test-results ]]; then
    cp -a test-results "${dir}/test-results" 2>/dev/null || log "could not copy test-results/ to ${dir}"
  fi
  log "failed run: logs and Playwright traces saved to ${dir}"
}

cleanup() {
  local status=$?
  [[ "$cleaned_up" == 0 ]] || return 0
  cleaned_up=1
  # A second Ctrl-C while teardown runs must not abandon it half done.
  trap '' INT TERM
  # --reuse (#947) means this run never created project "$project_name" --
  # it is reusing a stack an earlier --keep run left up, or it failed before
  # ever confirming one exists -- so, unlike --keep, this is not a choice
  # this run's caller can override with --keep=0: it never fires the
  # teardown below at all, whatever --keep was passed as.
  if [[ -n "$reuse_project" ]]; then
    log "not tearing down project ${project_name} (--reuse never cleans up a stack it did not create)"
    return 0
  fi
  if [[ "$keep" == 1 ]]; then
    log "leaving project ${project_name} up (--keep). Tear it down completely with:"
    printf '  %s' "$(teardown_command)" >&2
    printf '\n' >&2
    return 0
  fi
  if [[ "$created_anything" == 0 ]]; then
    return 0
  fi
  # The standing Compose trap in docs/testing.md ("Compose commands attach to
  # whatever project .env-orbit names") is exactly the failure #875 hit, so confirm
  # this run's own db container still carries the label "$project_name"
  # before running `down --volumes` against it -- the same check docs/testing.md
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
  [[ "$status" == 0 ]] || save_failure_artifacts
  log "tearing down project ${project_name}"
  # The WebKit run's Playwright container is not a Compose service, so `down`
  # cannot see it; it carries this run's label instead. Docker's own `--rm`
  # covers a normal exit, not a killed client.
  local leftover
  leftover="$(docker ps --all --quiet --filter "label=orbit-e2e-run=${project_name}" 2>/dev/null || true)"
  # shellcheck disable=SC2086 # ids, split on purpose
  [[ -z "$leftover" ]] || docker rm --force $leftover > /dev/null 2>&1 || true
  # `--profile '*'` is every profile, so the processing parser (orbit-tika) is
  # part of the project whatever COMPOSE_PROFILES says.
  local down_ok=1
  compose --profile '*' down --volumes --remove-orphans --rmi local > /dev/null 2>&1 || down_ok=0
  if [[ "$orbit_image_built" == 1 ]]; then
    docker image rm "$orbit_image" > /dev/null 2>&1 || true
  fi
  # Final sweep by this project's own label: whatever `down` could not see.
  leftover="$(docker ps --all --quiet --filter "label=com.docker.compose.project=${project_name}" 2>/dev/null || true)"
  # shellcheck disable=SC2086
  [[ -z "$leftover" ]] || { down_ok=0; docker rm --force --volumes $leftover > /dev/null 2>&1 || true; }
  leftover="$(docker volume ls --quiet --filter "label=com.docker.compose.project=${project_name}" 2>/dev/null || true)"
  # shellcheck disable=SC2086
  [[ -z "$leftover" ]] || { down_ok=0; docker volume rm $leftover > /dev/null 2>&1 || true; }
  leftover="$(docker network ls --quiet --filter "label=com.docker.compose.project=${project_name}" 2>/dev/null || true)"
  # shellcheck disable=SC2086
  [[ -z "$leftover" ]] || { down_ok=0; docker network rm $leftover > /dev/null 2>&1 || true; }
  if [[ "$down_ok" == 0 ]]; then
    log "teardown of project ${project_name} needed more than \`compose down\`; if anything is still listed by \`docker ps --all --filter label=com.docker.compose.project=${project_name}\`, run:"
    printf '  %s' "$(teardown_command)" >&2
    printf '\n' >&2
  fi
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --- Preconditions -----------------------------------------------------------

for tool in docker node git curl jq openssl pnpm; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing prerequisite: $tool"
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 plugin is required."
docker info >/dev/null 2>&1 || fail "Docker daemon is not reachable."
[[ -f .env-orbit.example && -f docker-compose.yml ]] || fail "run from the Orbit repository root."

# #876 / docs/testing.md "Local traps" worktree-install entry (#784): a git worktree's git-dir
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

if [[ -n "$reuse_project" ]]; then
  # --- Reuse: identify and health-check an existing kept stack (#947) -------
  #
  # Identify project "$project_name" by Compose's own project/service labels,
  # never by a container name or a port the caller has to remember right --
  # the same labels the collision check below (and cleanup() above) trust,
  # used here the safe way round: filtering by them instead of assuming a
  # name refers to the right thing. `docker ps` lists running containers
  # only, which doubles as the "is it actually still up" half of the check;
  # Docker's own health status and the /api/health probe below cover "is it
  # actually ready", the same bar a fresh `compose up --wait` holds a new
  # stack to.
  container_for_service() {
    # First name only, taken by parameter expansion rather than a pipe into
    # `head`: that shape races SIGPIPE and the acceptance check for #809
    # rejects it outright. `docker ps` here returns at most a handful of
    # lines, so reading them all and trimming costs nothing.
    local names
    names=$(docker ps --filter "label=com.docker.compose.project=${project_name}" \
      --filter "label=com.docker.compose.service=$1" --format '{{.Names}}')
    printf '%s' "${names%%$'\n'*}"
  }
  host_port_of() {
    docker inspect --format "{{with index .NetworkSettings.Ports \"$2\"}}{{(index . 0).HostPort}}{{end}}" "$1" 2>/dev/null
  }

  app_container="$(container_for_service orbit-app)"
  [[ -n "$app_container" ]] ||
    fail "--reuse ${project_name}: no running orbit-app container for this project. Start one first with --keep -- its startup log line names the project to pass here -- or check the project name."
  db_container="$(container_for_service orbit-db)"
  [[ -n "$db_container" ]] ||
    fail "--reuse ${project_name}: found orbit-app but no running orbit-db container; the stack is only partly up. Refusing to reuse it."

  app_health="$(docker inspect --format '{{.State.Health.Status}}' "$app_container" 2>/dev/null || true)"
  [[ "$app_health" == "healthy" ]] ||
    fail "--reuse ${project_name}: orbit-app is not healthy (Docker health status: ${app_health:-none}). Refusing to reuse it."

  app_port="$(host_port_of "$app_container" "3000/tcp")"
  [[ -n "$app_port" ]] ||
    fail "--reuse ${project_name}: could not read orbit-app's published host port."
  export ORBIT_PORT="$app_port"

  # Only the oidc profile has a provider or a mail sidecar to find (#916); a
  # local-only kept stack has neither, and reusing it under --profile oidc
  # would otherwise run the suite against a stack with no provider at all
  # and fail confusingly deep inside a sign-in step instead of here.
  if [[ "$profile" == "oidc" ]]; then
    oidc_container="$(container_for_service orbit-oidc)"
    [[ -n "$oidc_container" ]] ||
      fail "--reuse ${project_name}: --profile oidc but no running orbit-oidc container for this project -- reuse it with --profile local-only if that is what is actually running, or start an oidc-profile stack with --keep."
    oidc_port="$(host_port_of "$oidc_container" "4443/tcp")"
    [[ -n "$oidc_port" ]] ||
      fail "--reuse ${project_name}: could not read orbit-oidc's published host port."
    export TEST_OIDC_PORT="$oidc_port"

    # GreenMail is optional even in the oidc profile's own stack shape:
    # missing it just means the kept stack's caller never needed mail, so a
    # non-mail spec rerun (the common case) still works. A mail spec against
    # a stack that lacks it fails later at the mail step itself, loudly.
    mail_container="$(container_for_service orbit-greenmail)"
    if [[ -n "$mail_container" ]]; then
      smtp_port="$(host_port_of "$mail_container" "3025/tcp")"
      imaps_port="$(host_port_of "$mail_container" "3993/tcp")"
      [[ -z "$smtp_port" ]] || export TEST_SMTP_PORT="$smtp_port"
      [[ -z "$imaps_port" ]] || export TEST_IMAPS_PORT="$imaps_port"
    fi
  fi

  readonly app_port
  readonly base_url="http://127.0.0.1:${app_port}"
  # Only used to satisfy docker-compose.yml's `${ORBIT_IMAGE:?...}` guard so
  # the diagnostic `compose ps`/`compose logs` calls at the bottom of this
  # script still render if the reused suite run fails -- never built, never
  # pulled, never compared against what is actually running.
  orbit_image="reused-by-947:${project_name}"

  response="$(curl --fail --silent --show-error --max-time 10 "${base_url}/api/health")" ||
    fail "--reuse ${project_name}: health endpoint did not respond at ${base_url}/api/health -- this may not be the stack you think it is."
  jq --exit-status '.status == "ready" and .service == "orbit"' <<< "$response" > /dev/null ||
    fail "--reuse ${project_name}: health endpoint did not report ready: ${response}"
  log "reusing project ${project_name} (profile ${profile}, app on ${base_url}); skipping image build, OIDC build and compose up"
  # A stack kept by a run from before #920 has no parser, and reusing it
  # would quietly reintroduce exactly the gap this check closes.
  assert_document_parser_ready
else
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
  app_port="${ORBIT_PORT:-$(free_port)}"
  readonly app_port
  # Exported rather than set per-invocation: compose/docker-compose.local-e2e.yml
  # reads it to build the application's own APP_URL and OIDC callback URL, so
  # every compose call in this script has to agree about the published port.
  # The "port already in use" bind-test below (the "${app_port}:the Orbit
  # application" entry in the port_check loop) confirms a freshly-picked port
  # is still free -- and rejects a bad override -- before anything starts.
  export ORBIT_PORT="$app_port"
  readonly base_url="http://127.0.0.1:${app_port}"

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
  for fixed_name in "${project_name}-app" "${project_name}-db" "${project_name}-clamav" "${project_name}-tika"; do
    if docker inspect "$fixed_name" >/dev/null 2>&1; then
      label="$(docker inspect "$fixed_name" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
      [[ "$label" == "$project_name" ]] || fail "container ${fixed_name} already exists and belongs to project '${label}', not '${project_name}'. Refusing to touch it."
    fi
  done

  # --- Build the app image: configuration runs inside it (#1210) ------------

  orbit_revision="$(git rev-parse HEAD)"
  orbit_version="$(node scripts/calculate-version.mjs --channel preview)"
  # Per-run tag (#1241): the image is this run's to remove at teardown, which
  # is only safe if no other run at the same commit shares the tag. Layers
  # stay cached by the builder, so a rebuild costs nothing extra. It must
  # also have the installer's local-tag shape, orbit-local:<12 hex>, because
  # configure now runs inside this image and refuses any other (#1210,
  # isValidOrbitImage), so the run's uniqueness goes into the hex: a hash of
  # the commit and this process.
  readonly orbit_image="orbit-local:$(printf '%s-%s' "$(git rev-parse HEAD)" "$$" | sha256sum | cut -c1-12)"
  readonly orbit_revision
  readonly orbit_version
  readonly orbit_channel="dev"

  # From here on there is something to tear down, even if the build fails
  # half way (a built image, a created network).
  created_anything=1
  orbit_image_built=1
  log "building ${orbit_image} (version ${orbit_version})"
  # Straight from the Dockerfile, as scripts/build-container.sh does, but
  # with this suite's own dev channel (build-container.sh stamps preview).
  docker buildx build --load \
    --build-arg ORBIT_VERSION="$orbit_version" \
    --build-arg ORBIT_REVISION="$orbit_revision" \
    --build-arg ORBIT_CHANNEL="$orbit_channel" \
    --tag "$orbit_image" --file Dockerfile .

  # --- Local secrets and TLS material: generate only what is missing --------

  ORBIT_IMAGE="$orbit_image" bash scripts/configure.sh
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

  # dev-greenmail-cert.sh signs for 30 days. Past that, Orbit refuses the
  # sidecar's certificate, every mail step fails with "no mail arrived", and
  # nothing says why -- the stack passed its health check. So an expired or
  # nearly expired CA is regenerated the same as a missing one (#1236).
  if [[ ! -f .orbit-secrets/greenmail.p12 || ! -f .orbit-secrets/greenmail-ca.pem || ! -f .orbit-secrets/greenmail-key.pem ]]; then
    log "generating GreenMail TLS material (missing from .orbit-secrets/)"
    bash scripts/dev-greenmail-cert.sh
  elif ! openssl x509 -in .orbit-secrets/greenmail-ca.pem -noout -checkend 86400 >/dev/null 2>&1; then
    log "regenerating GreenMail TLS material (.orbit-secrets/greenmail-ca.pem has expired or expires within a day)"
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
fi

# --- Dependencies -------------------------------------------------------------

# A worktree that owns its node_modules outright -- a real directory, not a
# symlink -- is the case the preinstall guard (#784, #858) already proves
# safe: an install there writes only inside the worktree, through pnpm's
# shared store. It gets the main checkout's treatment; only a worktree that
# reaches into the main checkout's install is held to the checks below.
if [[ "$in_worktree" == 0 || ( -d "$repo_dir/node_modules" && ! -L "$repo_dir/node_modules" ) ]]; then
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
    fail "refusing: this worktree has no usable dependencies to run against -- node_modules is either missing or is not the main checkout's shared install -- and installing them here would rewire the main checkout instead (docs/testing.md, Local traps, worktree install, #784/#876). Run this script from the main Orbit checkout."
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
    fail "refusing: this branch's pnpm-lock.yaml differs from what pnpm actually installed in the main checkout (node_modules/.pnpm/lock.yaml) -- this branch changes dependencies, so they must be installed from the main checkout, not from a worktree (docs/testing.md, Local traps, worktree install, #784/#876)."
  fi
  log "worktree dependencies already match the main checkout's installed lockfile; skipping pnpm install (#876)"
fi

# --- Build and bring up the stack, unless --reuse named one already up ------

if [[ -n "$reuse_project" ]]; then
  : # already identified, health-checked and logged above (#947).
else
  if [[ "$profile" == "local-only" ]]; then
    log "local-only profile: no identity provider to build"
  else
    log "building the disposable OIDC acceptance provider"
    compose build orbit-oidc
  fi

  log "starting the acceptance stack (profile ${profile}, project ${project_name}, app on ${base_url})"
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

  assert_document_parser_ready
fi

# --- Run the Playwright suite -------------------------------------------------
# playwright_args was assembled right after argument parsing, above.

# #1235: a run that includes a WebKit project happens inside CI's Playwright
# image (the `docker run` below says why and how); the decision is made here
# so the host browser download can skip WebKit, whose download on this host
# only ends in a "missing dependencies" warning nobody can act on.
in_image=0
if [[ "$playwright_project" == *webkit* ]]; then
  in_image=1
elif [[ -z "$playwright_project" ]]; then
  case "${ORBIT_E2E_ENGINES:-}" in chromium | firefox) ;; *) in_image=1 ;; esac
fi

log "installing Playwright's Chromium, Firefox and WebKit builds"
# scripts/install-test-browser.sh (README "Local development"): a plain
# --only-shell install, not CI's --with-deps. --with-deps apt-get-installs
# system libraries and needs root; a local checkout is not guaranteed sudo.
ORBIT_E2E_SKIP_WEBKIT_DOWNLOAD="$in_image" bash scripts/install-test-browser.sh

log "running the Playwright suite (profile: ${profile})${spec:+ (spec: $spec)}${playwright_project:+ (project: $playwright_project)}"
suite_status=0
# playwright.config.ts reads this to decide whether to trust the disposable
# provider's self-signed certificate and where to resolve `orbit-oidc` to.
# There is no provider in the local-only profile, so neither applies and the
# variable is left off rather than set to a value that would be a lie.
acceptance_oidc=()
[[ "$profile" == "local-only" ]] || acceptance_oidc=(ORBIT_ACCEPTANCE_OIDC=true)
# #1150: a --reuse (#947) stack is by definition already claimed, so the
# one-time "unclaimed" project (#1039, tests/e2e/playwright.config.ts) --
# whose one spec, bootstrap-protection.spec.ts, asserts the instance is NOT
# yet claimed -- fails loudly against it, and "setup" depends on that
# project, so nothing else runs either. tests/e2e/claim.setup.ts is already
# idempotent against an already-claimed stack (its own comment), so that
# project needs no change; the config reads this flag to drop only the
# "unclaimed" project and "setup"'s dependency on it, leaving a fresh run
# (this variable unset) with exactly the graph it has today.
reuse_env=()
[[ -z "$reuse_project" ]] || reuse_env=(ORBIT_E2E_REUSE=true)
# A project this script named itself, or was handed through COMPOSE_PROJECT_NAME
# as the header invites, is one it brought up and health-checked here: say so,
# or tests/e2e/support/database.ts refuses to reset a database it believes it
# did not create.
[[ -n "$reuse_project" ]] || reuse_env+=("ORBIT_E2E_OWNED_PROJECT=$project_name")
# COMPOSE_PROJECT_NAME is handed to the suite because a spec may need to ask
# the stack's own database a question -- tests/e2e/v19-tour.spec.ts proves the
# tour's example body is never written down, which only the database can
# answer. Every other `compose` call in this script passes an explicit `-p`;
# the suite has no way to know that name, and without it its `docker compose`
# would adopt whatever project .env-orbit happens to name (docs/testing.md, "Local traps":
# "Compose commands attach to whatever project .env-orbit names") -- a different stack,
# or none. CI needs no equivalent: it runs compose without `-p`, so the
# environment there already agrees with .env-orbit.
# node_modules/@playwright/test/cli.js directly, not `pnpm exec playwright`:
# in a worktree `pnpm exec` re-verifies node_modules against the lockfile and
# can abort trying to repair a node_modules it does not own (#858, same
# reasoning as install-test-browser.sh's header comment). Same binary.
suite_env=(PLAYWRIGHT_BASE_URL="$base_url" COMPOSE_PROJECT_NAME="$project_name" "${acceptance_oidc[@]}" "${reuse_env[@]}")
# tests/e2e/playwright.config.ts records a trace "on-first-retry", and local
# runs retry nothing, so a local failure used to leave only a page snapshot
# -- not enough to tell a harness race from a product one (docs/flakes.md,
# the 2026-10-06 spoofed-PDF sighting). Locally, keep a trace of every
# failure; ORBIT_E2E_TRACE overrides (Playwright's own values: off, on,
# retain-on-failure, on-first-retry).
playwright_cmd=(node node_modules/@playwright/test/cli.js test --config tests/e2e/playwright.config.ts \
  "--trace=${ORBIT_E2E_TRACE:-retain-on-failure}" "${playwright_args[@]}")

# #1235: WebKit cannot launch on this host -- its system packages need root
# -- so a run that includes a WebKit project happens inside the Playwright
# image CI runs it in, on the host network with this checkout bind-mounted
# at its own path. The image is read from .gitlab-ci.yml so local and CI use
# the same browser build. Chromium-only and Firefox-only runs stay on the
# host: nothing there needs the container and the host browsers are already
# downloaded. Inside the image:
#   - `--network host` puts the browsers where the stack's published ports
#     are; `--ipc=host` is what Playwright's own image documentation asks for.
#   - the suite shells out to `docker` (tests/e2e/support/database.ts,
#     bootstrap.ts), so the host CLI, its compose plugin and the rootless
#     socket are bind-mounted in.
#   - WebKit has no host-resolver or port-forcing option, so, exactly as the
#     `.webkit_oidc_hosts` jobs in .gitlab-ci.yml do, `orbit-oidc` is mapped
#     to 127.0.0.1 and a forward from 4443 -- the port in the fixed
#     https://orbit-oidc:4443/ issuer URL -- reaches the random host port the
#     sidecar was actually published on. The suite is told TEST_OIDC_PORT=4443
#     for the same reason.
#   - Only `node` runs on the mounted tree: never `pnpm install` in here, which
#     rewrites the host's node_modules (environment skill, 2026-08-24).
# in_image was decided above, before the browser download.
if [[ "$in_image" == 1 ]]; then
  # grep -m1, not `| head` (scripts/acceptance-sigpipe-safety.test.mjs, #809).
  playwright_image="$(grep -m1 '^  PLAYWRIGHT_IMAGE: ' .gitlab-ci.yml | sed 's/^  PLAYWRIGHT_IMAGE: *//')"
  [[ -n "$playwright_image" ]] || fail "could not read PLAYWRIGHT_IMAGE from .gitlab-ci.yml; the WebKit run needs CI's Playwright image."
  docker_cli="$(command -v docker)"
  compose_plugin="$(docker info --format '{{range .ClientInfo.Plugins}}{{if eq .Name "compose"}}{{.Path}}{{end}}{{end}}')"
  [[ -n "$compose_plugin" ]] || fail "docker's compose plugin was not found; the suite needs it inside the image."
  docker_sock="$(docker context inspect --format '{{(index .Endpoints "docker").Host}}')"
  docker_sock="${docker_sock#unix://}"
  [[ -S "$docker_sock" ]] || fail "docker socket not found at ${docker_sock}; the suite needs it inside the image."
  image_env=()
  for kv in "${suite_env[@]}"; do image_env+=(-e "$kv"); done
  for name in TEST_SMTP_PORT TEST_IMAPS_PORT ORBIT_E2E_ENGINES ORBIT_E2E_WEBKIT_DEVICES ORBIT_E2E_WORKERS ORBIT_IMAGE ORBIT_SECRETS_DIR; do
    [[ -z "${!name:-}" ]] || image_env+=(-e "${name}=${!name}")
  done
  oidc_forward=""
  if [[ "$profile" == "oidc" ]]; then
    image_env+=(-e TEST_OIDC_PORT=4443)
    oidc_forward="node -e 'const n=require(\"net\");n.createServer(s=>{const c=n.connect(${TEST_OIDC_PORT},\"127.0.0.1\");s.pipe(c).pipe(s);s.on(\"error\",()=>c.destroy());c.on(\"error\",()=>s.destroy())}).listen(4443,\"127.0.0.1\")' & sleep 1;"
  fi
  log "running Playwright inside ${playwright_image} (WebKit needs it; #1235)"
  docker run --rm --label "orbit-e2e-run=${project_name}" --network host --ipc=host --add-host orbit-oidc:127.0.0.1 \
    -v "${repo_dir}:${repo_dir}" -w "$repo_dir" \
    -v "${docker_cli}:/usr/local/bin/docker:ro" \
    -v "$(dirname -- "$compose_plugin"):/usr/local/lib/docker/cli-plugins:ro" \
    -v "${docker_sock}:/var/run/docker.sock" -e DOCKER_HOST=unix:///var/run/docker.sock \
    "${image_env[@]}" "$playwright_image" \
    sh -c "${oidc_forward} exec \"\$@\"" sh "${playwright_cmd[@]}" || suite_status=$?
else
  env "${suite_env[@]}" "${playwright_cmd[@]}" || suite_status=$?
fi

if [[ "$keep" == 1 ]]; then
  log "stack still up: ${base_url}"
fi

if [[ "$suite_status" != 0 ]]; then
  log "suite failed; service status and logs follow"
  compose ps || true
  compose logs --no-color || true
fi

exit "$suite_status"
