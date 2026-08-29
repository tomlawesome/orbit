#!/usr/bin/env bash
#
# Live evidence for the repair journeys (#532).
#
# scripts/repair.test.mjs proves the repair grammar against a fake docker
# shim: credential rotation never issues a real ALTER ROLE, restart-services
# proves itself with a marker file, and SQLSTATE 28P01 is a canned exit code.
# That is correct unit evidence and it stays. This harness is the other half:
# a real Compose stack, broken for real, recovered by scripts/repair.sh.
#
# The rule this harness lives by: a journey that cannot be run live is
# reported as absent, never approximated. A harness that quietly fakes a
# journey is worse than no harness, because it turns an untested path into a
# green tick. The `absent` list below is printed on every run for exactly
# that reason.
#
# Isolation: the target directory name doubles as the Compose project name
# install.sh persists, so everything this script creates carries the
# orbit-repair-journeys project label and can be swept even after a SIGKILL.
# It never touches a project it did not create.
#
# Usage: scripts/test-repair-journeys.sh [--keep] [--journey <name>] [--list]
#   ORBIT_REPAIR_JOURNEYS_IMAGE=<ref>  use this image instead of building one
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

# Journeys proven live by this script, in the order they run. The order is
# load-bearing: cancelled-repair refuses the very drift that credential-drift
# then repairs, which is what proves the refusal mutated nothing;
# signal-cleanup runs next, while the drift is still unrepaired, because it
# needs a real --execute --dangerous run to interrupt mid-flight, and its own
# contract requires leaving the drift untouched, so credential-drift (which
# repairs it) and idempotent-rerun (which re-runs that completed repair) still
# see exactly the deployment they see today.
readonly journeys=(cancelled-repair signal-cleanup credential-drift idempotent-rerun
                   hostile-value-privacy-negatives)

# Acceptance criteria of #532 with no live evidence yet. Printed on every run
# so the gap is visible in the log rather than implied by a green tick.
readonly absent=(
  "retained-volume-new-target"
  "interrupted-configuration-migration"
  "exact-image-prior-version"
)

keep_mode=0 only_journey="" list_mode=0
while (($#)); do
  case "$1" in
    --keep) keep_mode=1 ;;
    --journey) shift; only_journey="${1:-}"; [[ -n "$only_journey" ]] || { printf 'test-repair-journeys: --journey needs a name\n' >&2; exit 2; } ;;
    --list) list_mode=1 ;;
    *) printf 'test-repair-journeys: unknown option %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

if [[ "$list_mode" == 1 ]]; then
  printf 'live %s\n' "${journeys[@]}"
  printf 'absent %s\n' "${absent[@]}"
  exit 0
fi

workdir="$(mktemp -d /tmp/orbit-repair-journeys.XXXXXX)"
project="orbit-repair-journeys"
target="$workdir/$project"
registry_name="orbit-repair-journeys-registry"
# Deliberately not the install harness's 5300/3210: the two harnesses must be
# able to run at the same time on one machine without fighting over a port.
registry_port=5301
orbit_port=3211
repository="repair-journeys/orbit"
issuer="https://oidc.repair.invalid/application/o/orbit/"
household_id="7f1d6f2c-3b5e-4a71-9d0c-2e8b5a4c1f33"

note() { printf '[repair-journeys] %s\n' "$*"; }
fail() { printf '[repair-journeys] FAIL: %s\n' "$*" >&2; exit 1; }
result_line() { printf 'journey %s result=%s\n' "$1" "$2"; }

sweep_debris() {
  docker rm -f "$registry_name" >/dev/null 2>&1 || true
  docker ps -aq --filter "label=com.docker.compose.project=$project" |
    xargs -r docker rm -f >/dev/null 2>&1 || true
  docker volume ls -q --filter "label=com.docker.compose.project=$project" |
    xargs -r docker volume rm >/dev/null 2>&1 || true
  docker network ls -q --filter "label=com.docker.compose.project=$project" |
    xargs -r docker network rm >/dev/null 2>&1 || true
}

