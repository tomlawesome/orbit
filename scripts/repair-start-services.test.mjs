import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { writeEngineDockerShim } from "./engine-docker-shim.mjs";
import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// #1535: repair starts a deployment whose services are not running. Written
// from the issue's specification alone: finding `services-not-running`, action
// `start-services` (mutation=service-start, expect=services-healthy), run as
// Compose's own reconcile `up -d --no-build --no-recreate`, never
// `--remove-orphans`, and only when the deployment is complete on disk.
//
// Harness: the same one scripts/repair.test.mjs uses -- repair.sh runs from a
// copied fixture with a fake `docker` ahead of the real one on PATH. That
// suite's fixture builders are not exported (importing the file would register
// its tests here), so the base shim source is lifted from it and the fixture
// builders are repeated in the same shape. The base shim cannot say a container
// exists but is stopped, nor accept `compose up`, so a thin stateful wrapper
// sits in front of it: one state file per service (absent file = no container;
// "running" or "stopped"), which `compose ... up` flips to running, exactly as a
// Compose reconcile would.

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoDir = join(scriptsDir, "..");
const repairScriptSource = readFileSync(join(scriptsDir, "repair.sh"), "utf8");
const configureScriptSource = readFileSync(join(scriptsDir, "configure.sh"), "utf8");
const installerUiSource = readFileSync(join(scriptsDir, "installer-ui.sh"), "utf8");
const environmentExampleSource = readFileSync(join(repoDir, ".env-orbit.example"), "utf8");
const engineEventsDoc = readFileSync(join(repoDir, "docs", "engine-events.md"), "utf8");

const baseHarnessSource = readFileSync(join(scriptsDir, "repair.test.mjs"), "utf8");
const shimStart = baseHarnessSource.indexOf("function dockerShimScript(");
const shimEnd = baseHarnessSource.indexOf("\nfunction makeFakeBin(");
if (shimStart < 0 || shimEnd < shimStart) throw new Error("repair.test.mjs no longer defines dockerShimScript");
const FIXTURE_IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;
const FIXTURE_IMAGE = `ghcr.io/tomlawesome/orbit@${FIXTURE_IMAGE_DIGEST}`;
const dockerShimScript = new Function(
  "recoveryCryptoScriptPath",
  "FIXTURE_IMAGE",
  `${baseHarnessSource.slice(shimStart, shimEnd)}\nreturn dockerShimScript;`,
)(join(scriptsDir, "recovery-crypto.mjs"), FIXTURE_IMAGE);
const DB_ID = "1111aaaa2222";
const APP_ID = "3333bbbb4444";
const COMPOSE_UP = "up -d --no-build --no-recreate";

const scratchDirs = [];
afterEach(() => {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop(), { recursive: true, force: true });
});

function scratchDir(prefix = "orbit-repair-start-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function makeFixture({ withConfigure = true } = {}) {
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
  writeFileSync(join(targetDir, "docker-compose.yml"), "services:\n  orbit-app:\n    image: busybox\n");
  writeFileSync(
    join(targetDir, ".env-orbit"),
    [
      "APP_URL=https://orbit.repair-test.internal",
      `ORBIT_IMAGE=${FIXTURE_IMAGE}`,
      "ORBIT_CONFIG_APPLIED_VERSION=v0.3.0",
      `ORBIT_CONFIG_APPLIED_DIGEST=${FIXTURE_IMAGE_DIGEST}`,
      "OIDC_ISSUER=https://auth.repair-test.internal/application/o/orbit/",
      "OIDC_CLIENT_ID=repair-test-client",
      "OIDC_CLIENT_SECRET=repair-test-secret",
      "OIDC_CALLBACK_URL=https://orbit.repair-test.internal/api/auth/callback",
      "COMPOSE_PROJECT_NAME=repairtest",
      "",
    ].join("\n"),
  );
  chmodSync(join(targetDir, ".env-orbit"), 0o600);
  mkdirSync(join(targetDir, ".orbit-secrets"), { mode: 0o700 });
  for (const name of ["session-secret", "postgres-password", "document-kek", "oidc-client-secret"]) {
    writeFileSync(join(targetDir, ".orbit-secrets", name), "a".repeat(64) + "\n");
    chmodSync(join(targetDir, ".orbit-secrets", name), 0o600);
  }
  return targetDir;
}

