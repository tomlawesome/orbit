#!/usr/bin/env bash
# Real-container fresh-install acceptance exemplar (issue #289).
#
# Runs the working tree's install.sh unmocked — real Docker, real Compose,
# real PostgreSQL and ClamAV, real health checks — from a clean
# pre-provisioned directory to a healthy /api/health, then asserts
# operator-facing guarantees from docs/installer-guarantees.md. The one
# network path intercepted is OIDC discovery (a PATH curl shim serving a
# fixture document); the deployment assets come out of the image the
# installer resolved, exactly as they do for an operator (ADR-0019), so no
# external GitHub/registry state can influence the result.
#
# Asserted guarantees (docs/installer-guarantees.md):
#   Part 1 / install.sh #6      unattended pre-provisioning contract
#   Part 1 / install.sh #7      refusal to install into an unsafe target
#   Part 1 / configure.sh #5    symlinked .env-orbit refused
#   Part 1 / configure.sh #9    only digest-pinned ORBIT_IMAGE persisted
#   Part 1 / configuration.sh #2  .env-orbit trusted only at exact mode 600
#   docs/engine-events.md       plain events use documented vocabulary only
#
# With --lifecycle (issue #291), additionally:
#   Part 1 / install.sh #31     hard interruption leaves the target
#                               byte-identical; staging evidence owner-only
#   Part 1 / configure.sh #33, #24; install.sh #19  recognized-deployment
#                               rerun never rotates or rewrites a secret
#   Part 1 / install.sh #13, #21  fresh install refused while another
#                               deployment's database volume exists
#
# Usage:
#   bash scripts/test-install-acceptance.sh [--negative-only] [--red] [--keep] [--lifecycle]
#
#   --negative-only  run only the fast refusal scenarios (no image build)
#   --red            after a green run, deliberately violate an asserted
#                    guarantee and prove the assertions fail (red-run demo)
#   --keep           keep the work directory and containers on exit
#
# Environment:
#   ORBIT_ACCEPTANCE_IMAGE  prebuilt orbit image reference to test; when
#                           unset, the working tree is built locally.
#   COMPOSE_PROJECT_NAME    override the per-run Compose project name derived
#                           below (#894); install.sh honours the same
#                           variable, so an explicit value here reaches it.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
negative_only=0 red_mode=0 keep_mode=0 lifecycle_mode=0
for arg in "$@"; do
  case "$arg" in
    --negative-only) negative_only=1 ;;
    --red) red_mode=1 ;;
    --keep) keep_mode=1 ;;
    --lifecycle) lifecycle_mode=1 ;;
    *) printf 'test-install-acceptance: unknown option %s\n' "$arg" >&2; exit 2 ;;
  esac
done

note() { printf '[acceptance] %s\n' "$*"; }
fail() { printf '[acceptance] FAIL: %s\n' "$*" >&2; exit 1; }

workdir="$(mktemp -d /tmp/orbit-acceptance.XXXXXX)"

free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();});'
}

# #894: project_name, registry_name and both ports used to be the fixed
# literals "orbit-acceptance" / "orbit-acceptance-registry" / 5300 / 3210, so
# two runs on one host -- two worktrees, two sessions, a local run beside a
# CI job -- shared one Compose project and one pair of ports: either run's
# cleanup swept the other's containers and volumes, and a second run could
# not even bind its ports. Derive all four per run instead, the same way
# scripts/test-e2e-local.sh does for the same reason (#875): the project
# name from this checkout's path and this process's PID (so even two runs
# from the same checkout cannot collide), the ports from whatever the kernel
# hands out. An explicit COMPOSE_PROJECT_NAME in the caller's environment
# still wins, same as install.sh itself honours it.
repo_hash="$(printf '%s' "$repo_root" | md5sum | cut -c1-8)"
project_name="${COMPOSE_PROJECT_NAME:-orbit-acceptance-${repo_hash}-$$}"
readonly project_name
registry_name="${project_name}-registry"
registry_port="$(free_port)"
orbit_port="$(free_port)"
while [[ "$orbit_port" == "$registry_port" ]]; do
  orbit_port="$(free_port)"