cleanup() {
  local status=$?
  if [[ "$keep_mode" == 1 || ( "$status" -ne 0 && -n "${ORBIT_REPAIR_JOURNEYS_KEEP_ON_FAIL:-}" ) ]]; then
    note "keeping work directory: $target"
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

command -v docker >/dev/null 2>&1 || fail 'Docker is required.'
command -v curl >/dev/null 2>&1 || fail 'curl is required.'

# --- the deployment under test -------------------------------------------

# install.sh fetches its assets over the network and pulls its image from a
# registry, so a live journey needs both served locally: a curl shim for the
# working-tree assets and the fixture OIDC discovery document, and a throwaway
# registry for the image. This mirrors scripts/test-install-acceptance.sh
# rather than sharing code with it -- the two harnesses set up opposite states
# (that one a good deployment, this one a broken one) and coupling them would
# make each harder to read.
write_shim() {
  local revision="$1"
  mkdir -p "$workdir/shim"
  cat > "$workdir/discovery.json" <<EOF
{
  "issuer": "$issuer",
  "authorization_endpoint": "https://oidc.repair.invalid/application/o/authorize/",
  "token_endpoint": "https://oidc.repair.invalid/application/o/token/",
  "jwks_uri": "https://oidc.repair.invalid/application/o/orbit/jwks/",
  "response_types_supported": ["code"],
  "code_challenge_methods_supported": ["S256"],
  "scopes_supported": ["openid", "profile", "email"],
  "id_token_signing_alg_values_supported": ["RS256"]
}
EOF
  cat > "$workdir/shim/curl" <<SHIM
#!/usr/bin/env bash
# Serves working-tree assets and the fixture discovery document; every other
# URL fails closed, so an unexpected network dependency surfaces as a failure
# rather than as a silent fetch from the internet.
set -Eeuo pipefail
# Any revision, not just this checkout's HEAD: install.sh fetches the
# revision stamped into the image it pulled, which differs from HEAD whenever
# a prebuilt image is supplied. The working tree is the answer either way.
asset_prefix="https://raw.githubusercontent.com/$repository/"
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
  "\$asset_prefix"*)
    asset="\${url#"\$asset_prefix"}"
    asset="\${asset#*/}"
    [[ -f "$repo_root/\$asset" ]] || { [[ -z "\$write_out" ]] || printf '404'; exit 0; }
    serve "$repo_root/\$asset"
    ;;
  "\$discovery_url") serve "$workdir/discovery.json" ;;
  *) [[ -z "\$write_out" ]] || printf '000'; exit 6 ;;
esac
SHIM
  chmod 755 "$workdir/shim/curl"
}

make_target() {
  rm -rf -- "$target"
  mkdir -p -- "$target/.orbit-secrets"
  chmod 700 "$target/.orbit-secrets"
  printf 'repair-journeys-client-secret\n' > "$target/.orbit-secrets/oidc-client-secret"
  chmod 600 "$target/.orbit-secrets/oidc-client-secret"
  {
    printf 'APP_URL=https://orbit.repair.invalid\n'
    printf 'ORBIT_PORT=%s\n' "$orbit_port"
    printf 'ORBIT_BIND_ADDRESS=127.0.0.1\n'
    printf 'OIDC_ISSUER=%s\n' "$issuer"
    printf 'OIDC_CLIENT_ID=orbit-repair-journeys\n'
    printf 'OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret\n'
    printf 'OIDC_CALLBACK_URL=https://orbit.repair.invalid/api/auth/callback\n'
  } > "$target/.env-orbit"
  chmod 600 "$target/.env-orbit"
}