function treeSnapshot(targetDir) {
  const result = spawnSync("bash", ["-c", 'find . -mindepth 1 -printf "%p %m %s %y\\n" | LC_ALL=C sort'], {
    cwd: targetDir,
    encoding: "utf8",
  });
  return result.stdout;
}

// Runs repair.sh with the stateful docker. `db` / `app`: "absent" | "stopped" |
// "running". `dbReady=false` makes pg_isready fail on a running database.
// `upFails` makes `compose up` exit 1 after writing `upStderr` to stderr.
function runRepair(
  targetDir,
  args,
  { db = "absent", app = "absent", dbReady = true, upFails = false, upStderr = "", docker = {}, input, env } = {},
) {
  const binDir = scratchDir("orbit-repair-start-bin-");
  const engineDir = scratchDir("orbit-repair-start-engine-");
  const stateDir = scratchDir("orbit-repair-start-state-");
  const engineDockerPath = writeEngineDockerShim(engineDir);
  writeFileSync(join(binDir, "docker-base"), dockerShimScript({ engineDockerPath, ...docker }));
  chmodSync(join(binDir, "docker-base"), 0o755);
  for (const [name, state] of [["orbit-db", db], ["orbit-app", app]]) {
    if (state !== "absent") writeFileSync(join(stateDir, name), state);
  }
  if (!dbReady) writeFileSync(join(stateDir, "db-not-ready"), "");
  if (upFails) writeFileSync(join(stateDir, "up-fails"), "");
  writeFileSync(join(stateDir, "up-stderr"), upStderr);
  if (docker.unavailable) writeFileSync(join(stateDir, "passthrough"), "");
  writeFileSync(
    join(binDir, "docker"),
    [
      "#!/usr/bin/env bash",
      `S='${stateDir}'`,
      `BASE='${join(binDir, "docker-base")}'`,
      `DB_ID='${DB_ID}'`,
      `APP_ID='${APP_ID}'`,
      'printf "%s\\n" "$*" >> "$S/argv.log"',
      '[[ -e "$S/passthrough" ]] && exec "$BASE" "$@"',
      'state_of() { cat "$S/$1" 2>/dev/null || true; }',
      'svc_of_id() { case "$1" in "$DB_ID") echo orbit-db ;; "$APP_ID") echo orbit-app ;; esac; }',
      'case "${1:-}" in',
      "  ps)",
      "    svc=''; all=0; running_only=0",
      '    for a in "$@"; do',
      '      case "$a" in',
      '        label=com.docker.compose.service=*) svc="${a##*=}" ;;',
      "        -a|--all) all=1 ;;",
      "        status=running) running_only=1 ;;",
      "      esac",
      "    done",
      '    if [[ -n "$svc" ]]; then',
      '      st="$(state_of "$svc")"',
      '      [[ -z "$st" ]] && exit 0',
      '      if [[ "$st" != running && ( "$all" == 0 || "$running_only" == 1 ) ]]; then exit 0; fi',
      "    fi",
      "    ;;",
      "  inspect)",
      '    target="${!#}"; svc="$(svc_of_id "$target")"',
      '    if [[ -n "$svc" ]]; then',
      '      st="$(state_of "$svc")"',
      '      if [[ -z "$st" ]]; then printf "Error: No such object: %s\\n" "$target" >&2; exit 1; fi',
      '      case "$*" in',
      '        *"{{.State.Status}}"*) [[ "$st" == running ]] && echo running || echo exited; exit 0 ;;',
      '        *"{{.State.Running}}"*) [[ "$st" == running ]] && echo true || echo false; exit 0 ;;',
      "      esac",
      '      if [[ "$st" != running ]]; then exit 1; fi',
      "    fi",
      "    ;;",
      "  exec)",
      '    for a in "$@"; do',
      '      svc="$(svc_of_id "$a")"',
      '      if [[ -n "$svc" ]]; then',
      '        if [[ "$(state_of "$svc")" != running ]]; then',
      '          printf "Error response from daemon: container %s is not running\\n" "$a" >&2; exit 1',
      "        fi",
      '        if [[ "$*" == *pg_isready* && -e "$S/db-not-ready" ]]; then exit 1; fi',
      "      fi",
      "    done",
      "    ;;",
      "  compose)",
      "    is_up=0",
      '    for a in "$@"; do [[ "$a" == up ]] && is_up=1; done',
      '    if [[ "$is_up" == 1 ]]; then',
      '      if [[ -e "$S/up-fails" ]]; then cat "$S/up-stderr" >&2; exit 1; fi',
      '      recreate=1; [[ "$*" == *--no-recreate* ]] && recreate=0',
      "      for svc in orbit-db orbit-app; do",
      '        st="$(state_of "$svc")"',
      '        if [[ "$st" == running && "$recreate" == 1 ]]; then printf recreated > "$S/$svc"; continue; fi',
      '        [[ "$st" == running ]] || printf running > "$S/$svc"',
      "      done",
      "      exit 0",
      "    fi",
      "    ;;",
      "esac",
      'exec "$BASE" "$@"',
      "",
    ].join("\n"),
  );
  chmodSync(join(binDir, "docker"), 0o755);

  const merged = { HOME: process.env.HOME ?? tmpdir(), ...env };
  merged.PATH = `${binDir}:${merged.PATH ?? process.env.PATH}`;
  const result = failOnProcessDeadline(
    spawnSync("bash", [join(targetDir, "scripts", "repair.sh"), ...args], {
      cwd: targetDir,
      encoding: "utf8",
      input,
      env: merged,
      ...processGuard(),
    }),
    { label: "runRepair" },
  );
  const read = (name) => (existsSync(join(stateDir, name)) ? readFileSync(join(stateDir, name), "utf8") : "");
  return {
    ...result,
    argv: read("argv.log").split("\n").filter(Boolean),
    stateOf: (service) => read(service) || "absent",
  };
}

