import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard, processWatchdog } from "./process-budget.mjs";

// Tests here run functions extracted from scripts/test-backup-restore.sh
// under bash, some against a real in-process HTTP server; a spawn that
// takes tens of milliseconds quiet takes seconds on a starved core (#698).
// Budget and reasoning: scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

// Regression coverage for issue #684: scripts/test-backup-restore.sh's health
// probe used to hardcode `http://127.0.0.1:3000/api/health`, so the backup and
// restore acceptance drill could only ever run against a default-port
// deployment. On a host where anything else already held 3000 the drill was
// unusable — the stack could not publish there, and republishing Orbit on a
// free port did not help because the probe itself never moved. That made CI
// the only place restore behaviour could be validated, which is the slowest
// feedback loop in the repository.
//
// health_check gates nearly every assertion in the drill, including the
// negative ones (`if health_check; then fail 'Recovery import restarted
// Orbit.'`). A fixed probe therefore did not merely fail to find Orbit: it
// asked an unrelated service on 3000 whether Orbit was running, and believed
// the answer.
//
// This is the same defect scripts/restore.sh had and fixed under #383
// finding 3, which is why health_probe_url exists there (restore.sh keeps
// this drill's own function, word for word, since #1211). The suite below
// tests the real functions extracted verbatim out of the live shell script — never a
// hand-typed duplicate — so a regression in the actual fix is caught here
// rather than only in a copy.

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const drillPath = join(scriptsDir, "test-backup-restore.sh");
const drillSource = readFileSync(drillPath, "utf8");
const restoreSource = readFileSync(join(scriptsDir, "restore.sh"), "utf8");

// The exact literal the drill's health probe was hardcoded to before this fix
// (issue #684's own repro target). Pinned here rather than derived from git
// history, so this suite has no dependency on repository history surviving.
const preFixHardcodedProbeUrl = "http://127.0.0.1:3000/api/health";