install_deployment() {
  local image revision
  revision="$(git -C "$repo_root" rev-parse HEAD)"
  if [[ -n "${ORBIT_REPAIR_JOURNEYS_IMAGE:-}" ]]; then
    image="$ORBIT_REPAIR_JOURNEYS_IMAGE"
  else
    image="orbit-repair-journeys-local:$revision"
    note 'building working-tree image (this takes several minutes)'
    docker build --quiet -t "$image" \
      --build-arg ORBIT_VERSION=v0.0.0 \
      --build-arg ORBIT_REVISION="$revision" \
      --build-arg ORBIT_CHANNEL=ci "$repo_root" >/dev/null ||
      fail 'working-tree image build failed'
  fi

  docker rm -f "$registry_name" >/dev/null 2>&1 || true
  docker run -d --name "$registry_name" -p "127.0.0.1:$registry_port:5000" registry:2 >/dev/null ||
    fail 'local registry did not start'
  docker tag "$image" "127.0.0.1:$registry_port/$repository:latest"
  docker push --quiet "127.0.0.1:$registry_port/$repository:latest" >/dev/null ||
    fail 'push to the local registry failed'

  write_shim "$revision"
  make_target

  note 'installing the deployment under test'
  (cd "$target" && env PATH="$workdir/shim:$PATH" \
      ORBIT_REGISTRY="127.0.0.1:$registry_port" ORBIT_REPOSITORY="$repository" \
      bash "$repo_root/scripts/install.sh" </dev/null) > "$workdir/install.log" 2>&1 ||
    { sed -n '$p' "$workdir/install.log" >&2; fail "install.sh failed; log: $workdir/install.log"; }

  # Confirm the isolation claim rather than trusting it: a stray
  # COMPOSE_PROJECT_NAME would otherwise attach this run to somebody else's
  # stack, and the teardown below removes volumes (AGENTS.md, compose trap).
  # The container name is the fixed pin from docker-compose.yml, not a
  # project-prefixed one, which is also why refuse_foreign_stack runs first.
  local owner
  owner="$(docker inspect orbit-postgres --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
  [[ "$owner" == "$project" ]] ||
    fail "the stack is not owned by $project (got '${owner:-none}'); refusing to continue"
}

# docker-compose.yml pins fixed container names (orbit, orbit-postgres, ...),
# so only one Orbit stack can exist on a machine at a time whatever project it
# belongs to (#536). Running anyway would either fail halfway or, worse, leave
# this script's teardown pointing `down --volumes` at a stack it did not
# create. Refuse instead, and say whose it is.
refuse_foreign_stack() {
  local existing owner
  for existing in orbit orbit-postgres; do
    owner="$(docker inspect "$existing" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
    [[ -n "$owner" ]] || continue
    [[ "$owner" == "$project" ]] &&
      fail "a previous $project run left '$existing' behind; remove it and retry"
    fail "container '$existing' already exists, owned by Compose project '$owner'. Only one Orbit stack can run at a time; stop that one first."
  done
}

compose() { (cd "$target" && docker compose --env-file .env-orbit "$@"); }

health_check() { curl --fail --silent --max-time 5 "http://127.0.0.1:$orbit_port/api/health" | grep -q '"status":"ready"'; }

wait_for_health() {
  local deadline=$((SECONDS + 90))
  until health_check; do
    ((SECONDS < deadline)) || fail 'the deployment did not become healthy within 90s'
    sleep 2
  done
}

wait_for_unhealthy() {
  local deadline=$((SECONDS + 90))
  while health_check; do
    ((SECONDS < deadline)) || fail 'the deployment stayed healthy after its credential drifted'
    sleep 2
  done
}

# The copy install.sh placed in the deployment, never the one in this
# checkout: repair.sh resolves the deployment it operates on from its own
# location (scripts/repair.sh:1263), not from the working directory, so the
# repo's copy would diagnose the developer's own checkout and report findings
# that have nothing to do with the target. It is the same code either way --
# the shim serves the target its assets from this working tree.
repair() { (cd "$target" && env ORBIT_REPAIR_PROMPTS=machine bash "$target/scripts/repair.sh" "$@"); }

