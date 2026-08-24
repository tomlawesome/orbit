import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// This suite runs repair.sh from copied fixtures in temporary directories:
// like configure.sh, repair.sh forces its own cwd to its containing
// checkout (`dirname "$0"/..`), so it must never be pointed at the real
// repository. A fake `docker` executable is placed ahead of the real one on
// PATH (this sandbox has a real Docker CLI installed) for every invocation,
// so no test ever reaches a real daemon, container, volume, or image.

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoDir = join(scriptsDir, "..");
const repairScriptSource = readFileSync(join(scriptsDir, "repair.sh"), "utf8");
const configureScriptSource = readFileSync(join(scriptsDir, "configure.sh"), "utf8");
const configurationScriptSource = readFileSync(join(scriptsDir, "configuration.sh"), "utf8");
const installerUiSource = readFileSync(join(scriptsDir, "installer-ui.sh"), "utf8");
const environmentExampleSource = readFileSync(join(repoDir, ".env-orbit.example"), "utf8");

const scratchDirs = [];

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop(), { recursive: true, force: true });
  }
});

function scratchDir() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-repair-"));
  scratchDirs.push(dir);
  return dir;
}

// A `docker` shim covering every read-only subcommand repair.sh issues:
//   - `docker ps -a` (bare)                             -> connectivity probe
//   - `docker ps -a --filter project ... --format ...`    -> container ownership
//   - `docker ps -a --filter project --filter service=orbit-db --format ...`
//     / `...service=orbit-app...`                         -> per-service discovery
//   - `docker compose --project-name X ... config --quiet` -> interpolation
//   - `docker volume ls --filter ... --format ...`         -> volume retention
//   - `docker exec ... pg_isready ...` / `docker exec -e PGPASSWORD ... psql ...`
//                                                           -> database reachability/auth,
//                                                              plus the issue #528
//                                                              migration-failed backstop
//                                                              SELECT (fingerprinted by the
//                                                              literal orbit_migration_runs
//                                                              table name)
//   - `docker inspect --format '{{.Config.Image}}|...' <id>` -> app image/health
//   - `docker inspect --format '{{.Image}}' <id>`           -> issue #528 running image ID
//   - `docker image inspect --format '{{.Id}}' <ref>`       -> issue #528 locally-present
//                                                              image for the pinned ref
// `unavailable: true` makes every subcommand fail, simulating a missing or
// unreachable Docker without needing to hide the real `docker` binary from
// PATH (which shares a directory with bash/coreutils in this sandbox).
//
// Every invocation's full argv is appended to `argvLogPath` (when provided)
// before dispatch, regardless of outcome, so tests can assert a secret value
// never appears on any `docker` command line even when the scenario is
// deliberately built to make repair.sh's own captured output leaky.
// The real scripts/recovery-crypto.mjs (issue #296 slice 1) — the ORBKEK01
// CLI repair.sh's stage-two checkpoint step shells out to inside a one-off
// orbit-app container. The fake `docker` shim below dispatches a
// `compose ... run ... --entrypoint node orbit-app
// /opt/orbit/scripts/recovery-crypto.mjs <encrypt|decrypt> <path>` straight
// to this REAL script (with the real `node` already on PATH — this suite
// shims `docker` only), remapping the fixed container-internal paths
// repair.sh uses back to host paths, so no real Docker daemon or built
// image is ever required to exercise the actual ORBKEK01 crypto.
const recoveryCryptoScriptPath = join(scriptsDir, "recovery-crypto.mjs");

function dockerShimScript({
  unavailable = false,
  volumes = [],
  containers = [],
  composeFails = false,
  db = { present: true, ready: true, authResult: "ok" },
  app = { present: true, image: "ghcr.io/tomlawesome/orbit@sha256:" + "0".repeat(64), health: "healthy" },
  argvLogPath = "",
  // --execute's restart-services support: `restartFails` makes every
  // `docker restart` invocation fail (exit 1); `healthMarkerPath`, when
  // set, makes a successful `docker restart` write a marker file, and
  // makes subsequent `docker inspect` report `healthy` once that marker
  // exists — this is what lets a test prove the post-execution
  // re-diagnosis honestly reflects a real restart rather than a canned
  // answer.
  restartFails = false,
  healthMarkerPath = "",
  // --execute --dangerous's rotate-database-credential support:
  // `alterRoleFails` makes every script-mode `psql -f -` exec'd for the
  // rotate-credential step fail (exit 1), simulating that step itself
  // failing after a successful checkpoint. `recoveryCryptoFails` makes
  // every `compose run ... recovery-crypto.mjs ...` invocation fail
  // outright (exit 1) BEFORE dispatching to the real script, simulating a
  // Docker/compose-level failure distinct from a crypto-level one (e.g. a
  // bad passphrase, which the real script itself already reports via its
  // own nonzero exit — no separate flag needed for that case).
  alterRoleFails = false,
  recoveryCryptoFails = false,
  // When set, a successful rotate-credential exec touches this marker
  // file, and the psql-auth branch reports `ok` (regardless of
  // `db.authResult`) once the marker exists — mirroring `healthMarkerPath`
  // above, this is what lets a test prove the post-execution re-diagnosis
  // honestly reflects a real rotation rather than a canned answer.
  dbAuthMarkerPath = "",
  // The rotate-credential step delivers its SQL (including the fresh
  // credential) over `psql -f -`'s STDIN, never argv (see the coordinator
  // review this fixes: the SQL must never appear in `docker`/`psql` argv,
  // observable via /proc). When set, the shim's `-f -` branch captures
  // exactly what it received on its own stdin into this path, so a test can
  // assert the rotation SQL genuinely arrived via stdin (not argv, and not
  // simply absent because the call never happened).
  execStdinLogPath = "",
  // When set, the shim's `exec)` branch appends its full argument list (one
  // invocation per line) to this path — lets a test assert exactly which
  // host the authenticated database probe dialed (e.g. the compose service
  // name `orbit-db`, never a loopback literal — see #610) without having to
  // pick the exec call out of every other `docker` invocation logged to
  // `argvLogPath`.
  execArgvLogPath = "",
  // issue #528 migration-failed backstop support: the single fixed-literal
  // `SELECT "outcome", "reason" FROM "drizzle"."orbit_migration_runs" ...`
  // repair.sh issues over the already-authenticated probe path, fingerprinted
  // by the literal table name (never by full SQL text matching — that would
  // defeat the point of testing byte-for-byte literal issuance). Default
  // (`migrationRun: undefined`, `migrationRunRaw: undefined`) simulates the
  // bookkeeping table not existing yet (a real `psql` ERROR on stderr, exit
  // 1) so every test that doesn't opt in stays a no-finding skip.
  // `migrationRun: { outcome, reason }` returns a clean
  // `-t -A -F'|'` row: `${outcome}|${reason}`, exit 0. `migrationRunRaw`
  // overrides with an arbitrary raw byte sequence (for hostile/garbage-output
  // tests) instead of the outcome/reason shape, still exit 0.
  migrationRun = undefined,
  migrationRunRaw = undefined,
  // issue #528 image-identity-mismatch support. `imageInspect: { present,
  // id }` controls `docker image inspect --format '{{.Id}}' <pinned-ref>`:
  // present=false (the default) makes it fail, exactly like a pinned image
  // never pulled locally, so every test that doesn't opt in leaves Step 13 a
  // no-finding skip. `appImageId` controls `docker inspect --format
  // '{{.Image}}' <container>` — the RUNNING container's actual image ID,
  // deliberately independent from `app.image` (the Config.Image reference
  // string Step 12's stale-container check reads).
  imageInspect = { present: false, id: "" },
  appImageId = "sha256:" + "9".repeat(64),
} = {}) {
  if (unavailable) {
    return "#!/usr/bin/env bash\nexit 1\n";
  }
  const volumeLines = volumes.map((name) => `    printf '%s\\n' '${name}'`).join("\n");
  const containerLines = containers
    .map(({ id, service }) => `      printf '%s\\n' '${id}|${service}'`)
    .join("\n");
  const dbId = db && db.present !== false ? (db.id ?? "1111aaaa2222") : "";
  const appId = app && app.present !== false ? (app.id ?? "3333bbbb4444") : "";
  const dbReadyExit = db && db.ready === false ? 1 : 0;
  const authResult = (db && db.authResult) || "ok";
  const appImage = (app && app.image) || "";
  const appHealth = app && app.health !== undefined ? app.health : "healthy";
  // The app's own operational log, so a refusal to start over the database can
  // be told apart from a generic unhealthy container (#437).
  const appLog = (app && app.log) || "";
  const alterRoleExit = alterRoleFails ? 1 : 0;
  const migrationRunHasData = migrationRunRaw !== undefined || migrationRun;
  const migrationRunExit = migrationRunHasData ? 0 : 1;
  const migrationRunLine =
    migrationRunRaw !== undefined
      ? `printf '%s' '${migrationRunRaw}'`
      : migrationRun
        ? `printf '%s|%s\\n' '${migrationRun.outcome ?? ""}' '${migrationRun.reason ?? ""}'`
        : `printf 'ERROR:  relation \"drizzle.orbit_migration_runs\" does not exist\\n' >&2`;
  const imageInspectPresent = Boolean(imageInspect && imageInspect.present === true);
  // Defaults to appImageId (not a separate literal) so a "match" scenario
  // needs only `imageInspect: { present: true }`, and a "mismatch" scenario
  // only needs to override this one field.
  const imageInspectId = (imageInspect && imageInspect.id) || appImageId;
  const logLine = argvLogPath
    ? `printf '%s\\n' "$*" >> '${argvLogPath}' 2>/dev/null || true`
    : "true";
  const appHealthExpr = healthMarkerPath
    ? `if [[ -e '${healthMarkerPath}' ]]; then printf 'healthy'; else printf '%s' '${appHealth}'; fi`
    : `printf '%s' '${appHealth}'`;
  const composeRunLines = [
    // "run" can appear at any position after --project-name/--env-file, so
    // this scans the whole argv rather than checking a fixed index.
    "    is_run=0",
    '    for a in "$@"; do [[ "$a" == "run" ]] && is_run=1; done',
    '    if [[ "$is_run" == 1 ]]; then',
    '      args=("$@")',
    "      idx=0",
    "      recovery_op=''",
    "      recovery_path=''",
    "      volume_src=''",
    "      volume_dst=''",
    '      while [[ "$idx" -lt "${#args[@]}" ]]; do',
    '        a="${args[$idx]}"',
    '        case "$a" in',
    "          --volume)",
    "            idx=$((idx + 1))",
    '            vol="${args[$idx]:-}"',
    '            volume_src="${vol%%:*}"',
    '            rest="${vol#*:}"',
    '            volume_dst="${rest%%:*}"',
    "            ;;",
    "          encrypt|decrypt)",
    '            recovery_op="$a"',
    "            idx=$((idx + 1))",
    '            recovery_path="${args[$idx]:-}"',
    "            ;;",
    "        esac",
    "        idx=$((idx + 1))",
    "      done",
    '      if [[ -n "$recovery_op" ]]; then',
    recoveryCryptoFails ? "        exit 1" : "        true",
    '        real_path="$recovery_path"',
    '        if [[ -n "$volume_src" && "$recovery_path" == "$volume_dst" ]]; then',
    '          real_path="$volume_src"',
    '        elif [[ "$recovery_path" == "/run/secrets/orbit-postgres-password" ]]; then',
    '          real_path=".orbit-secrets/postgres-password"',
    "        fi",
    `        exec node '${recoveryCryptoScriptPath}' "$recovery_op" "$real_path"`,
    "      fi",
    "    fi",
  ].join("\n");
  return [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    logLine,
    'case "${1:-}" in',
    "  ps)",
    "    filter_count=0",
    '    for a in "$@"; do [[ "$a" == "--filter" ]] && filter_count=$((filter_count + 1)); done',
    '    joined="$*"',
    '    if [[ "$filter_count" -ge 2 && "$joined" == *"service=orbit-db"* ]]; then',
    `      ${dbId ? `printf '%s\\n' '${dbId}'` : "true"}`,
    "      exit 0",
    "    fi",
    '    if [[ "$filter_count" -ge 2 && "$joined" == *"service=orbit-app"* ]]; then',
    `      ${appId ? `printf '%s\\n' '${appId}'` : "true"}`,
    "      exit 0",
    "    fi",
    '    if [[ "$filter_count" -ge 1 ]]; then',
    containerLines || "      true",
    "    fi",
    "    exit 0",
    "    ;;",
    "  compose)",
    composeRunLines,
    composeFails ? "    exit 1" : "    exit 0",
    "    ;;",
    "  volume)",
    '    if [[ "${2:-}" == "ls" ]]; then',
    volumeLines || "      true",
    "      exit 0",
    "    fi",
    "    exit 1",
    "    ;;",
    "  exec)",
    execArgvLogPath ? `    printf '%s\\n' "$*" >> '${execArgvLogPath}' 2>/dev/null || true` : "    true",
    // Real `docker exec` refuses a flag it does not know, with exit 125 and
    // this message. The shim used to accept anything, so `docker exec -T` --
    // a `docker compose exec` flag that plain `docker exec` has never had --
    // passed every test here and failed on every real deployment (#607). A
    // fake producer that is more permissive than the real one cannot catch
    // the code drifting away from it, so this branch is deliberately strict.
    '    exec_args=("${@:2}")',
    "    exec_idx=0",
    '    while (( exec_idx < ${#exec_args[@]} )); do',
    '      exec_arg="${exec_args[exec_idx]}"',
    '      case "$exec_arg" in',
    "        --env|--user|--workdir|--env-file|--detach-keys) exec_idx=$((exec_idx + 2)) ;;",
    "        --detach|--interactive|--tty|--privileged) exec_idx=$((exec_idx + 1)) ;;",
    '        --*) printf "unknown flag: %s\\n" "$exec_arg" >&2; exit 125 ;;',
    "        -e|-u|-w) exec_idx=$((exec_idx + 2)) ;;",
    "        -*)",
    '          exec_rest="${exec_arg#-}"',
    '          for (( exec_c = 0; exec_c < ${#exec_rest}; exec_c++ )); do',
    '            case "${exec_rest:exec_c:1}" in',
    "              d|i|t) ;;",
    '              *) printf "unknown shorthand flag: \x27%s\x27 in -%s\\n" "${exec_rest:exec_c:1}" "${exec_rest:exec_c:1}" >&2; exit 125 ;;',
    "            esac",
    "          done",
    "          exec_idx=$((exec_idx + 1))",
    "          ;;",
    "        *) break ;;",
    "      esac",
    "    done",
    '    joined="$*"',
    '    if [[ "$joined" == *"pg_isready"* ]]; then',
    `      exit ${dbReadyExit}`,
    "    fi",
    // The rotate-credential step's script-mode invocation
    // (`psql -v ON_ERROR_STOP=1 ... -f -`) is fingerprinted by the literal
    // trailing " -f -" token, never by SQL text (there is none in argv —
    // that is exactly the property under test). This exec call is the ONLY
    // one repair.sh ever pipes real stdin content into, so reading it here
    // is safe: the other exec branches below never touch stdin, and so
    // never race with repair.sh's own prompt reads on its primary stdin.
    '    if [[ "$joined" == *" -f -"* ]]; then',
    execStdinLogPath ? `      cat > '${execStdinLogPath}'` : "      cat > /dev/null",
    alterRoleExit === 0 && dbAuthMarkerPath ? `      : > '${dbAuthMarkerPath}'` : "      true",
    `      exit ${alterRoleExit}`,
    "    fi",
    // issue #528 migration-failed backstop: fingerprinted by the literal
    // table name, checked BEFORE the generic *psql* branch below (which
    // would otherwise also match this call and answer with the unrelated
    // SELECT-1 authResult instead).
    '    if [[ "$joined" == *"orbit_migration_runs"* ]]; then',
    `      ${migrationRunLine}`,
    `      exit ${migrationRunExit}`,
    "    fi",
    // issue #610: the official Postgres image's pg_hba.conf trusts loopback
    // unconditionally (`host all all 127.0.0.1/32 trust`), so a probe that
    // dials 127.0.0.1/::1/localhost would be accepted no matter what
    // password it supplied — `database-credential-mismatch` could never
    // fire on a real deployment. This mirrors that trust rule here so a
    // repair.sh regression back to dialing loopback (instead of the
    // compose service name) makes every credential-mismatch fixture below
    // report healthy, and those tests fail (#610).
    '    if [[ "$joined" == *"127.0.0.1"* || "$joined" == *"::1"* || "$joined" == *"localhost"* ]]; then',
    "      exit 0",
    "    fi",
    '    if [[ "$joined" == *"psql"* ]]; then',
    dbAuthMarkerPath
      ? `      effective_auth_result="${authResult}"; [[ -e '${dbAuthMarkerPath}' ]] && effective_auth_result=ok`
      : `      effective_auth_result="${authResult}"`,
    '      case "$effective_auth_result" in',
    "        ok) exit 0 ;;",
    "        mismatch)",
    // Deliberately echoes the (env-forwarded) PGPASSWORD value into stderr,
    // as a hostile/leaky client might, so tests can prove repair.sh never
    // re-emits captured subprocess output even in the worst case.
    "          printf 'psql: error: connection to server at \"127.0.0.1\", port 5432 failed: FATAL:  password authentication failed for user \"orbit\" (shim-saw-password=%s)\\n' \"${PGPASSWORD:-}\" >&2",
    "          exit 2",
    "          ;;",
    "        *)",
    "          printf 'psql: error: connection to server at \"127.0.0.1\", port 5432 failed: could not translate host name\\n' >&2",
    "          exit 1",
    "          ;;",
    "      esac",
    "    fi",
    "    exit 1",
    "    ;;",
    "  logs)",
    // The app's own operational log, so a refusal to start over the database
    // can be told apart from a generic unhealthy container (#437).
    `    printf '%s\\n' '${appLog}'`,
    "    exit 0",
    "    ;;",
    "  inspect)",
    // issue #528 Step 13: `docker inspect --format '{{.Image}}' <id>` — the
    // running container's actual image ID — is a distinct call from Step
    // 12's combined Config.Image/Health format just below, so it must be
    // routed first.
    '    if [[ "${3:-}" == "{{.Image}}" ]]; then',
    `      printf '%s\\n' '${appImageId}'`,
    "      exit 0",
    "    fi",
    `    app_health="$(${appHealthExpr})"`,
    `    printf '%s|%s\\n' '${appImage}' "$app_health"`,
    "    exit 0",
    "    ;;",
    "  image)",
    // issue #528 Step 13: `docker image inspect --format '{{.Id}}' <ref>` —
    // the locally-present image for the pinned reference. Absent by default
    // (imageInspectPresent=false), simulating a pinned image never pulled
    // locally, so Step 13 skips (never guesses) unless a test opts in.
    '    if [[ "${2:-}" == "inspect" ]]; then',
    imageInspectPresent ? `      printf '%s\\n' '${imageInspectId}'` : "      true",
    imageInspectPresent ? "      exit 0" : "      exit 1",
    "    fi",
    "    exit 1",
    "    ;;",
    "  restart)",
    restartFails ? "    exit 1" : healthMarkerPath ? `    : > '${healthMarkerPath}'` : "    exit 0",
    healthMarkerPath && !restartFails ? "    exit 0" : "",
    "    ;;",
    "esac",
    "exit 1",
    "",
  ].join("\n");
}

function makeFakeBin(dockerOptions) {
  const binDir = mkdtempSync(join(tmpdir(), "orbit-repair-fakebin-"));
  scratchDirs.push(binDir);
  writeFileSync(join(binDir, "docker"), dockerShimScript(dockerOptions));
  chmodSync(join(binDir, "docker"), 0o755);
  return binDir;
}

// Builds a target directory that repair.sh --check reports as fully
// healthy: recognized managed files, a valid .orbit-secrets with all four
// managed secrets, and (when `withConfigure` is true) a configure.sh that
// reports the deployment as ready.
function makeFixture({ withConfigure = true, withComposeAndEnv = true, withSecrets = true } = {}) {
  const targetDir = scratchDir();
  mkdirSync(join(targetDir, "scripts"));
  writeFileSync(join(targetDir, "scripts", "repair.sh"), repairScriptSource);
  chmodSync(join(targetDir, "scripts", "repair.sh"), 0o755);
  if (withConfigure) {
    writeFileSync(join(targetDir, "scripts", "configure.sh"), configureScriptSource);
    chmodSync(join(targetDir, "scripts", "configure.sh"), 0o755);
    writeFileSync(join(targetDir, "scripts", "installer-ui.sh"), installerUiSource);
    chmodSync(join(targetDir, "scripts", "installer-ui.sh"), 0o755);
    writeFileSync(join(targetDir, ".env-orbit.example"), environmentExampleSource);
  }
  if (withComposeAndEnv) {
    writeFileSync(join(targetDir, "docker-compose.yml"), "services:\n  orbit-app:\n    image: busybox\n");
    const envLines = [
      "APP_URL=https://orbit.repair-test.internal",
      "ORBIT_IMAGE=orbit-local:abcdef123456",
      "OIDC_ISSUER=https://auth.repair-test.internal/application/o/orbit/",
      "OIDC_CLIENT_ID=repair-test-client",
      "OIDC_CLIENT_SECRET=repair-test-secret",
      "OIDC_CALLBACK_URL=https://orbit.repair-test.internal/api/auth/callback",
      "COMPOSE_PROJECT_NAME=repairtest",
      "",
    ].join("\n");
    writeFileSync(join(targetDir, ".env-orbit"), envLines);
    chmodSync(join(targetDir, ".env-orbit"), 0o600);
  }
  if (withSecrets) {
    mkdirSync(join(targetDir, ".orbit-secrets"), { mode: 0o700 });
    for (const name of ["session-secret", "postgres-password", "document-kek", "oidc-client-secret"]) {
      writeFileSync(join(targetDir, ".orbit-secrets", name), "a".repeat(64) + "\n");
      chmodSync(join(targetDir, ".orbit-secrets", name), 0o600);
    }
  }
  return targetDir;
}