function extractFunction(source, name, where) {
  const pattern = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}`, "m");
  const match = source.match(pattern);
  if (!match) {
    throw new Error(`Could not find function ${name}() in ${where}`);
  }
  return match[0];
}

const healthProbeUrlSource = extractFunction(drillSource, "health_probe_url", "scripts/test-backup-restore.sh");
const healthCheckSource = extractFunction(drillSource, "health_check", "scripts/test-backup-restore.sh");
const waitForHealthSource = extractFunction(drillSource, "wait_for_health", "scripts/test-backup-restore.sh");
const restoreHealthProbeUrlSource = extractFunction(restoreSource, "health_probe_url", "scripts/restore.sh");

const scratchDirs = [];
const servers = [];

afterEach(async () => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop(), { recursive: true, force: true });
  }
  while (servers.length > 0) {
    const server = servers.pop();
    await new Promise((resolve) => server.close(resolve));
  }
});

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-drill-health-"));
  scratchDirs.push(dir);
  return dir;
}

function writeEnvironmentFile(dir, lines) {
  const path = join(dir, ".env-orbit");
  writeFileSync(path, lines.map((line) => `${line}\n`).join(""));
  chmodSync(path, 0o600);
  return path;
}

// health_probe_url reads the shell variable $environment_file, not an
// environment variable, so it is assigned inside the harness itself rather
// than passed through spawnSync's `env` — exactly as the drill sets it from
// ORBIT_ENV_FILE at the top of the script.
function harnessPrelude(environmentFile) {
  return [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    `environment_file=${JSON.stringify(environmentFile)}`,
    // The drill's own failure reporter, so wait_for_health's timeout path
    // produces the operator-visible sentence rather than an unbound-command
    // error that would mask which branch was taken.
    'fail() { printf "Orbit backup test: %s\\n" "$*" >&2; exit 1; }',
  ];
}

function runHealthProbeUrl(environmentFile, exported = {}) {
  const harness = [...harnessPrelude(environmentFile), healthProbeUrlSource, "health_probe_url"].join("\n");
  const env = { ...process.env, ...exported };
  if (!("ORBIT_PORT" in exported)) delete env.ORBIT_PORT;
  if (!("ORBIT_BIND_ADDRESS" in exported)) delete env.ORBIT_BIND_ADDRESS;
  return failOnProcessDeadline(spawnSync("bash", ["-c", harness], { encoding: "utf8", env, ...processGuard() }), { label: "runHealthProbeUrl" });
}

// Async, non-blocking bash runner — required (not spawnSync) whenever the bash
// child needs to talk to an HTTP server running in-process: spawnSync blocks
// this process's event loop for its whole duration, so an in-process
// http.Server could never service the child's request until the child had
// already given up and spawnSync returned.
function runBashAsync(script) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", script]);
    let stdout = "";
    let stderr = "";
    const watchdog = processWatchdog({ label: "runBashAsync", kill: () => child.kill("SIGKILL") });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      watchdog.touch();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      watchdog.touch();
    });
    child.on("error", (error) => {
      watchdog.stop();
      reject(error);
    });
    child.on("close", (status, signal) => {
      watchdog.stop();
      if (watchdog.reason) {
        reject(watchdog.error({ stdout, stderr }));
        return;
      }
      resolve({ status, signal, stdout, stderr });
    });
  });
}

async function startHealthServer() {
  const server = createServer((req, res) => {
    if (req.url === "/api/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  servers.push(server);
  const port = await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
  // Guard against the (extremely unlikely) case of the ephemeral port
  // colliding with the literal the drill used to hardcode: the whole point of
  // these tests is to exercise a NON-default port.
  expect(port).not.toBe(3000);
  return port;
}

describe("scripts/test-backup-restore.sh health_probe_url (issue #684)", () => {
  it.each([
    [
      "no ORBIT_BIND_ADDRESS/ORBIT_PORT set (default deployment, unchanged behaviour)",
      ["APP_URL=https://orbit.internal"],
      "http://127.0.0.1:3000/api/health",
    ],
    [
      "ORBIT_BIND_ADDRESS=0.0.0.0 explicit, default port",
      ["APP_URL=https://orbit.internal", "ORBIT_BIND_ADDRESS=0.0.0.0"],
      "http://127.0.0.1:3000/api/health",
    ],
    [
      "ORBIT_PORT only, bind address defaults to 0.0.0.0 -> loopback",
      ["APP_URL=https://orbit.internal", "ORBIT_PORT=8443"],
      "http://127.0.0.1:8443/api/health",
    ],
    [
      "ORBIT_BIND_ADDRESS=127.0.0.1 and non-default ORBIT_PORT (mirrors test-install-acceptance.sh's ORBIT_PORT=3210 deployment)",
      ["APP_URL=https://orbit.internal", "ORBIT_BIND_ADDRESS=127.0.0.1", "ORBIT_PORT=3210"],
      "http://127.0.0.1:3210/api/health",
    ],
    [
      "a non-loopback ORBIT_BIND_ADDRESS is passed through unchanged, not remapped to loopback",
      ["APP_URL=https://orbit.internal", "ORBIT_BIND_ADDRESS=192.168.1.50", "ORBIT_PORT=3000"],
      "http://192.168.1.50:3000/api/health",
    ],
  ])("%s", (_label, envLines, expectedUrl) => {
    const dir = makeFixture();
    const result = runHealthProbeUrl(writeEnvironmentFile(dir, envLines));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(expectedUrl);
  });

  it("pins the exact pre-fix hardcoded literal this fix replaced, and shows the fixed output now differs for a non-default port", () => {
    const dir = makeFixture();
    const environmentFile = writeEnvironmentFile(dir, ["APP_URL=https://orbit.internal", "ORBIT_PORT=9443"]);
    const result = runHealthProbeUrl(environmentFile);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toBe(preFixHardcodedProbeUrl);
    expect(result.stdout).toBe("http://127.0.0.1:9443/api/health");
  });

  it("an exported ORBIT_PORT/ORBIT_BIND_ADDRESS wins over .env-orbit, as it does for Compose itself (#1241)", () => {
    const dir = makeFixture();
    const environmentFile = writeEnvironmentFile(dir, ["APP_URL=https://orbit.internal", "ORBIT_PORT=3000"]);
    const result = runHealthProbeUrl(environmentFile, { ORBIT_PORT: "3001", ORBIT_BIND_ADDRESS: "127.0.0.1" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("http://127.0.0.1:3001/api/health");
  });

  it("derives the probe the same way scripts/restore.sh does, so the two cannot drift apart", () => {
    expect(healthProbeUrlSource).toBe(restoreHealthProbeUrlSource);
  });

  it("leaves no hardcoded probe target in the drill: health_check builds its URL rather than spelling one out", () => {
    expect(healthCheckSource).not.toContain("3000");
    expect(healthCheckSource).not.toContain("127.0.0.1");
    expect(healthCheckSource).toContain("health_probe_url");
    // The only surviving mentions of the old literal are in the explanatory
    // comment above health_probe_url, never in code that runs.
    const executableLines = drillSource
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"));
    expect(executableLines.join("\n")).not.toContain(preFixHardcodedProbeUrl);
  });
});

describe("scripts/test-backup-restore.sh health_check (issue #684)", () => {
  it("reaches a deployment on a non-default ORBIT_PORT, which the hardcoded 127.0.0.1:3000 probe would have missed", async () => {
    const port = await startHealthServer();
    const dir = makeFixture();
    const environmentFile = writeEnvironmentFile(dir, [
      "APP_URL=https://orbit.internal",
      `ORBIT_PORT=${port}`,
    ]);
    const harness = [
      ...harnessPrelude(environmentFile),
      healthProbeUrlSource,
      healthCheckSource,
      "health_check",
    ].join("\n");
    const result = await runBashAsync(harness);
    expect(result.status).toBe(0);
  });

  it("is not satisfied by a service on a port other than the one .env-orbit configures, so the drill's negative assertions stay honest", async () => {
    // The #684 scenario in miniature: a health endpoint is live on one port,
    // while this deployment is configured for a different one. health_check
    // must report unhealthy, because the live server is not this Orbit. Before
    // the fix an unrelated service on 3000 answered for Orbit, which would
    // have turned assertions like "Recovery import restarted Orbit despite
    // unfinished restore evidence" into false failures.
    const strangerPort = await startHealthServer();
    const dir = makeFixture();
    const environmentFile = writeEnvironmentFile(dir, [
      "APP_URL=https://orbit.internal",
      // A port nothing is listening on: adjacent to the stranger's, and not
      // the stranger's own.
      `ORBIT_PORT=${strangerPort === 65535 ? strangerPort - 1 : strangerPort + 1}`,
    ]);
    const harness = [
      ...harnessPrelude(environmentFile),
      healthProbeUrlSource,
      healthCheckSource,
      "health_check",
    ].join("\n");
    const result = await runBashAsync(harness);
    expect(result.status).not.toBe(0);
  });
});

describe("scripts/test-backup-restore.sh wait_for_health (issue #684)", () => {
  it("completes against a deployment on a non-default ORBIT_PORT", async () => {
    const port = await startHealthServer();
    const dir = makeFixture();
    const environmentFile = writeEnvironmentFile(dir, [
      "APP_URL=https://orbit.internal",
      `ORBIT_PORT=${port}`,
    ]);
    const harness = [
      ...harnessPrelude(environmentFile),
      healthProbeUrlSource,
      healthCheckSource,
      waitForHealthSource,
      "wait_for_health",
    ].join("\n");
    const result = await runBashAsync(harness);
    expect(result.stderr).not.toContain("did not become healthy");
    expect(result.status).toBe(0);
  });
});

// #1241: this drill borrows a deployment, so its teardown must put back what it
// changed and must never remove the deployment or its data. Two layers: the
// real script is run against a fake docker to prove the trap fires on failure
// and on SIGINT/SIGTERM, and the teardown functions are extracted verbatim and
// run against each state a half-finished drill can leave behind.

const cleanupSource = extractFunction(drillSource, "cleanup", "scripts/test-backup-restore.sh");
const collectEvidenceSource = extractFunction(drillSource, "collect_evidence", "scripts/test-backup-restore.sh");
const restoreDeploymentSource = extractFunction(drillSource, "restore_deployment", "scripts/test-backup-restore.sh");

function readLines(path) {
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
    : [];
}

/** Runs cleanup() as the EXIT trap, exactly as the drill registers it, in a
 * scratch deployment where every collaborator is a recording stub. */
function runTeardown({ status = 0, vars = {}, healthy = true, maintenanceActive = "f", journal = false, keyBackup = false }) {
  const dir = makeFixture();
  const calls = join(dir, "calls.log");
  const evidenceRoot = join(dir, "evidence");
  const state = join(dir, "restore-state");
  const binDir = join(dir, "bin");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(calls, "");
  for (const name of ["restore.sh", "end-maintenance.sh"]) {
    writeFileSync(join(dir, "scripts", name), `printf '${name} %s\\n' "$*" >> "${calls}"\n`);
  }
  writeFileSync(
    join(binDir, "docker"),
    `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "${calls}"