# A freshly installed deployment must be healthy by repair's own diagnosis
# before anything is broken on purpose. Without this, a harness failure two
# steps later reads as "repair got it wrong" when the truth may be that the
# deployment was never clean.
assert_baseline_healthy() {
  local status=0 output
  output="$(repair --check 2>&1)" || status=$?
  [[ "$status" == 0 ]] || {
    printf '%s\n' "$output" >&2
    fail "the freshly installed deployment is not healthy by repair --check (exit $status)"
  }
}

# --- fixture data, written under the original password --------------------

seed_household() {
  compose exec -T orbit-db sh -c \
    'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --set=ON_ERROR_STOP=1 --command="
      delete from households where id = '\''$1'\'';
      insert into households (id, name, timezone, default_currency, setup_completed)
        values ('\''$1'\'', '\''repair-journeys-household'\'', '\''Europe/London'\'', '\''GBP'\'', true);"' \
    sh "$household_id" >/dev/null || fail 'could not seed the household fixture'
}

household_name() {
  compose exec -T orbit-db sh -c \
    'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --tuples-only --no-align --command="
      select name from households where id = '\''$1'\'';"' \
    sh "$household_id" | tr -d '\r' | tail -1
}

# A manifest of everything repair is allowed to touch: path, mode, and content
# hash of every managed file, so "byte-identical" is asserted rather than
# eyeballed.
deployment_manifest() {
  (cd "$target" && find . -path ./node_modules -prune -o -type f -print |
    LC_ALL=C sort |
    while read -r path; do
      printf '%s %s %s\n' "$path" "$(stat -c '%a' "$path")" "$(sha256sum "$path" | awk '{print $1}')"
    done)
}

# --- the drift every journey below is built on ----------------------------

drift_the_credential() {
  # Real drift, not a simulated one: the database volume keeps the password it
  # was initialised with, and only the Orbit side moves. This is what an
  # operator produces by restoring a secrets directory over a retained volume.
  #
  # The write REPLACES the file rather than truncating it, because that is what
  # a restore actually does -- `tar -x`, `rsync` and `mv` all leave a new inode
  # at the path, and a Compose `file:` secret is a bind mount of an inode. An
  # in-place `>` keeps every running container in step and so cannot exercise
  # the stale-mount path at all, which is exactly why this harness missed #629
  # on its first run. Only orbit-app is restarted afterwards, deliberately: the
  # database container carries on with the file it started with, as it would
  # for an operator who restored secrets without stopping the stack.
  local staged="$target/.orbit-secrets/.drift.XXXXXX"
  staged="$(mktemp "$target/.orbit-secrets/.drift.XXXXXX")"
  printf 'drifted-password-%s\n' "$RANDOM" > "$staged"
  chmod 600 "$staged"
  mv -- "$staged" "$target/.orbit-secrets/postgres-password"
  compose restart orbit-app >/dev/null 2>&1 || true
  wait_for_unhealthy
}

# --- journeys -------------------------------------------------------------

journey_cancelled_repair() {
  local before after
  before="$(deployment_manifest)"

  # Three attempts at the typed action word, all wrong, then the batch is
  # refused: exit 6, reason=refused-by-operator, and nothing mutated.
  local output status=0
  output="$(printf 'not-the-word\nnot-the-word\nnot-the-word\n' | repair --execute --dangerous 2>&1)" || status=$?

  [[ "$status" == 6 ]] || fail "a refused dangerous batch exited $status, expected 6"
  grep -q 'prompt-abort field=action-word' <<<"$output" ||
    fail 'a refused dangerous batch did not abort the action-word prompt'
  grep -q 'dangerous result=refused .*reason=refused-by-operator' <<<"$output" ||
    fail 'a refused dangerous batch did not report reason=refused-by-operator'

  after="$(deployment_manifest)"
  [[ "$before" == "$after" ]] || {
    diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") >&2 || true
    fail 'a cancelled repair changed the deployment'
  }
  health_check && fail 'a cancelled repair silently fixed the drift'
  result_line cancelled-repair pass
}

