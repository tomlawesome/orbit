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
#   --project NAME  Playwright project from playwright.config.ts:
#                    desktop-chromium or mobile-chromium. Default: both.
#   --repeat N      Run the suite N times against ONE instance, reporting each
#                    run's status. The default of 1 is the ordinary run.
#   --keep          Leave the stack up on exit instead of tearing it down, and
#                    print the base URL so another run can target it. Tear it
#                    down afterwards with:
#                      docker compose -p orbit-e2e-local --env-file .env-orbit \
#                        -f docker-compose.yml -f docker-compose.mail.yml \
#                        -f docker-compose.acceptance.yml \
#                        -f docker-compose.local-e2e.yml down --volumes
#
# --repeat is a DEBUGGING TOOL, not a gate. Running twice against one instance
# makes leaked fixtures show themselves, which is how the interface-created
# household leak and #741 were found. It is deliberately not a criterion any
# issue has to satisfy: this harness destroys its volumes on every run and CI
# builds a fresh stack, so nobody meets the second run in real use, and some
# journeys are one-way by design (v19-arrival's own docblock says so).
#
# So: use it to hunt, and do not read a second-run failure as a defect on its
# own. Confirm the finding against a scenario somebody actually runs before
# filing anything (owner, 2026-09-03).
#
# AGENTS.md "Traps when running things locally" applies here directly: this
# script always passes an explicit, distinctive Compose `-p` project name
# (below) so it can never attach to whatever project a real deployment's
# .env-orbit happens to name, and it only ever tears down that same project.
# docker-compose.yml also pins container_name for orbit-app/orbit-db/
# orbit-clamav, which would block a second stack under those names
# regardless of project; docker-compose.local-e2e.yml renames them for this
# script only. Never runs `pnpm db:generate` (also an AGENTS.md trap) and
# never writes to .env-orbit or an existing file under .orbit-secrets/ --
# scripts/configure.sh and the secret generation below only fill in what is
# missing.
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

readonly project_name="orbit-e2e-local"
readonly app_port="13777"
# Exported rather than set per-invocation: docker-compose.local-e2e.yml reads
# it to build the application's own APP_URL and OIDC callback URL, so every
# compose call in this script has to agree about the published port.
export ORBIT_PORT="$app_port"
readonly base_url="http://127.0.0.1:${app_port}"
readonly compose_files=(-f docker-compose.yml -f docker-compose.mail.yml -f docker-compose.acceptance.yml -f docker-compose.local-e2e.yml)

spec=""
playwright_project=""
keep=0
repeat=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep)
      keep=1
      shift
      ;;
    --repeat)
      [[ $# -ge 2 ]] || { printf 'test-e2e-local: --repeat requires a value.\n' >&2; exit 2; }
      [[ "$2" =~ ^[1-9][0-9]*$ ]] || { printf 'test-e2e-local: --repeat wants a positive integer.\n' >&2; exit 2; }
      repeat="$2"
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
      printf 'Usage: %s [--spec PATH] [--project desktop-chromium|mobile-chromium] [--repeat N] [--keep]\n' "$0"
      exit 0
      ;;
    *)
      printf 'test-e2e-local: unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

orbit_image=""

log() { printf 'test-e2e-local: %s\n' "$*" >&2; }
fail() { log "$*"; exit 1; }

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

port_free() {
  ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# GreenMail's SMTP port and the disposable OIDC provider's port are fixed in
# CI (3025 and 4443: tests/e2e/v19-mail-collection.spec.ts's SMTP_PORT,
# docker-compose.acceptance.yml's host bindings, and playwright.config.ts's
# host-resolver-rules all default to them via TEST_SMTP_PORT/TEST_OIDC_PORT)
# but that is exactly what a real Orbit deployment on this host already
# holds. Pick free ports instead and export them so every one of those
# readers agrees -- the test and the compose host-binding must always
# resolve to the SAME number, which is why this is one variable each rather
# than two that could diverge. An explicit override from the caller's
# environment is respected as-is.
free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();});'
}
export TEST_SMTP_PORT="${TEST_SMTP_PORT:-$(free_port)}"
export TEST_OIDC_PORT="${TEST_OIDC_PORT:-$(free_port)}"
while [[ "$TEST_OIDC_PORT" == "$TEST_SMTP_PORT" ]]; do
  TEST_OIDC_PORT="$(free_port)"