case " $* " in *" start "*) : > "${dir}/healthy" ;; *" logs "*) printf 'stub-compose-logs\\n' ;; esac
exit 0
`,
  );
  chmodSync(join(binDir, "docker"), 0o755);
  if (healthy) writeFileSync(join(dir, "healthy"), "");
  writeFileSync(join(dir, "maintenance"), maintenanceActive);
  if (journal) writeFileSync(join(state, "restore.journal"), "state=checkpointed\n");
  writeFileSync(join(dir, "kek"), "wrong-key\n");
  writeFileSync(join(dir, "kek.backup"), "real-key\n");
  for (const name of ["backup.tar", "recovery.tar", "maintenance.tar"]) writeFileSync(join(dir, name), "x");
  mkdirSync(join(dir, "testdir"));

  const lines = [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    `cd ${JSON.stringify(dir)}`,
    `environment_file=${JSON.stringify(join(dir, ".env-orbit"))}`,
    `live_kek=${JSON.stringify(join(dir, "kek"))}`,
    `repo_dir=${JSON.stringify(dir)}`,
    `restore_state_directory=${JSON.stringify(state)}`,
    `key_backup=${keyBackup ? JSON.stringify(join(dir, "kek.backup")) : '""'}`,
    `backup_path=${JSON.stringify(join(dir, "backup.tar"))}`,
    `recovery_bundle_path=${JSON.stringify(join(dir, "recovery.tar"))}`,
    `maintenance_backup_path=${JSON.stringify(join(dir, "maintenance.tar"))}`,
    `test_directory=${JSON.stringify(join(dir, "testdir"))}`,
    'drill_run_container="orbit-backup-drill-test"',
    "touched=0 fixtures_seeded=0 fixtures_removed=0 maintenance_touched=0",
    'maintenance_initial="" journal_at_start=0 torn_down=0 failure_reason="" last_error="" evidence_dir=""',
    "readonly teardown_health_seconds=2",
    ...Object.entries(vars).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`),
    `export ORBIT_EVIDENCE_ROOT=${JSON.stringify(evidenceRoot)}`,
    `health_check() { [[ -e ${JSON.stringify(join(dir, "healthy"))} ]]; }`,
    `maintenance_active() { cat ${JSON.stringify(join(dir, "maintenance"))}; }`,
    `remove_document_fixture() { echo remove_document_fixture >> ${JSON.stringify(calls)}; }`,
    `remove_credential_fixture() { echo remove_credential_fixture >> ${JSON.stringify(calls)}; }`,
    collectEvidenceSource,
    restoreDeploymentSource,
    cleanupSource,
    "trap cleanup EXIT",
    `exit ${status}`,
  ];
  const result = failOnProcessDeadline(
    spawnSync("bash", ["-c", lines.join("\n")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      ...processGuard(),
    }),
    { label: "runTeardown" },
  );
  const evidence = readdirSync(dir).includes("evidence") ? readdirSync(evidenceRoot) : [];
  return { result, dir, calls: readLines(calls), evidenceRoot, evidence, kek: readFileSync(join(dir, "kek"), "utf8") };
}