# Proves the EXIT trap documented above scripts/repair.sh's cleanup()
# (~line 1266): a real --execute run, interrupted while it holds a private
# mode-700 copy of live secrets, removes that copy and is never silent.
#
# An earlier version of this journey interrupted the credential rotation and
# asserted no `.orbit-repair-recovery.*` was left behind. It passed -- and it
# passed just as happily with cleanup_recovery_dir deliberately removed from
# repair.sh, because on that path no recovery directory is ever created:
# ensure_recovery_dir is called only by do_restore_transaction (repair.sh:2692)
# and do_restore_configuration_rollback (:2794). The assertion searched for
# something that never existed. So this journey seeds the finding that does
# open one.
#
# The fixture is a leftover installer staging directory, which is
# staging-evidence-present -> restore-transaction. It must satisfy every
# precondition do_restore_transaction re-verifies (real non-symlink dirs,
# rollback and rollback/original both mode 700) and must NOT carry the
# `committed` marker, which repair.sh refuses on sight. The staged backup of
# .env-orbit is byte-identical to the live file, so if the restore does get
# partway before the signal lands it is a no-op on content.
#
# The run is --execute --safe-only, so the credential rotation is not selected
# at all and the drift survives untouched for credential-drift and
# idempotent-rerun.
#
# The interrupt is landed on the recovery directory's own existence rather
# than on a log line: poll until `.orbit-repair-recovery.*` is really there,
# then signal. That makes the precondition the trigger, so this journey can
# never again assert the absence of something that was never created.
#
# `exec` inside the backgrounded subshell replaces its own process image with
# repair.sh, so $! is repair.sh's real PID and the signal lands on the process
# that owns the trap, not on a throwaway parent shell.
journey_signal_cleanup() {
  local before after out infile staging pid status=0 found=0 leftover

  before="$(deployment_manifest)"

  staging="$(mktemp -d "$target/.orbit-install-staging.XXXXXX")"
  chmod 700 -- "$staging"
  mkdir -p -- "$staging/rollback/original"
  chmod 700 -- "$staging/rollback" "$staging/rollback/original"
  cp -a -- "$target/.env-orbit" "$staging/rollback/original/.env-orbit"

  out="$workdir/signal-cleanup.out"
  infile="$workdir/signal-cleanup.in"
  : > "$out"
  # --safe-only, not --dangerous: repair.sh's flags are selectors, not
  # modifiers (its usage at :1188), so --dangerous alone selects stage two
  # and would skip restore-transaction entirely -- which is the only action
  # here that opens a recovery directory. `y` approves the safe batch
  # (confirm_safe_batch, machine prompts). The credential drift is left
  # untouched by this invocation, so the journeys after this one are
  # unaffected by construction rather than by luck of the class order.
  printf 'y\n' > "$infile"

  (
    cd "$target"
    exec env ORBIT_REPAIR_PROMPTS=machine bash "$target/scripts/repair.sh" --execute --safe-only
  ) <"$infile" >"$out" 2>&1 &
  pid=$!

  local deadline=$((SECONDS + 60))
  while :; do
    if compgen -G "$target/.orbit-repair-recovery.*" >/dev/null 2>&1; then found=1; break; fi
    kill -0 "$pid" 2>/dev/null || break
    ((SECONDS < deadline)) || break
    sleep 0.005
  done

  if [[ "$found" != 1 ]]; then
    wait "$pid" 2>/dev/null || true
    rm -rf -- "$staging"
    cat "$out" >&2
    fail 'signal-cleanup: never observed a private recovery directory to interrupt'
  fi

  kill -TERM "$pid" 2>/dev/null || true
  # `wait` reports the signalled child's 128+15, and this script runs under
  # `set -e`: an unguarded `wait` here kills the harness itself with 143
  # instead of the journey observing the interruption it just caused.
  status=0
  wait "$pid" 2>/dev/null || status=$?
  [[ "$status" != 0 ]] || fail 'an interrupted repair exited 0'

  # The contract, and the assertion that now genuinely fails when the trap
  # stops removing the recovery copy.
  leftover="$(find "$target" -maxdepth 1 -name '.orbit-repair-recovery.*' -print 2>/dev/null)"
  [[ -z "$leftover" ]] ||
    fail "signal-cleanup: an interrupted repair orphaned a private recovery copy: $leftover"

  grep -q 'interrupted before completion' "$out" ||
    { cat "$out" >&2; fail 'signal-cleanup: the interrupted run printed no recovery guidance'; }

  # Teardown: the seeded staging directory is this journey's own fixture, and
  # repair.sh deliberately leaves it in place for a retry. Remove it so the
  # journeys after this one see the deployment they expect.
  rm -rf -- "$staging"
  find "$target" -maxdepth 1 -name '.orbit-install-staging.*' -exec rm -rf -- {} + 2>/dev/null || true

  after="$(deployment_manifest)"
  [[ "$before" == "$after" ]] || {
    diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") >&2 || true
    fail 'an interrupted repair left the deployment changed'
  }

  [[ "$(household_name)" == 'repair-journeys-household' ]] ||
    fail 'an interrupted repair disturbed the fixture data'
  health_check && fail 'an interrupted repair silently fixed the drift'
  result_line signal-cleanup pass
}

