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
# see exactly the deployment they see today. The last five (#681) each start
# from, and hand back, the healthy repaired deployment, so their internal
# order is free.
readonly journeys=(cancelled-repair signal-cleanup credential-drift idempotent-rerun
                   hostile-value-privacy-negatives retained-volume-new-target
                   interrupted-configuration-migration
                   unsafe-permissions missing-files failed-db-migration
                   unhealthy-app successful-rollback)

# Acceptance criteria of #532 with no live evidence yet. Printed on every run
# so the gap is visible in the log rather than implied by a green tick.
readonly absent=(
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
# The signal deliberately lands inside the creation window, every run. The
# poll notices the directory the moment it exists on disk, which can be
# before repair.sh itself knows its name: the shape #655 caught on CI was
# recovery_dir="$(mktemp -d ...)" killed after mktemp's mkdir but before the
# assignment, leaving the EXIT trap holding an empty variable and the copy
# orphaned. That window is microseconds wide, so CI hit it once in many
# runs. The PATH shims below stretch whichever command creates the directory
# (mktemp for the old shape, mkdir for the current assign-first shape) by
# 300ms after creation, so the TERM sent on first sight of the directory
# arrives while creation is still in flight — the worst legal moment, made
# deterministic. A regression to name-after-creation fails this journey
# every run instead of one run in hundreds.
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

  # Window-stretching shims — see the journey comment above. Absolute paths
  # inside, because the shim directory itself is on PATH.
  local shimdir
  shimdir="$workdir/signal-cleanup-shims"
  mkdir -p -- "$shimdir"
  cat > "$shimdir/mktemp" <<'SHIM'
#!/usr/bin/env bash
created="$(/usr/bin/mktemp "$@")" || exit
printf '%s\n' "$created"
sleep 0.3
SHIM
  cat > "$shimdir/mkdir" <<'SHIM'
#!/usr/bin/env bash
/bin/mkdir "$@"; rc=$?
sleep 0.3
exit "$rc"
SHIM
  chmod 755 -- "$shimdir/mktemp" "$shimdir/mkdir"

  (
    cd "$target"
    exec env ORBIT_REPAIR_PROMPTS=machine PATH="$shimdir:$PATH" \
      bash "$target/scripts/repair.sh" --execute --safe-only
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

# Proves the #261 fixed-project collision guard: a retained database volume
# paired with a NEW target directory must never have a fresh password minted
# against it.
#
# This is the failure that motivated repair mode in the first place. An
# operator points a new install at a directory whose named volume survived
# (`docker compose down` without `--volumes`, a moved checkout, a restored
# host). The volume still holds the OLD role's password hash. The obvious
# automatic fix -- "the secret file is missing, mint one" -- produces a
# SECOND broken credential and buries the original failure under a new one.
# repair.sh routes that specific secret-missing to rotate-database-credential
# instead, and routes a retained document volume to `manual`, because a new
# document key would make retained documents permanently unreadable
# (repair.sh's EXCEPTION 1 and EXCEPTION 2, ADR-0014 decision 5).
#
# The journey is read-only by construction: only --check and --plan run
# against the new target, never --execute. That matters twice over -- it is
# what the guard is about, and it means this journey cannot disturb the live
# deployment whose volume it borrows.
#
# The new target deliberately carries the SAME COMPOSE_PROJECT_NAME, because
# the collision only exists when the retained volume belongs to the project
# the new directory names. `${project}_orbit-db-data` is the exact volume
# repair.sh looks for (repair.sh:2115).
journey_retained_volume_new_target() {
  local newtarget output status=0 plan before
  before="$(deployment_manifest)"
  newtarget="$workdir/new-target"
  rm -rf -- "$newtarget"
  mkdir -p -- "$newtarget/scripts"

  cp -a -- "$target/.env-orbit" "$newtarget/.env-orbit"
  cp -a -- "$target/docker-compose.yml" "$newtarget/docker-compose.yml"
  cp -a -- "$target/scripts/repair.sh" "$newtarget/scripts/repair.sh"
  for helper in configuration.sh recovery-crypto.mjs release-metadata-patterns.sh; do
    [[ -f "$target/scripts/$helper" ]] && cp -a -- "$target/scripts/$helper" "$newtarget/scripts/$helper"
  done

  # The secrets directory is present and VALID, holding every secret except
  # postgres-password. That precise shape is what reaches the guard, and the
  # first version of this journey got it wrong: with no .orbit-secrets at all,
  # no `secret-missing` finding is raised, `resolve_secret_missing_action` is
  # never consulted, and the plan line the journey asserted came from the
  # unconditional `volume-retained-without-credentials -> rotate-database-
  # credential` class mapping instead. It passed with the guard deliberately
  # disabled, which is to say it proved nothing about the guard. Verified by
  # mutation both ways -- see the journey's evidence on #532.
  cp -a -- "$target/.orbit-secrets" "$newtarget/.orbit-secrets"
  rm -f -- "$newtarget/.orbit-secrets/postgres-password"
  chmod 700 -- "$newtarget/.orbit-secrets"

  docker volume inspect "${project}_orbit-db-data" >/dev/null 2>&1 ||
    fail 'retained-volume-new-target: the database volume this journey needs does not exist'

  status=0
  output="$( (cd "$newtarget" && env ORBIT_REPAIR_PROMPTS=machine bash ./scripts/repair.sh --check) 2>&1 )" || status=$?
  [[ "$status" == 4 ]] ||
    { printf '%s\n' "$output" >&2; fail "retained-volume-new-target: --check exited $status, expected 4"; }
  grep -q 'finding class=volume-retained-without-credentials' <<<"$output" ||
    { printf '%s\n' "$output" >&2
      fail 'retained-volume-new-target: --check did not report volume-retained-without-credentials'; }
  # Both findings must be present, or the guard below is not the thing under
  # test: it only fires where a missing postgres-password and a retained
  # volume coincide.
  grep -q 'finding class=secret-missing target=postgres-password' <<<"$output" ||
    { printf '%s\n' "$output" >&2
      fail 'retained-volume-new-target: --check did not report the missing postgres-password'; }

  status=0
  plan="$( (cd "$newtarget" && env ORBIT_REPAIR_PROMPTS=machine bash ./scripts/repair.sh --plan) 2>&1 )" || status=$?

  # The guard itself. regenerate-secret against a retained volume is the
  # wrong fix, and its absence here is the whole point of the journey -- so
  # it is asserted alongside the positive routing, never on its own.
  grep -q 'plan action=rotate-database-credential' <<<"$plan" ||
    { printf '%s\n' "$plan" >&2
      fail 'retained-volume-new-target: the retained-volume password was not planned as rotate-database-credential'; }
  grep -q 'plan action=regenerate-secret' <<<"$plan" &&
    { printf '%s\n' "$plan" >&2
      fail 'retained-volume-new-target: a fresh secret was planned against a retained volume'; }

  # Neither read-only mode may touch the live deployment it borrowed from.
  # Asserted as "unchanged", not as "healthy": whether the live stack is
  # healthy at this point depends on which journeys ran before this one, and
  # a health check would make this journey pass or fail for reasons that have
  # nothing to do with what it tests. The manifest is the honest question --
  # did diagnosing a second directory alter the first one.
  [[ "$(deployment_manifest)" == "$before" ]] ||
    fail 'retained-volume-new-target: diagnosing a new target changed the live deployment'

  rm -rf -- "$newtarget"
  result_line retained-volume-new-target pass
}

# Live evidence for #532's "interrupted configuration migration, recovered via
# slice 2's boundary" (ADR-0014 decision 7).
#
# configuration.sh's migrate_file() writes a new .env-orbit by assembling it
# elsewhere and renaming it into place, keeping the previous content beside it
# at `.env-orbit.orbit-config.rollback`. An interruption between those two
# steps is the case this journey builds: a live file that no longer validates,
# next to a rollback copy that does.
#
# repair.sh only raises configuration-migration-interrupted where BOTH halves
# hold -- `configure.sh --check` fails AND `--check-rollback` passes on a
# mode-600 regular file. Where the rollback is not recoverable the class
# degrades to configuration-invalid/-incomplete, whose action is
# rerun-configuration, not a restore. That distinction is the whole point, so
# this journey asserts the negative first: it proves the class can be absent
# for the right reason before believing the run where it is present.
#
# It works on a copy of the live deployment rather than on the deployment
# itself, like retained-volume-new-target above, because unlike every other
# journey here it has to run --execute and actually mutate what it diagnoses.
journey_interrupted_configuration_migration() {
  local newtarget rollback live before expected status output plan
  before="$(deployment_manifest)"
  newtarget="$workdir/interrupted-migration"
  rm -rf -- "$newtarget"

  # A whole-directory copy rather than a hand-picked file list: repair.sh
  # checks fourteen managed paths (repair.sh's restore_transaction_paths), and
  # a copy missing any of them raises managed-file-missing findings that have
  # nothing to do with what this journey tests.
  cp -a -- "$target" "$newtarget"

  live="$newtarget/.env-orbit"
  rollback="$newtarget/.env-orbit.orbit-config.rollback"

  # The rollback copy, exactly as migrate_file() leaves it: byte-identical to
  # the good file, mode 600.
  cp -a -- "$live" "$rollback"
  chmod 600 -- "$rollback"
  expected="$(sha256sum "$rollback" | awk '{print $1}')"

  # The interruption itself -- a half-written live file. Truncating to the
  # first few lines is what a rename that never happened leaves behind: valid
  # syntax, missing required keys.
  head -n 4 -- "$rollback" > "$live"
  chmod 600 -- "$live"

  # Prove the precondition rather than assuming it. If --check were to pass
  # here, or --check-rollback to fail, every assertion below would be about
  # some other code path and would still look like a pass.
  status=0
  (cd "$newtarget" && bash scripts/configure.sh --check >/dev/null 2>&1) || status=$?
  [[ "$status" != 0 ]] ||
    fail 'interrupted-configuration-migration: the truncated .env-orbit still passes --check, so the fixture is wrong'
  status=0
  (cd "$newtarget" && bash scripts/configure.sh --check-rollback >/dev/null 2>&1) || status=$?
  [[ "$status" == 0 ]] ||
    fail 'interrupted-configuration-migration: the rollback copy does not pass --check-rollback, so the class cannot fire'

  # --- the negative: an unrecoverable rollback must NOT reach this class ----
  # 644 is what a careless `cp` without -a leaves, and it must degrade to
  # configuration-invalid/-incomplete, whose action is rerun-configuration
  # rather than a restore.
  #
  # What this proves, precisely: the SYSTEM refuses an unrecoverable rollback.
  # It does not attribute the refusal to repair.sh's own guard, and cannot --
  # `configure.sh --check-rollback` enforces the identical two conditions at
  # configure.sh:956-960 (regular non-symlink file, mode 600), so
  # configuration_migration_rollback_recoverable's first two lines are
  # redundant with the subprocess it then runs. Established by mutation:
  # deleting repair.sh's `has_mode` line leaves this journey passing, because
  # --check-rollback had already failed the copy. A symlinked rollback was
  # tried as a fixture that might separate them and does not -- configure.sh
  # refuses that too.
  #
  # The criterion is about the boundary's behaviour, not about which of two
  # layers enforces it, so this is the honest form of the assertion. The
  # journey's ability to fail rests on the positive path below, where removing
  # the rollback-copy deletion from do_restore_configuration_rollback does
  # break it.
  chmod 644 -- "$rollback"
  status=0
  output="$( (cd "$newtarget" && bash scripts/repair.sh --check) 2>&1 )" || status=$?
  grep -q 'finding class=configuration-migration-interrupted' <<<"$output" &&
    { printf '%s\n' "$output" >&2
      fail 'interrupted-configuration-migration: the class fired on a mode-644 rollback, so the recoverability guard is not being consulted'; }
  grep -qE 'finding class=configuration-(invalid|incomplete)' <<<"$output" ||
    { printf '%s\n' "$output" >&2
      fail 'interrupted-configuration-migration: an unrecoverable rollback produced neither configuration-invalid nor configuration-incomplete'; }

  chmod 600 -- "$rollback"

  # --- the positive -------------------------------------------------------
  status=0
  output="$( (cd "$newtarget" && bash scripts/repair.sh --check) 2>&1 )" || status=$?
  [[ "$status" == 4 ]] ||
    { printf '%s\n' "$output" >&2; fail "interrupted-configuration-migration: --check exited $status, expected 4"; }
  grep -q 'finding class=configuration-migration-interrupted target=configuration severity=fail' <<<"$output" ||
    { printf '%s\n' "$output" >&2
      fail 'interrupted-configuration-migration: --check did not report configuration-migration-interrupted'; }

  status=0
  plan="$( (cd "$newtarget" && bash scripts/repair.sh --plan) 2>&1 )" || status=$?
  grep -q 'plan action=restore-transaction resolves=configuration-migration-interrupted mutation=reversible backup=required' <<<"$plan" ||
    { printf '%s\n' "$plan" >&2
      fail 'interrupted-configuration-migration: the interruption was not planned as a reversible, backed-up restore-transaction'; }

  # --execute --safe-only runs every planned action that is not
  # rotate-database-credential or regenerate-secret -- restart-services and
  # fix-permissions included, and restart-services would restart the LIVE
  # containers this copy still names. Refuse to execute unless the restore is
  # the only thing in the batch, rather than discovering that afterwards.
  # Captured into a variable rather than tested through a pipeline: under
  # `set -o pipefail` a `grep -v` that matches nothing exits 1, which is the
  # success case here, and the pipeline's status would report a failure the
  # final command never had.
  local unexpected
  unexpected="$(grep -E '^plan action=' <<<"$plan" |
    grep -vE '^plan action=(restore-transaction|manual) ' || true)"
  [[ -z "$unexpected" ]] ||
    { printf '%s\n' "$plan" >&2
      fail "interrupted-configuration-migration: the plan carries executable actions beyond the restore, refusing to execute: $unexpected"; }

  status=0
  output="$( (cd "$newtarget" && bash scripts/repair.sh --execute --safe-only) 2>&1 )" || status=$?
  [[ "$status" == 0 ]] ||
    { printf '%s\n' "$output" >&2; fail "interrupted-configuration-migration: --execute exited $status, expected 0"; }
  grep -q 'execute action=restore-transaction resolves=configuration-migration-interrupted result=done' <<<"$output" ||
    { printf '%s\n' "$output" >&2
      fail 'interrupted-configuration-migration: the restore did not report done'; }

  # The boundary's actual promise: the live file is the rollback's content,
  # byte for byte, at mode 600 -- and the rollback copy is consumed, so a
  # second run has nothing left to restore.
  [[ "$(sha256sum "$live" | awk '{print $1}')" == "$expected" ]] ||
    fail 'interrupted-configuration-migration: .env-orbit was not restored to the rollback content'
  [[ "$(stat -c '%a' "$live")" == 600 ]] ||
    fail 'interrupted-configuration-migration: the restored .env-orbit is not mode 600'
  [[ ! -e "$rollback" ]] ||
    fail 'interrupted-configuration-migration: the rollback copy survived a completed restore'

  # And the repaired copy now diagnoses its configuration as clean.
  status=0
  output="$( (cd "$newtarget" && bash scripts/repair.sh --check) 2>&1 )" || status=$?
  grep -qE 'finding class=configuration-' <<<"$output" &&
    { printf '%s\n' "$output" >&2
      fail 'interrupted-configuration-migration: a configuration finding survived the restore'; }

  [[ "$(deployment_manifest)" == "$before" ]] ||
    fail 'interrupted-configuration-migration: repairing a copy changed the live deployment'

  rm -rf -- "$newtarget"
  result_line interrupted-configuration-migration pass
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

# The five journeys below (#681, criterion 27) run after the shared
# deployment is healthy again — credential-drift has repaired the drift and
# idempotent-rerun has proven the rerun empty — so each starts from, and
# must hand back, a healthy deployment with an unchanged manifest. That
# also means `--journey <one-of-these>` cannot work alone: the global
# setup drifts the credential unconditionally, and only the earlier
# journeys repair it, so a standalone tail journey sees an unhealthy
# deployment and fails on its own preconditions. successful-rollback stays
# last: its completed restore replaces every managed file's inode, and a
# Compose file: secret is a bind mount of an inode (#629), so running
# containers keep the pre-restore secret files — identical in content, but
# a journey relying on inode identity after it would be misled.

journey_unsafe_permissions() {
  local before output status=0
  before="$(deployment_manifest)"

  chmod 644 -- "$target/.env-orbit"
  chmod 644 -- "$target/.orbit-secrets/postgres-password"

  output="$(repair --check 2>&1)" || status=$?
  [[ "$status" == 4 ]] || { printf '%s\n' "$output" >&2; fail "unsafe-permissions: --check exited $status, expected 4"; }
  grep -q 'finding class=managed-file-permissions target=environment-file severity=fail' <<<"$output" ||
    { printf '%s\n' "$output" >&2; fail 'unsafe-permissions: --check did not report managed-file-permissions'; }
  grep -q 'finding class=secret-permissions target=postgres-password severity=fail' <<<"$output" ||
    { printf '%s\n' "$output" >&2; fail 'unsafe-permissions: --check did not report secret-permissions'; }

  status=0
  output="$(printf 'y\n' | repair --execute --safe-only 2>&1)" || status=$?
  [[ "$status" == 0 ]] ||
    { printf '%s\n' "$output" >&2; fail "unsafe-permissions: --execute exited $status, expected 0"; }
  grep -q 'execute action=fix-permissions resolves=managed-file-permissions result=done' <<<"$output" ||
    { printf '%s\n' "$output" >&2; fail 'unsafe-permissions: the environment-file fix did not report done'; }
  grep -q 'execute action=fix-permissions resolves=secret-permissions result=done' <<<"$output" ||
    { printf '%s\n' "$output" >&2; fail 'unsafe-permissions: the secret-file fix did not report done'; }

  [[ "$(stat -c '%a' "$target/.env-orbit")" == 600 ]] ||
    fail 'unsafe-permissions: .env-orbit was not restored to mode 600'
  [[ "$(stat -c '%a' "$target/.orbit-secrets/postgres-password")" == 600 ]] ||
    fail 'unsafe-permissions: postgres-password was not restored to mode 600'

  [[ "$(deployment_manifest)" == "$before" ]] ||
    fail 'unsafe-permissions: the repaired deployment does not match its pre-breakage manifest'
  health_check || fail 'unsafe-permissions: the deployment is unhealthy after a permissions repair'
  result_line unsafe-permissions pass
}

# managed-file-missing routes to `manual` by design — repair never
# fabricates a managed file's content — so this journey is read-only like
# retained-volume-new-target: it proves the diagnosis and the routing, and
# proves repair left the gap for the operator rather than papering over it.
journey_missing_files() {
  local before output plan status=0
  before="$(deployment_manifest)"

  cp -a -- "$target/docker-compose.yml" "$workdir/docker-compose.yml.orig"
  rm -f -- "$target/docker-compose.yml"

  output="$(repair --check 2>&1)" || status=$?
  [[ "$status" == 4 ]] || { printf '%s\n' "$output" >&2; fail "missing-files: --check exited $status, expected 4"; }
  grep -q 'finding class=managed-file-missing target=compose-file severity=fail' <<<"$output" ||
    { printf '%s\n' "$output" >&2; fail 'missing-files: --check did not report managed-file-missing'; }

  status=0
  plan="$(repair --plan 2>&1)" || status=$?
  grep -q 'plan action=manual resolves=managed-file-missing' <<<"$plan" ||
    { printf '%s\n' "$plan" >&2; fail 'missing-files: the missing file was not routed to manual'; }
  grep -q 'manual step: recreate the missing managed file' <<<"$plan" ||
    { printf '%s\n' "$plan" >&2; fail 'missing-files: no manual guidance was printed for the missing file'; }
  [[ ! -e "$target/docker-compose.yml" ]] ||
    fail 'missing-files: something recreated the managed file; repair must never fabricate one'

  cp -a -- "$workdir/docker-compose.yml.orig" "$target/docker-compose.yml"

  status=0
  repair --check >/dev/null 2>&1 || status=$?
  [[ "$status" == 0 ]] || fail "missing-files: --check after restoring the file exited $status, expected 0"
  [[ "$(deployment_manifest)" == "$before" ]] ||
    fail 'missing-files: the restored deployment does not match its pre-breakage manifest'
  result_line missing-files pass
}

# migration-failed routes to `manual` by design (ADR-0004's recovery point
# is the operator's rollback boundary), so this journey too is read-only on
# the deployment: what it proves live is the SQL backstop against a real
# PostgreSQL — the row a genuinely failed migration leaves behind is
# exactly what it seeds. The negative runs first: the class must be absent
# on the healthy deployment before its presence after seeding means
# anything.
journey_failed_db_migration() {
  local before output plan status=0
  before="$(deployment_manifest)"

  output="$(repair --check 2>&1)" || status=$?
  [[ "$status" == 0 ]] ||
    { printf '%s\n' "$output" >&2; fail "failed-db-migration: the deployment is not healthy before seeding (exit $status)"; }
  grep -q 'migration-failed' <<<"$output" &&
    fail 'failed-db-migration: the class fired before a failure was seeded, so the fixture proves nothing'

  compose exec -T orbit-db sh -c \
    'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --set=ON_ERROR_STOP=1 --command="
      insert into drizzle.orbit_migration_runs (started_at, finished_at, outcome, reason)
        values (now(), now(), '\''failed'\'', '\''migration_failed'\'');"' >/dev/null ||
    fail 'failed-db-migration: could not seed the failed migration run'

  status=0
  output="$(repair --check 2>&1)" || status=$?
  [[ "$status" == 4 ]] || { printf '%s\n' "$output" >&2; fail "failed-db-migration: --check exited $status, expected 4"; }
  grep -q 'finding class=migration-failed target=database severity=fail' <<<"$output" ||
    { printf '%s\n' "$output" >&2; fail 'failed-db-migration: --check did not report migration-failed'; }

  status=0
  plan="$(repair --plan 2>&1)" || status=$?
  grep -q 'plan action=manual resolves=migration-failed' <<<"$plan" ||
    { printf '%s\n' "$plan" >&2; fail 'failed-db-migration: the failed migration was not routed to manual'; }
  grep -q 'recovery point' <<<"$plan" ||
    { printf '%s\n' "$plan" >&2; fail 'failed-db-migration: the manual guidance does not name the recovery point'; }

  compose exec -T orbit-db sh -c \
    'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --set=ON_ERROR_STOP=1 --command="
      delete from drizzle.orbit_migration_runs where outcome = '\''failed'\'';"' >/dev/null ||
    fail 'failed-db-migration: could not remove the seeded failure row'

  status=0
  repair --check >/dev/null 2>&1 || status=$?
  [[ "$status" == 0 ]] || fail "failed-db-migration: --check after cleanup exited $status, expected 0"
  [[ "$(deployment_manifest)" == "$before" ]] ||
    fail 'failed-db-migration: diagnosing a database state changed the deployment files'
  result_line failed-db-migration pass
}

# A genuinely wedged application: SIGSTOP freezes the app's PID 1, so the
# health endpoint stops answering while the container keeps running, and
# Docker's own healthcheck (interval 10s, retries 10) eventually marks it
# unhealthy — the exact state an operator sees from a hung app. A restart
# genuinely fixes it, which is what makes restart-services the honest
# routing to prove here. The docker-status wait is the long pole: the flip
# needs ten consecutive probe failures, so the deadline is generous.
journey_unhealthy_app() {
  local before output status=0 health deadline
  before="$(deployment_manifest)"

  docker kill --signal=STOP orbit >/dev/null 2>&1 ||
    fail 'unhealthy-app: could not freeze the app container'

  deadline=$((SECONDS + 240))
  while :; do
    health="$(docker inspect orbit --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null || true)"
    [[ "$health" == unhealthy ]] && break
    ((SECONDS < deadline)) || { docker kill --signal=CONT orbit >/dev/null 2>&1 || true
      fail 'unhealthy-app: the frozen app never reached docker health status unhealthy'; }
    sleep 5
  done

  # On failure, print the window repair.sh step 12 reads. Which run of the
  # container a sentinel came from is the whole question this journey got
  # wrong once (#778), and neither the finding nor the exit code says: only
  # the timestamps against the container's own start time do. Read-only, and
  # only on the failing path, so a passing run stays quiet.
  unhealthy_app_window() {
    printf '[repair-journeys] unhealthy-app: container started at %s\n' \
      "$(docker inspect orbit --format '{{.State.StartedAt}}' 2>/dev/null || echo unknown)"
    printf '[repair-journeys] unhealthy-app: docker logs --tail 50 at --check time:\n'
    docker logs --timestamps --tail 50 orbit 2>&1 || true
  }

  output="$(repair --check 2>&1)" || status=$?
  [[ "$status" == 4 ]] || { printf '%s\n' "$output" >&2
    unhealthy_app_window >&2
    docker kill --signal=CONT orbit >/dev/null 2>&1 || true
    fail "unhealthy-app: --check exited $status, expected 4"; }
  grep -q 'finding class=application-unhealthy target=application severity=fail' <<<"$output" ||
    { printf '%s\n' "$output" >&2
      unhealthy_app_window >&2
      docker kill --signal=CONT orbit >/dev/null 2>&1 || true
      fail 'unhealthy-app: --check did not report application-unhealthy'; }

  status=0
  output="$(printf 'y\n' | repair --execute --safe-only 2>&1)" || status=$?
  [[ "$status" == 0 ]] ||
    { printf '%s\n' "$output" >&2
      docker kill --signal=CONT orbit >/dev/null 2>&1 || true
      fail "unhealthy-app: --execute exited $status, expected 0"; }
  grep -q 'execute action=restart-services resolves=application-unhealthy result=done' <<<"$output" ||
    { printf '%s\n' "$output" >&2; fail 'unhealthy-app: restart-services did not report done'; }

  wait_for_health
  [[ "$(deployment_manifest)" == "$before" ]] ||
    fail 'unhealthy-app: a service restart changed the deployment files'
  [[ "$(household_name)" == 'repair-journeys-household' ]] ||
    fail 'unhealthy-app: the restart disturbed the fixture data'
  result_line unhealthy-app pass
}

# Criterion 27's "successful rollback": a recognized installer transaction
# is rolled back to completion. The staged backup deliberately differs from
# the live file — signal-cleanup's byte-identical fixture proves an
# interrupted restore mutates nothing, so this journey must prove the
# complement: a completed restore really moves the deployment back to the
# rollback content, byte for byte, and consumes the staging evidence so a
# rerun has nothing left to restore.
journey_successful_rollback() {
  local before staging expected live output plan status=0
  before="$(deployment_manifest)"
  live="$target/.env-orbit"

  staging="$(mktemp -d "$target/.orbit-install-staging.XXXXXX")"
  chmod 700 -- "$staging"
  mkdir -p -- "$staging/rollback/original"
  chmod 700 -- "$staging/rollback" "$staging/rollback/original"

  # Stage a backup of EVERY managed path that exists, exactly as
  # install.sh's prepare_rollback_area does before touching anything. The
  # restore treats a managed path with no staged original as one the
  # interrupted transaction created and REMOVES it — the first version of
  # this fixture staged only .env-orbit, and the completed rollback duly
  # rolled the deployment's own scripts out of existence (exit 127 on the
  # next repair invocation). The list mirrors repair.sh's
  # restore_transaction_paths, the same way interrupted-configuration-
  # migration's whole-directory copy already leans on it.
  local managed
  for managed in docker-compose.yml docker-compose.mail.yml \
      docker-compose.mail-alias-rotation.yml .env-orbit.example \
      config/tika-config.json scripts/configure.sh scripts/installer-ui.sh \
      scripts/configuration.sh scripts/backup.sh scripts/restore.sh \
      scripts/repair.sh scripts/engine-check.sh .env-orbit .orbit-secrets; do
    [[ -e "$target/$managed" ]] || continue
    mkdir -p -- "$staging/rollback/original/$(dirname -- "$managed")"
    cp -a -- "$target/$managed" "$staging/rollback/original/$managed"
  done
  expected="$(sha256sum "$staging/rollback/original/.env-orbit" | awk '{print $1}')"

  # The interrupted install's half-applied change: a live value that moved
  # after the backup was staged. ORBIT_PORT keeps the file valid — APP_URL
  # was tried first and fails configure.sh's readiness, because its host no
  # longer matches OIDC_CALLBACK_URL's — so the only finding is the staging
  # evidence and the restore is the only executable action. The running
  # container keeps its published port either way; only the file moves.
  sed -i 's|^ORBIT_PORT=.*|ORBIT_PORT=3212|' "$live"
  [[ "$(sha256sum "$live" | awk '{print $1}')" != "$expected" ]] ||
    fail 'successful-rollback: the drifted live file still matches the backup, so the fixture proves nothing'

  status=0
  output="$(repair --check 2>&1)" || status=$?
  [[ "$status" == 3 ]] || { printf '%s\n' "$output" >&2; fail "successful-rollback: --check exited $status, expected 3 (attention)"; }
  grep -q 'finding class=staging-evidence-present target=staging severity=warn' <<<"$output" ||
    { printf '%s\n' "$output" >&2; fail 'successful-rollback: --check did not report the staging evidence'; }

  status=0
  plan="$(repair --plan 2>&1)" || status=$?
  grep -q 'plan action=restore-transaction resolves=staging-evidence-present mutation=reversible backup=required' <<<"$plan" ||
    { printf '%s\n' "$plan" >&2; fail 'successful-rollback: the staging evidence was not planned as a backed-up restore-transaction'; }
  local unexpected
  unexpected="$(grep -E '^plan action=' <<<"$plan" |
    grep -vE '^plan action=(restore-transaction|manual|rerun-configuration) ' || true)"
  [[ -z "$unexpected" ]] ||
    { printf '%s\n' "$plan" >&2
      fail "successful-rollback: the plan carries executable actions beyond the restore, refusing to execute: $unexpected"; }

  status=0
  output="$(printf 'y\n' | repair --execute --safe-only 2>&1)" || status=$?
  [[ "$status" == 0 ]] ||
    { printf '%s\n' "$output" >&2; fail "successful-rollback: --execute exited $status, expected 0"; }
  grep -q 'execute action=restore-transaction resolves=staging-evidence-present result=done' <<<"$output" ||
    { printf '%s\n' "$output" >&2; fail 'successful-rollback: the restore did not report done'; }

  [[ "$(sha256sum "$live" | awk '{print $1}')" == "$expected" ]] ||
    fail 'successful-rollback: .env-orbit was not rolled back to the staged content'
  [[ "$(stat -c '%a' "$live")" == 600 ]] ||
    fail 'successful-rollback: the rolled-back .env-orbit is not mode 600'
  compgen -G "$target/.orbit-install-staging.*" >/dev/null 2>&1 &&
    fail 'successful-rollback: the staging evidence survived a completed rollback'

  status=0
  repair --check >/dev/null 2>&1 || status=$?
  [[ "$status" == 0 ]] || fail "successful-rollback: --check after the rollback exited $status, expected 0"
  [[ "$(deployment_manifest)" == "$before" ]] ||
    fail 'successful-rollback: the rolled-back deployment does not match its pre-drift manifest'
  health_check || fail 'successful-rollback: the deployment is unhealthy after the rollback'
  [[ "$(household_name)" == 'repair-journeys-household' ]] ||
    fail 'successful-rollback: the rollback disturbed the fixture data'
  result_line successful-rollback pass
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
