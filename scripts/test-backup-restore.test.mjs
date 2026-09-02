import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

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
// finding 3, which is why health_probe_url exists there. The suite below
// mirrors scripts/restore.test.mjs deliberately, and like it tests the real
// functions extracted verbatim out of the live shell script — never a
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

function runHealthProbeUrl(environmentFile) {
  const harness = [...harnessPrelude(environmentFile), healthProbeUrlSource, "health_probe_url"].join("\n");
  return spawnSync("bash", ["-c", harness], { encoding: "utf8" });
}

// Async, non-blocking bash runner — required (not spawnSync) whenever the bash
// child needs to talk to an HTTP server running in-process: spawnSync blocks
// this process's event loop for its whole duration, so an in-process
// http.Server could never service the child's request until the child had
// already given up and spawnSync returned.
function runBashAsync(script, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", script]);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
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
    const result = await runBashAsync(harness, 10_000);
    expect(result.status).toBe(0);
  }, 15_000);

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
    const result = await runBashAsync(harness, 10_000);
    expect(result.status).not.toBe(0);
  }, 15_000);
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
    const result = await runBashAsync(harness, 20_000);
    expect(result.stderr).not.toContain("did not become healthy");
    expect(result.status).toBe(0);
  }, 25_000);
});