// Overwrites .env-orbit with a digest-pinned ORBIT_IMAGE (the shape
// stale-container comparisons require — see the regex in
// check_application_container in repair.sh). makeFixture()'s default
// ORBIT_IMAGE ("orbit-local:abcdef123456") is deliberately not
// digest-pinned so ordinary tests never accidentally exercise this
// comparison.
function writeDigestPinnedEnv(targetDir, orbitImage) {
  const envLines = [
    "APP_URL=https://orbit.repair-test.internal",
    `ORBIT_IMAGE=${orbitImage}`,
    "OIDC_ISSUER=https://auth.repair-test.internal/application/o/orbit/",
    "OIDC_CLIENT_ID=repair-test-client",
    "OIDC_CLIENT_SECRET=repair-test-secret",
    "OIDC_CALLBACK_URL=https://orbit.repair-test.internal/api/auth/callback",
    "COMPOSE_PROJECT_NAME=repairtest",
    "",
  ].join("\n");
  writeFileSync(join(targetDir, ".env-orbit"), envLines);
  chmodSync(join(targetDir, ".env-orbit"), 0o600);
}

// Overwrites .env-orbit with a file-backed OIDC_CLIENT_SECRET_FILE instead
// of makeFixture()'s default direct OIDC_CLIENT_SECRET value — the shape
// every real install.sh deployment actually produces. Backed by the
// .orbit-secrets/oidc-client-secret file makeFixture() already writes, so
// no other setup is needed. A targeted overwrite (mirroring
// writeDigestPinnedEnv above), not a makeFixture() option: makeFixture() is
// shared by ~170 other tests that rely on its direct-secret default, and
// this shape is only relevant to the configuration-migration-interrupted
// tests below (issue #529 follow-up — the staged-directory validation this
// replaced could never see this shape, since it deliberately omitted
// .orbit-secrets).
function writeFileBackedOidcSecretEnv(targetDir) {
  const envLines = [
    "APP_URL=https://orbit.repair-test.internal",
    "ORBIT_IMAGE=orbit-local:abcdef123456",
    "OIDC_ISSUER=https://auth.repair-test.internal/application/o/orbit/",
    "OIDC_CLIENT_ID=repair-test-client",
    "OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret",
    "OIDC_CALLBACK_URL=https://orbit.repair-test.internal/api/auth/callback",
    "COMPOSE_PROJECT_NAME=repairtest",
    "",
  ].join("\n");
  writeFileSync(join(targetDir, ".env-orbit"), envLines);
  chmodSync(join(targetDir, ".env-orbit"), 0o600);
}

function runRepair(targetDir, args, dockerOptions = {}, { input, env } = {}) {
  const binDir = makeFakeBin(dockerOptions);
  return spawnSync("bash", [join(targetDir, "scripts", "repair.sh"), ...args], {
    cwd: targetDir,
    encoding: "utf8",
    input,
    env: { PATH: `${binDir}:${process.env.PATH}`, HOME: process.env.HOME ?? tmpdir(), ...env },
  });
}

// Async counterpart to runRepair, for tests that need to interact with a
// still-running repair.sh — e.g. sending it input, waiting for a specific
// prompt to appear, and THEN signaling it — none of which spawnSync (fully
// synchronous, all input supplied upfront) can express.
function spawnRepair(targetDir, args, dockerOptions = {}, { env } = {}) {
  const binDir = makeFakeBin(dockerOptions);
  const child = spawn("bash", [join(targetDir, "scripts", "repair.sh"), ...args], {
    cwd: targetDir,
    env: { PATH: `${binDir}:${process.env.PATH}`, HOME: process.env.HOME ?? tmpdir(), ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => {
    child.on("close", (status, signal) => resolve({ status, signal, stdoutText: () => stdout, stderrText: () => stderr }));
  });
  return { child, exited, stdoutSoFar: () => stdout, stderrSoFar: () => stderr };
}

// Resolves once `predicate(accumulatedStderr)` first becomes true, or
// rejects after `timeoutMs` — used to wait for a specific prompt to appear
// on a spawnRepair() child's stderr before acting on it (e.g. sending a
// signal), without a fixed sleep.
function waitForStderr(spawned, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (predicate(spawned.stderrSoFar())) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error("Timed out waiting for stderr predicate")), timeoutMs);
    const handler = () => {
      if (predicate(spawned.stderrSoFar())) {
        clearTimeout(timer);
        spawned.child.stderr.off("data", handler);
        resolve();
      }
    };
    spawned.child.stderr.on("data", handler);
  });
}

// Snapshots every path/mode/mtime under targetDir, for asserting "zero
// mutation" (declined/EOF confirmation, or a not-in-safe-set-only plan)
// the same way the --check suite above already does.
function treeSnapshot(targetDir) {
  return spawnSync("find", [targetDir, "-printf", "%p %m %T@\n"], { encoding: "utf8" }).stdout;
}

function lines(stdout) {
  return stdout.split("\n").filter(Boolean);
}

describe("scripts/repair.sh --check", () => {
  it("rejects an invocation without --check", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, []);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
    expect(result.stdout).toBe("");
  });

  it("rejects an unrecognised argument", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });

  it("tolerates --plain in either order around --check", () => {
    const targetDir = makeFixture();
    const first = runRepair(targetDir, ["--check", "--plain"]);
    const second = runRepair(targetDir, ["--plain", "--check"]);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.stdout).toBe(second.stdout);
  });

  it("reports a fully healthy sandbox with exit 0 and no findings", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(0);
    expect(lines(result.stdout)).toEqual(["diagnosis result=healthy checked=17 skipped=0"]);
  });

  it("never emits ANSI or cursor-control bytes", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--check"]);
    expect(result.stdout).not.toMatch(/\x1b/u);
    expect(result.stderr).not.toMatch(/\x1b/u);
  });

  it("produces byte-identical output across repeated runs", () => {
    const targetDir = makeFixture();
    const first = runRepair(targetDir, ["--check"]);
    const second = runRepair(targetDir, ["--check"]);
    expect(first.stdout).toBe(second.stdout);
    expect(first.status).toBe(second.status);
  });

  it("never mutates the sandbox tree (identical path/mode/mtime snapshot before and after)", () => {
    const targetDir = makeFixture();
    const before = spawnSync("find", [targetDir, "-printf", "%p %m %T@\n"], { encoding: "utf8" });
    const result = runRepair(targetDir, ["--check"]);
    const after = spawnSync("find", [targetDir, "-printf", "%p %m %T@\n"], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(after.stdout).toBe(before.stdout);
  });

  it("reports not-orbit-directory and exits 5 for a directory with no Orbit fingerprint", () => {
    const targetDir = scratchDir();
    mkdirSync(join(targetDir, "scripts"));
    writeFileSync(join(targetDir, "scripts", "repair.sh"), repairScriptSource);
    chmodSync(join(targetDir, "scripts", "repair.sh"), 0o755);

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(5);
    expect(lines(result.stdout)).toEqual([
      "finding class=not-orbit-directory target=directory severity=fail",
      "diagnosis result=failed checked=1 skipped=16",
    ]);
  });

  it("reports managed-file-missing for an absent .env-orbit", () => {
    const targetDir = makeFixture({ withConfigure: false });
    rmSync(join(targetDir, ".env-orbit"));

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=managed-file-missing target=environment-file severity=fail");
    expect(result.stdout).toContain("diagnosis result=failed");
  });

  it("reports managed-file-symlink for a symlinked .env-orbit", () => {
    const targetDir = makeFixture({ withConfigure: false });
    const realFile = join(targetDir, "real-env-orbit");
    writeFileSync(realFile, "APP_URL=https://orbit.repair-test.internal\n");
    chmodSync(realFile, 0o600);
    rmSync(join(targetDir, ".env-orbit"));
    symlinkSync(realFile, join(targetDir, ".env-orbit"));

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=managed-file-symlink target=environment-file severity=fail");
  });

  it("reports managed-file-permissions for a loosely-permissioned .env-orbit", () => {
    const targetDir = makeFixture({ withConfigure: false });
    chmodSync(join(targetDir, ".env-orbit"), 0o644);

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=managed-file-permissions target=environment-file severity=fail");
  });

  it("reports secrets-directory-invalid for a wrong-permission .orbit-secrets", () => {
    const targetDir = makeFixture({ withConfigure: false });
    chmodSync(join(targetDir, ".orbit-secrets"), 0o755);

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=secrets-directory-invalid target=secrets-directory severity=fail");
  });

  it("reports secrets-directory-invalid for a symlinked .orbit-secrets", () => {
    const targetDir = makeFixture({ withConfigure: false });
    const realDir = join(targetDir, "real-secrets");
    mkdirSync(realDir, { mode: 0o700 });
    rmSync(join(targetDir, ".orbit-secrets"), { recursive: true, force: true });
    symlinkSync(realDir, join(targetDir, ".orbit-secrets"));

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=secrets-directory-invalid target=secrets-directory severity=fail");
  });

  it("reports secret-missing (warn) for an absent managed secret file", () => {
    const targetDir = makeFixture({ withConfigure: false });
    rmSync(join(targetDir, ".orbit-secrets", "document-kek"));

    const result = runRepair(targetDir, ["--check"]);

    expect(result.stdout).toContain("finding class=secret-missing target=document-kek severity=warn");
  });

  it("reports secret-missing (warn) for an empty managed secret file", () => {
    const targetDir = makeFixture({ withConfigure: false });
    writeFileSync(join(targetDir, ".orbit-secrets", "session-secret"), "");

    const result = runRepair(targetDir, ["--check"]);

    expect(result.stdout).toContain("finding class=secret-missing target=session-secret severity=warn");
  });

  it("reports secret-permissions (fail) for a loosely-permissioned secret file", () => {
    const targetDir = makeFixture({ withConfigure: false });
    chmodSync(join(targetDir, ".orbit-secrets", "postgres-password"), 0o644);

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=secret-permissions target=postgres-password severity=fail");
  });

  it("reports secret-permissions (fail) for a symlinked secret file", () => {
    const targetDir = makeFixture({ withConfigure: false });
    const realFile = join(targetDir, "real-document-kek");
    writeFileSync(realFile, "b".repeat(64));
    chmodSync(realFile, 0o600);
    rmSync(join(targetDir, ".orbit-secrets", "document-kek"));
    symlinkSync(realFile, join(targetDir, ".orbit-secrets", "document-kek"));

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=secret-permissions target=document-kek severity=fail");
  });

  it("reports staging-evidence-present (warn) for a leftover installer staging directory", () => {
    const targetDir = makeFixture();
    mkdirSync(join(targetDir, ".orbit-install-staging.abcdef"), { mode: 0o700 });

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(3);
    expect(lines(result.stdout)).toEqual([
      "finding class=staging-evidence-present target=staging severity=warn",
      "diagnosis result=attention checked=17 skipped=0",
    ]);
  });

  it("reports configuration-incomplete when configure.sh --check fails without stderr output", () => {
    const targetDir = makeFixture();
    writeFileSync(
      join(targetDir, ".env-orbit"),
      "APP_URL=https://orbit.repair-test.internal\n",
    );
    chmodSync(join(targetDir, ".env-orbit"), 0o600);

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=configuration-incomplete target=configuration severity=fail");
  });

  it("reports configuration-invalid when configure.sh --check fails with stderr output", () => {
    const targetDir = makeFixture();
    chmodSync(join(targetDir, ".env-orbit"), 0o644);

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=configuration-invalid target=configuration severity=fail");
  });

  // --- configuration-migration-interrupted (ADR-0014 decision 7, issue #529) -

  it("reports configuration-migration-interrupted instead of configuration-invalid when a valid .orbit-config.rollback copy exists", () => {
    const targetDir = makeFixture();
    const goodEnv = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    writeFileSync(join(targetDir, ".env-orbit.orbit-config.rollback"), goodEnv);
    chmodSync(join(targetDir, ".env-orbit.orbit-config.rollback"), 0o600);
    chmodSync(join(targetDir, ".env-orbit"), 0o644); // live fails validation

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(4);
    expect(result.stdout).toContain(
      "finding class=configuration-migration-interrupted target=configuration severity=fail",
    );
    expect(result.stdout).not.toContain("configuration-invalid");
    expect(result.stdout).not.toContain("configuration-incomplete");
  });

  it("fires on the file-backed OIDC_CLIENT_SECRET_FILE shape a real install produces (issue #529 follow-up)", () => {
    const targetDir = makeFixture();
    writeFileBackedOidcSecretEnv(targetDir);
    const goodEnv = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    writeFileSync(join(targetDir, ".env-orbit.orbit-config.rollback"), goodEnv);
    chmodSync(join(targetDir, ".env-orbit.orbit-config.rollback"), 0o600);
    // Live fails validation (content-incomplete, not mode-644, so this
    // exercises the same file-backed-secret shape on both sides without a
    // managed-file-permissions finding also firing).
    writeFileSync(join(targetDir, ".env-orbit"), "APP_URL=https://orbit.repair-test.internal\n");
    chmodSync(join(targetDir, ".env-orbit"), 0o600);

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(4);
    expect(result.stdout).toContain(
      "finding class=configuration-migration-interrupted target=configuration severity=fail",
    );
  });

  it("reports plain configuration-invalid, unchanged, when the live file fails validation and no rollback copy exists", () => {
    const targetDir = makeFixture();
    chmodSync(join(targetDir, ".env-orbit"), 0o644);
    expect(existsSync(join(targetDir, ".env-orbit.orbit-config.rollback"))).toBe(false);

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=configuration-invalid target=configuration severity=fail");
    expect(result.stdout).not.toContain("configuration-migration-interrupted");
  });

  it("does not report configuration-migration-interrupted when the rollback copy also fails validation", () => {
    const targetDir = makeFixture();
    writeFileSync(join(targetDir, ".env-orbit.orbit-config.rollback"), "APP_URL=https://orbit.repair-test.internal\n");
    chmodSync(join(targetDir, ".env-orbit.orbit-config.rollback"), 0o600);
    chmodSync(join(targetDir, ".env-orbit"), 0o644);

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=configuration-invalid target=configuration severity=fail");
    expect(result.stdout).not.toContain("configuration-migration-interrupted");
  });

  it("does not report configuration-migration-interrupted when the rollback copy is a symlink", () => {
    const targetDir = makeFixture();
    const goodEnv = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    writeFileSync(join(targetDir, ".env-orbit.real-rollback"), goodEnv);
    chmodSync(join(targetDir, ".env-orbit.real-rollback"), 0o600);
    symlinkSync(join(targetDir, ".env-orbit.real-rollback"), join(targetDir, ".env-orbit.orbit-config.rollback"));
    chmodSync(join(targetDir, ".env-orbit"), 0o644);

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=configuration-invalid target=configuration severity=fail");
    expect(result.stdout).not.toContain("configuration-migration-interrupted");
  });

  it("a stale rollback copy next to an already-healthy live .env-orbit produces no finding", () => {
    const targetDir = makeFixture();
    const goodEnv = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    writeFileSync(join(targetDir, ".env-orbit.orbit-config.rollback"), goodEnv);
    chmodSync(join(targetDir, ".env-orbit.orbit-config.rollback"), 0o600);

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(0);
    expect(lines(result.stdout)).toEqual(["diagnosis result=healthy checked=17 skipped=0"]);
  });

  it("the .orbit-config.rollback suffix literal agrees across configuration.sh (writes it), repair.sh (restores it), and configure.sh (checks it) — ADR-0014 decision 7's mirroring bargain", () => {
    const extractReadonlyString = (source, varName) => {
      const match = source.match(new RegExp(`readonly ${varName}=("[^"]*")`));
      if (!match) {
        throw new Error(`Could not find "readonly ${varName}=" in the given source`);
      }
      return JSON.parse(match[1]);
    };

    const fromConfiguration = extractReadonlyString(configurationScriptSource, "rollback_suffix");
    const fromRepair = extractReadonlyString(repairScriptSource, "configuration_rollback_suffix");
    const fromConfigure = extractReadonlyString(configureScriptSource, "configuration_rollback_suffix");

    expect(fromConfiguration).toBe(".orbit-config.rollback");
    expect(fromRepair).toBe(fromConfiguration);
    expect(fromConfigure).toBe(fromConfiguration);
  });

  it("reports compose-interpolation-failed when docker compose config fails", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--check"], { composeFails: true });

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=compose-interpolation-failed target=compose severity=fail");
  });

  it("reports volume-retained-without-credentials for the #261 fixed-project collision", () => {
    const targetDir = makeFixture();
    rmSync(join(targetDir, ".orbit-secrets", "postgres-password"));

    const result = runRepair(targetDir, ["--check"], { volumes: ["repairtest_orbit-db-data"] });

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=secret-missing target=postgres-password severity=warn");
    expect(result.stdout).toContain(
      "finding class=volume-retained-without-credentials target=database-volume severity=fail",
    );
  });

  it("does not report volume-retained-without-credentials when the credential is present", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], { volumes: ["repairtest_orbit-db-data"] });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("volume-retained-without-credentials");
  });

  // --- ADR-0014 decision 5's second retention guard: document-kek --------

  it("reports document-volume-retained-without-key when a document volume is retained without document-kek", () => {
    const targetDir = makeFixture();
    rmSync(join(targetDir, ".orbit-secrets", "document-kek"));

    const result = runRepair(targetDir, ["--check"], { volumes: ["repairtest_orbit-documents-data"] });

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=secret-missing target=document-kek severity=warn");
    expect(result.stdout).toContain(
      "finding class=document-volume-retained-without-key target=document-volume severity=fail",
    );
  });

  it("does not report document-volume-retained-without-key when document-kek is present", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], { volumes: ["repairtest_orbit-documents-data"] });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("document-volume-retained-without-key");
  });

  it("does not cross-wire the two retention guards: a retained database volume alone never reports document-volume-retained-without-key, and vice versa", () => {
    const targetDir = makeFixture();
    rmSync(join(targetDir, ".orbit-secrets", "postgres-password"));
    rmSync(join(targetDir, ".orbit-secrets", "document-kek"));

    const result = runRepair(targetDir, ["--check"], { volumes: ["repairtest_orbit-db-data"] });

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=volume-retained-without-credentials target=database-volume severity=fail");
    expect(result.stdout).not.toContain("document-volume-retained-without-key");
  });

  it("reports unrelated-resource-present for a document volume belonging to a different Compose project", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], { volumes: ["someother_orbit-documents-data"] });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("finding class=unrelated-resource-present target=document-volume severity=info");
  });

  it("reports unrelated-resource-present for a volume belonging to a different Compose project", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], { volumes: ["someother_orbit-db-data"] });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("finding class=unrelated-resource-present target=database-volume severity=info");
  });

  it("reports container-foreign-owner for a container in-project without a known Orbit service label", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], {
      containers: [{ id: "0123456789ab", service: "not-an-orbit-service" }],
    });

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=container-foreign-owner target=container severity=fail");
  });

  it("does not report container-foreign-owner for a recognized Orbit service", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], {
      containers: [{ id: "0123456789ab", service: "orbit-db" }],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("container-foreign-owner");
  });

  it("reports docker-unavailable for every docker-backed check when docker cannot be used", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], { unavailable: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("finding class=docker-unavailable target=compose severity=info");
    expect(result.stdout).toContain("finding class=docker-unavailable target=database-volume severity=info");
    expect(result.stdout).toContain("finding class=docker-unavailable target=document-volume severity=info");
    expect(result.stdout).toContain("finding class=docker-unavailable target=container severity=info");
    expect(result.stdout).toContain("finding class=docker-unavailable target=database severity=info");
    expect(result.stdout).toContain("finding class=docker-unavailable target=application severity=info");
    expect(result.stdout).toContain("finding class=docker-unavailable target=image severity=info");
    expect(lines(result.stdout).at(-1)).toBe("diagnosis result=healthy checked=10 skipped=7");
  });

  it("groups findings by the fixed class order regardless of discovery order", () => {
    const targetDir = makeFixture();
    // Triggers, in filesystem-discovery order: secret-missing (step 3) before
    // staging-evidence-present (step 4) before compose-interpolation-failed
    // (step 8) — but the fixed class order prints managed-file-* classes
    // ahead of secret-missing, and staging-evidence-present ahead of
    // compose-interpolation-failed, regardless of check execution order.
    rmSync(join(targetDir, ".orbit-secrets", "session-secret"));
    mkdirSync(join(targetDir, ".orbit-install-staging.xyz"), { mode: 0o700 });

    const result = runRepair(targetDir, ["--check"], { composeFails: true });
    const findingClasses = lines(result.stdout)
      .filter((line) => line.startsWith("finding "))
      .map((line) => line.match(/class=([a-z-]+)/u)[1]);

    expect(findingClasses).toEqual([
      "secret-missing",
      "staging-evidence-present",
      "compose-interpolation-failed",
    ]);
  });

  it("never discloses a path, configured value, or secret on stdout", () => {
    const targetDir = makeFixture();
    rmSync(join(targetDir, ".env-orbit"));

    const result = runRepair(targetDir, ["--check"]);

    expect(result.stdout).not.toContain(targetDir);
    expect(result.stdout).not.toContain("repair-test-secret");
    expect(result.stdout).not.toContain(".env-orbit");
  });

  // --- Slice 2 (issue #261): database and application container diagnosis --
  //
  // makeFixture()'s default dockerShimScript() options simulate a fully
  // healthy orbit-db + orbit-app (present, ready, authenticating, matching
  // image, healthy), which is why every test above this point — none of
  // which pass `db`/`app` docker options — stays healthy/unaffected by
  // these new checks. The tests below override just `db`/`app` to exercise
  // each new reason class in isolation.

  it("reports database-unreachable (fail) when the orbit-db container is absent", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], { db: { present: false } });

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=database-unreachable target=database severity=fail");
    expect(result.stdout).not.toContain("database-credential-mismatch");
  });

  it("reports database-unreachable (fail) when pg_isready does not succeed", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], { db: { present: true, ready: false } });

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=database-unreachable target=database severity=fail");
  });

  it("reports database-credential-mismatch (fail) for a 28P01-style auth failure — the motivating #261 failure", () => {
    const targetDir = makeFixture();
    const distinctPassword = "N0t-4-Re4l-Postgres-Password-XyZ99";
    writeFileSync(join(targetDir, ".orbit-secrets", "postgres-password"), `${distinctPassword}\n`);
    chmodSync(join(targetDir, ".orbit-secrets", "postgres-password"), 0o600);

    const result = runRepair(targetDir, ["--check"], {
      db: { present: true, ready: true, authResult: "mismatch" },
    });

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=database-credential-mismatch target=database severity=fail");
    expect(result.stdout).not.toContain("database-unreachable");
    expect(result.stdout).not.toContain(distinctPassword);
    expect(result.stderr).not.toContain(distinctPassword);
  });

  it("dials the compose service name for the authenticated probe, never loopback — #610", () => {
    const targetDir = makeFixture();
    const execArgvLogPath = join(scratchDir(), "exec-argv.log");

    const result = runRepair(targetDir, ["--check"], {
      db: { present: true, ready: true, authResult: "mismatch" },
      execArgvLogPath,
    });

    const execArgvLog = readFileSync(execArgvLogPath, "utf8");
    expect(execArgvLog).toContain("orbit-db");
    expect(execArgvLog).not.toContain("127.0.0.1");
    expect(result.stdout).toContain("finding class=database-credential-mismatch target=database severity=fail");
  });

  it("reports no database finding when pg_isready and authentication both succeed", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], {
      db: { present: true, ready: true, authResult: "ok" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("database-unreachable");
    expect(result.stdout).not.toContain("database-credential-mismatch");
  });

  it("reports database-unreachable (fail), not credential-mismatch, for a non-auth psql error", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], {
      db: { present: true, ready: true, authResult: "other-error" },
    });

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=database-unreachable target=database severity=fail");
    expect(result.stdout).not.toContain("database-credential-mismatch");
  });

  it("reports stale-container (warn) when the running app image does not match ORBIT_IMAGE", () => {
    const targetDir = makeFixture();
    const pinned = `ghcr.io/tomlawesome/orbit@sha256:${"a".repeat(64)}`;
    const running = `ghcr.io/tomlawesome/orbit@sha256:${"b".repeat(64)}`;
    writeDigestPinnedEnv(targetDir, pinned);

    const result = runRepair(targetDir, ["--check"], {
      app: { present: true, image: running, health: "healthy" },
    });

    expect(result.status).toBe(3);
    expect(result.stdout).toContain("finding class=stale-container target=container severity=warn");
  });

  it("does not report stale-container when the running app image matches ORBIT_IMAGE", () => {
    const targetDir = makeFixture();
    const pinned = `ghcr.io/tomlawesome/orbit@sha256:${"a".repeat(64)}`;
    writeDigestPinnedEnv(targetDir, pinned);

    const result = runRepair(targetDir, ["--check"], {
      app: { present: true, image: pinned, health: "healthy" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("stale-container");
  });

  it("does not report stale-container when ORBIT_IMAGE is not digest-pinned (nothing safe to compare)", () => {
    // makeFixture()'s default ORBIT_IMAGE ("orbit-local:abcdef123456") is a
    // local build tag, not a digest-pinned reference; the comparison must
    // stay silent rather than guess.
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], {
      app: { present: true, image: "something-else:latest", health: "healthy" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("stale-container");
  });

  // --- image-identity-mismatch (issue #528 slice C) -------------------------
  //
  // Distinct from stale-container above: this compares content-addressable
  // image IDs (docker inspect .Image on the container vs. docker image
  // inspect .Id on the pinned reference), not the Config.Image string.

  it("reports image-identity-mismatch (fail) when the running image ID differs from the locally pinned image", () => {
    const targetDir = makeFixture();
    const pinned = `ghcr.io/tomlawesome/orbit@sha256:${"a".repeat(64)}`;
    writeDigestPinnedEnv(targetDir, pinned);
    const runningId = "sha256:" + "1".repeat(64);
    const pinnedLocalId = "sha256:" + "2".repeat(64);

    const result = runRepair(targetDir, ["--check"], {
      app: { present: true, image: pinned, health: "healthy" },
      appImageId: runningId,
      imageInspect: { present: true, id: pinnedLocalId },
    });

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=image-identity-mismatch target=image severity=fail");
  });

  it("does not report image-identity-mismatch when the running image ID matches the locally pinned image", () => {
    const targetDir = makeFixture();
    const pinned = `ghcr.io/tomlawesome/orbit@sha256:${"a".repeat(64)}`;
    writeDigestPinnedEnv(targetDir, pinned);
    const sameId = "sha256:" + "3".repeat(64);

    const result = runRepair(targetDir, ["--check"], {
      app: { present: true, image: pinned, health: "healthy" },
      appImageId: sameId,
      imageInspect: { present: true, id: sameId },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("image-identity-mismatch");
  });

  it("skips image-identity-mismatch (never guesses) when the pinned image is not present locally", () => {
    const targetDir = makeFixture();
    const pinned = `ghcr.io/tomlawesome/orbit@sha256:${"a".repeat(64)}`;
    writeDigestPinnedEnv(targetDir, pinned);

    const result = runRepair(targetDir, ["--check"], {
      app: { present: true, image: pinned, health: "healthy" },
      appImageId: "sha256:" + "1".repeat(64),
      imageInspect: { present: false },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("image-identity-mismatch");
  });

  it("skips image-identity-mismatch when ORBIT_IMAGE is not digest-pinned", () => {
    // makeFixture()'s default ORBIT_IMAGE is not digest-pinned; even if a
    // mismatched local image happened to be configured, there is nothing
    // safe to compare against.
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], {
      app: { present: true, image: "something-else:latest", health: "healthy" },
      appImageId: "sha256:" + "1".repeat(64),
      imageInspect: { present: true, id: "sha256:" + "2".repeat(64) },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("image-identity-mismatch");
  });

  it("skips image-identity-mismatch when the app container does not exist", () => {
    const targetDir = makeFixture();
    const pinned = `ghcr.io/tomlawesome/orbit@sha256:${"a".repeat(64)}`;
    writeDigestPinnedEnv(targetDir, pinned);

    const result = runRepair(targetDir, ["--check"], {
      app: { present: false },
      imageInspect: { present: true, id: "sha256:" + "2".repeat(64) },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("image-identity-mismatch");
  });

  it("reports application-unhealthy (fail) when the app container's health status is unhealthy", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], { app: { present: true, health: "unhealthy" } });

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=application-unhealthy target=application severity=fail");
  });

  it("names a database the app refuses, rather than calling it unhealthy (#437)", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], {
      app: {
        present: true,
        health: "unhealthy",
        log: "ERROR orbit migrations startup.migration state=exhausted reason=database_mismatch action=attach_matching_database impact=migration_blocked",
      },
    });

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=database-schema-mismatch target=application severity=fail");
    // Reported INSTEAD of, not as well as: restarting cannot change either side.
    expect(result.stdout).not.toContain("application-unhealthy");
  });

  it("distinguishes a database below the supported floor (#437)", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], {
      app: {
        present: true,
        health: "unhealthy",
        log: "ERROR orbit migrations startup.migration state=exhausted reason=database_below_floor action=upgrade_from_supported_version impact=migration_blocked",
      },
    });

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=database-below-floor target=application severity=fail");
  });

  it("plans neither of those as a restart (#437)", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--plan"], {
      app: {
        present: true,
        health: "unhealthy",
        log: "reason=database_mismatch",
      },
    });

    expect(result.stdout).not.toContain("restart-services");
    expect(result.stdout).toContain("manual");
  });

  // --- migration-failed (issue #528 slice B) ---------------------------------
  //
  // Primary path: extends the existing #437 app-log sentinel scan with
  // `reason=migration_failed` (works on a stopped/crash-looping container).
  // Backstop: a single fixed-literal SELECT of the migrator's own outcome
  // bookkeeping row, sequenced strictly AFTER the sentinel scan and skipped
  // whenever that scan already reported; run only over the
  // already-authenticated SELECT-1 probe path (check_database_reachability
  // records the coordinates, the query itself fires after Step 12), for when
  // logs are rotated away or the container is gone entirely.

  it("reports migration-failed (fail) via the app-log sentinel scan on a crash-looping/stopped container", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], {
      app: {
        present: true,
        health: "unhealthy",
        log: "ERROR orbit migrations startup.migration state=exhausted reason=migration_failed impact=migration_blocked",
      },
    });

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=migration-failed target=application severity=fail");
    // Reported INSTEAD of, not as well as (same #437 discipline as the other
    // two sentinel-derived classes).
    expect(result.stdout).not.toContain("application-unhealthy");
  });

  it("keeps the sentinel scan primary: when both channels would report, the sentinel fires and the backstop SQL is never issued", () => {
    const targetDir = makeFixture();
    const logDir = scratchDir();
    const argvLogPath = join(logDir, "docker-argv.log");

    const result = runRepair(targetDir, ["--check"], {
      app: {
        present: true,
        health: "unhealthy",
        log: "ERROR orbit migrations startup.migration state=exhausted reason=migration_failed impact=migration_blocked",
      },
      migrationRun: { outcome: "failed", reason: "migration_error" },
      argvLogPath,
    });

    expect(result.status).toBe(4);
    // The finding comes from the log-sentinel channel (target=application),
    // never the SQL channel (target=database), and only once.
    const migrationFindingLines = lines(result.stdout).filter((line) => line.includes("class=migration-failed"));
    expect(migrationFindingLines).toHaveLength(1);
    expect(migrationFindingLines[0]).toContain("target=application");
    // The ordering proof: every docker invocation's argv is logged by the
    // shim, and the backstop's outcome-row query (fingerprinted by its
    // literal table name) must never have been issued at all.
    const argvLog = readFileSync(argvLogPath, "utf8");
    expect(argvLog).not.toContain("orbit_migration_runs");
  });

  it("falls back to the SQL backstop when the container is present but the sentinel has rotated out of its logs", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], {
      app: {
        present: true,
        health: "unhealthy",
        // The bounded --tail window no longer carries any startup sentinel:
        // exactly the rotated-logs case the backstop exists for.
        log: "unrelated recent log output only",
      },
      migrationRun: { outcome: "failed", reason: "migration_error" },
    });

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=migration-failed target=database severity=fail");
  });

  it("reports migration-failed (fail) via the SQL backstop when the app container is absent (logs unavailable)", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], {
      app: { present: false },
      migrationRun: { outcome: "failed", reason: "migration_error" },
    });

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=migration-failed target=database severity=fail");
  });

  it("does not report migration-failed (backstop) when the latest migration run succeeded", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], {
      app: { present: false },
      migrationRun: { outcome: "succeeded", reason: "" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("migration-failed");
  });

  it("does not report migration-failed (skip, never guess) when the outcome bookkeeping table does not exist yet", () => {
    const targetDir = makeFixture();

    // migrationRun left unset: the shim simulates `orbit_migration_runs` not
    // existing yet (a real psql ERROR, non-matching output).
    const result = runRepair(targetDir, ["--check"], { app: { present: false } });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("migration-failed");
  });

  it("does not report migration-failed (skip, never guess) for hostile backstop output that fails the strict enum pattern", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], {
      app: { present: false },
      migrationRunRaw: "not a valid enum row; DROP TABLE orbit_migration_runs; -- 12345",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("migration-failed");
  });

  it("emits at most one migration-failed finding when both the sentinel and the backstop would independently report it", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], {
      app: {
        present: true,
        health: "unhealthy",
        log: "reason=migration_failed",
      },
      migrationRun: { outcome: "failed", reason: "migration_error" },
    });

    expect(result.status).toBe(4);
    const migrationFindingLines = lines(result.stdout).filter((line) => line.includes("class=migration-failed"));
    expect(migrationFindingLines).toHaveLength(1);
  });

  it("retires the unsupported-schema reserved class name entirely (issue #528)", () => {
    expect(repairScriptSource).not.toContain("unsupported-schema");
  });

  it("does not report application-unhealthy while the app container is still starting", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], { app: { present: true, health: "starting" } });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("application-unhealthy");
  });

  it("does not report application-unhealthy when the app container has no healthcheck at all", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], { app: { present: true, health: "" } });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("application-unhealthy");
  });

  it("does not report a stale-container or application-unhealthy finding when the app container does not exist yet", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], { app: { present: false } });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("stale-container");
    expect(result.stdout).not.toContain("application-unhealthy");
  });

  it("never leaks the postgres-password secret value on stdout, stderr, or any docker argv, across every database scenario", () => {
    const distinctPassword = "Zx9-Very-Distinct-Postgres-Secret-Q7";
    const scenarios = [
      { db: { present: false } },
      { db: { present: true, ready: false } },
      { db: { present: true, ready: true, authResult: "mismatch" } },
      { db: { present: true, ready: true, authResult: "ok" } },
      { db: { present: true, ready: true, authResult: "other-error" } },
    ];

    for (const dockerOptions of scenarios) {
      const targetDir = makeFixture();
      writeFileSync(join(targetDir, ".orbit-secrets", "postgres-password"), `${distinctPassword}\n`);
      chmodSync(join(targetDir, ".orbit-secrets", "postgres-password"), 0o600);
      const logDir = scratchDir();
      const argvLogPath = join(logDir, "docker-argv.log");

      const result = runRepair(targetDir, ["--check"], { ...dockerOptions, argvLogPath });

      expect(result.stdout).not.toContain(distinctPassword);
      expect(result.stderr).not.toContain(distinctPassword);
      let argvLog = "";
      try {
        argvLog = readFileSync(argvLogPath, "utf8");
      } catch {
        argvLog = "";
      }
      expect(argvLog).not.toContain(distinctPassword);
    }
  });
});