describe("scripts/test-backup-restore.sh teardown puts back what it changed (#1241)", () => {
  it("does nothing to the deployment when the run never touched it", () => {
    const { result, calls } = runTeardown({ status: 1, healthy: false });
    expect(result.status).toBe(1);
    expect(calls.filter((c) => c.startsWith("docker "))).toEqual([]);
  });

  it("removes its fixtures, its bundles and its temp directory, and nothing of the deployment's", () => {
    const { result, dir, calls } = runTeardown({ vars: { touched: 1, fixtures_seeded: 1 } });
    expect(result.status).toBe(0);
    expect(calls).toContain("remove_document_fixture");
    expect(calls).toContain("remove_credential_fixture");
    expect(calls).toContain("docker rm -f -v orbit-backup-drill-test");
    for (const name of ["backup.tar", "recovery.tar", "maintenance.tar", "testdir"]) {
      expect(existsSync(join(dir, name)), name).toBe(false);
    }
    // The deployment is borrowed: no teardown call may take it, its volumes,
    // networks or images away.
    for (const call of calls) {
      expect(call).not.toMatch(/ down( |$)| volume | network | rmi | prune/);
      expect(call).not.toMatch(/^docker rm (?!-f -v orbit-backup-drill-test$)/);
    }
  });

  it("does not remove fixtures twice when the drill already removed them", () => {
    const { calls } = runTeardown({ vars: { touched: 1, fixtures_seeded: 1, fixtures_removed: 1 } });
    expect(calls).not.toContain("remove_document_fixture");
  });

  it("restores the live document key a failed key-rejection step left swapped", () => {
    const { kek } = runTeardown({ status: 1, keyBackup: true });
    expect(kek).toBe("real-key\n");
  });

  it("recovers an unfinished restore this run left, but never one that was already there", () => {
    const left = runTeardown({ status: 1, journal: true, vars: { touched: 1 } });
    expect(left.calls).toContain("restore.sh --recover");
    const preexisting = runTeardown({ status: 1, journal: true, vars: { touched: 1, journal_at_start: 1 } });
    expect(preexisting.calls).not.toContain("restore.sh --recover");
  });

  it("starts orbit-app when the run left it down, and leaves a healthy one alone", () => {
    const down = runTeardown({ status: 1, healthy: false, vars: { touched: 1 } });
    expect(down.calls.some((c) => / start orbit-app$/.test(c))).toBe(true);
    const up = runTeardown({ status: 1, healthy: true, vars: { touched: 1 } });
    expect(up.calls.some((c) => / start /.test(c))).toBe(false);
  });

  it("reopens an instance the drill closed for maintenance, but not one that was closed before", () => {
    const closedByDrill = runTeardown({
      status: 1,
      maintenanceActive: "t",
      vars: { touched: 1, maintenance_touched: 1, maintenance_initial: "f" },
    });
    expect(closedByDrill.calls).toContain("end-maintenance.sh ");
    const closedBefore = runTeardown({
      status: 1,
      maintenanceActive: "t",
      vars: { touched: 1, maintenance_touched: 1, maintenance_initial: "t" },
    });
    expect(closedBefore.calls).not.toContain("end-maintenance.sh ");
    const reopened = runTeardown({
      maintenanceActive: "f",
      vars: { touched: 1, maintenance_touched: 1, maintenance_initial: "f" },
    });
    expect(reopened.calls).not.toContain("end-maintenance.sh ");
  });

  it("fires exactly once however many times it is reached", () => {
    const dir = makeFixture();
    const harness = [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      `cd ${JSON.stringify(dir)}`,
      'touched=0 torn_down=0 key_backup="" backup_path="" recovery_bundle_path="" maintenance_backup_path="" test_directory="" evidence_dir="" failure_reason="" last_error="" journal_at_start=0',
      'restore_state_directory="$PWD/none" environment_file="$PWD/env" live_kek="$PWD/kek"',
      collectEvidenceSource,
      restoreDeploymentSource,
      cleanupSource,
      "trap cleanup EXIT",
      "cleanup",
      "exit 0",
    ].join("\n");
    const result = failOnProcessDeadline(spawnSync("bash", ["-c", harness], { encoding: "utf8", ...processGuard() }), { label: "once" });
    expect(result.stderr.match(/teardown: starting/g)).toHaveLength(1);
    expect(result.stderr.match(/teardown: complete/g)).toHaveLength(1);
  });

  it("keeps compose state, logs and the restore journal of a failed run, and prints where", () => {
    const { result, evidenceRoot, evidence, calls } = runTeardown({
      status: 3,
      journal: true,
      vars: { touched: 1, failure_reason: "simulated drill failure", last_error: "line 9: some command" },
    });
    expect(evidence).toHaveLength(1);
    const dir = join(evidenceRoot, evidence[0]);
    expect(evidence[0]).toMatch(/^test-backup-restore-\d{8}T\d{6}Z$/);
    expect(result.stderr).toContain(`evidence kept in: ${dir}`);
    const info = readFileSync(join(dir, "run-info.txt"), "utf8");
    expect(info).toContain("exit_status=3");
    expect(info).toContain("simulated drill failure");
    expect(info).toContain("line 9: some command");
    expect(readFileSync(join(dir, "compose.log"), "utf8")).toContain("stub-compose-logs");
    expect(existsSync(join(dir, "compose-ps.txt"))).toBe(true);
    expect(readFileSync(join(dir, "restore.journal"), "utf8")).toContain("state=checkpointed");
    // Evidence is taken before anything is recovered or removed.
    const firstLogs = calls.findIndex((c) => c.includes(" logs "));
    expect(firstLogs).toBeGreaterThanOrEqual(0);
    expect(calls.findIndex((c) => c === "restore.sh --recover")).toBeGreaterThan(firstLogs);
  });

  it("writes no evidence for a run that passed", () => {
    const { result, evidence } = runTeardown({ status: 0, vars: { touched: 1 } });
    expect(result.status).toBe(0);
    expect(evidence).toEqual([]);
  });
});

