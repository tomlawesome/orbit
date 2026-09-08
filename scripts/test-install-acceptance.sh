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
registry_port=5300
orbit_port=3210
repository="acceptance/orbit"
issuer="https://oidc.acceptance.invalid/application/o/orbit/"
# --- Per-run isolation: unique Compose project name ------------------------
#
# #894: the target directory's basename doubled as the Compose project name
# (configure.sh's engine_configure_project_name falls back to the basename
# of pwd), and that basename -- and the registry container name next to it
# -- used to be the fixed literal "orbit-acceptance". Two concurrent runs
# then shared one Compose project label and one registry container name, so
# the second run's sweep_debris (below) deleted the first run's still-live
# containers, volumes and networks outright, and its `docker run --name`
# for the registry tore down the first run's registry to reuse the name.
# Derive a per-run name instead, the same way scripts/test-e2e-local.sh does
# for its own Compose project name (#875): a hash of this checkout's path so
# two different worktrees never collide, plus this process's PID so two runs
# from the same worktree cannot collide either.
#
# This does not make two concurrent runs fully independent: install.sh
# itself pins container_name values (orbit, orbit-db, orbit-clamav) rather
# than deriving them from the project name, so a second run's install.sh
# still refuses outright once it reaches Compose, same as before. The point
# of a per-run name is only that the refusal is clean -- the second run
# fails on its own containers/target, not on the first run's -- and that
# neither run's cleanup sweep touches the other's resources.
#
# registry_port and orbit_port stay fixed: a bind conflict on either is a
# plain, non-destructive Docker/Compose error (the second run's `docker run`
# or `docker compose up` refuses to start), not a name-keyed deletion like
# sweep_debris or a same-name `docker run` used to cause. Nothing else in
# this script names a host-level resource (container, volume, network,
# port) from a literal other than the ones above.
worktree_hash="$(printf '%s' "$repo_root" | md5sum | cut -c1-8)"
run_name="orbit-acceptance-${worktree_hash}-$$"
readonly run_name
note "run: $run_name"
registry_name="${run_name}-registry"
# The target directory name doubles as the Compose project name the
# installer persists (via configure.sh's basename-of-pwd fallback), so every
# container/volume/network this script creates carries the run_name project
# label and can be swept even after an untrappable SIGKILL left debris
# behind.
target="$workdir/$run_name"

# scripts/test-install-acceptance.test.mjs (#894): proves run_name/registry_name
# are unique per run and that the sweep filter uses run_name, without a
# Docker daemon. Mirrors TEST_E2E_LOCAL_DRY_RUN in scripts/test-e2e-local.sh
# -- exit before any Docker or network call is made.
if [[ -n "${TEST_INSTALL_ACCEPTANCE_DRY_RUN:-}" ]]; then
  printf 'run_name=%s\n' "$run_name"
  printf 'registry_name=%s\n' "$registry_name"
  printf 'target=%s\n' "$target"
  rm -rf -- "$workdir"
  exit 0
fi

sweep_debris() {
  docker rm -f "$registry_name" >/dev/null 2>&1 || true
  docker ps -aq --filter label=com.docker.compose.project="$run_name" |
    xargs -r docker rm -f >/dev/null 2>&1 || true
  docker volume ls -q --filter label=com.docker.compose.project="$run_name" |
    xargs -r docker volume rm >/dev/null 2>&1 || true
  docker network ls -q --filter label=com.docker.compose.project="$run_name" |
    xargs -r docker network rm >/dev/null 2>&1 || true
}

cleanup() {
  local status=$?
  if [[ "$keep_mode" == 1 || ( "$status" -ne 0 && -n "${ORBIT_ACCEPTANCE_KEEP_ON_FAIL:-}" ) ]]; then
    note "keeping work directory: $workdir"
    return
  fi
  if [[ -f "$target/.env-orbit" && -f "$target/docker-compose.yml" ]]; then
    chmod 600 "$target/.env-orbit" 2>/dev/null || true
    (cd "$target" && docker compose --env-file .env-orbit down --volumes --remove-orphans >/dev/null 2>&1) || true
  fi
  sweep_debris
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
    printf 'OIDC_ISSUER=%s\n' "$issuer"
    printf 'OIDC_CLIENT_ID=orbit-acceptance\n'
    printf 'OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret\n'
    printf 'OIDC_CALLBACK_URL=https://orbit.acceptance.invalid/api/auth/callback\n'
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

note "work directory: $workdir"
sweep_debris
negative_scenarios
if [[ "$negative_only" == 1 ]]; then
  note "negative-only run complete"
  exit 0
fi
positive_scenario
note "acceptance exemplar complete"