done
export TEST_OIDC_PORT

# The app's own port and the two ports just selected must be free before
# anything starts -- refuse clearly rather than fail deep inside
# `compose up` or hang waiting for health. TEST_SMTP_PORT/TEST_OIDC_PORT are
# freshly chosen above, so this is normally a formality; it still guards an
# explicit caller override and the narrow race between selection and use.
for port_check in "${TEST_SMTP_PORT}:GreenMail SMTP (TEST_SMTP_PORT)" \
  "${TEST_OIDC_PORT}:the disposable OIDC provider (TEST_OIDC_PORT)" \
  "${app_port}:the Orbit application"; do
  port="${port_check%%:*}"
  label="${port_check#*:}"
  port_free "$port" || fail "port ${port} (${label}) is already in use -- likely a real Orbit deployment on this host. Stop it before running the local acceptance suite."
done
log "using TEST_SMTP_PORT=${TEST_SMTP_PORT} TEST_OIDC_PORT=${TEST_OIDC_PORT}"

# The renamed containers (docker-compose.local-e2e.yml) must not already
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

if [[ ! -f .orbit-secrets/greenmail.p12 || ! -f .orbit-secrets/greenmail-ca.pem || ! -f .orbit-secrets/greenmail-key.pem ]]; then
  log "generating GreenMail TLS material (missing from .orbit-secrets/)"
  bash scripts/dev-greenmail-cert.sh
fi
for required in .orbit-secrets/greenmail.p12 .orbit-secrets/greenmail-ca.pem; do
  [[ -f "$required" ]] || fail "missing GreenMail TLS material: ${required}"
done

for secret_file in smtp-password imap-password imap-alias-current-secret; do
  path=".orbit-secrets/${secret_file}"
  if [[ ! -f "$path" ]]; then
    log "generating missing secret: ${path}"
    (umask 077; openssl rand -hex 32 > "$path")
    chmod 600 "$path"
  fi
done

# --- Dependencies -------------------------------------------------------------

pnpm install --frozen-lockfile

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
  docker compose -p "$project_name" --env-file .env-orbit -f docker-compose.yml -f docker-compose.build.yml \
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

playwright_args=()
[[ -z "$playwright_project" ]] || playwright_args+=(--project "$playwright_project")
[[ -z "$spec" ]] || playwright_args+=("$spec")

log "installing Playwright's Chromium build"
# scripts/install-test-browser.sh (README "Local development"): a plain
# --only-shell install, not CI's --with-deps. --with-deps apt-get-installs
# system libraries and needs root; a local checkout is not guaranteed sudo.
bash scripts/install-test-browser.sh

repeat_note=""
[[ "$repeat" == 1 ]] || repeat_note=", ${repeat} times against this one instance"
log "running the Playwright suite${spec:+ (spec: $spec)}${playwright_project:+ (project: $playwright_project)}${repeat_note}"
suite_status=0
run_statuses=()
for (( run = 1; run <= repeat; run++ )); do
  [[ "$repeat" == 1 ]] || log "run ${run} of ${repeat}"
  run_status=0
  PLAYWRIGHT_BASE_URL="$base_url" ORBIT_ACCEPTANCE_OIDC=true \
    pnpm exec playwright test "${playwright_args[@]}" || run_status=$?
  run_statuses+=("$run_status")
  [[ "$run_status" == 0 ]] || suite_status="$run_status"
done

if [[ "$repeat" -gt 1 ]]; then
  # The comparison #730 asks for: identical status across runs against one
  # instance. A first run that passes and a second that fails is the signature
  # of fixtures surviving the first.
  log "run statuses in order: ${run_statuses[*]}"
  first="${run_statuses[0]}"
  for status in "${run_statuses[@]}"; do
    [[ "$status" == "$first" ]] || fail "runs disagreed (${run_statuses[*]}): the instance did not come back to the same state"
  done
  log "every run against this instance agreed (${first})"
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