// The real script, against a fake docker: the trap really is wired to failure
// and to both signals. The seeding `compose exec` is where the fake fails or
// blocks, which is the first point after the run changes the deployment.
async function freePort() {
  const server = createNetServer();
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function prepareDrill(mode) {
  const dir = makeFixture();
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const secrets = join(dir, "secrets");
  mkdirSync(secrets);
  writeFileSync(join(secrets, "document-kek"), "kek\n");
  const envFile = join(dir, ".env-orbit");
  writeFileSync(envFile, `ORBIT_BIND_ADDRESS=127.0.0.1\nORBIT_PORT=${await freePort()}\n`);
  const calls = join(dir, "calls.log");
  const pidFile = join(dir, "blocked.pid");
  writeFileSync(calls, "");
  writeFileSync(
    join(binDir, "docker"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${calls}"
case " $* " in *" logs "*) printf 'stub-compose-logs\\n' ;; esac
if [[ " $* " == *" --user orbit:orbit "* ]]; then
  if [[ "${mode}" == block ]]; then
    printf '%s' "$$" > "${pidFile}"
    printf 'stub-docker-blocked\\n' >&2
    exec sleep 300
  fi
  exit 1
fi
exit 0
`,
  );
  chmodSync(join(binDir, "docker"), 0o755);
  return {
    dir,
    calls,
    pidFile,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      ORBIT_ENV_FILE: envFile,
      ORBIT_SECRETS_DIR: secrets,
      ORBIT_BACKUP_DIR: join(dir, "backups"),
      ORBIT_EVIDENCE_ROOT: join(dir, "evidence"),
      TMPDIR: dir,
      ORBIT_BACKUP_TEST_TEARDOWN_HEALTH_SECONDS: "1",
    },
  };
}

function evidenceDirs(dir) {
  const root = join(dir, "evidence");
  return existsSync(root) ? readdirSync(root).map((name) => join(root, name)) : [];
}

function drillTempDirs(dir) {
  return readdirSync(dir).filter((name) => name.startsWith("orbit-backup-test."));
}

describe("scripts/test-backup-restore.sh trap wiring (#1241)", () => {
  it("tears down and keeps evidence when the drill fails after changing the deployment", async () => {
    const { dir, calls, env } = await prepareDrill("fail");
    const result = failOnProcessDeadline(spawnSync("bash", [drillPath], { encoding: "utf8", env, ...processGuard() }), { label: "drill fail" });
    expect(result.status).not.toBe(0);
    const log = readLines(calls);
    expect(result.stderr.match(/teardown: starting/g)).toHaveLength(1);
    // Fixtures were seeded before the failure, so they are removed again.
    expect(log.some((c) => c.includes("delete from households"))).toBe(true);
    expect(log.some((c) => c.includes("delete from users"))).toBe(true);
    expect(log.some((c) => c.startsWith("rm -f -v orbit-backup-drill-"))).toBe(true);
    expect(log.some((c) => / down( |$)| volume | network /.test(c))).toBe(false);
    expect(drillTempDirs(dir)).toEqual([]);
    const evidence = evidenceDirs(dir);
    expect(evidence).toHaveLength(1);
    expect(readFileSync(join(evidence[0], "run-info.txt"), "utf8")).toMatch(/last_failed_command=line \d+:/);
    expect(readFileSync(join(evidence[0], "compose.log"), "utf8")).toContain("stub-compose-logs");
  });

  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ])("tears down exactly once on %s, even while docker is blocked", async (signal, expectedStatus) => {
    const { dir, calls, pidFile, env } = await prepareDrill("block");
    const outcome = await new Promise((resolve, reject) => {
      // Own process group, signalled as a whole: what a terminal's Ctrl-C, a
      // runner's cancel and `timeout` deliver. bash only runs a trap once its
      // foreground command ends, so a signal sent to the script alone waits
      // for the blocked docker call; the group signal ends both at once.
      const child = spawn("bash", [drillPath], { env, detached: true });
      let stderr = "";
      let signalled = false;
      const watchdog = processWatchdog({ label: `drill ${signal}`, kill: () => child.kill("SIGKILL") });
      child.stdout.on("data", () => watchdog.touch());
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        watchdog.touch();
        if (!signalled && stderr.includes("stub-docker-blocked")) {
          signalled = true;
          process.kill(-child.pid, signal);
        }
      });
      child.on("error", (error) => {
        watchdog.stop();
        reject(error);
      });
      child.on("close", (status) => {
        watchdog.stop();
        if (watchdog.reason) reject(watchdog.error({ stdout: "", stderr }));
        else resolve({ status, stderr });
      });
    });
    expect(outcome.status).toBe(expectedStatus);
    expect(outcome.stderr.match(/teardown: starting/g)).toHaveLength(1);
    const log = readLines(calls);
    expect(log.some((c) => c.includes("delete from households"))).toBe(true);
    expect(drillTempDirs(dir)).toEqual([]);
    expect(evidenceDirs(dir)).toHaveLength(1);
    // The blocked docker call was stopped, not left running past the script.
    const blockedPid = Number(readFileSync(pidFile, "utf8"));
    let alive = true;
    try {
      process.kill(blockedPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });
});