// --- Slice 3 (issue #261): --plan — a proposed, classified repair plan ----
//
// --plan runs the identical read-only diagnosis as --check (same shims,
// same fixtures) and turns the resulting findings into `plan ...` lines
// instead of `finding ...` lines. These tests reuse makeFixture()/
// runRepair()/dockerShimScript() from the --check suite above rather than
// re-deriving fixture-building logic.

describe("scripts/repair.sh --plan", () => {
  it("rejects an invocation combining --check and --plan", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--check", "--plan"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
    expect(result.stdout).toBe("");
  });

  it("rejects an invocation combining --plan and --check (reverse order)", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--plan", "--check"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });

  it("reports an empty plan (exit 0) for a fully healthy sandbox", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--plan"]);

    expect(result.status).toBe(0);
    expect(lines(result.stdout)).toEqual(["plan result=empty actions=0 manual=0"]);
    expect(result.stderr).toBe("");
  });

  it("tolerates --plain in either order around --plan and produces identical output", () => {
    const targetDir = makeFixture();
    const first = runRepair(targetDir, ["--plan", "--plain"]);
    const second = runRepair(targetDir, ["--plain", "--plan"]);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.stdout).toBe(second.stdout);
  });

  it("never emits ANSI or cursor-control bytes under --plan", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--plan"]);
    expect(result.stdout).not.toMatch(/\x1b/u);
    expect(result.stderr).not.toMatch(/\x1b/u);
  });

  it("produces byte-identical --plan output across repeated runs", () => {
    const targetDir = makeFixture();
    const first = runRepair(targetDir, ["--plan"]);
    const second = runRepair(targetDir, ["--plan"]);
    expect(first.stdout).toBe(second.stdout);
    expect(first.status).toBe(second.status);
  });

  it("never mutates the sandbox tree under --plan (identical path/mode/mtime snapshot before and after)", () => {
    const targetDir = makeFixture();
    const before = spawnSync("find", [targetDir, "-printf", "%p %m %T@\n"], { encoding: "utf8" });
    const result = runRepair(targetDir, ["--plan"]);
    const after = spawnSync("find", [targetDir, "-printf", "%p %m %T@\n"], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(after.stdout).toBe(before.stdout);
  });

  it("plans not-an-orbit-installation as manual and still exits 5", () => {
    const targetDir = scratchDir();
    mkdirSync(join(targetDir, "scripts"));
    writeFileSync(join(targetDir, "scripts", "repair.sh"), repairScriptSource);
    chmodSync(join(targetDir, "scripts", "repair.sh"), 0o755);

    const result = runRepair(targetDir, ["--plan"]);

    expect(result.status).toBe(5);
    expect(lines(result.stdout)).toEqual([
      "plan action=manual resolves=not-orbit-directory mutation=none backup=not-required",
      "plan result=manual-required actions=0 manual=1",
    ]);
    expect(result.stderr).toContain("resolves=not-orbit-directory");
  });

  it("plans staging-evidence-present as restore-transaction (reversible, backup required)", () => {
    const targetDir = makeFixture();
    mkdirSync(join(targetDir, ".orbit-install-staging.abcdef"), { mode: 0o700 });

    const result = runRepair(targetDir, ["--plan"]);

    expect(result.status).toBe(3);
    expect(result.stdout).toContain(
      "plan action=restore-transaction resolves=staging-evidence-present mutation=reversible backup=required",
    );
    expect(lines(result.stdout).at(-1)).toBe("plan result=ready actions=1 manual=0");
  });

  it("plans managed-file-permissions as fix-permissions (reversible, no backup needed)", () => {
    const targetDir = makeFixture({ withConfigure: false });
    chmodSync(join(targetDir, ".env-orbit"), 0o644);

    const result = runRepair(targetDir, ["--plan"]);

    expect(result.status).toBe(3);
    expect(result.stdout).toContain(
      "plan action=fix-permissions resolves=managed-file-permissions mutation=reversible backup=not-required",
    );
  });

  it("plans secrets-directory-invalid as fix-permissions", () => {
    const targetDir = makeFixture({ withConfigure: false });
    chmodSync(join(targetDir, ".orbit-secrets"), 0o755);

    const result = runRepair(targetDir, ["--plan"]);

    expect(result.status).toBe(3);
    expect(result.stdout).toContain(
      "plan action=fix-permissions resolves=secrets-directory-invalid mutation=reversible backup=not-required",
    );
  });

  it("plans secret-permissions as fix-permissions", () => {
    const targetDir = makeFixture({ withConfigure: false });
    chmodSync(join(targetDir, ".orbit-secrets", "postgres-password"), 0o644);

    const result = runRepair(targetDir, ["--plan"]);

    expect(result.status).toBe(3);
    expect(result.stdout).toContain(
      "plan action=fix-permissions resolves=secret-permissions mutation=reversible backup=not-required",
    );
  });

  it("plans a missing non-database secret as regenerate-secret (no backup needed)", () => {
    const targetDir = makeFixture({ withConfigure: false });
    rmSync(join(targetDir, ".orbit-secrets", "session-secret"));

    const result = runRepair(targetDir, ["--plan"]);

    expect(result.status).toBe(3);
    expect(result.stdout).toContain(
      "plan action=regenerate-secret resolves=secret-missing mutation=reversible backup=not-required",
    );
  });

  it("plans a missing postgres-password as regenerate-secret when no volume is retained", () => {
    const targetDir = makeFixture();
    rmSync(join(targetDir, ".orbit-secrets", "postgres-password"));

    // No `volumes` option passed to the docker shim: nothing is retained.
    const result = runRepair(targetDir, ["--plan"]);

    expect(result.status).toBe(3);
    expect(result.stdout).toContain(
      "plan action=regenerate-secret resolves=secret-missing mutation=reversible backup=not-required",
    );
    expect(result.stdout).not.toContain("rotate-database-credential");
  });

  it("plans a missing postgres-password as rotate-database-credential (never regenerate-secret) when the volume is retained — the #261 fixed-project collision", () => {
    const targetDir = makeFixture();
    rmSync(join(targetDir, ".orbit-secrets", "postgres-password"));

    const result = runRepair(targetDir, ["--plan"], { volumes: ["repairtest_orbit-db-data"] });

    expect(result.status).toBe(3);
    const planLines = lines(result.stdout).filter((line) => line.startsWith("plan action="));
    expect(planLines).toEqual([
      "plan action=rotate-database-credential resolves=secret-missing mutation=credential-rotation backup=required",
      "plan action=rotate-database-credential resolves=volume-retained-without-credentials mutation=credential-rotation backup=required",
    ]);
    expect(result.stdout).not.toContain("regenerate-secret");
    expect(lines(result.stdout).at(-1)).toBe("plan result=ready actions=2 manual=0");
  });

  it("plans volume-retained-without-credentials as rotate-database-credential when the secrets directory itself is invalid", () => {
    const targetDir = makeFixture({ withConfigure: false });
    chmodSync(join(targetDir, ".orbit-secrets"), 0o755);

    const result = runRepair(targetDir, ["--plan"], { volumes: ["repairtest_orbit-db-data"] });

    expect(result.stdout).toContain(
      "plan action=rotate-database-credential resolves=volume-retained-without-credentials mutation=credential-rotation backup=required",
    );
    // secrets-directory-invalid suppresses the individual secret-missing check
    // (see repair.sh Step 3), so only one rotate-database-credential line
    // appears here, alongside the fix-permissions line for the directory itself.
    expect(result.stdout).toContain(
      "plan action=fix-permissions resolves=secrets-directory-invalid mutation=reversible backup=not-required",
    );
  });

  // --- ADR-0014 decision 5's second retention guard: document-kek plans as
  // manual, never regenerate-secret, when a document volume is retained ----

  it("plans a missing document-kek as manual (never regenerate-secret) when a document volume is retained", () => {
    const targetDir = makeFixture();
    rmSync(join(targetDir, ".orbit-secrets", "document-kek"));

    const result = runRepair(targetDir, ["--plan"], { volumes: ["repairtest_orbit-documents-data"] });

    expect(result.status).toBe(4);
    const planLines = lines(result.stdout).filter((line) => line.startsWith("plan action="));
    expect(planLines).toEqual([
      "plan action=manual resolves=secret-missing mutation=none backup=not-required",
      "plan action=manual resolves=document-volume-retained-without-key mutation=none backup=not-required",
    ]);
    expect(result.stdout).not.toContain("regenerate-secret");
    expect(result.stderr).toContain("manual step:");
    expect(result.stderr).toContain("document-kek");
    expect(lines(result.stdout).at(-1)).toBe("plan result=manual-required actions=0 manual=2");
  });

  it("plans a missing document-kek as regenerate-secret when no document volume is retained", () => {
    const targetDir = makeFixture();
    rmSync(join(targetDir, ".orbit-secrets", "document-kek"));

    // No `volumes` option passed to the docker shim: nothing is retained.
    const result = runRepair(targetDir, ["--plan"]);

    expect(result.status).toBe(3);
    expect(result.stdout).toContain(
      "plan action=regenerate-secret resolves=secret-missing mutation=reversible backup=not-required",
    );
    expect(result.stdout).not.toContain("document-volume-retained-without-key");
    expect(result.stdout).not.toContain("action=manual");
  });

  it("does not cross-wire the two retention guards in planning: a retained document volume never routes postgres-password away from regenerate-secret, and a retained database volume never routes document-kek to manual", () => {
    const targetDir = makeFixture();
    rmSync(join(targetDir, ".orbit-secrets", "postgres-password"));
    rmSync(join(targetDir, ".orbit-secrets", "document-kek"));

    const result = runRepair(targetDir, ["--plan"], {
      volumes: ["repairtest_orbit-documents-data"],
    });

    expect(result.stdout).toContain(
      "plan action=regenerate-secret resolves=secret-missing mutation=reversible backup=not-required",
    );
    expect(result.stdout).not.toContain("rotate-database-credential");

    const targetDir2 = makeFixture();
    rmSync(join(targetDir2, ".orbit-secrets", "postgres-password"));
    rmSync(join(targetDir2, ".orbit-secrets", "document-kek"));

    const result2 = runRepair(targetDir2, ["--plan"], {
      volumes: ["repairtest_orbit-db-data"],
    });

    expect(result2.stdout).toContain(
      "plan action=rotate-database-credential resolves=secret-missing mutation=credential-rotation backup=required",
    );
    const planLines2 = lines(result2.stdout).filter((line) => line.startsWith("plan action="));
    // document-kek is still missing but no document volume is retained, so it
    // still regenerates safely — never manual.
    expect(planLines2).toContain(
      "plan action=regenerate-secret resolves=secret-missing mutation=reversible backup=not-required",
    );
    expect(result2.stdout).not.toContain("action=manual");
  });

  it("plans database-credential-mismatch as rotate-database-credential — the motivating #261 failure", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--plan"], { db: { present: true, ready: true, authResult: "mismatch" } });

    expect(result.status).toBe(3);
    expect(result.stdout).toContain(
      "plan action=rotate-database-credential resolves=database-credential-mismatch mutation=credential-rotation backup=required",
    );
  });

  it("plans application-unhealthy as restart-services", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--plan"], { app: { present: true, health: "unhealthy" } });

    expect(result.status).toBe(3);
    expect(result.stdout).toContain(
      "plan action=restart-services resolves=application-unhealthy mutation=service-restart backup=not-required",
    );
  });

  it("plans stale-container as restart-services", () => {
    const targetDir = makeFixture();
    const pinned = `ghcr.io/tomlawesome/orbit@sha256:${"a".repeat(64)}`;
    const running = `ghcr.io/tomlawesome/orbit@sha256:${"b".repeat(64)}`;
    writeDigestPinnedEnv(targetDir, pinned);

    const result = runRepair(targetDir, ["--plan"], { app: { present: true, image: running, health: "healthy" } });

    expect(result.status).toBe(3);
    expect(result.stdout).toContain(
      "plan action=restart-services resolves=stale-container mutation=service-restart backup=not-required",
    );
  });

  it("plans configuration-incomplete as rerun-configuration (no mutation)", () => {
    const targetDir = makeFixture();
    writeFileSync(join(targetDir, ".env-orbit"), "APP_URL=https://orbit.repair-test.internal\n");
    chmodSync(join(targetDir, ".env-orbit"), 0o600);

    const result = runRepair(targetDir, ["--plan"]);

    expect(result.status).toBe(3);
    expect(result.stdout).toContain(
      "plan action=rerun-configuration resolves=configuration-incomplete mutation=none backup=not-required",
    );
  });

  it("plans configuration-invalid as rerun-configuration (no mutation)", () => {
    const targetDir = makeFixture();
    chmodSync(join(targetDir, ".env-orbit"), 0o644);

    const result = runRepair(targetDir, ["--plan"]);

    expect(result.status).toBe(3);
    expect(result.stdout).toContain(
      "plan action=rerun-configuration resolves=configuration-invalid mutation=none backup=not-required",
    );
  });

  it("plans configuration-migration-interrupted as the safe restore-transaction batch (ADR-0014 decision 7, issue #529)", () => {
    const targetDir = makeFixture();
    const goodEnv = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    writeFileSync(join(targetDir, ".env-orbit.orbit-config.rollback"), goodEnv);
    chmodSync(join(targetDir, ".env-orbit.orbit-config.rollback"), 0o600);
    chmodSync(join(targetDir, ".env-orbit"), 0o644);

    const result = runRepair(targetDir, ["--plan"]);

    expect(result.status).toBe(3);
    expect(result.stdout).toContain(
      "plan action=restore-transaction resolves=configuration-migration-interrupted mutation=reversible backup=required",
    );
    expect(result.stdout).not.toContain("rerun-configuration");
  });

  // --- manual-class findings: no safe automatic action -----------------

  const manualScenarios = [
    {
      name: "managed-file-missing",
      resolves: "managed-file-missing",
      setup: (targetDir) => rmSync(join(targetDir, ".env-orbit")),
      dockerOptions: {},
      withConfigure: false,
    },
    {
      name: "managed-file-symlink",
      resolves: "managed-file-symlink",
      setup: (targetDir) => {
        const realFile = join(targetDir, "real-env-orbit");
        writeFileSync(realFile, "APP_URL=https://orbit.repair-test.internal\n");
        chmodSync(realFile, 0o600);
        rmSync(join(targetDir, ".env-orbit"));
        symlinkSync(realFile, join(targetDir, ".env-orbit"));
      },
      dockerOptions: {},
      withConfigure: false,
    },
    {
      name: "compose-interpolation-failed",
      resolves: "compose-interpolation-failed",
      setup: () => {},
      dockerOptions: { composeFails: true },
      withConfigure: true,
    },
    {
      name: "container-foreign-owner",
      resolves: "container-foreign-owner",
      setup: () => {},
      dockerOptions: { containers: [{ id: "0123456789ab", service: "not-an-orbit-service" }] },
      withConfigure: true,
    },
    {
      name: "database-unreachable",
      resolves: "database-unreachable",
      setup: () => {},
      dockerOptions: { db: { present: false } },
      withConfigure: true,
    },
    {
      name: "database-schema-mismatch",
      resolves: "database-schema-mismatch",
      setup: () => {},
      dockerOptions: {
        app: {
          present: true,
          health: "unhealthy",
          log: "ERROR orbit migrations startup.migration state=exhausted reason=database_mismatch action=attach_matching_database impact=migration_blocked",
        },
      },
      withConfigure: true,
    },
    {
      name: "database-below-floor",
      resolves: "database-below-floor",
      setup: () => {},
      dockerOptions: {
        app: {
          present: true,
          health: "unhealthy",
          log: "ERROR orbit migrations startup.migration state=exhausted reason=database_below_floor action=upgrade_from_supported_version impact=migration_blocked",
        },
      },
      withConfigure: true,
    },
    {
      // issue #528 slice B.
      name: "migration-failed",
      resolves: "migration-failed",
      setup: () => {},
      dockerOptions: {
        app: {
          present: true,
          health: "unhealthy",
          log: "ERROR orbit migrations startup.migration state=exhausted reason=migration_failed impact=migration_blocked",
        },
      },
      withConfigure: true,
    },
    {
      // issue #528 slice C.
      name: "image-identity-mismatch",
      resolves: "image-identity-mismatch",
      setup: (targetDir) => writeDigestPinnedEnv(targetDir, `ghcr.io/tomlawesome/orbit@sha256:${"a".repeat(64)}`),
      dockerOptions: {
        app: { present: true, image: `ghcr.io/tomlawesome/orbit@sha256:${"a".repeat(64)}`, health: "healthy" },
        appImageId: "sha256:" + "1".repeat(64),
        imageInspect: { present: true, id: "sha256:" + "2".repeat(64) },
      },
      withConfigure: true,
    },
    // Note: unrelated-resource-present and docker-unavailable are
    // deliberately NOT in this table — both are always info-severity
    // findings under --check, and the severity gate (see the "Severity
    // gate" section of the --plan header comment) means an info-severity
    // finding is never planned at all, not even as `action=manual`. See
    // the dedicated "severity gate" tests below instead.
  ];

  for (const scenario of manualScenarios) {
    it(`plans ${scenario.name} as manual, with a matching stderr manual-step line`, () => {
      const targetDir = makeFixture({ withConfigure: scenario.withConfigure });
      scenario.setup(targetDir);

      const result = runRepair(targetDir, ["--plan"], scenario.dockerOptions);

      expect(result.stdout).toContain(
        `plan action=manual resolves=${scenario.resolves} mutation=none backup=not-required`,
      );
      expect(result.stderr).toContain(`resolves=${scenario.resolves}`);
      expect(result.stderr.length).toBeGreaterThan(0);
    });
  }

  it("migration-failed's manual guidance cites the ADR-0004 recovery point, field-level only (no path/value)", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--plan"], {
      app: {
        present: true,
        health: "unhealthy",
        log: "reason=migration_failed",
      },
    });

    expect(result.status).toBe(4);
    expect(result.stderr).toContain("resolves=migration-failed");
    expect(result.stderr.toLowerCase()).toContain("recovery point");
    expect(result.stderr).not.toContain(targetDir);
    expect(result.stderr).not.toContain(".env-orbit");
  });

  // --- severity gate: info-severity findings are never planned ----------
  //
  // --check itself never lets an info-severity finding (docker-unavailable,
  // unrelated-resource-present) make the deployment anything other than
  // `healthy` (exit 0). --plan must not contradict that verdict for the
  // identical state: an info-only diagnosis must also come back
  // `result=empty` / exit 0, not `manual-required` / exit 4.

  it("plans docker-unavailable (info-only) as an empty plan, exit 0 — matches --check's healthy verdict for the same state", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--plan"], { unavailable: true });

    expect(result.status).toBe(0);
    expect(lines(result.stdout)).toEqual(["plan result=empty actions=0 manual=0"]);
    expect(result.stdout).not.toContain("docker-unavailable");
    expect(result.stderr).toBe("");
  });

  it("plans unrelated-resource-present (info-only) as an empty plan, exit 0 — matches --check's healthy verdict for the same state", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--plan"], { volumes: ["someother_orbit-db-data"] });

    expect(result.status).toBe(0);
    expect(lines(result.stdout)).toEqual(["plan result=empty actions=0 manual=0"]);
    expect(result.stdout).not.toContain("unrelated-resource-present");
    expect(result.stderr).toBe("");
  });

  it("plans only the fail-severity finding when an info-severity and a fail-severity finding are both present", () => {
    const targetDir = makeFixture();
    // unrelated-resource-present (info, from the mismatched-project volume)
    // alongside database-unreachable (fail, from the absent orbit-db
    // container): only the fail-severity finding should be planned.
    const result = runRepair(targetDir, ["--plan"], {
      volumes: ["someother_orbit-db-data"],
      db: { present: false },
    });

    expect(result.status).toBe(4);
    expect(lines(result.stdout)).toEqual([
      "plan action=manual resolves=database-unreachable mutation=none backup=not-required",
      "plan result=manual-required actions=0 manual=1",
    ]);
    expect(result.stdout).not.toContain("unrelated-resource-present");
  });

  // --- exit-code semantics: 3 = at least one automatic action planned, --
  // --- 4 = findings exist but none of them has an automatic action ------

  it("exits 3 (plan-available) when automatic actions and manual findings are both present", () => {
    const targetDir = makeFixture();
    // staging-evidence-present -> restore-transaction (automatic) alongside
    // database-unreachable -> manual (no automatic action).
    mkdirSync(join(targetDir, ".orbit-install-staging.xyz"), { mode: 0o700 });

    const result = runRepair(targetDir, ["--plan"], { db: { present: false } });

    expect(result.status).toBe(3);
    const summary = lines(result.stdout).at(-1);
    expect(summary).toBe("plan result=ready actions=1 manual=1");
  });

  it("exits 4 (unplannable-failures-present) when findings exist but none has an automatic action", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--plan"], { db: { present: false } });

    expect(result.status).toBe(4);
    expect(lines(result.stdout)).toEqual([
      "plan action=manual resolves=database-unreachable mutation=none backup=not-required",
      "plan result=manual-required actions=0 manual=1",
    ]);
  });

  it("groups plan lines by the fixed class order regardless of discovery order", () => {
    const targetDir = makeFixture();
    rmSync(join(targetDir, ".orbit-secrets", "session-secret"));
    mkdirSync(join(targetDir, ".orbit-install-staging.xyz"), { mode: 0o700 });

    const result = runRepair(targetDir, ["--plan"], { composeFails: true });
    const resolvesClasses = lines(result.stdout)
      .filter((line) => line.startsWith("plan action="))
      .map((line) => line.match(/resolves=([a-z-]+)/u)[1]);

    expect(resolvesClasses).toEqual(["secret-missing", "staging-evidence-present", "compose-interpolation-failed"]);
  });

  it("never discloses a path, configured value, or secret on stdout or stderr under --plan", () => {
    const targetDir = makeFixture({ withConfigure: false });
    rmSync(join(targetDir, ".env-orbit"));

    const result = runRepair(targetDir, ["--plan"]);

    expect(result.stdout).not.toContain(targetDir);
    expect(result.stdout).not.toContain("repair-test-secret");
    expect(result.stdout).not.toContain(".env-orbit");
    expect(result.stderr).not.toContain(targetDir);
    expect(result.stderr).not.toContain(".env-orbit");
  });

  it("never leaks the postgres-password secret value on stdout, stderr, or any docker argv under --plan", () => {
    const distinctPassword = "Zx9-Very-Distinct-Postgres-Secret-Q7-Plan";
    const targetDir = makeFixture();
    writeFileSync(join(targetDir, ".orbit-secrets", "postgres-password"), `${distinctPassword}\n`);
    chmodSync(join(targetDir, ".orbit-secrets", "postgres-password"), 0o600);
    const logDir = scratchDir();
    const argvLogPath = join(logDir, "docker-argv.log");

    const result = runRepair(targetDir, ["--plan"], {
      db: { present: true, ready: true, authResult: "mismatch" },
      argvLogPath,
    });

    expect(result.stdout).not.toContain(distinctPassword);
    expect(result.stderr).not.toContain(distinctPassword);
    let argvLog = "";
    try {
      argvLog = readFileSync(argvLogPath, "utf8");
    } catch {
      argvLog = "";
    }
    expect(argvLog).not.toContain(distinctPassword);
  });
});

