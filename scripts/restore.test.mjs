import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Regression coverage for issue #383 finding 3: scripts/restore.sh's health
// probe used to hardcode `http://127.0.0.1:3000/api/health`, so any
// deployment with a non-default ORBIT_PORT/ORBIT_BIND_ADDRESS (both
// first-class operator knobs — configure.sh writes them into .env-orbit,
// docker-compose.yml publishes orbit-app as
// `${ORBIT_BIND_ADDRESS:-0.0.0.0}:${ORBIT_PORT:-3000}:3000`, and
// scripts/test-install-acceptance.sh exercises ORBIT_PORT=3210 for exactly
// this reason) could never complete a restore: cutover health-wait fails,
// rollback's own health-wait fails identically, and `--recover` fails at the
// same probe, leaving Orbit deliberately stopped with no supported command
// to clear the resulting journal.
//
// This suite tests the real `health_probe_url`/`wait_for_health` functions
// extracted verbatim out of the live scripts/restore.sh (never a hand-typed
// duplicate), so a regression in the actual fix is caught here rather than
// only in a copy.

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const restoreScriptSource = readFileSync(join(scriptsDir, "restore.sh"), "utf8");

// The exact literal scripts/restore.sh's health probe was hardcoded to
// before this fix (issue #383 finding 3's own repro target). Kept here as a
// pinned value, not derived from git history, so this test suite has no
// dependency on repository history being preserved.
const preFixHardcodedProbeUrl = "http://127.0.0.1:3000/api/health";

function extractFunction(name) {
  const pattern = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}`, "m");
  const match = restoreScriptSource.match(pattern);
  if (!match) {
    throw new Error(`Could not find function ${name}() in scripts/restore.sh`);
  }
  return match[0];
}

const healthProbeUrlSource = extractFunction("health_probe_url");
const waitForHealthSource = extractFunction("wait_for_health");

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
  const dir = mkdtempSync(join(tmpdir(), "orbit-restore-health-"));
  scratchDirs.push(dir);
  return dir;
}

function writeEnvironmentFile(dir, lines) {
  const path = join(dir, ".env-orbit");
  writeFileSync(path, lines.map((line) => `${line}\n`).join(""));
  chmodSync(path, 0o600);
  return path;
}

// Runs `health_probe_url` (extracted from the real script, never a
// hand-typed duplicate) against a given .env-orbit fixture and returns its
// stdout. health_probe_url reads the shell variable $environment_file, not
// an environment variable, so it must be assigned inside the harness itself
// rather than passed through spawnSync's `env`.
function runHealthProbeUrl(environmentFile) {
  const harness = [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    `environment_file=${JSON.stringify(environmentFile)}`,
    healthProbeUrlSource,
    "health_probe_url",
  ].join("\n");
  return spawnSync("bash", ["-c", harness], { encoding: "utf8" });
}

// Async, non-blocking bash runner — required (not spawnSync) whenever the
// bash child needs to talk to an HTTP server running in-process: spawnSync
// blocks this process's event loop for its whole duration, so an in-process
// http.Server can never actually service the child's request until the
// child already gave up, timed out, and spawnSync returned. Using `spawn`
// keeps the event loop free to drive the server while bash runs.
function runBashAsync(script, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", script]);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
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

describe("scripts/restore.sh health_probe_url (issue #383 finding 3)", () => {
  it.each([
    [
      "no ORBIT_BIND_ADDRESS/ORBIT_PORT set (default deployment)",
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
    const environmentFile = writeEnvironmentFile(dir, envLines);
    const result = runHealthProbeUrl(environmentFile);
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
});

describe("scripts/restore.sh wait_for_health (issue #383 finding 3)", () => {
  it("reaches a deployment's health endpoint on a non-default ORBIT_PORT, which a hardcoded 127.0.0.1:3000 probe would have missed", async () => {
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
    // Sanity-guard against the (extremely unlikely) case of colliding with
    // the literal port this script used to hardcode: the whole point of this
    // test is to exercise a NON-default port.
    expect(port).not.toBe(3000);

    const dir = makeFixture();
    const environmentFile = writeEnvironmentFile(dir, [
      "APP_URL=https://orbit.internal",
      `ORBIT_PORT=${port}`,
    ]);
    const scopedHarness = [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      `environment_file=${JSON.stringify(environmentFile)}`,
      healthProbeUrlSource,
      waitForHealthSource,
      "wait_for_health",
    ].join("\n");
    const result = await runBashAsync(scopedHarness, 10000);
    expect(result.status).toBe(0);
  });

  it("does not reach a health endpoint bound on a different port than the one .env-orbit configures (probe target must match, not guess)", async () => {
    const server = createServer((req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    servers.push(server);
    const realPort = await new Promise((resolve, reject) => {
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });

    // A second, unbound port standing in for "the wrong target" (e.g. what a
    // hardcoded/stale probe would hit instead of the deployment's actual
    // configured port).
    const probe = createServer(() => {});
    const wrongPort = await new Promise((resolve, reject) => {
      probe.on("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
    expect(wrongPort).not.toBe(realPort);

    const dir = makeFixture();
    const environmentFile = writeEnvironmentFile(dir, [
      "APP_URL=https://orbit.internal",
      `ORBIT_PORT=${wrongPort}`,
    ]);
    // Shorten the 45s retry deadline to keep this negative case fast; the
    // retried command itself (curl --max-time 2) is untouched, so this only
    // trims how many times a doomed probe retries before giving up.
    const shortenedWaitForHealthSource = waitForHealthSource.replace("SECONDS + 45", "SECONDS + 1");
    expect(shortenedWaitForHealthSource).not.toBe(waitForHealthSource);
    const scopedHarness = [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      `environment_file=${JSON.stringify(environmentFile)}`,
      healthProbeUrlSource,
      shortenedWaitForHealthSource,
      "wait_for_health",
    ].join("\n");
    const result = await runBashAsync(scopedHarness, 10000);
    expect(result.status).not.toBe(0);
  });
});