journey_credential_drift() {
  local output status=0
  output="$(repair --check 2>&1)" || status=$?
  [[ "$status" == 4 ]] || fail "--check on a drifted credential exited $status, expected 4"
  grep -q 'finding class=database-credential-mismatch' <<<"$output" ||
    fail '--check did not report database-credential-mismatch'

  status=0
  output="$(printf 'rotate\nrepair-journeys-passphrase\nrepair-journeys-passphrase\n' |
    repair --execute --dangerous 2>&1)" || status=$?
  [[ "$status" == 0 ]] || {
    printf '%s\n' "$output" >&2
    fail "the dangerous batch exited $status, expected 0"
  }
  grep -q 'execute action=rotate-database-credential .*result=done' <<<"$output" ||
    fail 'rotate-database-credential did not report result=done'
  grep -q 'dangerous result=complete' <<<"$output" ||
    fail 'the dangerous batch did not complete'

  # Authentication works again...
  wait_for_health
  status=0
  repair --check >/dev/null 2>&1 || status=$?
  [[ "$status" == 0 ]] || fail "--check after rotation exited $status, expected 0 (healthy)"

  # ...and the data written under the original password is still there, which
  # is the half a rotation could destroy and a marker file could never prove.
  [[ "$(household_name)" == 'repair-journeys-household' ]] ||
    fail 'the fixture written under the original password did not survive rotation'
  result_line credential-drift pass
}

journey_idempotent_rerun() {
  local output status=0
  output="$(printf 'rotate\nrepair-journeys-passphrase\nrepair-journeys-passphrase\n' |
    repair --execute --dangerous 2>&1)" || status=$?
  [[ "$status" == 0 ]] || {
    printf '%s\n' "$output" >&2
    fail "re-running a completed repair exited $status, expected 0"
  }
  grep -q 'dangerous result=empty' <<<"$output" ||
    fail 're-running a completed repair found work to do'
  health_check || fail 're-running a completed repair left the deployment unhealthy'
  [[ "$(household_name)" == 'repair-journeys-household' ]] ||
    fail 're-running a completed repair disturbed the fixture data'
  result_line idempotent-rerun pass
}