// ---------------------------------------------------------------------------
// --execute --safe-only (issue #261, slice 4 stage one)
// ---------------------------------------------------------------------------

function mode(path) {
  return (statSync(path).mode & 0o777).toString(8);
}

// Builds a leftover `.orbit-install-staging.*` directory shaped like
// install.sh's own prepare_rollback_area: rollback/original/<path>, mode
// 700 throughout. `envBackupLines`, when given, becomes the staged
// .env-orbit backup content restore-transaction should restore live.
// `committed`, when true, drops install.sh's own commit marker (issue #383
// finding 2) into the staging directory, marking it as belonging to an
// install that already succeeded rather than one that was interrupted.
function makeStagingTransaction(targetDir, { envBackupLines, committed = false } = {}) {
  const stagingDir = join(targetDir, ".orbit-install-staging.abc123");
  const originalDir = join(stagingDir, "rollback", "original");
  mkdirSync(originalDir, { recursive: true, mode: 0o700 });
  chmodSync(stagingDir, 0o700);
  chmodSync(join(stagingDir, "rollback"), 0o700);
  chmodSync(originalDir, 0o700);
  if (envBackupLines) {
    writeFileSync(join(originalDir, ".env-orbit"), envBackupLines.join("\n") + "\n");
    chmodSync(join(originalDir, ".env-orbit"), 0o600);
  }
  if (committed) {
    writeFileSync(join(stagingDir, "committed"), "");
  }
  return stagingDir;
}