done
repository="acceptance/orbit"
issuer="https://oidc.acceptance.invalid/application/o/orbit/"
# The target directory name doubles as the Compose project name the
# installer persists (derive_compose_project_name in install.sh falls back
# to the target directory's basename when COMPOSE_PROJECT_NAME is not set),
# so every container/volume/network this script creates carries this run's
# project label and can be swept even after an untrappable SIGKILL left
# debris behind.
target="$workdir/$project_name"
# Slice 4 (#907): the local-only run (local_only_scenario) gets its own
# target directory and its own Compose project name, so the sweep can tell
# the two deployments' debris apart. It still cannot run while the primary
# deployment's database volume exists: install.sh #13/#21 refuse a fresh
# install whenever any `*orbit-db-data` volume is on the host, whatever
# project owns it (the lifecycle run asserts exactly that), so the primary
# deployment is taken down, volumes included, before the local-only install.
local_only_target="$workdir/local-only-deploy"
local_only_project_name="${project_name}-local"

sweep_debris() {
  local sweep_project="${1:-$project_name}"
  docker rm -f "$registry_name" >/dev/null 2>&1 || true
  docker ps -aq --filter label=com.docker.compose.project="$sweep_project" |
    xargs -r docker rm -f >/dev/null 2>&1 || true
  docker volume ls -q --filter label=com.docker.compose.project="$sweep_project" |
    xargs -r docker volume rm >/dev/null 2>&1 || true
  docker network ls -q --filter label=com.docker.compose.project="$sweep_project" |
    xargs -r docker network rm >/dev/null 2>&1 || true
}

cleanup() {
  local status=$?
  if [[ "$keep_mode" == 1 || ( "$status" -ne 0 && -n "${ORBIT_ACCEPTANCE_KEEP_ON_FAIL:-}" ) ]]; then
    note "keeping work directory: $workdir (project $project_name)"
    return
  fi
  if [[ -f "$target/.env-orbit" && -f "$target/docker-compose.yml" ]]; then
    chmod 600 "$target/.env-orbit" 2>/dev/null || true
    (cd "$target" && docker compose --env-file .env-orbit down --volumes --remove-orphans >/dev/null 2>&1) || true
  fi
  if [[ -f "$local_only_target/.env-orbit" && -f "$local_only_target/docker-compose.yml" ]]; then
    chmod 600 "$local_only_target/.env-orbit" 2>/dev/null || true
    (cd "$local_only_target" && docker compose --env-file .env-orbit down --volumes --remove-orphans >/dev/null 2>&1) || true
  fi
  sweep_debris "$project_name"
  sweep_debris "$local_only_project_name"
  rm -rf -- "$workdir"
}
trap cleanup EXIT

# --- negative scenarios (no image, no network, fail-closed refusals) -------

make_preprovisioned_target() {
  rm -rf -- "$target"
  mkdir -p -- "$target/.orbit-secrets"
  chmod 700 "$target/.orbit-secrets"
  printf 'acceptance-client-secret\n' > "$target/.orbit-secrets/oidc-client-secret"
  chmod 600 "$target/.orbit-secrets/oidc-client-secret"
  # APP_URL must be a deployment-ready public HTTPS origin (loopback is a
  # dev-only mode --check refuses); health is still probed via the published
  # loopback port. The secret-file path is the canonical in-container mount.
  {
    printf 'APP_URL=https://orbit.acceptance.invalid\n'
    printf 'ORBIT_PORT=%s\n' "$orbit_port"
    printf 'ORBIT_BIND_ADDRESS=127.0.0.1\n'
    # ADR-0023 section 1: OIDC is opt-in; the sign-in mode has to be named
    # explicitly here too, or a legacy-shaped env file with the OIDC fields
    # merely present (and no ORBIT_AUTH_OIDC key) is read as local-only by
    # both configure.sh --check and install.sh's own discovery gate, and this
    # scenario would stop exercising provider discovery at all.
    printf 'ORBIT_AUTH_OIDC=true\n'
    printf 'OIDC_ISSUER=%s\n' "$issuer"
    printf 'OIDC_CLIENT_ID=orbit-acceptance\n'
    printf 'OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret\n'
    printf 'OIDC_CALLBACK_URL=https://orbit.acceptance.invalid/api/auth/callback\n'
  } > "$target/.env-orbit"
  chmod 600 "$target/.env-orbit"
}

