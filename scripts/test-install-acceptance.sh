#!/usr/bin/env bash
# Real-container fresh-install acceptance exemplar (issue #289).
#
# Runs the working tree's install.sh unmocked — real Docker, real Compose,
# real PostgreSQL and ClamAV, real health checks — from a clean
# pre-provisioned directory to a healthy /api/health, then asserts
# operator-facing guarantees from docs/installer-guarantees.md. Only the two
# network fetch paths are intercepted (a PATH curl shim serving working-tree
# deployment assets and a fixture OIDC discovery document), so no external
# GitHub/registry state can influence the result.
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

workdir="$(mktemp -d /tmp/orbit-acceptance.XXXXXX)"
registry_name="orbit-acceptance-registry"
registry_port=5300
orbit_port=3210
repository="acceptance/orbit"
issuer="https://oidc.acceptance.invalid/application/o/orbit/"
# The target directory name doubles as the Compose project name the
# installer persists, so every container/volume/network this script creates
# carries the orbit-acceptance project label and can be swept even after an
# untrappable SIGKILL left debris behind.
target="$workdir/orbit-acceptance"

sweep_debris() {
  docker rm -f "$registry_name" >/dev/null 2>&1 || true
  docker ps -aq --filter label=com.docker.compose.project=orbit-acceptance |
    xargs -r docker rm -f >/dev/null 2>&1 || true
  docker volume ls -q --filter label=com.docker.compose.project=orbit-acceptance |
    xargs -r docker volume rm >/dev/null 2>&1 || true
  docker network ls -q --filter label=com.docker.compose.project=orbit-acceptance |
    xargs -r docker network rm >/dev/null 2>&1 || true
}

note() { printf '[acceptance] %s\n' "$*"; }
fail() { printf '[acceptance] FAIL: %s\n' "$*" >&2; exit 1; }

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

# --- shim: the only two intercepted network paths --------------------------

write_shim() {
  local revision="$1"
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
# Acceptance shim: serves working-tree deployment assets and the fixture
# OIDC discovery document; every other URL fails closed so an unexpected
# network dependency surfaces as a test failure.
set -Eeuo pipefail
asset_base="https://raw.githubusercontent.com/$repository/$revision"
discovery_url="${issuer}.well-known/openid-configuration"
output="" write_out="" url=""
args=("\$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  case "\${args[i]}" in
    --output) output="\${args[i+1]}"; ((i++)) ;;
    --write-out) write_out="\${args[i+1]}"; ((i++)) ;;
    --header|--connect-timeout|--max-time|--max-filesize|--proto|--proto-redir) ((i++)) ;;
    --*|-*) ;;
    *) url="\${args[i]}" ;;
  esac
done
serve() {
  [[ -z "\$output" ]] || cp -- "\$1" "\$output"
  [[ -z "\$write_out" ]] || printf '200'
}
case "\$url" in
  "\$asset_base"/*)
    asset="\${url#"\$asset_base"/}"
    [[ -f "$repo_root/\$asset" ]] || exit 22
    serve "$repo_root/\$asset"
    ;;
  "\$discovery_url")
    serve "$workdir/discovery.json"
    ;;
  *)
    exit 6
    ;;
esac
SHIM
  chmod 755 "$workdir/shim/curl"
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
  grep '^phase=' "$workdir/install.log" | grep -q '=unknown' &&
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
  find "$target/.orbit-secrets" -type f ! -perm 600 | grep -q . &&
    fail "a generated secret file is not mode 600"

  /usr/bin/curl --fail --silent --max-time 5 "http://127.0.0.1:$orbit_port/api/health" |
    grep -q '"status":"ready"' || fail "/api/health did not report ready"
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
  digest="$(docker inspect --format '{{index .RepoDigests}}' "127.0.0.1:$registry_port/$repository:latest" |
    grep -oE 'sha256:[0-9a-f]{64}' | head -1)"
  [[ -n "$digest" ]] || fail "could not capture the pushed digest"

  write_shim "$revision"
  make_preprovisioned_target

  if [[ "$lifecycle_mode" == 1 ]]; then
    # catalogue Part 1 / install.sh #31: a hard interruption before the
    # commit point leaves the pre-provisioned target byte-identical; any
    # staging evidence stays owner-only.
    cp -- "$target/.env-orbit" "$workdir/env-before-interrupt"
    # set -m gives the background job its own process group so the hard kill
    # reaches the whole installer tree and nothing else.
    set -m
    ( cd "$target" && env PATH="$workdir/shim:$PATH" \
        ORBIT_REGISTRY="127.0.0.1:$registry_port" ORBIT_REPOSITORY="$repository" \
        bash "$repo_root/scripts/install.sh" </dev/null ) \
        > "$workdir/install.log" 2>&1 &
    local install_bg=$! waited=0
    set +m
    # Wait for the staging directory itself rather than a '^phase=assets' log
    # line: install.sh's UI events are queued (installer_ui_event) until
    # load_installer_ui sources the just-fetched installer-ui.sh, which does
    # not happen until *after* every asset has been fetched and bash -n
    # checked (install.sh:1395-1421). So the "starting" event for the assets
    # phase is only ever written to the log already-batched with "completed"
    # right as the phase ends — grepping for it can never catch install.sh
    # mid-fetch, only after the whole phase (and everything gated on the log
    # line) has already finished. staging_dir is mkdir'd as the very first
    # step of the phase (install.sh:1398), before any asset is fetched, so
    # its appearance on disk is a real-time signal of "assets phase begun."
    until find "$target" -maxdepth 1 -name '.orbit-install-staging.*' -type d 2>/dev/null |
      grep -q .; do
      sleep 0.2; waited=$((waited + 1))
      [[ "$waited" -lt 300 ]] || fail "interruption: assets phase never observed"
      kill -0 "$install_bg" 2>/dev/null || fail "interruption: installer exited before the assets phase"
    done
    kill -9 -- "-$install_bg" 2>/dev/null || true
    wait "$install_bg" 2>/dev/null || true
    cmp -s "$workdir/env-before-interrupt" "$target/.env-orbit" ||
      fail "interruption during assets phase mutated .env-orbit"
    find "$target" -maxdepth 1 -name '.orbit-install-staging*' -type d ! -perm 700 | grep -q . &&
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