describe("scripts/repair.sh --execute --safe-only", () => {
  // --- usage / flag contract -------------------------------------------

  it("rejects --execute without --safe-only, explaining stage two is not implemented", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--execute"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
    expect(result.stderr).toContain("--safe-only");
    expect(result.stdout).toBe("");
  });

  it("rejects --safe-only without --execute", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--safe-only"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });

  it("rejects --execute --safe-only combined with --check", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--execute", "--safe-only", "--check"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });

  it("rejects --safe-only combined with --plan", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--plan", "--safe-only"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });

  // --- not-an-orbit-installation forces exit 5, same as --check/--plan --

  it("reports not-orbit-directory as a skipped manual action and forces exit 5", () => {
    const targetDir = scratchDir();
    mkdirSync(join(targetDir, "scripts"));
    writeFileSync(join(targetDir, "scripts", "repair.sh"), repairScriptSource);
    chmodSync(join(targetDir, "scripts", "repair.sh"), 0o755);

    const result = runRepair(targetDir, ["--execute", "--safe-only"]);

    expect(result.status).toBe(5);
    expect(lines(result.stdout)).toEqual([
      "execute action=manual resolves=not-orbit-directory result=skipped",
      "execution result=empty done=0 failed=0",
      "finding class=not-orbit-directory target=directory severity=fail",
      "diagnosis result=failed checked=1 skipped=16",
    ]);
  });

  // --- healthy / empty-plan case ------------------------------------------

  it("reports execution result=empty for a fully healthy target, exit 0", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--execute", "--safe-only"]);

    expect(result.status).toBe(0);
    expect(lines(result.stdout)).toEqual([
      "execution result=empty done=0 failed=0",
      "diagnosis result=healthy checked=17 skipped=0",
    ]);
  });

  // --- unactionable: a plan exists but nothing is in the safe set --------

  it("reports execution result=unactionable when every planned action is outside the safe set, without prompting", () => {
    const targetDir = makeFixture();
    const before = treeSnapshot(targetDir);

    const result = runRepair(targetDir, ["--execute", "--safe-only"], { db: { present: false } });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("execute action=manual resolves=database-unreachable result=skipped");
    expect(result.stdout).toContain("execution result=unactionable done=0 failed=0");
    expect(result.stdout).not.toContain("plan action=");
    expect(result.stdout).not.toContain("prompt");
    expect(treeSnapshot(targetDir)).toBe(before);
  });

  // --- automation contract: non-interactive proceeds without any prompt --

  it("proceeds without any confirmation preview or prompt line under non-interactive automation", () => {
    const targetDir = makeFixture({ withConfigure: false });
    chmodSync(join(targetDir, ".env-orbit"), 0o644);

    const result = runRepair(targetDir, ["--execute", "--safe-only"]);

    expect(result.stdout).not.toContain("plan action=");
    expect(result.stdout).not.toContain("prompt");
    expect(result.stdout).toContain("execute action=fix-permissions resolves=managed-file-permissions result=done");
    expect(mode(join(targetDir, ".env-orbit"))).toBe("600");
  });

  // --- fix-permissions ------------------------------------------------------

  it("fix-permissions: chmods a loosely-permissioned .env-orbit back to 600", () => {
    const targetDir = makeFixture({ withConfigure: false });
    chmodSync(join(targetDir, ".env-orbit"), 0o644);

    const result = runRepair(targetDir, ["--execute", "--safe-only"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("execute action=fix-permissions resolves=managed-file-permissions result=done");
    expect(result.stdout).toContain("execution result=complete done=1 failed=0");
    expect(mode(join(targetDir, ".env-orbit"))).toBe("600");
  });

  it("fix-permissions: chmods a loosely-permissioned secret file back to 600", () => {
    const targetDir = makeFixture({ withConfigure: false });
    chmodSync(join(targetDir, ".orbit-secrets", "postgres-password"), 0o644);

    const result = runRepair(targetDir, ["--execute", "--safe-only"]);

    expect(result.stdout).toContain("execute action=fix-permissions resolves=secret-permissions result=done");
    expect(mode(join(targetDir, ".orbit-secrets", "postgres-password"))).toBe("600");
  });

  it("fix-permissions: chmods a loosely-permissioned .orbit-secrets directory back to 700", () => {
    const targetDir = makeFixture({ withConfigure: false });
    chmodSync(join(targetDir, ".orbit-secrets"), 0o755);

    const result = runRepair(targetDir, ["--execute", "--safe-only"]);

    expect(result.stdout).toContain(
      "execute action=fix-permissions resolves=secrets-directory-invalid result=done",
    );
    expect(mode(join(targetDir, ".orbit-secrets"))).toBe("700");
  });

  it("fix-permissions: refuses to chmod through a symlinked secret, reporting failed and leaving the symlink untouched", () => {
    const targetDir = makeFixture({ withConfigure: false });
    const realTarget = join(targetDir, "real-secret-target");
    writeFileSync(realTarget, "outside-content");
    chmodSync(realTarget, 0o600);
    rmSync(join(targetDir, ".orbit-secrets", "postgres-password"));
    symlinkSync(realTarget, join(targetDir, ".orbit-secrets", "postgres-password"));

    const result = runRepair(targetDir, ["--execute", "--safe-only"]);

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("execute action=fix-permissions resolves=secret-permissions result=failed");
    expect(result.stdout).toContain("execution result=failed done=0 failed=1");
    const linkStat = statSync(join(targetDir, ".orbit-secrets", "postgres-password"), { throwIfNoEntry: false });
    expect(linkStat).toBeTruthy();
    expect(
      spawnSync("test", ["-L", join(targetDir, ".orbit-secrets", "postgres-password")]).status,
    ).toBe(0);
  });

  // --- restore-transaction ---------------------------------------------------

  it("restore-transaction: restores a staged prior .env-orbit over the current live copy and removes the staging directory on success", () => {
    const targetDir = makeFixture({ withConfigure: false });
    makeStagingTransaction(targetDir, {
      envBackupLines: [
        "APP_URL=https://orbit.old-good-state.internal",
        "ORBIT_IMAGE=orbit-local:oldgood",
        "COMPOSE_PROJECT_NAME=repairtest",
      ],
    });

    const result = runRepair(targetDir, ["--execute", "--safe-only"]);

    expect(result.stdout).toContain(
      "execute action=restore-transaction resolves=staging-evidence-present result=done",
    );
    const restoredEnv = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    expect(restoredEnv).toContain("APP_URL=https://orbit.old-good-state.internal");
    expect(restoredEnv).toContain("ORBIT_IMAGE=orbit-local:oldgood");
    expect(mode(join(targetDir, ".env-orbit"))).toBe("600");
    expect(spawnSync("bash", ["-c", `ls -d '${targetDir}'/.orbit-install-staging.* 2>/dev/null`], { encoding: "utf8" }).stdout).toBe(
      "",
    );
  });

  it("restore-transaction: removes a live managed path that has no staged backup (created by the interrupted transaction)", () => {
    const targetDir = makeFixture({ withConfigure: false });
    makeStagingTransaction(targetDir, {
      envBackupLines: ["APP_URL=https://orbit.old-good-state.internal", "COMPOSE_PROJECT_NAME=repairtest"],
    });
    // docker-compose.mail.yml exists live but was never backed up: per
    // install.sh's own managed_was_present bookkeeping, that means it did
    // not exist before the interrupted transaction and must be removed.
    writeFileSync(join(targetDir, "docker-compose.mail.yml"), "services: {}\n");

    const result = runRepair(targetDir, ["--execute", "--safe-only"]);

    expect(result.stdout).toContain(
      "execute action=restore-transaction resolves=staging-evidence-present result=done",
    );
    expect(statSync(join(targetDir, "docker-compose.mail.yml"), { throwIfNoEntry: false })).toBeFalsy();
  });

  it("restore-transaction: self-restores every path it already touched and leaves the staging directory intact when a later path fails", () => {
    const targetDir = makeFixture({ withConfigure: false });
    const stagingDir = makeStagingTransaction(targetDir, {
      envBackupLines: ["APP_URL=https://orbit.old-good-state.internal", "COMPOSE_PROJECT_NAME=repairtest"],
    });
    // Stage a backup for scripts/configure.sh too (so it's a path this
    // action will also try to touch), then make the live scripts/
    // directory read-only so removing scripts/configure.sh fails partway
    // through the same restore-transaction action, after .env-orbit (which
    // sorts first in the fixed allowlist) has already been replaced.
    mkdirSync(join(stagingDir, "rollback", "original", "scripts"), { recursive: true, mode: 0o700 });
    writeFileSync(join(stagingDir, "rollback", "original", "scripts", "configure.sh"), configureScriptSource);
    chmodSync(join(stagingDir, "rollback", "original", "scripts", "configure.sh"), 0o600);
    const beforeEnv = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    chmodSync(join(targetDir, "scripts"), 0o555);

    let result;
    try {
      result = runRepair(targetDir, ["--execute", "--safe-only"]);
    } finally {
      chmodSync(join(targetDir, "scripts"), 0o755);
    }

    expect(result.status).toBe(4);
    expect(result.stdout).toContain(
      "execute action=restore-transaction resolves=staging-evidence-present result=failed",
    );
    expect(result.stdout).toContain("execution result=failed done=0 failed=1");
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toBe(beforeEnv);
    expect(
      spawnSync("bash", ["-c", `ls -d '${targetDir}'/.orbit-install-staging.* 2>/dev/null`], { encoding: "utf8" }).stdout,
    ).not.toBe("");
  });

  // issue #383 finding 2: a leftover `.orbit-install-staging.*` directory is
  // not necessarily evidence of an INTERRUPTED transaction — install.sh only
  // starts the long image-pull/health-wait phase after its own transaction
  // has already committed, and a host crash during that phase can leave
  // staging behind next to a successfully installed deployment. Before this
  // fix, restore-transaction could not tell the two cases apart and would
  // silently revert a completed install/update back to the pre-update
  // files. The worst-case variant the verifier reproduced: a path with no
  // staged backup (`.orbit-secrets`, exactly what a first-time install's own
  // bookkeeping produces for a brand-new secrets directory) was treated as
  // "created by the interrupted transaction" and deleted outright, with only
  // a private recovery copy — cleaned up before the run even finished —
  // ever holding a copy. install.sh now writes a `committed` marker into the
  // staging directory at the moment its own transaction commits; repair.sh
  // must refuse restore-transaction outright whenever that marker is
  // present, touching nothing.
  it("finding 2 (issue #383): refuses restore-transaction outright when the staging directory is marked committed, and .orbit-secrets survives untouched", () => {
    const targetDir = makeFixture({ withConfigure: false });
    // Mirrors the verifier's worst-case repro: .orbit-secrets has NO staged
    // backup under rollback/original (exactly what a fresh install's own
    // prepare_rollback_area records for a brand-new secrets directory —
    // managed_was_present=0), so an interrupted-transaction reading of this
    // same staging directory would treat it as "created by the transaction"
    // and remove it.
    makeStagingTransaction(targetDir, {
      envBackupLines: ["APP_URL=https://orbit.old-good-state.internal", "COMPOSE_PROJECT_NAME=repairtest"],
      committed: true,
    });
    const beforeEnv = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    const beforeSecretNames = readdirSync(join(targetDir, ".orbit-secrets")).sort();
    const beforePostgresPassword = readFileSync(
      join(targetDir, ".orbit-secrets", "postgres-password"),
      "utf8",
    );

    const result = runRepair(targetDir, ["--execute", "--safe-only"]);

    expect(result.status).toBe(4);
    expect(result.stdout).toContain(
      "execute action=restore-transaction resolves=staging-evidence-present result=failed",
    );
    expect(result.stdout).toContain("execution result=failed done=0 failed=1");
    // Loud, not silent: an operator running this must be told why, on
    // stderr (stdout stays enum-only per the stdout contract).
    expect(result.stderr).toContain("refusing restore-transaction");
    expect(result.stderr).toContain("committed");
    expect(result.stderr).not.toBe("");

    // Nothing was touched: the completed install's .env-orbit is untouched...
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toBe(beforeEnv);
    // ...and — the critical regression — .orbit-secrets was never deleted.
    expect(existsSync(join(targetDir, ".orbit-secrets"))).toBe(true);
    expect(readdirSync(join(targetDir, ".orbit-secrets")).sort()).toEqual(beforeSecretNames);
    expect(readFileSync(join(targetDir, ".orbit-secrets", "postgres-password"), "utf8")).toBe(
      beforePostgresPassword,
    );
    expect(mode(join(targetDir, ".orbit-secrets"))).toBe("700");
    // The staging directory itself is left in place for manual review, not
    // silently swallowed either.
    expect(
      spawnSync("bash", ["-c", `ls -d '${targetDir}'/.orbit-install-staging.* 2>/dev/null`], { encoding: "utf8" })
        .stdout,
    ).not.toBe("");
  });

  it("restore-transaction still restores normally when the staging directory has no commit marker (a genuinely interrupted transaction)", () => {
    const targetDir = makeFixture({ withConfigure: false });
    makeStagingTransaction(targetDir, {
      envBackupLines: ["APP_URL=https://orbit.old-good-state.internal", "COMPOSE_PROJECT_NAME=repairtest"],
      committed: false,
    });

    const result = runRepair(targetDir, ["--execute", "--safe-only"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "execute action=restore-transaction resolves=staging-evidence-present result=done",
    );
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toContain(
      "APP_URL=https://orbit.old-good-state.internal",
    );
  });

  // --- restore-transaction (configuration-migration-interrupted boundary, ---
  // --- ADR-0014 decision 7, issue #529) ---------------------------------------

  it("restores the .orbit-config.rollback copy into .env-orbit, removes the rollback file, and ends healthy", () => {
    const targetDir = makeFixture();
    const goodEnv = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    writeFileSync(join(targetDir, ".env-orbit.orbit-config.rollback"), goodEnv);
    chmodSync(join(targetDir, ".env-orbit.orbit-config.rollback"), 0o600);
    chmodSync(join(targetDir, ".env-orbit"), 0o644);

    const result = runRepair(targetDir, ["--execute", "--safe-only"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "execute action=restore-transaction resolves=configuration-migration-interrupted result=done",
    );
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toBe(goodEnv);
    expect(mode(join(targetDir, ".env-orbit"))).toBe("600");
    expect(existsSync(join(targetDir, ".env-orbit.orbit-config.rollback"))).toBe(false);
    expect(result.stdout).toContain("diagnosis result=healthy");
  });

  it("injected failure mid-restore: self-restores .env-orbit and reports failed (exit 4), leaving the rollback copy in place", () => {
    const targetDir = makeFixture();
    const goodEnv = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    writeFileSync(join(targetDir, ".env-orbit.orbit-config.rollback"), goodEnv);
    chmodSync(join(targetDir, ".env-orbit.orbit-config.rollback"), 0o600);
    // Content-incomplete rather than mode-644: mode 644 would ALSO trigger
    // managed-file-permissions/fix-permissions in the same safe batch, which
    // only touches the mode (not the content) and would confound this
    // test's done/failed count with an unrelated successful action.
    writeFileSync(join(targetDir, ".env-orbit"), "APP_URL=https://orbit.repair-test.internal\n");
    chmodSync(join(targetDir, ".env-orbit"), 0o600);
    const beforeBrokenEnv = readFileSync(join(targetDir, ".env-orbit"), "utf8");

    // A failing `mv` ahead of the real one on PATH injects a failure at the
    // final same-filesystem rename step, after the live .env-orbit has
    // already been backed up into the private recovery directory — this
    // exercises the self-restore path, not a refusal before anything is
    // touched.
    const binDir = makeFakeBin({});
    writeFileSync(join(binDir, "mv"), "#!/usr/bin/env bash\nexit 1\n");
    chmodSync(join(binDir, "mv"), 0o755);
    const result = spawnSync("bash", [join(targetDir, "scripts", "repair.sh"), "--execute", "--safe-only"], {
      cwd: targetDir,
      encoding: "utf8",
      env: { PATH: `${binDir}:${process.env.PATH}`, HOME: process.env.HOME ?? tmpdir() },
    });

    expect(result.status).toBe(4);
    expect(result.stdout).toContain(
      "execute action=restore-transaction resolves=configuration-migration-interrupted result=failed",
    );
    expect(result.stdout).toContain("execution result=failed done=0 failed=1");
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toBe(beforeBrokenEnv);
    expect(mode(join(targetDir, ".env-orbit"))).toBe("600");
    expect(existsSync(join(targetDir, ".env-orbit.orbit-config.rollback"))).toBe(true);
  });

  it("output hygiene: restoring the rollback copy never prints the target directory path or a configured value", () => {
    const targetDir = makeFixture();
    const goodEnv = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    writeFileSync(join(targetDir, ".env-orbit.orbit-config.rollback"), goodEnv);
    chmodSync(join(targetDir, ".env-orbit.orbit-config.rollback"), 0o600);
    chmodSync(join(targetDir, ".env-orbit"), 0o644);

    const result = runRepair(targetDir, ["--execute", "--safe-only"]);

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).not.toContain(targetDir);
    expect(combined).not.toContain("orbit-repair-configuration-rollback");
    expect(combined).not.toContain(".orbit-config.rollback");
    expect(combined).not.toContain("APP_URL=");
    expect(combined).not.toContain("repair-test-secret");
    expect(combined).not.toContain("repairtest");
  });

  // --- restart-services -------------------------------------------------------

  it("restart-services: restarts the orbit-app container exactly once even when both stale-container and application-unhealthy fire, and the re-diagnosis honestly reflects it", () => {
    const targetDir = makeFixture({ withConfigure: false });
    writeDigestPinnedEnv(targetDir, "ghcr.io/tomlawesome/orbit@sha256:" + "1".repeat(64));
    const scratch = scratchDir();
    const argvLogPath = join(scratch, "docker-argv.log");
    const healthMarkerPath = join(scratch, "healed");

    const result = runRepair(targetDir, ["--execute", "--safe-only"], {
      app: {
        image: "ghcr.io/tomlawesome/orbit@sha256:" + "0".repeat(64),
        health: "unhealthy",
      },
      argvLogPath,
      healthMarkerPath,
    });

    expect(result.stdout).toContain("execute action=restart-services resolves=stale-container result=done");
    expect(result.stdout).toContain("execute action=restart-services resolves=application-unhealthy result=done");
    expect(result.stdout).toContain("execution result=complete done=2 failed=0");
    // Honest re-diagnosis: application-unhealthy clears (the shim's health
    // marker simulates the restart curing the healthcheck), but a plain
    // `docker restart` never changes the running image, so
    // stale-container's underlying cause is untouched and it honestly
    // persists in the re-diagnosis below the terminal execution line — the
    // tool never pretends a restart fixed something it structurally
    // cannot fix.
    const reDiagnosis = result.stdout.slice(result.stdout.indexOf("execution result="));
    expect(reDiagnosis).not.toContain("finding class=application-unhealthy");
    expect(reDiagnosis).toContain("finding class=stale-container target=container severity=warn");

    let argvLog = "";
    try {
      argvLog = readFileSync(argvLogPath, "utf8");
    } catch {
      argvLog = "";
    }
    const restartCount = argvLog.split("\n").filter((line) => line.startsWith("restart ")).length;
    expect(restartCount).toBe(1);
  });

  it("restart-services: reports failed when the docker restart command itself fails", () => {
    const targetDir = makeFixture({ withConfigure: false });

    const result = runRepair(targetDir, ["--execute", "--safe-only"], {
      app: { health: "unhealthy" },
      restartFails: true,
    });

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("execute action=restart-services resolves=application-unhealthy result=failed");
    expect(result.stdout).toContain("execution result=failed done=0 failed=1");
  });

  // --- out-of-safe-set findings are always reported skipped, never executed --

  it("reports regenerate-secret-eligible findings as skipped and leaves the secret absent", () => {
    const targetDir = makeFixture({ withConfigure: false });
    rmSync(join(targetDir, ".orbit-secrets", "session-secret"));

    const result = runRepair(targetDir, ["--execute", "--safe-only"]);

    expect(result.stdout).toContain("execute action=regenerate-secret resolves=secret-missing result=skipped");
    expect(statSync(join(targetDir, ".orbit-secrets", "session-secret"), { throwIfNoEntry: false })).toBeFalsy();
  });

  it("reports rotate-database-credential findings as skipped and never touches the postgres-password secret", () => {
    const distinctPassword = "Zx9-Very-Distinct-Postgres-Secret-Execute";
    const targetDir = makeFixture({ withConfigure: false });
    writeFileSync(join(targetDir, ".orbit-secrets", "postgres-password"), `${distinctPassword}\n`);
    chmodSync(join(targetDir, ".orbit-secrets", "postgres-password"), 0o600);
    const scratch = scratchDir();
    const argvLogPath = join(scratch, "docker-argv.log");

    const result = runRepair(targetDir, ["--execute", "--safe-only"], {
      db: { present: true, ready: true, authResult: "mismatch" },
      argvLogPath,
    });

    expect(result.stdout).toContain(
      "execute action=rotate-database-credential resolves=database-credential-mismatch result=skipped",
    );
    expect(readFileSync(join(targetDir, ".orbit-secrets", "postgres-password"), "utf8")).toContain(
      distinctPassword,
    );
    expect(result.stdout).not.toContain(distinctPassword);
    expect(result.stderr).not.toContain(distinctPassword);
    let argvLog = "";
    try {
      argvLog = readFileSync(argvLogPath, "utf8");
    } catch {
      argvLog = "";
    }
    expect(argvLog).not.toContain(distinctPassword);
  });

  it("reports manual findings as skipped and never fabricates a missing managed file", () => {
    const targetDir = makeFixture({ withConfigure: false });
    rmSync(join(targetDir, "docker-compose.yml"));

    const result = runRepair(targetDir, ["--execute", "--safe-only"]);

    expect(result.stdout).toContain("execute action=manual resolves=managed-file-missing result=skipped");
    expect(statSync(join(targetDir, "docker-compose.yml"), { throwIfNoEntry: false })).toBeFalsy();
  });

  // --- confirmation model: machine prompts (ORBIT_REPAIR_PROMPTS=machine) --

  it("machine prompts: shows the plan preview, then prompt/prompt-accept, and executes on a bare 'y'", () => {
    const targetDir = makeFixture({ withConfigure: false });
    chmodSync(join(targetDir, ".env-orbit"), 0o644);

    const result = runRepair(
      targetDir,
      ["--execute", "--safe-only"],
      {},
      { input: "y\n", env: { ORBIT_REPAIR_PROMPTS: "machine" } },
    );

    expect(result.stdout).toContain("plan action=fix-permissions resolves=managed-file-permissions");
    expect(result.stdout).toContain("prompt field=safe-batch kind=confirm required=true attempt=1");
    expect(result.stdout).toContain("prompt-accept field=safe-batch");
    expect(result.stdout).toContain("execute action=fix-permissions resolves=managed-file-permissions result=done");
    expect(mode(join(targetDir, ".env-orbit"))).toBe("600");
  });

  it("machine prompts: a non-'y' answer aborts with zero mutation", () => {
    const targetDir = makeFixture({ withConfigure: false });
    chmodSync(join(targetDir, ".env-orbit"), 0o644);
    const before = treeSnapshot(targetDir);

    const result = runRepair(
      targetDir,
      ["--execute", "--safe-only"],
      {},
      { input: "n\n", env: { ORBIT_REPAIR_PROMPTS: "machine" } },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("prompt-abort field=safe-batch");
    expect(result.stdout).toContain("execute action=fix-permissions resolves=managed-file-permissions result=skipped");
    expect(result.stdout).toContain("execution result=declined done=0 failed=0");
    expect(treeSnapshot(targetDir)).toBe(before);
  });

  it("machine prompts: EOF (no answer line) aborts with zero mutation", () => {
    const targetDir = makeFixture({ withConfigure: false });
    chmodSync(join(targetDir, ".env-orbit"), 0o644);
    const before = treeSnapshot(targetDir);

    const result = runRepair(
      targetDir,
      ["--execute", "--safe-only"],
      {},
      { input: "", env: { ORBIT_REPAIR_PROMPTS: "machine" } },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("prompt-abort field=safe-batch");
    expect(treeSnapshot(targetDir)).toBe(before);
  });

  // --- confirmation model: interactive TTY (ORBIT_REPAIR_TTY_INPUT=1 test hook) --

  it("interactive prompt: accepting with 'y' executes the safe batch", () => {
    const targetDir = makeFixture({ withConfigure: false });
    chmodSync(join(targetDir, ".env-orbit"), 0o644);

    const result = runRepair(
      targetDir,
      ["--execute", "--safe-only"],
      {},
      { input: "y\n", env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Proceed?");
    expect(result.stdout).toContain("plan action=fix-permissions resolves=managed-file-permissions");
    expect(mode(join(targetDir, ".env-orbit"))).toBe("600");
  });

  it("interactive prompt: declining with 'n' leaves the deployment unmutated", () => {
    const targetDir = makeFixture({ withConfigure: false });
    chmodSync(join(targetDir, ".env-orbit"), 0o644);
    const before = treeSnapshot(targetDir);

    const result = runRepair(
      targetDir,
      ["--execute", "--safe-only"],
      {},
      { input: "n\n", env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("execution result=declined done=0 failed=0");
    expect(treeSnapshot(targetDir)).toBe(before);
  });

  it("interactive prompt: EOF (Ctrl-D) leaves the deployment unmutated", () => {
    const targetDir = makeFixture({ withConfigure: false });
    chmodSync(join(targetDir, ".env-orbit"), 0o644);
    const before = treeSnapshot(targetDir);

    const result = runRepair(
      targetDir,
      ["--execute", "--safe-only"],
      {},
      { input: "", env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
    );

    expect(result.status).toBe(1);
    expect(treeSnapshot(targetDir)).toBe(before);
  });

  // --- determinism / no-ANSI / privacy, mirroring the --check/--plan suites --

  it("produces byte-identical output across repeated declined runs", () => {
    const targetDir = makeFixture({ withConfigure: false });
    chmodSync(join(targetDir, ".env-orbit"), 0o644);

    const first = runRepair(
      targetDir,
      ["--execute", "--safe-only"],
      {},
      { input: "n\n", env: { ORBIT_REPAIR_PROMPTS: "machine" } },
    );
    const second = runRepair(
      targetDir,
      ["--execute", "--safe-only"],
      {},
      { input: "n\n", env: { ORBIT_REPAIR_PROMPTS: "machine" } },
    );

    expect(first.stdout).toBe(second.stdout);
    expect(first.status).toBe(second.status);
  });

  it("never emits ANSI or cursor-control bytes", () => {
    const targetDir = makeFixture({ withConfigure: false });
    chmodSync(join(targetDir, ".env-orbit"), 0o644);

    const result = runRepair(targetDir, ["--execute", "--safe-only"]);

    expect(result.stdout).not.toMatch(/\x1b/u);
    expect(result.stderr).not.toMatch(/\x1b/u);
  });

  it("never discloses a path, configured value, or secret on stdout or stderr under --execute", () => {
    const targetDir = makeFixture({ withConfigure: false });
    chmodSync(join(targetDir, ".env-orbit"), 0o644);

    const result = runRepair(targetDir, ["--execute", "--safe-only"]);

    expect(result.stdout).not.toContain(targetDir);
    expect(result.stdout).not.toContain("repair-test-secret");
    expect(result.stdout).not.toContain(".env-orbit");
    expect(result.stderr).not.toContain(targetDir);
  });
});

// ---------------------------------------------------------------------------
// --execute --dangerous (issue #261, slice 5, stage two:
// rotate-database-credential) — owner decisions on issue #261:
//   - "Slice 4 decisions (owner, 2026-08-13)" — two-stage execution,
//     checkpoints are passphrase-encrypted ORBKEK01 recovery bundles.
//   - "Slice 4 approval model (owner, 2026-08-13)" — hybrid confirmation,
//     dangerous actions require the operator to TYPE THE ACTION WORD,
//     dangerous actions are never automatable.
//   - "Stage two approved for build (owner, 2026-08-13)" — checkpoint
//     first, typed action word, never non-interactive, post-execution
//     re-diagnosis, #297 machine-prompt style.
//   - "Recorded intention (owner)" — step iterator, both execution styles
//     must remain structurally possible.
// ---------------------------------------------------------------------------

const ROTATE_PASSPHRASE = "correct-horse-battery-staple";
const ORIGINAL_POSTGRES_PASSWORD = "a".repeat(64);
const HEX_SECRET_PATTERN = /^[0-9a-f]{64}$/;

// The exact, closed set of stdout line SHAPES this script may ever emit —
// used for schema-blind "stdout stays enums-only" assertions (issue #261
// stage-two contract-discipline requirement): every line of stdout, in
// every scenario, must match one of these, never a bespoke path/value/
// secret-carrying line.
const STDOUT_LINE_PATTERNS = [
  /^finding class=[a-z-]+ target=[a-z-]+ severity=(info|warn|fail)$/,
  /^diagnosis result=(healthy|attention|failed) checked=\d+ skipped=\d+$/,
  /^plan action=[a-z-]+ resolves=[a-z-]+ mutation=(none|reversible|credential-rotation|service-restart) backup=(required|not-required)$/,
  /^execute action=[a-z-]+ resolves=[a-z-]+ result=(done|failed|skipped)$/,
  /^execution result=(empty|complete|unactionable|declined|failed) done=\d+ failed=\d+$/,
  /^dangerous result=(empty|complete|refused|failed) done=\d+ failed=\d+ reason=(none|non-interactive|refused-by-operator|checkpoint-failed|step-failed)$/,
  /^prompt field=[a-z-]+ kind=(confirm|typed-word|secret) required=true attempt=\d+$/,
  /^prompt-accept field=[a-z-]+$/,
  /^prompt-reject field=[a-z-]+ reason=[a-z-]+$/,
  /^prompt-abort field=[a-z-]+$/,
];

function expectStdoutIsEnumOnly(stdout) {
  for (const line of lines(stdout)) {
    expect(STDOUT_LINE_PATTERNS.some((pattern) => pattern.test(line)), `unexpected stdout line: ${line}`).toBe(true);
  }
}

// A deployment with exactly one warn/fail finding — database-credential-mismatch
// — the #261 "motivating failure" fixture (mirrors the existing --plan/
// --execute --safe-only tests' own setup), and always a valid 64-hex
// postgres-password so the checkpoint step has something real to preserve.
function makeCredentialMismatchFixture() {
  const targetDir = makeFixture({ withConfigure: false });
  return targetDir;
}

function findCheckpointDir(targetDir) {
  const match = readdirSync(targetDir).find((name) => name.startsWith(".orbit-repair-checkpoint."));
  return match ? join(targetDir, match) : null;
}

function findCheckpointBundle(targetDir) {
  const dir = findCheckpointDir(targetDir);
  if (!dir) return null;
  const member = readdirSync(dir).find((name) => name.endsWith(".orbkek"));
  return member ? join(dir, member) : null;
}

const stagedPasswordPath = (targetDir) => join(targetDir, ".orbit-secrets", ".repair-staged-postgres-password");

describe("scripts/repair.sh --execute --dangerous (issue #261 slice 5, stage two)", () => {
  // --- usage / flag contract ------------------------------------------------

  it("rejects --dangerous without --execute", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--dangerous"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });

  it("rejects --execute --dangerous combined with --check", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--execute", "--dangerous", "--check"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });

  it("rejects --dangerous combined with --plan", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--plan", "--dangerous"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });

  it("accepts --execute --dangerous alone (without --safe-only) as a valid invocation", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--execute", "--dangerous"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dangerous result=empty done=0 failed=0 reason=none");
  });

  // --- never automatable (Slice 4 approval-model decision: "dangerous
  // actions are never automatable"; no flag combination bypasses approval) --

  it("--execute --safe-only alone (no --dangerous) still only ever reports rotate-database-credential as skipped, with zero checkpoint activity", () => {
    const targetDir = makeCredentialMismatchFixture();
    const before = treeSnapshot(targetDir);

    const result = runRepair(targetDir, ["--execute", "--safe-only"], {
      db: { present: true, ready: true, authResult: "mismatch" },
    });

    expect(result.stdout).toContain(
      "execute action=rotate-database-credential resolves=database-credential-mismatch result=skipped",
    );
    expect(findCheckpointDir(targetDir)).toBeNull();
    expect(treeSnapshot(targetDir)).toBe(before);
  });

  it("refuses the dangerous batch under a genuinely non-interactive invocation, stable exit 6, reason=non-interactive, zero mutation, no prompt shown", () => {
    const targetDir = makeCredentialMismatchFixture();
    const before = treeSnapshot(targetDir);
    const argvLogPath = join(scratchDir(), "argv.log");

    const result = runRepair(targetDir, ["--execute", "--dangerous"], {
      db: { present: true, ready: true, authResult: "mismatch" },
      argvLogPath,
    });

    expect(result.status).toBe(6);
    expect(result.stdout).toContain("execute action=rotate-database-credential resolves=database-credential-mismatch result=skipped");
    expect(result.stdout).toContain("dangerous result=refused done=0 failed=0 reason=non-interactive");
    expect(result.stdout).not.toContain("prompt field=");
    expect(findCheckpointDir(targetDir)).toBeNull();
    expect(treeSnapshot(targetDir)).toBe(before);
    const argvLog = existsSync(argvLogPath) ? readFileSync(argvLogPath, "utf8") : "";
    expect(argvLog).not.toContain("ALTER ROLE");
  });

  it("combined --safe-only --dangerous, non-interactive: the safe batch still runs unattended while the dangerous batch is refused — each batch is independent", () => {
    const targetDir = makeCredentialMismatchFixture();
    chmodSync(join(targetDir, ".env-orbit"), 0o644); // adds a fixable managed-file-permissions finding

    const result = runRepair(targetDir, ["--execute", "--safe-only", "--dangerous"], {
      db: { present: true, ready: true, authResult: "mismatch" },
    });

    expect(result.status).toBe(6);
    expect(result.stdout).toContain("execute action=fix-permissions resolves=managed-file-permissions result=done");
    expect(result.stdout).toContain("execution result=complete done=1 failed=0");
    expect(result.stdout).toContain("dangerous result=refused done=0 failed=0 reason=non-interactive");
    expect(mode(join(targetDir, ".env-orbit"))).toBe("600");
    expect(findCheckpointDir(targetDir)).toBeNull();
  });

  // --- typed-word approval gate (owner: "operator must TYPE THE ACTION
  // WORD... a non-standard input, so muscle-memory Enter can never fire it")

  it("a bare Enter (empty input) refuses the dangerous action, exit 6, zero mutation", () => {
    const targetDir = makeCredentialMismatchFixture();
    const before = treeSnapshot(targetDir);

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      { db: { present: true, ready: true, authResult: "mismatch" } },
      { input: "\n", env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
    );

    expect(result.status).toBe(6);
    expect(result.stdout).toContain("dangerous result=refused done=0 failed=0 reason=refused-by-operator");
    expect(treeSnapshot(targetDir)).toBe(before);
  });

  it("EOF during the typed-word prompt refuses the dangerous action, exit 6, zero mutation", () => {
    const targetDir = makeCredentialMismatchFixture();
    const before = treeSnapshot(targetDir);

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      { db: { present: true, ready: true, authResult: "mismatch" } },
      { input: "", env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
    );

    expect(result.status).toBe(6);
    expect(result.stdout).toContain("dangerous result=refused done=0 failed=0 reason=refused-by-operator");
    expect(treeSnapshot(targetDir)).toBe(before);
  });

  it("any word other than the exact literal 'rotate' refuses (case-sensitive: 'Rotate'/'ROTATE'/'y' all refuse)", () => {
    for (const word of ["Rotate", "ROTATE", "y", "yes"]) {
      const targetDir = makeCredentialMismatchFixture();
      const result = runRepair(
        targetDir,
        ["--execute", "--dangerous"],
        { db: { present: true, ready: true, authResult: "mismatch" } },
        { input: `${word}\n${word}\n${word}\n`, env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
      );
      expect(result.status).toBe(6);
      expect(result.stdout).toContain("dangerous result=refused done=0 failed=0 reason=refused-by-operator");
    }
  });

  it("bounded re-prompt: a wrong word on attempt 1, then the correct word on attempt 2, proceeds", () => {
    const targetDir = makeCredentialMismatchFixture();

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      { db: { present: true, ready: true, authResult: "mismatch" } },
      {
        input: `nope\nrotate\n${ROTATE_PASSPHRASE}\n${ROTATE_PASSPHRASE}\n`,
        env: { ORBIT_REPAIR_TTY_INPUT: "1" },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dangerous result=complete done=1 failed=0 reason=none");
    expect(result.stderr).toContain("attempt(s) remaining");
  });

  it("machine prompts: the typed-word field is bounded at exactly 3 attempts, then prompt-abort", () => {
    const targetDir = makeCredentialMismatchFixture();

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      { db: { present: true, ready: true, authResult: "mismatch" } },
      { input: "no\nno\nno\n", env: { ORBIT_REPAIR_PROMPTS: "machine" } },
    );

    expect(result.status).toBe(6);
    const promptLines = lines(result.stdout).filter((line) => line.startsWith("prompt field=action-word"));
    const rejectLines = lines(result.stdout).filter((line) => line.startsWith("prompt-reject field=action-word"));
    expect(promptLines).toEqual([
      "prompt field=action-word kind=typed-word required=true attempt=1",
      "prompt field=action-word kind=typed-word required=true attempt=2",
      "prompt field=action-word kind=typed-word required=true attempt=3",
    ]);
    // configure.sh's own machine_prompt_collect convention (see
    // engine-prompts.test.mjs "aborts after a third rejected answer"): all
    // 3 attempts are individually rejected, THEN prompt-abort follows —
    // there is no 4th prompt.
    expect(rejectLines).toHaveLength(3);
    expect(result.stdout).toContain("prompt-abort field=action-word");
    expect(result.stdout).not.toContain("prompt-accept field=action-word");
  });

  it("machine prompts: an empty answer for the typed-word field is classified reason=empty, a wrong word reason=mismatch", () => {
    const targetDir = makeCredentialMismatchFixture();

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      { db: { present: true, ready: true, authResult: "mismatch" } },
      { input: "\nwrong\nwrong\n", env: { ORBIT_REPAIR_PROMPTS: "machine" } },
    );

    expect(result.stdout).toContain("prompt-reject field=action-word reason=empty");
    expect(result.stdout).toContain("prompt-reject field=action-word reason=mismatch");
  });

  // --- checkpoint-before-rotation ordering & ORBKEK01 format (owner:
  // "Checkpoints are passphrase-encrypted recovery bundles... write the
  // checkpoint in the ORBKEK01 recovery-bundle format... no new formats") --

  it("the happy path: typed word + matching passphrase rotates the credential, and proves checkpoint-before-rotation ordering end to end", () => {
    const targetDir = makeCredentialMismatchFixture();
    const dbAuthMarkerPath = join(scratchDir(), "db-auth-marker");
    const argvLogPath = join(scratchDir(), "argv.log");
    const execStdinLogPath = join(scratchDir(), "exec-stdin.log");

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      { db: { present: true, ready: true, authResult: "mismatch" }, dbAuthMarkerPath, argvLogPath, execStdinLogPath },
      { input: `rotate\n${ROTATE_PASSPHRASE}\n${ROTATE_PASSPHRASE}\n`, env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("execute action=rotate-database-credential resolves=database-credential-mismatch result=done");
    expect(result.stdout).toContain("dangerous result=complete done=1 failed=0 reason=none");
    // Post-execution re-diagnosis reflects a REAL rotation (the shim only
    // reports the database auth as healthy once the ALTER ROLE step actually
    // ran — see dbAuthMarkerPath), not a canned answer: the mismatch finding
    // is gone from the re-diagnosis's own `finding ...` lines (it still
    // legitimately appears earlier, in the `plan`/`execute` lines that
    // resolved it), and the trailing diagnosis is the very last thing
    // printed, reporting the deployment healthy.
    expect(result.stdout).not.toContain("finding class=database-credential-mismatch");
    expect(lines(result.stdout).at(-1)).toBe("diagnosis result=healthy checked=16 skipped=1");
    expect(existsSync(dbAuthMarkerPath)).toBe(true);

    // The local secret was actually rotated to a fresh 64-hex value, distinct
    // from the original.
    const newPassword = readFileSync(join(targetDir, ".orbit-secrets", "postgres-password"), "utf8").trim();
    expect(newPassword).toMatch(HEX_SECRET_PATTERN);
    expect(newPassword).not.toBe(ORIGINAL_POSTGRES_PASSWORD);
    expect(mode(join(targetDir, ".orbit-secrets", "postgres-password"))).toBe("600");

    // The staged intermediate file was moved into place, not left behind.
    expect(existsSync(stagedPasswordPath(targetDir))).toBe(false);

    // The checkpoint bundle: ORBKEK01 format, correct permissions, kept
    // (never cleaned up, unlike the stage-one private recovery directory).
    const checkpointDir = findCheckpointDir(targetDir);
    expect(checkpointDir).not.toBeNull();
    expect(mode(checkpointDir)).toBe("700");
    const bundlePath = findCheckpointBundle(targetDir);
    expect(bundlePath).not.toBeNull();
    expect(mode(bundlePath)).toBe("600");
    expect(readFileSync(bundlePath).subarray(0, 8).toString("ascii")).toBe("ORBKEK01");

    // The restart step actually ran.
    const argvLog = readFileSync(argvLogPath, "utf8");
    expect(argvLog).toMatch(/^restart /m);

    // The rotation SQL — including the fresh credential — was delivered
    // ONLY over psql's stdin (`-f -`), never as `docker`/`psql` argv:
    // neither the literal statement text nor any 64-hex-char candidate
    // (which would be the credential) ever appears in the argv log, even
    // though the exec call for it did happen (proven by the `-f -` fixture
    // matching in the log below).
    expect(argvLog).not.toContain("ALTER ROLE");
    expect(argvLog).not.toMatch(/[0-9a-f]{64}/);
    expect(argvLog).toMatch(/ -f -(\s|$)/m);

    // ...and it DID genuinely arrive over stdin: the shim's `-f -` branch
    // captured exactly what repair.sh piped into it.
    const execStdin = readFileSync(execStdinLogPath, "utf8");
    expect(execStdin).toContain(`ALTER ROLE "orbit" WITH PASSWORD '${newPassword}'`);

    expectStdoutIsEnumOnly(result.stdout);
    expect(result.stdout).not.toContain(targetDir);
    expect(result.stdout).not.toContain(ROTATE_PASSPHRASE);
    expect(result.stdout).not.toContain(ORIGINAL_POSTGRES_PASSWORD);
    expect(result.stdout).not.toContain(newPassword);
    expect(result.stderr).not.toContain(ROTATE_PASSPHRASE);
    expect(result.stderr).not.toContain(newPassword);
    // repair.sh prints the checkpoint directory as the relative path it
    // created it under (never the absolute host path) — see "Privacy"
    // above; assert on that basename rather than the absolute path.
    expect(result.stderr).toContain(basename(checkpointDir));
  });

  it("checkpoint precedes rotation: when the checkpoint itself cannot be created, no rotation SQL is ever sent (argv or stdin) and the credential is never touched", () => {
    const targetDir = makeCredentialMismatchFixture();
    const argvLogPath = join(scratchDir(), "argv.log");
    const execStdinLogPath = join(scratchDir(), "exec-stdin.log");

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      {
        db: { present: true, ready: true, authResult: "mismatch" },
        recoveryCryptoFails: true,
        argvLogPath,
        execStdinLogPath,
      },
      { input: `rotate\n${ROTATE_PASSPHRASE}\n${ROTATE_PASSPHRASE}\n`, env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
    );

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("dangerous result=failed done=0 failed=1 reason=checkpoint-failed");
    expect(result.stdout).toContain("execute action=rotate-database-credential resolves=database-credential-mismatch result=failed");
    expect(
      readFileSync(join(targetDir, ".orbit-secrets", "postgres-password"), "utf8").trim(),
    ).toBe(ORIGINAL_POSTGRES_PASSWORD);
    expect(findCheckpointDir(targetDir)).toBeNull(); // the failed attempt's own directory is cleaned up
    const argvLog = existsSync(argvLogPath) ? readFileSync(argvLogPath, "utf8") : "";
    expect(argvLog).not.toContain("ALTER ROLE");
    expect(argvLog).not.toMatch(/ -f -(\s|$)/m); // the rotate-credential exec never even ran
    expect(argvLog).not.toContain("restart");
    // No rotation SQL was received over stdin either — the shim's `-f -`
    // branch (the only thing that would have written this file) was never
    // reached at all.
    expect(existsSync(execStdinLogPath)).toBe(false);
  });

  it("when the current postgres-password secret is missing/invalid, the checkpoint step is a documented no-op (no passphrase prompt) and rotation still proceeds", () => {
    const targetDir = makeCredentialMismatchFixture();
    // Overwrite with non-hex content: repair.sh's own diagnosis never
    // content-validates secrets (only presence/mode), so this still reaches
    // rotate-database-credential the same way an entirely-missing secret
    // would (per the header's "Checkpoint — the checkpoint step is a
    // documented no-op" note), without requiring a full missing-secret
    // fixture rebuild.
    writeFileSync(join(targetDir, ".orbit-secrets", "postgres-password"), "not-a-valid-hex-secret\n");
    chmodSync(join(targetDir, ".orbit-secrets", "postgres-password"), 0o600);

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      { db: { present: true, ready: true, authResult: "mismatch" } },
      { input: "rotate\n", env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dangerous result=complete done=1 failed=0 reason=none");
    expect(result.stderr).toContain("proceeding without a content checkpoint");
    expect(result.stderr).not.toContain("checkpoint passphrase");
    expect(findCheckpointDir(targetDir)).toBeNull();
  });

  // --- rotation-step failure: guidance + checkpoint preserved + stable exit -

  it("rotation-step failure (the rotate-credential exec fails after a successful checkpoint): guidance referencing the checkpoint, checkpoint preserved, credential/config untouched, stable exit 4", () => {
    const targetDir = makeCredentialMismatchFixture();
    const argvLogPath = join(scratchDir(), "argv.log");
    const execStdinLogPath = join(scratchDir(), "exec-stdin.log");

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      {
        db: { present: true, ready: true, authResult: "mismatch" },
        alterRoleFails: true,
        argvLogPath,
        execStdinLogPath,
      },
      { input: `rotate\n${ROTATE_PASSPHRASE}\n${ROTATE_PASSPHRASE}\n`, env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
    );

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("dangerous result=failed done=0 failed=1 reason=step-failed");
    expect(result.stdout).toContain("execute action=rotate-database-credential resolves=database-credential-mismatch result=failed");

    // The checkpoint from BEFORE the failed step is preserved (never
    // cleaned up), and its path is named in stderr recovery guidance.
    const checkpointDir = findCheckpointDir(targetDir);
    expect(checkpointDir).not.toBeNull();
    expect(existsSync(findCheckpointBundle(targetDir))).toBe(true);
    expect(result.stderr).toContain("stage two step 'rotate-credential' failed");
    expect(result.stderr).toContain(basename(checkpointDir));
    expect(result.stderr).toContain("checkpoint passphrase");

    // The live secret was never overwritten (update-config never ran).
    expect(
      readFileSync(join(targetDir, ".orbit-secrets", "postgres-password"), "utf8").trim(),
    ).toBe(ORIGINAL_POSTGRES_PASSWORD);

    // restart-services never ran (the sequence stopped at rotate-credential).
    const argvLog = readFileSync(argvLogPath, "utf8");
    expect(argvLog).not.toMatch(/^restart /m);

    // The rotate-credential exec DID happen (the checkpoint had already
    // succeeded), and its SQL — including the staged credential — still
    // arrived only over stdin, never argv, even on this failing attempt.
    expect(argvLog).not.toContain("ALTER ROLE");
    expect(argvLog).not.toMatch(/[0-9a-f]{64}/);
    expect(existsSync(execStdinLogPath)).toBe(true);
    expect(readFileSync(execStdinLogPath, "utf8")).toContain('ALTER ROLE "orbit" WITH PASSWORD');

    expect(result.stdout).not.toContain(ROTATE_PASSPHRASE);
    expect(result.stdout).not.toContain(checkpointDir);
  });

  // --- passphrase rule enforcement (owner: "existing ≥12-char rule,
  // prompted twice") -----------------------------------------------------

  it("a too-short passphrase is rejected and re-prompted; correcting it on the next attempt still succeeds", () => {
    const targetDir = makeCredentialMismatchFixture();

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      { db: { present: true, ready: true, authResult: "mismatch" } },
      {
        input: `rotate\nshort\n${ROTATE_PASSPHRASE}\n${ROTATE_PASSPHRASE}\n`,
        env: { ORBIT_REPAIR_TTY_INPUT: "1" },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dangerous result=complete done=1 failed=0 reason=none");
    expect(result.stderr).toContain("at least 12 characters");
  });

  it("a too-short passphrase, never corrected within 3 attempts, fails the checkpoint step (reason=checkpoint-failed, exit 4), not the approval gate", () => {
    const targetDir = makeCredentialMismatchFixture();

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      { db: { present: true, ready: true, authResult: "mismatch" } },
      { input: "rotate\nshort\nshort\nshort\n", env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
    );

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("dangerous result=failed done=0 failed=1 reason=checkpoint-failed");
    expect(
      readFileSync(join(targetDir, ".orbit-secrets", "postgres-password"), "utf8").trim(),
    ).toBe(ORIGINAL_POSTGRES_PASSWORD);
  });

  it("a mismatched passphrase confirmation is rejected and re-prompted; a matching confirmation on the next attempt still succeeds", () => {
    const targetDir = makeCredentialMismatchFixture();

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      { db: { present: true, ready: true, authResult: "mismatch" } },
      {
        input: `rotate\n${ROTATE_PASSPHRASE}\nwrong-confirmation-value\n${ROTATE_PASSPHRASE}\n${ROTATE_PASSPHRASE}\n`,
        env: { ORBIT_REPAIR_TTY_INPUT: "1" },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dangerous result=complete done=1 failed=0 reason=none");
    expect(result.stderr).toContain("did not match");
  });

  it("a mismatched passphrase confirmation, never corrected within 3 attempts, fails the checkpoint step (exit 4)", () => {
    const targetDir = makeCredentialMismatchFixture();

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      { db: { present: true, ready: true, authResult: "mismatch" } },
      {
        // The passphrase-entry field is satisfied on its first attempt
        // (accepted immediately, ≥12 characters); all 3 remaining answer
        // lines go to the confirmation field, and MUST each differ from
        // ROTATE_PASSPHRASE (never re-using the correct value) so none of
        // them accidentally matches and short-circuits the exhaustion.
        input: `rotate\n${ROTATE_PASSPHRASE}\nwrong-confirm-1\nwrong-confirm-2\nwrong-confirm-3\n`,
        env: { ORBIT_REPAIR_TTY_INPUT: "1" },
      },
    );

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("dangerous result=failed done=0 failed=1 reason=checkpoint-failed");
  });

  it("machine prompts: a blank passphrase is reason=empty, a too-short-but-nonempty passphrase is reason=too-short", () => {
    const targetDir = makeCredentialMismatchFixture();

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      { db: { present: true, ready: true, authResult: "mismatch" } },
      { input: "rotate\n\nshort\nshort\n", env: { ORBIT_REPAIR_PROMPTS: "machine" } },
    );

    expect(result.stdout).toContain("prompt-reject field=checkpoint-passphrase reason=empty");
    expect(result.stdout).toContain("prompt-reject field=checkpoint-passphrase reason=too-short");
  });

  it("machine prompts: a passphrase-confirmation mismatch is reason=mismatch", () => {
    const targetDir = makeCredentialMismatchFixture();

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      { db: { present: true, ready: true, authResult: "mismatch" } },
      {
        input: `rotate\n${ROTATE_PASSPHRASE}\nnope\n${ROTATE_PASSPHRASE}\n${ROTATE_PASSPHRASE}\n`,
        env: { ORBIT_REPAIR_PROMPTS: "machine" },
      },
    );

    expect(result.stdout).toContain("prompt-reject field=checkpoint-passphrase-confirm reason=mismatch");
    expect(result.status).toBe(0);
  });

  // --- machine-prompt grammar (#297 style; schema-blind — grammar shape,
  // not hardcoded text where the grammar forbids it) ----------------------

  it("machine prompts: emits the full field/kind/attempt grammar for action-word, checkpoint-passphrase and checkpoint-passphrase-confirm, and never the answer itself", () => {
    const targetDir = makeCredentialMismatchFixture();

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      { db: { present: true, ready: true, authResult: "mismatch" } },
      { input: `rotate\n${ROTATE_PASSPHRASE}\n${ROTATE_PASSPHRASE}\n`, env: { ORBIT_REPAIR_PROMPTS: "machine" } },
    );

    expect(result.stdout).toContain("prompt field=action-word kind=typed-word required=true attempt=1");
    expect(result.stdout).toContain("prompt-accept field=action-word");
    expect(result.stdout).toContain("prompt field=checkpoint-passphrase kind=secret required=true attempt=1");
    expect(result.stdout).toContain("prompt-accept field=checkpoint-passphrase");
    expect(result.stdout).toContain("prompt field=checkpoint-passphrase-confirm kind=secret required=true attempt=1");
    expect(result.stdout).toContain("prompt-accept field=checkpoint-passphrase-confirm");
    expect(result.stdout).not.toContain(ROTATE_PASSPHRASE);
    expect(result.stdout).not.toContain("rotate\n"); // the typed word itself is never echoed as a value either
    expectStdoutIsEnumOnly(result.stdout);
  });

  it("machine prompts: EOF during the checkpoint-passphrase field aborts that field and refuses (checkpoint-failed)", () => {
    const targetDir = makeCredentialMismatchFixture();

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      { db: { present: true, ready: true, authResult: "mismatch" } },
      { input: "rotate\n", env: { ORBIT_REPAIR_PROMPTS: "machine" } },
    );

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("prompt-abort field=checkpoint-passphrase");
    expect(result.stdout).toContain("dangerous result=failed done=0 failed=1 reason=checkpoint-failed");
  });

  // --- post-execution re-diagnosis always runs, on every terminal outcome --

  it("post-execution re-diagnosis runs and is the final thing printed, even when the dangerous batch was refused", () => {
    const targetDir = makeCredentialMismatchFixture();

    const result = runRepair(targetDir, ["--execute", "--dangerous"], {
      db: { present: true, ready: true, authResult: "mismatch" },
    });

    expect(lines(result.stdout).at(-1)).toMatch(/^diagnosis result=/);
  });

  it("post-execution re-diagnosis runs and is the final thing printed, even when the dangerous batch failed", () => {
    const targetDir = makeCredentialMismatchFixture();

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      { db: { present: true, ready: true, authResult: "mismatch" }, alterRoleFails: true },
      { input: `rotate\n${ROTATE_PASSPHRASE}\n${ROTATE_PASSPHRASE}\n`, env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
    );

    expect(lines(result.stdout).at(-1)).toMatch(/^diagnosis result=/);
  });

  // --- stdout stays enums-only in every scenario --------------------------

  it("stdout is enum-lines-only for a refused (non-interactive) run", () => {
    const targetDir = makeCredentialMismatchFixture();
    const result = runRepair(targetDir, ["--execute", "--dangerous"], {
      db: { present: true, ready: true, authResult: "mismatch" },
    });
    expectStdoutIsEnumOnly(result.stdout);
  });

  it("stdout is enum-lines-only for a declined (wrong-word) interactive run", () => {
    const targetDir = makeCredentialMismatchFixture();
    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      { db: { present: true, ready: true, authResult: "mismatch" } },
      { input: "no\n", env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
    );
    expectStdoutIsEnumOnly(result.stdout);
  });

  it("stdout is enum-lines-only for a failed rotation step", () => {
    const targetDir = makeCredentialMismatchFixture();
    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      { db: { present: true, ready: true, authResult: "mismatch" }, alterRoleFails: true },
      { input: `rotate\n${ROTATE_PASSPHRASE}\n${ROTATE_PASSPHRASE}\n`, env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
    );
    expectStdoutIsEnumOnly(result.stdout);
  });

  it("never discloses the checkpoint directory path, the passphrase, or either credential value on stdout, across the full happy path", () => {
    const targetDir = makeCredentialMismatchFixture();
    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      { db: { present: true, ready: true, authResult: "mismatch" } },
      { input: `rotate\n${ROTATE_PASSPHRASE}\n${ROTATE_PASSPHRASE}\n`, env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
    );

    expect(result.stdout).not.toContain(targetDir);
    expect(result.stdout).not.toContain(ROTATE_PASSPHRASE);
    expect(result.stdout).not.toContain(ORIGINAL_POSTGRES_PASSWORD);
  });

  // --- combined safe + dangerous batches in one invocation -----------------

  it("both batches together: an interactively-approved safe fix and an interactively-approved dangerous rotation both execute, under one final re-diagnosis", () => {
    const targetDir = makeCredentialMismatchFixture();
    chmodSync(join(targetDir, ".env-orbit"), 0o644); // adds managed-file-permissions (safe)

    const result = runRepair(
      targetDir,
      ["--execute", "--safe-only", "--dangerous"],
      { db: { present: true, ready: true, authResult: "mismatch" } },
      {
        input: `y\nrotate\n${ROTATE_PASSPHRASE}\n${ROTATE_PASSPHRASE}\n`,
        env: { ORBIT_REPAIR_TTY_INPUT: "1" },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("execute action=fix-permissions resolves=managed-file-permissions result=done");
    expect(result.stdout).toContain("execution result=complete done=1 failed=0");
    expect(result.stdout).toContain("execute action=rotate-database-credential resolves=database-credential-mismatch result=done");
    expect(result.stdout).toContain("dangerous result=complete done=1 failed=0 reason=none");
    expect(mode(join(targetDir, ".env-orbit"))).toBe("600");
    // Exactly one trailing diagnosis block, not one per batch.
    expect(lines(result.stdout).filter((line) => line.startsWith("diagnosis result="))).toHaveLength(1);
  });

  // issue #383 finding 1: do_restart_services memoizes per service in
  // $service_restart_result, and execute_repair resets that memo only ONCE
  // before both batches run. On a deployment with BOTH
  // database-credential-mismatch (dangerous -> rotate-database-credential,
  // whose step 4 reuses do_restart_services) and application-unhealthy
  // (safe -> restart-services) — the exact #261 motivating combination,
  // since a bad credential is precisely what makes the app's own
  // healthcheck fail — `--execute --safe-only --dangerous` used to run the
  // safe batch's restart first, memoize it `done`, and then have the
  // rotation's own step 4 hit that memo and skip the restart entirely: the
  // run reported complete/done with the container still holding the
  // pre-rotation password. The fix clears the memo immediately before the
  // dangerous batch's own restart-services dispatch, so the post-rotation
  // restart always actually runs.
  it("finding 1 (issue #383): the post-rotation restart is not skipped by an earlier safe-batch restart in the same --safe-only --dangerous run", () => {
    const targetDir = makeCredentialMismatchFixture();
    const argvLogPath = join(scratchDir(), "argv.log");

    const result = runRepair(
      targetDir,
      ["--execute", "--safe-only", "--dangerous"],
      {
        db: { present: true, ready: true, authResult: "mismatch" },
        app: { health: "unhealthy" },
        argvLogPath,
      },
      {
        input: `y\nrotate\n${ROTATE_PASSPHRASE}\n${ROTATE_PASSPHRASE}\n`,
        env: { ORBIT_REPAIR_TTY_INPUT: "1" },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("execute action=restart-services resolves=application-unhealthy result=done");
    expect(result.stdout).toContain("execution result=complete done=1 failed=0");
    expect(result.stdout).toContain(
      "execute action=rotate-database-credential resolves=database-credential-mismatch result=done",
    );
    expect(result.stdout).toContain("dangerous result=complete done=1 failed=0 reason=none");

    const argvLog = readFileSync(argvLogPath, "utf8");
    const argvLines = lines(argvLog);
    const restartIndexes = argvLines
      .map((line, index) => (line.startsWith("restart ") ? index : -1))
      .filter((index) => index !== -1);
    const alterRoleIndex = argvLines.findIndex((line) => line.includes(" -f -"));

    // The bug reproduced with exactly one restart, issued BEFORE the ALTER
    // ROLE (the safe batch's own restart, with the dangerous batch's step 4
    // silently skipped by the stale memo). The fix requires two restarts:
    // the safe batch's, then a second one strictly AFTER the credential
    // rotation, so the container actually picks up the new password.
    expect(restartIndexes).toHaveLength(2);
    expect(alterRoleIndex).toBeGreaterThan(-1);
    expect(restartIndexes[0]).toBeLessThan(alterRoleIndex);
    expect(restartIndexes[1]).toBeGreaterThan(alterRoleIndex);
  });
});

// ---------------------------------------------------------------------------
// --execute --dangerous: regenerate-secret (#530 slice, ADR-0014 decision 5)
// ---------------------------------------------------------------------------

function secretsDirEntries(targetDir) {
  return readdirSync(join(targetDir, ".orbit-secrets"));
}

describe("scripts/repair.sh --execute --dangerous: regenerate-secret (#530 slice)", () => {
  // --- never automatable / typed-word approval gate -----------------------

  it("refuses the dangerous batch under a genuinely non-interactive invocation, exit 6, zero mutation, no prompt shown", () => {
    const targetDir = makeFixture({ withConfigure: false });
    rmSync(join(targetDir, ".orbit-secrets", "session-secret"));
    const before = treeSnapshot(targetDir);

    const result = runRepair(targetDir, ["--execute", "--dangerous"]);

    expect(result.status).toBe(6);
    expect(result.stdout).toContain("execute action=regenerate-secret resolves=secret-missing result=skipped");
    expect(result.stdout).toContain("dangerous result=refused done=0 failed=0 reason=non-interactive");
    expect(result.stdout).not.toContain("prompt field=");
    expect(treeSnapshot(targetDir)).toBe(before);
    expect(existsSync(join(targetDir, ".orbit-secrets", "session-secret"))).toBe(false);
  });

  it("a bare Enter (empty input) refuses, exit 6, zero mutation", () => {
    const targetDir = makeFixture({ withConfigure: false });
    rmSync(join(targetDir, ".orbit-secrets", "session-secret"));
    const before = treeSnapshot(targetDir);

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      {},
      { input: "\n", env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
    );

    expect(result.status).toBe(6);
    expect(result.stdout).toContain("dangerous result=refused done=0 failed=0 reason=refused-by-operator");
    expect(treeSnapshot(targetDir)).toBe(before);
  });

  it("EOF during the typed-word prompt refuses, exit 6, zero mutation", () => {
    const targetDir = makeFixture({ withConfigure: false });
    rmSync(join(targetDir, ".orbit-secrets", "session-secret"));
    const before = treeSnapshot(targetDir);

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      {},
      { input: "", env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
    );

    expect(result.status).toBe(6);
    expect(result.stdout).toContain("dangerous result=refused done=0 failed=0 reason=refused-by-operator");
    expect(treeSnapshot(targetDir)).toBe(before);
  });

  it("any word other than the exact literal 'regenerate' refuses (case-sensitive), 3 attempts then exit 6, zero mutation", () => {
    for (const word of ["Regenerate", "REGENERATE", "y", "rotate"]) {
      const targetDir = makeFixture({ withConfigure: false });
      rmSync(join(targetDir, ".orbit-secrets", "session-secret"));

      const result = runRepair(
        targetDir,
        ["--execute", "--dangerous"],
        {},
        { input: `${word}\n${word}\n${word}\n`, env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
      );

      expect(result.status).toBe(6);
      expect(result.stdout).toContain("dangerous result=refused done=0 failed=0 reason=refused-by-operator");
      expect(existsSync(join(targetDir, ".orbit-secrets", "session-secret"))).toBe(false);
    }
  });

  it("bounded re-prompt: a wrong word on attempt 1, then the correct word on attempt 2, proceeds", () => {
    const targetDir = makeFixture({ withConfigure: false });
    rmSync(join(targetDir, ".orbit-secrets", "session-secret"));

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      {},
      { input: "nope\nregenerate\n", env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dangerous result=complete done=1 failed=0 reason=none");
    expect(result.stderr).toContain("attempt(s) remaining");
  });

  it("machine prompts: the typed-word field is bounded at exactly 3 attempts, then prompt-abort, using the word 'regenerate'", () => {
    const targetDir = makeFixture({ withConfigure: false });
    rmSync(join(targetDir, ".orbit-secrets", "session-secret"));

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      {},
      { input: "no\nno\nno\n", env: { ORBIT_REPAIR_PROMPTS: "machine" } },
    );

    expect(result.status).toBe(6);
    const promptLines = lines(result.stdout).filter((line) => line.startsWith("prompt field=action-word"));
    expect(promptLines).toEqual([
      "prompt field=action-word kind=typed-word required=true attempt=1",
      "prompt field=action-word kind=typed-word required=true attempt=2",
      "prompt field=action-word kind=typed-word required=true attempt=3",
    ]);
    expect(result.stdout).toContain("prompt-abort field=action-word");
    expect(result.stdout).not.toContain("prompt-accept field=action-word");
  });

  it("machine prompts: the correct word 'regenerate' is accepted and mutates the secret", () => {
    const targetDir = makeFixture({ withConfigure: false });
    rmSync(join(targetDir, ".orbit-secrets", "session-secret"));

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      {},
      { input: "regenerate\n", env: { ORBIT_REPAIR_PROMPTS: "machine" } },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("prompt-accept field=action-word");
    expect(result.stdout).toContain("dangerous result=complete done=1 failed=0 reason=none");
    expect(result.stdout).not.toContain("regenerate\n"); // the typed word itself is never echoed as a value
  });

  // --- successful regeneration: write discipline ---------------------------

  it("the successful regeneration writes a fresh 64-hex secret at mode 600, with no leftover staging temp file", () => {
    const targetDir = makeFixture({ withConfigure: false });
    rmSync(join(targetDir, ".orbit-secrets", "session-secret"));

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      {},
      { input: "regenerate\n", env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("execute action=regenerate-secret resolves=secret-missing result=done");
    expect(result.stdout).toContain("dangerous result=complete done=1 failed=0 reason=none");

    const secretPath = join(targetDir, ".orbit-secrets", "session-secret");
    const content = readFileSync(secretPath, "utf8").trim();
    expect(content).toMatch(HEX_SECRET_PATTERN);
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);

    // No leftover `.installing.*` staging temp file — the rename onto the
    // live path is the last thing the write discipline does.
    const leftoverStaging = secretsDirEntries(targetDir).filter((name) => name.startsWith(".installing."));
    expect(leftoverStaging).toHaveLength(0);
  });

  it("regenerates a real zero-byte placeholder secret (install.sh's own OIDC_CLIENT_SECRET_FILE shape) — the old empty placeholder is gone, replaced by real content", () => {
    const targetDir = makeFixture({ withConfigure: false });
    // Mirrors ensure_oidc_client_secret_placeholder in configure.sh: a real,
    // zero-byte, mode-0600 file — not simply removed — is exactly what a
    // real install.sh deployment produces before an operator ever runs
    // --set-oidc-secret.
    writeFileSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), "");
    chmodSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), 0o600);

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      {},
      { input: "regenerate\n", env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("execute action=regenerate-secret resolves=secret-missing result=done");

    const secretPath = join(targetDir, ".orbit-secrets", "oidc-client-secret");
    const content = readFileSync(secretPath, "utf8").trim();
    expect(content).toMatch(HEX_SECRET_PATTERN);
    expect(content.length).toBeGreaterThan(0);
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);
  });

  it("regenerates every distinct missing-secret target deferred in the same run", () => {
    const targetDir = makeFixture({ withConfigure: false });
    rmSync(join(targetDir, ".orbit-secrets", "session-secret"));
    rmSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"));

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      {},
      { input: "regenerate\n", env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
    );

    expect(result.status).toBe(0);
    const doneLines = lines(result.stdout).filter(
      (line) => line === "execute action=regenerate-secret resolves=secret-missing result=done",
    );
    expect(doneLines).toHaveLength(2);
    expect(result.stdout).toContain("dangerous result=complete done=2 failed=0 reason=none");

    const sessionSecret = readFileSync(join(targetDir, ".orbit-secrets", "session-secret"), "utf8").trim();
    const oidcSecret = readFileSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), "utf8").trim();
    expect(sessionSecret).toMatch(HEX_SECRET_PATTERN);
    expect(oidcSecret).toMatch(HEX_SECRET_PATTERN);
    expect(sessionSecret).not.toBe(oidcSecret);
  });

  // --- step failure: TOCTOU re-proof catches a change during the approval
  // window, leaving the secret recoverable (still absent, never corrupted) --

  it("a permissions change on the secrets directory during the approval window fails the step cleanly: reason=step-failed, exit 4, secret still absent and recoverable on retry", async () => {
    const targetDir = makeFixture({ withConfigure: false });
    rmSync(join(targetDir, ".orbit-secrets", "session-secret"));

    const spawned = spawnRepair(targetDir, ["--execute", "--dangerous"], {}, { env: { ORBIT_REPAIR_TTY_INPUT: "1" } });

    try {
      await waitForStderr(spawned, (text) => text.includes("type 'regenerate'"));
      // Simulates a concurrent process/operator narrowing the secrets
      // directory's permissions in the window between the plan preview and
      // the operator's typed confirmation — exactly the TOCTOU gap
      // do_regenerate_secret_step's own re-proof (mirroring
      // fix-permissions') exists to catch.
      chmodSync(join(targetDir, ".orbit-secrets"), 0o500);
      spawned.child.stdin.write("regenerate\n");
      spawned.child.stdin.end();

      const result = await spawned.exited;

      expect(result.status).toBe(4);
      expect(result.stdoutText()).toContain("dangerous result=failed done=0 failed=1 reason=step-failed");
      expect(result.stdoutText()).toContain(
        "execute action=regenerate-secret resolves=secret-missing result=failed",
      );
      expect(result.stderrText()).toContain("stage two regenerate-secret step");

      // Recoverable: nothing was written. Restore the directory mode an
      // operator would fix, and confirm a plain retry still works.
      chmodSync(join(targetDir, ".orbit-secrets"), 0o700);
      expect(existsSync(join(targetDir, ".orbit-secrets", "session-secret"))).toBe(false);
      const leftoverStaging = secretsDirEntries(targetDir).filter((name) => name.startsWith(".installing."));
      expect(leftoverStaging).toHaveLength(0);

      const retry = runRepair(
        targetDir,
        ["--execute", "--dangerous"],
        {},
        { input: "regenerate\n", env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
      );
      expect(retry.status).toBe(0);
      expect(
        readFileSync(join(targetDir, ".orbit-secrets", "session-secret"), "utf8").trim(),
      ).toMatch(HEX_SECRET_PATTERN);
    } finally {
      chmodSync(join(targetDir, ".orbit-secrets"), 0o700);
    }
  });

  // --- mixed dangerous batch: rotate-database-credential AND
  // regenerate-secret together in one run --------------------------------

  it("a mixed dangerous batch (retained-volume rotation + an unrelated missing secret) requires BOTH typed words in turn, then executes both", () => {
    const targetDir = makeFixture({ withConfigure: false });
    rmSync(join(targetDir, ".orbit-secrets", "postgres-password"));
    rmSync(join(targetDir, ".orbit-secrets", "session-secret"));

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      { volumes: ["repairtest_orbit-db-data"] },
      { input: "rotate\nregenerate\n", env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "execute action=rotate-database-credential resolves=secret-missing result=done",
    );
    expect(result.stdout).toContain(
      "execute action=rotate-database-credential resolves=volume-retained-without-credentials result=done",
    );
    expect(result.stdout).toContain("execute action=regenerate-secret resolves=secret-missing result=done");
    expect(result.stdout).toContain("dangerous result=complete done=3 failed=0 reason=none");

    expect(
      readFileSync(join(targetDir, ".orbit-secrets", "postgres-password"), "utf8").trim(),
    ).toMatch(HEX_SECRET_PATTERN);
    expect(
      readFileSync(join(targetDir, ".orbit-secrets", "session-secret"), "utf8").trim(),
    ).toMatch(HEX_SECRET_PATTERN);
  });

  it("in a mixed batch, refusing the SECOND word (regenerate) refuses the WHOLE batch — the credential is never rotated either, even though 'rotate' was typed correctly", () => {
    const targetDir = makeFixture({ withConfigure: false });
    rmSync(join(targetDir, ".orbit-secrets", "postgres-password"));
    rmSync(join(targetDir, ".orbit-secrets", "session-secret"));
    const argvLogPath = join(scratchDir(), "argv.log");

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      { volumes: ["repairtest_orbit-db-data"], argvLogPath },
      { input: "rotate\nwrong\nwrong\nwrong\n", env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
    );

    expect(result.status).toBe(6);
    expect(result.stdout).toContain("dangerous result=refused done=0 failed=0 reason=refused-by-operator");
    expect(existsSync(join(targetDir, ".orbit-secrets", "postgres-password"))).toBe(false);
    expect(existsSync(join(targetDir, ".orbit-secrets", "session-secret"))).toBe(false);
    expect(findCheckpointDir(targetDir)).toBeNull();
    const argvLog = existsSync(argvLogPath) ? readFileSync(argvLogPath, "utf8") : "";
    expect(argvLog).not.toContain("ALTER ROLE");
  });

  // --- output hygiene: no path, secret value or raw error anywhere --------

  it("never discloses the generated secret value, a path, or a raw error on stdout, stderr, argv or logs", () => {
    const targetDir = makeFixture({ withConfigure: false });
    rmSync(join(targetDir, ".orbit-secrets", "session-secret"));
    const argvLogPath = join(scratchDir(), "argv.log");

    const result = runRepair(
      targetDir,
      ["--execute", "--dangerous"],
      { argvLogPath },
      { input: "regenerate\n", env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
    );

    expect(result.status).toBe(0);
    const newSecret = readFileSync(join(targetDir, ".orbit-secrets", "session-secret"), "utf8").trim();
    expect(result.stdout).not.toContain(newSecret);
    expect(result.stderr).not.toContain(newSecret);
    expect(result.stdout).not.toContain(targetDir);
    expect(result.stderr).not.toContain(targetDir);
    expect(result.stdout).not.toContain(".orbit-secrets");
    expectStdoutIsEnumOnly(result.stdout);
    const argvLog = existsSync(argvLogPath) ? readFileSync(argvLogPath, "utf8") : "";
    expect(argvLog).not.toContain(newSecret);
  });
});

// issue #383 finding 4: unlike install.sh/restore.sh/backup.sh/configure.sh
// (all `trap cleanup EXIT`), repair.sh registered no trap at all, so an
// abrupt termination (Ctrl-C, SIGTERM) mid-`--execute` left this run's own
// private recovery directory (`.orbit-repair-recovery.*`, holding plaintext
// copies of whatever restore-transaction had touched so far) behind
// forever, with no message to the operator. The fix adds `trap cleanup
// EXIT`, mirroring the other scripts' shape: it removes the recovery
// directory (the same removal cleanup_recovery_dir already performs at the
// end of every normal run) and prints interrupt guidance, without ever
// printing the recovery directory's own path (the "Privacy" contract is
// unchanged).
describe("scripts/repair.sh EXIT trap (issue #383 finding 4)", () => {
  it("removes its own private recovery directory and prints interrupt guidance when killed mid-run, instead of leaving it behind silently", async () => {
    const targetDir = makeCredentialMismatchFixture();
    makeStagingTransaction(targetDir, {
      envBackupLines: ["APP_URL=https://orbit.old-good-state.internal", "COMPOSE_PROJECT_NAME=repairtest"],
    });

    const spawned = spawnRepair(
      targetDir,
      ["--execute", "--safe-only", "--dangerous"],
      { db: { present: true, ready: true, authResult: "mismatch" } },
      { env: { ORBIT_REPAIR_TTY_INPUT: "1" } },
    );

    try {
      // Approve the safe batch: restore-transaction runs, which opens this
      // run's private recovery directory (the only action class that ever
      // needs one — see "Private recovery directory" in repair.sh's own
      // header). Then wait for the dangerous batch's own typed-word prompt
      // — the natural pause point after the recovery directory exists but
      // before execute_repair's own end-of-run cleanup_recovery_dir has had
      // a chance to run.
      await waitForStderr(spawned, (text) => text.includes("Proceed? [y/N]"));
      spawned.child.stdin.write("y\n");
      await waitForStderr(spawned, (text) => text.includes("type 'rotate'"));

      // Confirm the recovery directory genuinely exists before the kill —
      // otherwise this test would trivially pass for the wrong reason.
      const beforeKill = readdirSync(targetDir).filter((name) => name.startsWith(".orbit-repair-recovery."));
      expect(beforeKill).toHaveLength(1);

      spawned.child.kill("SIGTERM");
      const result = await spawned.exited;

      expect(result.signal).toBe("SIGTERM");
      expect(result.stderrText()).toContain("interrupted before completion");
      // Never discloses the recovery directory's own path, killed or not.
      expect(result.stderrText()).not.toContain(beforeKill[0]);
      const afterKill = readdirSync(targetDir).filter((name) => name.startsWith(".orbit-repair-recovery."));
      expect(afterKill).toHaveLength(0);
    } finally {
      if (!spawned.child.killed) {
        spawned.child.kill("SIGKILL");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// --export-diagnostics (issue #531, ADR-0014 decision 10)
// ---------------------------------------------------------------------------
//
// Decision 10: exported diagnostics are the deterministic --check/--plan
// stream and nothing else, plus exactly one identity line of already-safe
// metadata (configuration schema version, applied version, the digest-
// pinned image reference — public values under ADR-0008). The full content
// is printed to the terminal and explicitly confirmed before any file is
// written; allowlisting is inherited entirely from --check/--plan's own
// enum-only contract, never a second redaction layer.

const IDENTITY_DIGEST = "b".repeat(64);
const IDENTITY_APPLIED_DIGEST = `sha256:${IDENTITY_DIGEST}`;
const IDENTITY_IMAGE = `ghcr.io/tomlawesome/orbit@${IDENTITY_APPLIED_DIGEST}`;
const IDENTITY_LINE_PATTERN =
  /^identity schema_version=(?:\d{1,10}|unknown) applied_version=(?:v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)|unknown) image=(?:[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}|unknown)$/;

// Overwrites .env-orbit with the three ADR-0014 decision 10 identity fields
// set to well-formed values by default — the exact shapes
// configuration.sh's own is_valid_applied_version/is_valid_applied_digest/
// is_valid_immutable_image validators require (configuration.sh:93-103;
// repair.sh mirrors rather than shares these per decision 2) — plus a
// representative spread of the OTHER configured values a real deployment
// carries (APP_URL, OIDC settings, a project name), so the leak test below
// has real non-identity values to prove absent. Pass `null` for
// schemaVersion/appliedVersion/image to omit that key entirely (the
// "missing" case); pass any other string to test the "malformed" case.
function writeIdentityEnv(targetDir, overrides = {}) {
  const schemaVersion = "schemaVersion" in overrides ? overrides.schemaVersion : "1";
  const appliedVersion = "appliedVersion" in overrides ? overrides.appliedVersion : "v1.2.0";
  const image = "image" in overrides ? overrides.image : IDENTITY_IMAGE;

  const envLines = [
    "APP_URL=https://orbit.repair-test.internal",
    ...(image === null ? [] : [`ORBIT_IMAGE=${image}`]),
    "OIDC_ISSUER=https://auth.repair-test.internal/application/o/orbit/",
    "OIDC_CLIENT_ID=repair-test-client",
    "OIDC_CLIENT_SECRET=repair-test-secret",
    "OIDC_CALLBACK_URL=https://orbit.repair-test.internal/api/auth/callback",
    "COMPOSE_PROJECT_NAME=repairtest",
    ...(schemaVersion === null ? [] : [`ORBIT_CONFIG_SCHEMA_VERSION=${schemaVersion}`]),
    ...(appliedVersion === null ? [] : [`ORBIT_CONFIG_APPLIED_VERSION=${appliedVersion}`]),
    `ORBIT_CONFIG_APPLIED_DIGEST=${IDENTITY_APPLIED_DIGEST}`,
    "",
  ].join("\n");
  writeFileSync(join(targetDir, ".env-orbit"), envLines);
  chmodSync(join(targetDir, ".env-orbit"), 0o600);
}

describe("scripts/repair.sh --export-diagnostics (issue #531, ADR-0014 decision 10)", () => {
  // The docker shim's own `app.image` must match ORBIT_IMAGE or the
  // unrelated stale-container check fires a warn finding, which would make
  // the preview/byte-identical tests below depend on an incidental finding
  // instead of the export-diagnostics contract itself.
  const HEALTHY_APP_OPTIONS = { app: { image: IDENTITY_IMAGE, health: "healthy" } };
  const DECLINE = { input: "n\n", env: { ORBIT_REPAIR_TTY_INPUT: "1" } };
  const ACCEPT = { input: "y\n", env: { ORBIT_REPAIR_TTY_INPUT: "1" } };

  // --- flag surface -----------------------------------------------------

  it("rejects a bare invocation with no mode", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, []);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });

  it("rejects --export-diagnostics combined with --check", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--export-diagnostics", "--check"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });

  it("rejects --export-diagnostics combined with --plan", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--plan", "--export-diagnostics"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });

  it("rejects --export-diagnostics combined with --execute", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--execute", "--export-diagnostics"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });

  it("rejects --safe-only alongside --export-diagnostics", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--export-diagnostics", "--safe-only"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });

  it("rejects --dangerous alongside --export-diagnostics", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--export-diagnostics", "--dangerous"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });

  it("tolerates --plain in either order around --export-diagnostics", () => {
    const targetDir = makeFixture();
    const first = runRepair(targetDir, ["--export-diagnostics", "--plain"], {}, DECLINE);
    const second = runRepair(targetDir, ["--plain", "--export-diagnostics"], {}, DECLINE);
    expect(first.status).toBe(1);
    expect(second.status).toBe(1);
    expect(first.stdout).toBe(second.stdout);
  });

  it("exits 5 for a directory with no Orbit fingerprint: prints exactly the --check + --plan early content, never an identity line, a prompt, or a file", () => {
    const targetDir = scratchDir();
    mkdirSync(join(targetDir, "scripts"));
    writeFileSync(join(targetDir, "scripts", "repair.sh"), repairScriptSource);
    chmodSync(join(targetDir, "scripts", "repair.sh"), 0o755);

    const result = runRepair(targetDir, ["--export-diagnostics"]);

    expect(result.status).toBe(5);
    expect(lines(result.stdout)).toEqual([
      "finding class=not-orbit-directory target=directory severity=fail",
      "diagnosis result=failed checked=1 skipped=16",
      "plan action=manual resolves=not-orbit-directory mutation=none backup=not-required",
      "plan result=manual-required actions=0 manual=1",
    ]);
    expect(result.stdout).not.toContain("identity ");
    expect(result.stderr).not.toContain("[y/N]");
    expect(readdirSync(targetDir).some((name) => name.startsWith(".orbit-repair-diagnostics."))).toBe(false);
  });

  // --- preview content -------------------------------------------------

  it("previews the exact --check + --plan content plus the identity line, on stdout, before any confirmation prompt", () => {
    const targetDir = makeFixture({ withConfigure: false });
    writeIdentityEnv(targetDir);

    const checkResult = runRepair(targetDir, ["--check"], HEALTHY_APP_OPTIONS);
    const planResult = runRepair(targetDir, ["--plan"], HEALTHY_APP_OPTIONS);
    const result = runRepair(targetDir, ["--export-diagnostics"], HEALTHY_APP_OPTIONS, DECLINE);

    const expectedIdentity = `identity schema_version=1 applied_version=v1.2.0 image=${IDENTITY_IMAGE}`;
    expect(result.stdout).toBe(`${checkResult.stdout}${planResult.stdout}${expectedIdentity}\n`);
    expect(result.stderr).toContain("write the diagnostics above to a file? [y/N]");
  });

  // --- decline -----------------------------------------------------------

  it("declining writes nothing at all: no file, no temporary file left behind, exit 1, zero mutation", () => {
    const targetDir = makeFixture({ withConfigure: false });
    writeIdentityEnv(targetDir);
    const before = treeSnapshot(targetDir);

    const result = runRepair(targetDir, ["--export-diagnostics"], HEALTHY_APP_OPTIONS, DECLINE);

    expect(result.status).toBe(1);
    expect(treeSnapshot(targetDir)).toBe(before);
    expect(readdirSync(targetDir).some((name) => name.startsWith(".orbit-repair-diagnostics."))).toBe(false);
  });

  it("declines with no confirmation channel at all (fully non-interactive), without a prompt or a file", () => {
    const targetDir = makeFixture({ withConfigure: false });
    writeIdentityEnv(targetDir);
    const before = treeSnapshot(targetDir);

    const result = runRepair(targetDir, ["--export-diagnostics"], HEALTHY_APP_OPTIONS);

    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("[y/N]");
    expect(treeSnapshot(targetDir)).toBe(before);
    expect(readdirSync(targetDir).some((name) => name.startsWith(".orbit-repair-diagnostics."))).toBe(false);
  });

  // --- accept --------------------------------------------------------------

  it("accepting writes a mode-600 file whose content matches the preview, reporting the path on stderr only", () => {
    const targetDir = makeFixture({ withConfigure: false });
    writeIdentityEnv(targetDir);

    const result = runRepair(targetDir, ["--export-diagnostics"], HEALTHY_APP_OPTIONS, ACCEPT);

    expect(result.status).toBe(0);
    const written = readdirSync(targetDir).find((name) => name.startsWith(".orbit-repair-diagnostics."));
    expect(written).toBeDefined();
    const writtenPath = join(targetDir, written);
    expect(mode(writtenPath)).toBe("600");
    expect(readFileSync(writtenPath, "utf8")).toBe(result.stdout);
    expect(result.stdout).not.toContain(written);
    expect(result.stdout).not.toContain(targetDir);
    expect(result.stderr).toContain(written);
    expect(result.stderr).toContain("diagnostics exported to");
  });

  // --- identity line grammar ------------------------------------------------

  it("the identity line carries exactly three named fields matching a fixed grammar", () => {
    const targetDir = makeFixture({ withConfigure: false });
    writeIdentityEnv(targetDir);

    const result = runRepair(targetDir, ["--export-diagnostics"], HEALTHY_APP_OPTIONS, DECLINE);

    const identityLines = lines(result.stdout).filter((line) => line.startsWith("identity"));
    expect(identityLines).toHaveLength(1);
    expect(identityLines[0]).toMatch(IDENTITY_LINE_PATTERN);
    // "identity" + exactly 3 "key=value" tokens: a 4th field appended
    // anywhere would fail this even if it happened to look field-shaped.
    expect(identityLines[0].split(" ")).toHaveLength(4);
  });

  // --- the leak test: nothing but the three identity fields ever appears ---

  it("never contains any other configured value from .env-orbit — only the three identity fields, ever", () => {
    const targetDir = makeFixture({ withConfigure: false });
    writeIdentityEnv(targetDir);

    const result = runRepair(targetDir, ["--export-diagnostics"], HEALTHY_APP_OPTIONS, ACCEPT);
    expect(result.status).toBe(0);
    const written = readdirSync(targetDir).find((name) => name.startsWith(".orbit-repair-diagnostics."));
    const fileContent = readFileSync(join(targetDir, written), "utf8");

    const otherConfiguredValues = [
      "https://orbit.repair-test.internal", // APP_URL
      "https://auth.repair-test.internal/application/o/orbit/", // OIDC_ISSUER
      "repair-test-client", // OIDC_CLIENT_ID
      "repair-test-secret", // OIDC_CLIENT_SECRET
      "https://orbit.repair-test.internal/api/auth/callback", // OIDC_CALLBACK_URL
      "repairtest", // COMPOSE_PROJECT_NAME
      "a".repeat(64), // every .orbit-secrets file's raw value
    ];
    for (const value of otherConfiguredValues) {
      expect(result.stdout).not.toContain(value);
      expect(fileContent).not.toContain(value);
    }

    // The bounded exception: exactly the identity line's three fields.
    const expectedIdentity = `identity schema_version=1 applied_version=v1.2.0 image=${IDENTITY_IMAGE}`;
    expect(fileContent).toContain(expectedIdentity);
  });

  // --- missing/malformed identity fields -> placeholder, never the raw value

  describe("a missing or malformed identity field falls back to the fixed placeholder", () => {
    const scenarios = [
      { label: "missing schema_version", overrides: { schemaVersion: null }, field: "schema_version" },
      { label: "malformed schema_version (non-numeric)", overrides: { schemaVersion: "not-a-number" }, field: "schema_version" },
      { label: "missing applied_version", overrides: { appliedVersion: null }, field: "applied_version" },
      { label: "malformed applied_version (missing v prefix)", overrides: { appliedVersion: "1.2.0" }, field: "applied_version" },
      { label: "missing image (ORBIT_IMAGE)", overrides: { image: null }, field: "image" },
      { label: "malformed image (not digest-pinned)", overrides: { image: "orbit-local:abcdef123456" }, field: "image" },
    ];

    for (const { label, overrides, field } of scenarios) {
      it(`${label} -> placeholder "unknown" for ${field}, raw value never appears, still exactly three fields`, () => {
        const targetDir = makeFixture({ withConfigure: false });
        writeIdentityEnv(targetDir, overrides);

        const result = runRepair(targetDir, ["--export-diagnostics"], {}, DECLINE);

        const identity = lines(result.stdout).find((line) => line.startsWith("identity"));
        expect(identity).toMatch(IDENTITY_LINE_PATTERN);
        expect(identity).toContain(`${field}=unknown`);
        expect(identity.split(" ")).toHaveLength(4);

        const rawValue = overrides[Object.keys(overrides)[0]];
        if (rawValue) {
          expect(result.stdout).not.toContain(rawValue);
        }
      });
    }
  });

  // --- determinism -----------------------------------------------------

  it("produces byte-identical output across two runs against identical state", () => {
    const targetDir = makeFixture({ withConfigure: false });
    writeIdentityEnv(targetDir);

    const first = runRepair(targetDir, ["--export-diagnostics"], HEALTHY_APP_OPTIONS, DECLINE);
    const second = runRepair(targetDir, ["--export-diagnostics"], HEALTHY_APP_OPTIONS, DECLINE);

    expect(first.status).toBe(second.status);
    expect(first.stdout).toBe(second.stdout);
  });
});