# Slice 4 (#907): the local-only counterpart of make_preprovisioned_target.
# ORBIT_AUTH_OIDC=false and no OIDC_* fields at all -- the guided flow's own
# local-only path (scripts/configure.sh's guided_init) never writes them
# either. The unattended pre-provisioning contract (installer-guarantees.md,
# install.sh guarantee 6) still requires a non-empty oidc-client-secret file
# regardless of sign-in mode, so a harmless unused placeholder goes in it
# (ADR-0023 section 1: switching the provider off never requires deleting its
# configuration -- here there simply is none to begin with).
make_local_only_preprovisioned_target() {
  rm -rf -- "$target"
  mkdir -p -- "$target/.orbit-secrets"
  chmod 700 "$target/.orbit-secrets"
  printf 'unused-placeholder\n' > "$target/.orbit-secrets/oidc-client-secret"
  chmod 600 "$target/.orbit-secrets/oidc-client-secret"
  {
    printf 'APP_URL=https://orbit.acceptance.invalid\n'
    printf 'ORBIT_PORT=%s\n' "$orbit_port"
    printf 'ORBIT_BIND_ADDRESS=127.0.0.1\n'
    printf 'ORBIT_AUTH_OIDC=false\n'
    # JSON so the claim notice (ADR-0022 section 1) is one greppable line;
    # the text form spans three lines with no single unique anchor.
    printf 'ORBIT_LOG_FORMAT=json\n'
  } > "$target/.env-orbit"
  chmod 600 "$target/.env-orbit"
}

run_installer() {
  (cd "$target" && env PATH="$workdir/shim:$PATH" \
    ORBIT_REGISTRY="127.0.0.1:$registry_port" ORBIT_REPOSITORY="$repository" \
    timeout 900 bash "$repo_root/scripts/install.sh" </dev/null) \
    > "$workdir/install.log" 2>&1
}

negative_scenarios() {
  # catalogue Part 1 / configure.sh #5 and install.sh #6: a symlinked
  # .env-orbit in a pre-provisioned target is refused before any deployment.
  make_preprovisioned_target
  mv "$target/.env-orbit" "$target/.env-orbit.real"
  ln -s .env-orbit.real "$target/.env-orbit"
  if run_installer; then fail "installer accepted a symlinked .env-orbit"; fi
  [[ ! -f "$target/docker-compose.yml" ]] ||
    fail "refusal still fetched deployment assets into the target"
  note "negative: symlinked .env-orbit refused (configure.sh #5, install.sh #6)"

  # catalogue Part 1 / install.sh #6: a loosely-permissioned .orbit-secrets
  # directory fails the pre-provisioning contract outright.
  make_preprovisioned_target
  chmod 755 "$target/.orbit-secrets"
  if run_installer; then fail "installer accepted a mode-755 .orbit-secrets"; fi
  [[ ! -f "$target/docker-compose.yml" ]] ||
    fail "refusal still fetched deployment assets into the target"
  note "negative: mode-755 .orbit-secrets refused (install.sh #6)"

  # catalogue Part 1 / install.sh #7: an arbitrary non-empty directory is
  # refused before any pull or download.
  make_preprovisioned_target
  touch "$target/unexpected-file"
  if run_installer; then fail "installer accepted an extraneous target entry"; fi
  note "negative: extraneous target entry refused (install.sh #7)"
}

# --- shims: the one intercepted network path, and the assets-phase gate ----