const composeUpCalls = (r) => r.argv.filter((line) => /\bcompose\b/u.test(line) && /\bup\b/u.test(line));
const stderrLines = (r) => r.stderr.split("\n");

const STOPPED_OR_ABSENT = [
  ["absent", { db: "absent", app: "absent" }],
  ["stopped", { db: "stopped", app: "stopped" }],
];

describe("repair starts services that are not running (#1535)", () => {
  describe.each(STOPPED_OR_ABSENT)("containers %s, files complete", (_label, containers) => {
    it("--check reports services-not-running, not database-unreachable", () => {
      const targetDir = makeFixture();
      const result = runRepair(targetDir, ["--check"], containers);

      expect(result.stdout).toContain("finding class=services-not-running target=container severity=fail");
      expect(result.stdout).not.toContain("class=database-unreachable");
      expect(result.status).toBe(4);
      expect(composeUpCalls(result)).toEqual([]);
    });

    it("--plan puts start-services in the safe batch, and starts nothing", () => {
      const targetDir = makeFixture();
      const before = treeSnapshot(targetDir);
      const result = runRepair(targetDir, ["--plan"], containers);

      expect(result.stdout).toContain(
        "plan action=start-services resolves=services-not-running mutation=service-start backup=not-required target=container rollback=not-required expect=services-healthy",
      );
      expect(result.stdout).not.toContain("plan action=manual resolves=services-not-running");
      expect(composeUpCalls(result)).toEqual([]);
      expect(treeSnapshot(targetDir)).toBe(before);
    });

    it("--execute --safe-only brings the services up with the Compose reconcile, and re-diagnosis is healthy", () => {
      const targetDir = makeFixture();
      const result = runRepair(targetDir, ["--execute", "--safe-only"], containers);

      expect(result.stdout).toContain("execute action=start-services resolves=services-not-running result=done");
      expect(result.stdout).toContain("execution result=complete done=1 failed=0");
      const reDiagnosis = result.stdout.slice(result.stdout.indexOf("execution result="));
      expect(reDiagnosis).not.toContain("finding class=");
      expect(reDiagnosis).toContain("diagnosis result=healthy");
      expect(result.status).toBe(0);

      const calls = composeUpCalls(result);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain(COMPOSE_UP);
      expect(calls[0]).toContain("--project-name repairtest");
      expect(calls[0]).toContain("--env-file");
      expect(calls[0]).not.toContain("--remove-orphans");
      expect(result.stateOf("orbit-db")).toBe("running");
      expect(result.stateOf("orbit-app")).toBe("running");
      // Starting is all it does: no restart, removal or teardown.
      expect(result.argv.filter((line) => /^(restart|rm|stop|kill) /u.test(line))).toEqual([]);
      expect(result.argv.filter((line) => /\b(down|--force-recreate)\b/u.test(line))).toEqual([]);
    });
  });

  it("start-services is declared in the safe action set, and the finding class is ordered", () => {
    expect(repairScriptSource).toMatch(/readonly -a safe_action_classes=\([^)]*\bstart-services\b/u);
    expect(repairScriptSource).toMatch(/\[start-services\]=service-start/u);
    expect(repairScriptSource).toMatch(/\[start-services\]=services-healthy/u);
    expect(repairScriptSource).toMatch(/^\s*services-not-running\s*$/mu);
    expect(repairScriptSource).not.toContain("--remove-orphans");
  });

  it("documents the finding and the action in docs/engine-events.md", () => {
    expect(engineEventsDoc).toContain("services-not-running");
    expect(engineEventsDoc).toContain("start-services");
    expect(engineEventsDoc).toContain("service-start");
    expect(engineEventsDoc).toContain("services-healthy");
  });

  describe("preconditions: the deployment must be complete on disk and only Docker missing", () => {
    // [finding class, how to provoke it, extra runRepair options]
    const BLOCKERS = [
      ["managed-file-missing", (d) => rmSync(join(d, ".env-orbit"))],
      [
        "managed-file-symlink",
        (d) => {
          writeFileSync(join(d, "real-env-orbit"), "APP_URL=https://orbit.repair-test.internal\n", { mode: 0o600 });
          rmSync(join(d, ".env-orbit"));
          symlinkSync(join(d, "real-env-orbit"), join(d, ".env-orbit"));
        },
      ],
      ["managed-file-permissions", (d) => chmodSync(join(d, ".env-orbit"), 0o644)],
      ["secret-missing", (d) => rmSync(join(d, ".orbit-secrets", "session-secret"))],
      ["secret-permissions", (d) => chmodSync(join(d, ".orbit-secrets", "postgres-password"), 0o644)],
      ["secrets-directory-invalid", (d) => chmodSync(join(d, ".orbit-secrets"), 0o755)],
      [
        "configuration-incomplete",
        (d) => {
          writeFileSync(join(d, ".env-orbit"), `ORBIT_IMAGE=${FIXTURE_IMAGE}\n`, { mode: 0o600 });
        },
      ],
      [
        "configuration-migration-interrupted",
        (d) => {
          writeFileSync(join(d, ".env-orbit.orbit-config.rollback"), readFileSync(join(d, ".env-orbit"), "utf8"), { mode: 0o600 });
          writeFileSync(join(d, ".env-orbit"), "APP_URL=https://orbit.repair-test.internal\n", { mode: 0o600 });
        },
      ],
      [
        "deployment-version-unsupported",
        (d) => {
          const kept = readFileSync(join(d, ".env-orbit"), "utf8")
            .split("\n")
            .filter((line) => !line.startsWith("ORBIT_CONFIG_APPLIED_"))
            .join("\n");
          writeFileSync(join(d, ".env-orbit"), kept, { mode: 0o600 });
        },
      ],
      ["staging-evidence-present", (d) => mkdirSync(join(d, ".orbit-install-staging.abcdef"), { mode: 0o700 })],
      ["compose-interpolation-failed", () => {}, { docker: { composeFails: true } }],
      ["docker-unavailable", () => {}, { docker: { unavailable: true } }],
      ["container-foreign-owner", () => {}, { docker: { containers: [{ id: "0123456789ab", service: "not-an-orbit-service" }] } }],
      ["unrelated-resource-present", () => {}, { docker: { volumes: ["someother_orbit-db-data"] } }],
      [
        "image-identity-mismatch",
        () => {},
        { docker: { imageInspect: { present: true, id: "sha256:" + "2".repeat(64) }, appImageId: "sha256:" + "1".repeat(64) } },
      ],
    ];

    // Findings that need the application container to be running to be seen
    // at all are checked with the app running and only the database down.
    const containersFor = (cls) =>
      cls === "image-identity-mismatch" ? { db: "stopped", app: "running" } : { db: "stopped", app: "stopped" };

    it.each(BLOCKERS)("%s blocks the start: the plan is manual and names it", (cls, provoke, options = {}) => {
      const targetDir = makeFixture();
      provoke(targetDir);
      const state = { ...containersFor(cls), ...options };
      // --plan prints only actionable findings, so the blocker itself is
      // confirmed by --check (the scenario really does produce it).
      expect(runRepair(targetDir, ["--check"], state).stdout).toContain(`finding class=${cls} `);
      const result = runRepair(targetDir, ["--plan"], state);

      expect(result.stdout).not.toContain("plan action=start-services");
      // docker-unavailable replaces the container findings altogether; every
      // other blocker leaves services-not-running to be planned as manual.
      if (cls !== "docker-unavailable") {
        expect(runRepair(targetDir, ["--check"], state).stdout).toContain(
          "finding class=services-not-running target=container severity=fail",
        );
        expect(result.stdout).toContain("plan action=manual resolves=services-not-running");
        expect(result.stderr).toContain(cls);
      }
    });

    it.each(BLOCKERS)("%s blocks the start: --execute --safe-only never runs compose up", (cls, provoke, options = {}) => {
      const targetDir = makeFixture();
      provoke(targetDir);
      const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...containersFor(cls), ...options });

      expect(result.stdout).not.toContain("execute action=start-services");
      expect(composeUpCalls(result)).toEqual([]);
    });

    it("names the first unmet precondition when several fail", () => {
      const targetDir = makeFixture();
      chmodSync(join(targetDir, ".orbit-secrets", "postgres-password"), 0o644); // secret-permissions
      mkdirSync(join(targetDir, ".orbit-install-staging.abcdef"), { mode: 0o700 }); // staging-evidence-present
      const result = runRepair(targetDir, ["--plan"], { db: "stopped", app: "stopped" });

      expect(result.stdout).toContain("plan action=manual resolves=services-not-running");
      const guidance = stderrLines(result).filter((line) => line.includes("secret-permissions") || line.includes("staging-evidence-present"));
      expect(guidance.length).toBeGreaterThan(0);
      expect(guidance.join("\n")).toContain("secret-permissions");
      expect(guidance.join("\n")).not.toContain("staging-evidence-present");
    });

    it("a retained database volume without its credential blocks the start (8a)", () => {
      const targetDir = makeFixture();
      rmSync(join(targetDir, ".orbit-secrets", "postgres-password"));
      const state = { db: "absent", app: "absent", docker: { volumes: ["repairtest_orbit-db-data"] } };
      expect(runRepair(targetDir, ["--check"], state).stdout).toContain(
        "finding class=volume-retained-without-credentials target=database-volume severity=fail",
      );
      const result = runRepair(targetDir, ["--plan"], state);

      expect(result.stdout).not.toContain("plan action=start-services");
      expect(result.stdout).toContain("plan action=manual resolves=services-not-running");
      expect(result.stderr).toContain("volume-retained-without-credentials");

      const executed = runRepair(targetDir, ["--execute", "--safe-only"], {
        db: "absent",
        app: "absent",
        docker: { volumes: ["repairtest_orbit-db-data"] },
      });
      expect(composeUpCalls(executed)).toEqual([]);
    });

    it("a retained document volume without its key blocks the start (8a)", () => {
      const targetDir = makeFixture();
      rmSync(join(targetDir, ".orbit-secrets", "document-kek"));
      const state = { db: "absent", app: "absent", docker: { volumes: ["repairtest_orbit-documents-data"] } };
      expect(runRepair(targetDir, ["--check"], state).stdout).toContain(
        "finding class=document-volume-retained-without-key target=document-volume severity=fail",
      );
      const result = runRepair(targetDir, ["--plan"], state);

      expect(result.stdout).not.toContain("plan action=start-services");
      expect(result.stdout).toContain("plan action=manual resolves=services-not-running");
      expect(result.stderr).toContain("document-volume-retained-without-key");
    });
  });

  it("a running orbit-app is not recreated while a stopped orbit-db is started (--no-recreate)", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { db: "stopped", app: "running" });

    expect(result.stdout).toContain("execute action=start-services resolves=services-not-running result=done");
    const calls = composeUpCalls(result);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(COMPOSE_UP);
    expect(calls[0]).not.toContain("--force-recreate");
    expect(calls[0]).not.toContain("--remove-orphans");
    expect(result.stateOf("orbit-db")).toBe("running");
    // The shim records "recreated" if up is run without --no-recreate.
    expect(result.stateOf("orbit-app")).toBe("running");
    expect(result.argv.filter((line) => /^(restart|rm|stop|kill) /u.test(line))).toEqual([]);
  });

  describe("compose up fails", () => {
    const dockerWords =
      "\u001b[31mError response from daemon: no space left on device\u001b[0m\u0007\u0000\r\n" + "x".repeat(6000) + "\nlast line";

    it("reports result=failed with one bounded Docker said line, control characters stripped, nothing else changed", () => {
      const targetDir = makeFixture();
      const before = treeSnapshot(targetDir);
      const result = runRepair(targetDir, ["--execute", "--safe-only"], {
        db: "stopped",
        app: "stopped",
        upFails: true,
        upStderr: dockerWords,
      });

      expect(result.status).toBe(4);
      expect(result.stdout).toContain("execute action=start-services resolves=services-not-running result=failed");
      expect(result.stdout).toContain("execution result=failed done=0 failed=1");

      const said = stderrLines(result).filter((line) => line.includes("Docker said:"));
      expect(said).toHaveLength(1);
      expect(said[0].length).toBeLessThanOrEqual(600);
      // eslint-disable-next-line no-control-regex
      expect(said[0]).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/u);
      expect(result.stderr).not.toContain("\u001b");
      expect(said[0]).not.toContain("[31m");

      // Re-diagnosis still follows and still sees the services down.
      const reDiagnosis = result.stdout.slice(result.stdout.indexOf("execution result="));
      expect(reDiagnosis).toContain("finding class=services-not-running");
      expect(result.stateOf("orbit-db")).toBe("stopped");
      expect(result.stateOf("orbit-app")).toBe("stopped");
      expect(treeSnapshot(targetDir)).toBe(before);
      expect(result.argv.filter((line) => /^(restart|rm|stop|kill) /u.test(line))).toEqual([]);
    });

    it("keeps Docker's own words when they are short", () => {
      const targetDir = makeFixture();
      const result = runRepair(targetDir, ["--execute", "--safe-only"], {
        db: "absent",
        app: "absent",
        upFails: true,
        upStderr: "Error response from daemon: no space left on device\n",
      });

      const said = stderrLines(result).filter((line) => line.includes("Docker said:"));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain("no space left on device");
    });
  });

  describe("database container running but not ready", () => {
    it("is still database-unreachable, planned manual, and nothing is started", () => {
      const targetDir = makeFixture();
      const check = runRepair(targetDir, ["--check"], { db: "running", app: "running", dbReady: false });
      expect(check.stdout).toContain("finding class=database-unreachable target=database severity=fail");
      expect(check.stdout).not.toContain("class=services-not-running");

      const plan = runRepair(targetDir, ["--plan"], { db: "running", app: "running", dbReady: false });
      expect(plan.stdout).toContain("plan action=manual resolves=database-unreachable");
      expect(plan.stdout).not.toContain("start-services");

      const executed = runRepair(targetDir, ["--execute", "--safe-only"], { db: "running", app: "running", dbReady: false });
      expect(executed.stdout).toContain("execute action=manual resolves=database-unreachable result=skipped");
      expect(composeUpCalls(executed)).toEqual([]);
    });
  });
});