# Proves the "Privacy" contract above scripts/repair.sh:765 against values an
# attacker chooses: hostile configuration, filenames and container labels
# never reach output.
#
# An absence assertion is worthless unless the hostile value was actually
# handled, so each of the three vectors is paired with the finding class that
# only fires if repair.sh really did read it. If a class is missing the
# journey fails rather than quietly asserting nothing:
#
#   filename       .orbit-install-staging.<canary>/  -> staging-evidence-present
#   configuration  ORBIT_PORT=<canary> in .env-orbit -> compose-interpolation-failed
#   container      a container labelled into this project with a hostile
#                  compose service label            -> container-foreign-owner
#
# The configuration vector was written expecting configuration-invalid and
# observed compose-interpolation-failed: a non-numeric port breaks Compose's
# own interpolation before configure.sh --check is ever reached. That is the
# sharper vector of the two, because `docker compose config` quotes the
# offending value back in its error text and repair.sh captures that stderr
# wholesale. The contract says none of it may be reprinted.
journey_hostile_value_privacy_negatives() {
  local canary before after output status=0 missing=()
  canary="h0stile-$RANDOM-$$-canary"
  before="$(deployment_manifest)"

  local staging="$target/.orbit-install-staging.$canary"
  mkdir -p -- "$staging/rollback/original"
  chmod 700 -- "$staging" "$staging/rollback" "$staging/rollback/original"

  cp -a -- "$target/.env-orbit" "$workdir/env-orbit.orig"
  printf 'ORBIT_PORT=%s\n' "$canary" >> "$target/.env-orbit"

  docker run -d --name "orbit-journeys-$canary" \
    --label "com.docker.compose.project=$project" \
    --label "com.docker.compose.service=$canary" \
    --label "com.docker.compose.container-number=1" \
    busybox:stable sleep 600 >/dev/null 2>&1 ||
    fail 'hostile-value: could not start the labelled container vector'

  output="$(repair --check 2>&1)" || status=$?

  # Each vector must have been processed, or its absence from the output
  # proves nothing about privacy.
  grep -q 'finding class=staging-evidence-present' <<<"$output" || missing+=(staging-evidence-present)
  grep -q 'finding class=compose-interpolation-failed' <<<"$output" || missing+=(compose-interpolation-failed)
  grep -q 'finding class=container-foreign-owner' <<<"$output" || missing+=(container-foreign-owner)

  local leaked=0
  grep -q -- "$canary" <<<"$output" && leaked=1

  # Teardown before any assertion can exit, so a failure here never strands
  # the shared deployment for the journeys that follow.
  docker rm -f "orbit-journeys-$canary" >/dev/null 2>&1 || true
  rm -rf -- "$staging"
  cp -a -- "$workdir/env-orbit.orig" "$target/.env-orbit"

  if [[ ${#missing[@]} -gt 0 ]]; then
    printf '%s\n' "$output" >&2
    fail "hostile-value: repair never reported ${missing[*]}, so the vector was not exercised"
  fi
  if [[ "$leaked" == 1 ]]; then
    grep -n -- "$canary" <<<"$output" >&2 || true
    fail 'hostile-value: an operator-chosen value reached repair output'
  fi

  after="$(deployment_manifest)"
  [[ "$before" == "$after" ]] || {
    diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") >&2 || true
    fail 'hostile-value: the journey did not restore the deployment it borrowed'
  }
  result_line hostile-value-privacy-negatives pass
}

# --- run ------------------------------------------------------------------

refuse_foreign_stack
install_deployment
wait_for_health
assert_baseline_healthy
note 'the freshly installed deployment diagnoses healthy'
seed_household
note 'seeded fixture data under the original database password'
drift_the_credential
note 'the database volume keeps password A; the Orbit side now holds password B'

ran=0
for journey in "${journeys[@]}"; do
  if [[ -n "$only_journey" && "$only_journey" != "$journey" ]]; then continue; fi
  note "journey: $journey"
  "journey_${journey//-/_}"
  ran=$((ran + 1))
done

if [[ -n "$only_journey" && "$ran" == 0 ]]; then
  fail "no such journey: $only_journey (see --list)"
fi

for missing in "${absent[@]}"; do
  result_line "$missing" absent
done
note "journeys run=$ran absent=${#absent[@]}"