write_shim() {
  local real_docker
  real_docker="$(command -v docker)" || fail "docker is required"
  [[ "$real_docker" != "$workdir/shim/docker" ]] || fail "the docker shim resolved to itself"
  mkdir -p "$workdir/shim"
  cat > "$workdir/discovery.json" <<EOF
{
  "issuer": "$issuer",
  "authorization_endpoint": "https://oidc.acceptance.invalid/application/o/authorize/",
  "token_endpoint": "https://oidc.acceptance.invalid/application/o/token/",
  "jwks_uri": "https://oidc.acceptance.invalid/application/o/orbit/jwks/",
  "response_types_supported": ["code"],
  "code_challenge_methods_supported": ["S256"],
  "scopes_supported": ["openid", "profile", "email"],
  "id_token_signing_alg_values_supported": ["RS256"]
}
EOF
  cat > "$workdir/shim/curl" <<SHIM
#!/usr/bin/env bash
# Acceptance shim: serves the fixture OIDC discovery document. Deployment
# assets do not come over curl any more (ADR-0019), so every other URL fails
# closed and an unexpected network dependency surfaces as a test failure.
set -Eeuo pipefail
discovery_url="${issuer}.well-known/openid-configuration"
output="" write_out="" url=""
# Real curl refuses an option it does not know with exit 2 and this message,
# and refuses an option given no value with exit 2 as well (curl 8.14.1;
# scripts/tool-parity.test.mjs re-asserts both against the real binary). The
# shim used to ignore every unrecognised flag, so install.sh could have grown
# one curl has never had and this harness would still have gone green -- the
# same class of blindness as the plain 'docker exec -T' that shipped in #607.
refuse_option() {
  printf 'curl: option %s: is unknown\\n' "\$1" >&2
  exit 2
}
require_parameter() {
  printf 'curl: option %s: requires parameter\\n' "\$1" >&2
  exit 2
}
args=("\$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  case "\${args[i]}" in
    --output|-o)
      (( i + 1 < \${#args[@]} )) || require_parameter "\${args[i]}"
      output="\${args[i+1]}"; ((i++)) ;;
    --write-out|-w)
      (( i + 1 < \${#args[@]} )) || require_parameter "\${args[i]}"
      write_out="\${args[i+1]}"; ((i++)) ;;
    --header|-H|--connect-timeout|--max-time|-m|--max-filesize|--proto|--proto-redir|--retry|--resolve)
      (( i + 1 < \${#args[@]} )) || require_parameter "\${args[i]}"
      ((i++)) ;;
    --fail|-f|--silent|-s|--show-error|-S|--location|-L|--tlsv1.2|--tlsv1.3) ;;
    -*) refuse_option "\${args[i]}" ;;
    *) url="\${args[i]}" ;;
  esac
done
serve() {
  [[ -z "\$output" ]] || cp -- "\$1" "\$output"
  [[ -z "\$write_out" ]] || printf '200'
}
case "\$url" in
  "\$discovery_url")
    serve "$workdir/discovery.json"
    ;;
  *)
    # Real curl still writes the --write-out template when the transfer never
    # happened; %{http_code} is 000 with no response, and a host that will not
    # resolve exits 6 (curl 8.14.1; scripts/tool-parity.test.mjs).
    [[ -z "\$write_out" ]] || printf '000'
    exit 6
    ;;
esac
SHIM
  chmod 755 "$workdir/shim/curl"

  cat > "$workdir/shim/docker" <<SHIM
#!/usr/bin/env bash
# Everything reaches the real docker. The single interception is the assets
# gate (issue #677): when the lifecycle interruption scenario arms it, the
# installer's single docker-cp of the bundled deployment assets (ADR-0019)
# parks here — it announces that the installer is inside the assets phase,
# then blocks until the test releases the FIFO. The installer physically
# cannot advance past this call, so the kill point is fixed rather than raced
# against a poll interval.
#
# There is deliberately no argument validation here: every call, including the
# gated one, is handed to the real docker, so this shim cannot be more
# permissive than the tool it stands in front of (#616).
set -Eeuo pipefail
if [[ "\${1:-}" == "cp" && "\$*" == *":/opt/orbit/deploy/."* ]]; then
  if [[ -e "$workdir/assets-gate.armed" && ! -e "$workdir/assets-gate.reached" ]]; then
    : > "$workdir/assets-gate.reached"
    read -r _ < "$workdir/assets-gate.release" || true
  fi
fi
exec "$real_docker" "\$@"
SHIM
  chmod 755 "$workdir/shim/docker"
}

# --- positive scenario -----------------------------------------------------

assert_green() {
  local digest="$1" events
  grep -q 'configuration, OIDC discovery, and Docker Compose preflight passed' "$workdir/install.log" ||
    fail "preflight success line missing from install output"
  grep -q '^phase=complete .*state=completed' "$workdir/install.log" ||
    fail "terminal phase=complete event missing"

  # docs/engine-events.md: every emitted event uses the documented shape and
  # a green run contains no 'unknown' vocabulary fallback.
  events="$(grep -c '^phase=' "$workdir/install.log")" || fail "no plain events emitted"
  grep '^phase=' "$workdir/install.log" |
    grep -vE '^phase=[a-z-]+ component=[a-z-]+ state=[a-z-]+ reason=[a-z-]+ action=[a-z-]+ elapsed=[0-9]+s( simulation=true)?$' &&
    fail "event line outside the documented engine-events format"
  # One grep, not a `| grep -q` pipe: the unknown-fallback line, if any, could
  # sit early in a long log, and under set -e pipefail a first grep killed by
  # SIGPIPE once the second exited would turn 141 into the pipeline's status,
  # skipping this `&&` and passing a run that should fail (issue #809).
  grep -qE '^phase=.*=unknown' "$workdir/install.log" &&
    fail "green run emitted the unknown-vocabulary fallback"

  # catalogue Part 1 / configuration.sh #2: the deployment config is a
  # regular mode-600 file.
  [[ "$(stat -c %a "$target/.env-orbit")" == 600 && ! -L "$target/.env-orbit" ]] ||
    fail ".env-orbit is not a regular mode-600 file"

  # catalogue Part 1 / configure.sh #9: only the digest-pinned identity is
  # persisted, and it is exactly the image this run pushed.
  grep -q "^ORBIT_IMAGE=127.0.0.1:$registry_port/$repository@$digest$" "$target/.env-orbit" ||
    fail "persisted ORBIT_IMAGE is not the exact pushed digest"

  # catalogue Part 1 / install.sh #6: generated secrets stay owner-only.
  [[ "$(stat -c %a "$target/.orbit-secrets")" == 700 ]] ||
    fail ".orbit-secrets is not mode 700"
  # Capture first, test second: `find | grep -q .` races find's continued
  # traversal against grep's exit on the first match (issue #809). `-quit`
  # bounds find to at most one line, so there is nothing left to write once
  # it has printed that line -- the same guard scripts/test-backup-restore.sh
  # already uses at its own find-for-existence check.
  local bad_secret
  bad_secret="$(find "$target/.orbit-secrets" -type f ! -perm 600 -print -quit)"
  [[ -z "$bad_secret" ]] ||
    fail "a generated secret file is not mode 600"

  # Capture first, test second (issue #809): curl can still be streaming the
  # rest of the response when grep -q matches early and exits, which would
  # SIGPIPE curl and turn a healthy body into a 141 instead of a verdict.
  local health_body
  health_body="$(/usr/bin/curl --fail --silent --max-time 5 "http://127.0.0.1:$orbit_port/api/health")" || true
  [[ "$health_body" == *'"status":"ready"'* ]] || fail "/api/health did not report ready"
  note "green: fresh install healthy with $events documented events"
}

positive_scenario() {
  local image revision digest
  revision="$(git -C "$repo_root" rev-parse HEAD)"
  if [[ -n "${ORBIT_ACCEPTANCE_IMAGE:-}" ]]; then
    image="$ORBIT_ACCEPTANCE_IMAGE"
  else
    image="orbit-acceptance-local:$revision"
    note "building working-tree image (this takes several minutes)"
    # The Dockerfile only accepts ci/preview/dev at build time; stable
    # identities are promoted, never built.
    docker build --quiet -t "$image" \
      --build-arg ORBIT_VERSION=v0.0.0 \
      --build-arg ORBIT_REVISION="$revision" \
      --build-arg ORBIT_CHANNEL=ci "$repo_root" >/dev/null ||
      fail "working-tree image build failed"
  fi

  docker rm -f "$registry_name" >/dev/null 2>&1 || true
  docker run -d --name "$registry_name" -p "127.0.0.1:$registry_port:5000" \
    registry:2 >/dev/null || fail "local registry did not start"
  docker tag "$image" "127.0.0.1:$registry_port/$repository:latest"
  docker push --quiet "127.0.0.1:$registry_port/$repository:latest" >/dev/null ||
    fail "push to the local registry failed"
  # grep -m1, not `| head -1` (issue #809): docker inspect's one line can hold
  # more than one digest, and head -1 exiting after the first would SIGPIPE
  # grep while it still had output queued, turning a captured digest into a
  # 141. -m1 makes grep itself the one process that stops once it has enough.
  digest="$(docker inspect --format '{{index .RepoDigests}}' "127.0.0.1:$registry_port/$repository:latest" |
    grep -m1 -oE 'sha256:[0-9a-f]{64}')"
  [[ -n "$digest" ]] || fail "could not capture the pushed digest"

  write_shim
  make_preprovisioned_target

  if [[ "$lifecycle_mode" == 1 ]]; then
    # catalogue Part 1 / install.sh #31: a hard interruption before the
    # commit point leaves the pre-provisioned target byte-identical; any
    # staging evidence stays owner-only.
    cp -- "$target/.env-orbit" "$workdir/env-before-interrupt"
    # The kill point is a rendezvous, not a poll (issue #677). Neither a
    # '^phase=assets' log line nor the staging directory can locate it: UI
    # events are queued (installer_ui_event) until load_installer_ui sources
    # the just-extracted installer-ui.sh, which happens only after the whole
    # bundle is staged and bash -n checked, so the assets "starting" event
    # reaches the log already batched with "completed"; and while the staging
    # directory is mkdir'd first thing in the phase, install.sh reaches its
    # first legitimate in-transaction mutation of .env-orbit
    # (run_configuration_migration) a few hundred milliseconds later. Both
    # made the assertion a race against how promptly this loop noticed —
    # measured at ~300ms of headroom against a 0.2s poll, and lost outright on
    # a runner whose process spawns are cheaper.
    #
    # So the shim's assets gate parks the installer inside the phase instead:
    # the `docker cp` that extracts the bundle touches assets-gate.reached and
    # then blocks reading the release FIFO. Waiting for that marker is still a
    # poll, but
    # it is a poll for a state the installer holds indefinitely, so noticing
    # late costs time rather than correctness. Opening the FIFO read-write
    # here means neither side's open() can block.
    rm -f "$workdir/assets-gate.reached" "$workdir/assets-gate.release"
    mkfifo -m 600 "$workdir/assets-gate.release" ||
      fail "interruption: could not create the assets-gate FIFO"
    local release_fd
    exec {release_fd}<>"$workdir/assets-gate.release"
    : > "$workdir/assets-gate.armed"
    # set -m gives the background job its own process group so the hard kill
    # reaches the whole installer tree and nothing else.
    set -m
    ( cd "$target" && env PATH="$workdir/shim:$PATH" \
        ORBIT_REGISTRY="127.0.0.1:$registry_port" ORBIT_REPOSITORY="$repository" \
        bash "$repo_root/scripts/install.sh" </dev/null ) \
        > "$workdir/install.log" 2>&1 &
    local install_bg=$! waited=0 install_status=0
    set +m
    # The bound only has to cover host checks, the image pull and the banner
    # render before the assets phase begins; a slow runner spends longer there
    # without making the kill point any less exact. An installer that dies
    # first is caught by the liveness check, not by this bound.
    until [[ -e "$workdir/assets-gate.reached" ]]; do
      sleep 0.2; waited=$((waited + 1))
      if [[ "$waited" -ge 600 ]]; then
        # Never abandon a live installer: one left running past this point
        # goes on to create the deployment's database volume, which then
        # fails every later scenario for a reason that has nothing to do
        # with the scenario that leaked it.
        kill -9 -- "-$install_bg" 2>/dev/null || true
        wait "$install_bg" 2>/dev/null || true
        fail "interruption: assets phase never observed"
      fi
      kill -0 "$install_bg" 2>/dev/null || fail "interruption: installer exited before the assets phase"
    done
    kill -9 -- "-$install_bg" 2>/dev/null || true
    wait "$install_bg" 2>/dev/null || install_status=$?
    printf 'go\n' >&"$release_fd"
    exec {release_fd}>&-
    rm -f "$workdir/assets-gate.armed"
    # A scenario that reports success without having interrupted a running
    # installer is worse than one that flakes, so prove the interruption
    # happened: SIGKILL leaves 128+9, and an installer that had already left
    # the assets phase would have exited on its own with a status of its own.
    [[ "$install_status" == 137 ]] ||
      fail "interruption: installer was not killed mid-assets-phase (status $install_status)"
    # `-print -quit`, not a bare `| grep -q .` (issue #809): bounding find to
    # one line of output means it never has a second line queued when grep
    # exits, so it cannot take SIGPIPE and turn a real answer into a 141 --
    # the same reasoning as the existing find check in
    # scripts/test-backup-restore.sh.
    local staging_dir
    staging_dir="$(find "$target" -maxdepth 1 -name '.orbit-install-staging.*' -type d -print -quit)"
    [[ -n "$staging_dir" ]] ||
      fail "interruption: no staging directory, so the assets phase was never entered"
    cmp -s "$workdir/env-before-interrupt" "$target/.env-orbit" ||
      fail "interruption during assets phase mutated .env-orbit"
    local lax_staging_dir
    lax_staging_dir="$(find "$target" -maxdepth 1 -name '.orbit-install-staging*' -type d ! -perm 700 -print -quit)"
    [[ -z "$lax_staging_dir" ]] ||
      fail "interruption left staging evidence that is not owner-only"
    note "lifecycle: hard interruption left the target byte-identical (install.sh #31)"
    # Recovery is the operator's documented step: staging evidence is kept
    # until inspected, then removed before rerunning — validate_target
    # (install.sh #7) deliberately refuses a target containing it.
    rm -rf -- "$target"/.orbit-install-staging.* 2>/dev/null || true
  fi

  note "running unmocked install.sh against 127.0.0.1:$registry_port/$repository"
  run_installer || { tail -20 "$workdir/install.log" >&2; fail "install.sh exited nonzero"; }
  assert_green "$digest"

  if [[ "$lifecycle_mode" == 1 ]]; then
    # catalogue Part 1 / configure.sh #33, #24 and install.sh #19: a
    # recognized-deployment rerun revalidates without rotating any secret.
    local secrets_before secrets_after
    secrets_before="$(cd "$target/.orbit-secrets" && sha256sum ./* | sort)"
    run_installer || { tail -20 "$workdir/install.log" >&2; fail "update rerun exited nonzero"; }
    secrets_after="$(cd "$target/.orbit-secrets" && sha256sum ./* | sort)"
    [[ "$secrets_before" == "$secrets_after" ]] ||
      fail "update rerun changed a secret file"
    assert_green "$digest"
    note "lifecycle: update rerun preserved every secret byte-for-byte (configure.sh #33)"

    # catalogue Part 1 / install.sh #13 and #21: a fresh install is refused
    # while another deployment's database volume exists.
    local first_target="$target"
    target="$workdir/second-deploy"
    make_preprovisioned_target
    if run_installer; then
      target="$first_target"
      fail "fresh install proceeded despite an existing Orbit database volume"
    fi
    target="$first_target"
    note "lifecycle: fresh install refused while a database volume exists (install.sh #13, #21)"
  fi

  if [[ "$red_mode" == 1 ]]; then
    # Red-run demonstration: violate configuration.sh #2 and prove the
    # assertions catch it rather than passing vacuously.
    chmod 644 "$target/.env-orbit"
    if (assert_green "$digest") >/dev/null 2>&1; then
      fail "red run: assertions passed despite a violated guarantee"
    fi
    chmod 600 "$target/.env-orbit"
    note "red: deliberate mode-644 .env-orbit correctly failed the assertions"
  fi
}

# Slice 4 (#907): a fresh, local-only, no-OIDC install (docs/plans/
# m7-local-accounts.md "Slice 4" done-when). Reuses the image
# positive_scenario already built/pushed to the local registry (a plain
# `docker run` container, untouched by the Compose teardown below) -- no
# second build. Runs after, not alongside, the primary OIDC-configured
# deployment: see the header comment on $local_only_target.
local_only_scenario() {
  local first_target="$target" claim_lines=""

  (cd "$first_target" && docker compose --env-file .env-orbit down --volumes --remove-orphans >/dev/null 2>&1) ||
    fail "could not take the primary deployment down before the local-only install"

  write_shim
  target="$local_only_target"
  make_local_only_preprovisioned_target

  note "running unmocked install.sh against a local-only, no-OIDC deployment"
  export COMPOSE_PROJECT_NAME="$local_only_project_name"
  run_installer || { tail -20 "$workdir/install.log" >&2; target="$first_target"; unset COMPOSE_PROJECT_NAME; fail "local-only install.sh exited nonzero"; }
  unset COMPOSE_PROJECT_NAME

  # docs/plans/m7-local-accounts.md Slice 4 done-when: no OIDC trio required,
  # and install.sh's own oidc-discovery phase is skipped rather than
  # contacting a provider (installer-guarantees.md install.sh guarantee 57).
  grep -qE '^phase=oidc component=oidc state=skipped reason=provider-discovery action=skip elapsed=[0-9]+s$' "$workdir/install.log" ||
    fail "local-only run did not skip the OIDC-discovery phase"
  grep -q '^phase=complete .*state=completed' "$workdir/install.log" ||
    fail "local-only run did not reach the terminal phase=complete event"

  grep -q '^ORBIT_AUTH_OIDC=false$' "$target/.env-orbit" ||
    fail "local-only run did not persist ORBIT_AUTH_OIDC=false"
  grep -q '^OIDC_ISSUER=' "$target/.env-orbit" &&
    fail "local-only run wrote an OIDC_ISSUER it was never given"

  # The installer's own output must never carry the claim code (ADR-0022
  # section 1) -- only a pointer to where the operator reads it.
  grep -qi 'bootstrap.claim' "$workdir/install.log" &&
    fail "the installer's own output named the claim event; it must only point at the container log"
  grep -Fq 'Claim this instance: run "docker compose --env-file .env-orbit logs orbit-app"' "$workdir/install.log" ||
    fail "completion screen did not name the claim-notice pointer"

  local health_body
  health_body="$(/usr/bin/curl --fail --silent --max-time 5 "http://127.0.0.1:$orbit_port/api/health")" || true
  [[ "$health_body" == *'"status":"ready"'* ]] || fail "local-only /api/health did not report ready"

  # ADR-0022 section 1: printClaimNotice writes one JSON object per boot
  # while unclaimed ({"event":"bootstrap.claim",...}, ORBIT_LOG_FORMAT=json
  # set above precisely so this is one greppable line). src/lib/auth/
  # bootstrap.ts and its src/server/boot.ts call site are slice 5's own
  # touches (#907's sibling issue) and do not exist in this tree yet, so
  # this assertion is expected to fail until that slice lands -- it is
  # written now, against the ADR's documented line shape, so slice 5 only
  # has to make it pass, not invent it.
  claim_lines="$(cd "$target" && docker compose --env-file .env-orbit logs orbit-app 2>/dev/null |
    grep -c '"event":"bootstrap.claim"' || true)"
  [[ "$claim_lines" == 1 ]] ||
    fail "expected exactly one bootstrap.claim line in the container log, saw ${claim_lines:-0} (awaits slice 5, printClaimNotice)"

  (cd "$target" && docker compose --env-file .env-orbit down --volumes --remove-orphans >/dev/null 2>&1) || true
  target="$first_target"
  note "green: local-only install healthy, no OIDC configured, exactly one claim line, no code in installer output"
}

note "work directory: $workdir"
note "project: $project_name (registry $registry_name on 127.0.0.1:$registry_port, app on 127.0.0.1:$orbit_port)"
sweep_debris

# #894: scripts/test-install-acceptance.test.mjs proves the per-run
# derivation above and the sweep filter that uses it, with a fake `docker`
# on PATH standing in for the daemon -- no install, no network, no
# container. This hook stops right after the one real sweep_debris call
# above (itself a no-op against a fresh fake docker) so the test can inspect
# what it invoked without going anywhere near install.sh.
if [[ -n "${TEST_INSTALL_ACCEPTANCE_DRY_RUN:-}" ]]; then
  note "dry run: exiting after sweep_debris, before any installer run"
  exit 0
fi

negative_scenarios
if [[ "$negative_only" == 1 ]]; then
  note "negative-only run complete"
  exit 0
fi
positive_scenario
local_only_scenario
note "acceptance exemplar complete"
