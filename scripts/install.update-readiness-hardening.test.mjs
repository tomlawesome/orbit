// Hardening of the update readiness check (#1842, spec note 59049), written
// from the note alone before the change. check_update_readiness in install.sh:
//  1. keeps at most 16384 bytes of the one-off's stdout; the status is the
//     one-off's, not the reader's;
//  2. a ',' in the deployment path is fine, a ':' is refused before any compose run;
//  3. the one-off is named orbit-update-preflight-<installer pid>; on exit 124
//     or >=128 the installer runs `docker rm -f <name>` (failure ignored);
//  4. INT/TERM while the one-off runs end the installer at once (130/143), the
//     one-off stopped, its container removed, nothing in the deployment changed;
//  5. update_readiness_project_name uses read_compose_project_name.
// A wrapper `docker` first on PATH adds modes the shared fake lacks (a hanging,
// huge or endless one-off; a failing `docker rm -f`) and delegates the rest.

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { PROCESS_DEADLINE_MS, PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import {
  baseEnvironment,
  digest,
  eventLines,
  imageRepository,
  installScript,
  makeFakeBin,
  makePreprovisionedDeployment,
  makeTarget,
  pidAlive,
  readOptional,
  revision,
  runInstall,
  treeSnapshot,
} from "./install-test-support.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const TARGET = "v0.3.6";
const INSTALLED = "v0.3.5";
const RELEASES = ["v0.3.5", "v0.3.4", "v0.3.3", "v0.3.2"];
const TERMINAL = "phase=identity component=image state=failed reason=update-readiness action=retry";
const COULD_NOT_CHECK = "Orbit installer: Orbit could not check whether the database is ready for this release; see the lines above.";
const BLOCKED = "update-preflight: blocked documents.content_sha256 rows=12";
const REMEDY = "Orbit is still moving documents under the household key; run the update again later.";
const TIMEOUT_NOTE = "did not finish within 60 s";
const NAME = /^orbit-update-preflight-[0-9]+$/u;
const CAP = 16384;
const COLON_REFUSAL = "The installation directory's path contains a character Docker cannot mount; choose a directory without ':'.";

function manifestFile() {
  const manifest = {
    schema: "https://tomlawson.io/schemas/orbit-release-manifest/v1",
    version: TARGET,
    channel: "preview",
    commit: revision,
    updateFrom: RELEASES.slice(0, 3),
    releases: RELEASES,
    image: { repository: imageRepository, digest: `sha256:${digest}` },
    launcher: { tag: "v1.0.0", commit: revision },
    files: {},
    recordedAt: "2026-11-03T00:00:00Z",
  };
  const path = join(mkdtempSync(join(tmpdir(), "orbit-readiness-hardening-manifest-")), "orbit-release-manifest.json");
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return path;
}

/** An installed deployment in `folderName` under a fresh parent (a name with ',' or ':' for item 2); `composeFile` and `projectName` shape item 5. */
function installedFolder({ folderName, composeFile = "services: {}\n", projectName = "orbit" } = {}) {
  let targetDir = makeTarget();
  if (folderName) {
    targetDir = join(targetDir, folderName);
    mkdirSync(targetDir);
  }
  makePreprovisionedDeployment(targetDir, [
    `ORBIT_IMAGE=${imageRepository}@sha256:${"c".repeat(64)}`,
    `ORBIT_CONFIG_APPLIED_DIGEST=sha256:${"c".repeat(64)}`,
    `ORBIT_CONFIG_APPLIED_VERSION=${INSTALLED}`,
    ...(projectName ? [`COMPOSE_PROJECT_NAME=${projectName}`] : []),
  ]);
  writeFileSync(join(targetDir, "docker-compose.yml"), composeFile);
  writeFileSync(join(targetDir, ".orbit-secrets", "document-kek"), `${"a".repeat(64)}\n`, { mode: 0o600 });
  return targetDir;
}

// The wrapper docker. FAKE_ONEOFF_MODE: hang (records its start in oneoff-started, then sleeps),
// huge (FAKE_ONEOFF_PREFIX, then blank lines up to FAKE_ONEOFF_BLANK bytes, then FAKE_ONEOFF_SUFFIX, exit FAKE_READINESS_EXIT),
// endless (FAKE_ONEOFF_PREFIX, blank lines up to 16384 bytes, the marker line, then blank lines until stdout closes or 8 s pass).
// hang-early writes oneoff-early first, sleeps 0.3 s, then behaves as hang. FAKE_EPIPE_EXIT=1: a failed write exits 1 at once.
// FAKE_RM_FAIL=1 makes `docker rm -f` exit 1 after logging it. Everything else goes to the shared fake docker.
const wrapperScript = (realDocker) => `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const argv = process.argv.slice(2);
const env = process.env;
const log = (line) => env.FAKE_CALL_LOG && fs.appendFileSync(env.FAKE_CALL_LOG, line + "\\n");
const mode = env.FAKE_ONEOFF_MODE;
if (argv[0] === "rm" && argv[1] === "-f" && env.FAKE_RM_FAIL === "1") {
  log("docker " + argv.join(" "));
  process.exit(1);
}
if (mode && argv[0] === "compose" && argv.includes("run") && argv.includes("orbit-app")) {
  log("docker " + argv.join(" "));
  fs.appendFileSync(env.FAKE_STATE_DIR + "/readiness-oneoff.jsonl", JSON.stringify({ argv: argv.slice(1), orbitImage: env.ORBIT_IMAGE, composeFile: env.COMPOSE_FILE }) + "\\n");
  const write = (text) => { try { fs.writeSync(1, text); return true; } catch { if (env.FAKE_EPIPE_EXIT === "1") process.exit(1); return false; } };
  const blanks = (bytes) => { let left = bytes; while (left > 0) { const n = Math.min(left, 4096); if (!write("\\n".repeat(n))) return false; left -= n; } return true; };
  if (mode === "hang" || mode === "hang-early") {
    if (mode === "hang-early") {
      fs.writeFileSync(env.FAKE_STATE_DIR + "/oneoff-early", String(process.pid));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
    fs.writeFileSync(env.FAKE_STATE_DIR + "/oneoff-started", String(process.pid));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);
    process.exit(0);
  }
  const prefix = env.FAKE_ONEOFF_PREFIX ?? "";
  write(prefix);
  if (mode === "huge") {
    blanks(Number(env.FAKE_ONEOFF_BLANK) - prefix.length);
    write(env.FAKE_ONEOFF_SUFFIX ?? "");
    process.exit(Number(env.FAKE_READINESS_EXIT ?? 0));
  }
  if (mode === "endless") {
    blanks(${CAP} - prefix.length);
    write("update-preflight: blocked MARKER-PAST-THE-CAP\\n");
    const stop = Date.now() + 8000;
    while (Date.now() < stop) if (!blanks(4096)) break;
    process.exit(1);
  }
}
const result = spawnSync(${JSON.stringify(realDocker)}, argv, { stdio: "inherit", env });
process.exit(result.status ?? 1);
`;

function wrapperBin() {
  const real = makeFakeBin();
  const dir = mkdtempSync(join(tmpdir(), "orbit-readiness-hardening-bin-"));
  writeFileSync(join(dir, "docker"), wrapperScript(join(real, "docker")));
  chmodSync(join(dir, "docker"), 0o755);
  return { dir, path: `${dir}:${real}:${process.env.PATH}` };
}

function update(targetDir, extraEnv = {}) {
  return runInstall(
    targetDir,
    { PATH: wrapperBin().path, ORBIT_RELEASE_MANIFEST: manifestFile(), FAKE_DOCKER_VERSION: TARGET, FAKE_ENGINE_EXIT: "1", ...extraEnv },
    ["--plain", "--update"],
  );
}

const oneOffName = (result) => {
  const [call] = result.oneOffs;
  const index = call?.argv.indexOf("--name") ?? -1;
  return index >= 0 ? call.argv[index + 1] : undefined;
};
const removals = (calls) => calls.split("\n").filter((line) => /^docker rm /u.test(line));
const orbitLines = (stderr) => stderr.split("\n").filter((line) => line.startsWith("Orbit installer: "));

describe("#1842 item 1: the one-off's stdout is capped at 16384 bytes", () => {
  it("drops output past the cap: a blocked line after 16384 bytes of blank lines is never read", () => {
    const result = update(installedFolder(), {
      FAKE_ONEOFF_MODE: "huge",
      FAKE_ONEOFF_BLANK: String(CAP + 50_000),
      FAKE_ONEOFF_SUFFIX: "update-preflight: blocked MARKER-PAST-THE-CAP\n",
      FAKE_READINESS_EXIT: "1",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain("MARKER-PAST-THE-CAP");
    expect(orbitLines(result.stderr)).toContain(COULD_NOT_CHECK);
    expect(result.engineRuns).toHaveLength(0);
  });

  it("with an endless stream, never holds the marker past the cap, and the engine never runs", () => {
    const result = update(installedFolder(), { FAKE_ONEOFF_MODE: "endless" });
    expect(result.stderr).not.toContain("MARKER-PAST-THE-CAP");
    expect(result.engineRuns).toHaveLength(0);
  });

  it("keeps what is inside the cap: a blocked line and its remedy, then 100 KB more, still take the blocked path with the one-off's exit 1", () => {
    const result = update(installedFolder(), {
      FAKE_ONEOFF_MODE: "huge",
      FAKE_ONEOFF_PREFIX: `${BLOCKED}\n${REMEDY}\n`,
      FAKE_ONEOFF_BLANK: "100000",
      FAKE_READINESS_EXIT: "1",
    });
    expect(result.status).not.toBe(0);
    expect(eventLines(result.stdout).filter((event) => event.startsWith(TERMINAL))).toHaveLength(1);
    expect(result.stderr).toContain(BLOCKED);
    expect(orbitLines(result.stderr)).toContain(`Orbit installer: ${REMEDY}`);
    expect(orbitLines(result.stderr)).not.toContain(COULD_NOT_CHECK);
    expect(result.engineRuns).toHaveLength(0);
  });

  it("exit 0 with 100 KB of output still passes to the engine", () => {
    const result = update(installedFolder(), { FAKE_ONEOFF_MODE: "huge", FAKE_ONEOFF_PREFIX: "update-preflight: ready\n", FAKE_ONEOFF_BLANK: "100000", FAKE_READINESS_EXIT: "0" });
    expect(result.stdout).not.toContain("reason=update-readiness");
    expect(result.engineRuns).toHaveLength(1);
  });

  it("a one-off that dies on a failed write (EPIPE) with exit 0 and 100 KB of output still passes: output past the cap is drained", () => {
    const result = update(installedFolder(), { FAKE_ONEOFF_MODE: "huge", FAKE_ONEOFF_PREFIX: "update-preflight: ready\n", FAKE_ONEOFF_BLANK: "100000", FAKE_READINESS_EXIT: "0", FAKE_EPIPE_EXIT: "1" });
    expect(result.stdout).not.toContain("reason=update-readiness");
    expect(result.engineRuns).toHaveLength(1);
  });

  it("exit 2 with 100 KB of output is the could-not-check refusal, not the reader's status", () => {
    const result = update(installedFolder(), { FAKE_ONEOFF_MODE: "huge", FAKE_ONEOFF_BLANK: "100000", FAKE_READINESS_EXIT: "2" });
    expect(result.status).not.toBe(0);
    expect(orbitLines(result.stderr)).toContain(COULD_NOT_CHECK);
    expect(result.engineRuns).toHaveLength(0);
  });
});

describe("#1842 item 2: the deployment path and the one-off's mount", () => {
  it("a ',' in the path runs the check normally and mounts the folder as given", () => {
    const targetDir = installedFolder({ folderName: "sub,x" });
    const result = update(targetDir, { FAKE_READINESS_EXIT: "0" });
    expect(result.oneOffs).toHaveLength(1);
    const mount = result.oneOffs[0].argv[result.oneOffs[0].argv.indexOf("-v") + 1];
    expect(mount.endsWith("sub,x:/orbit-deploy:ro")).toBe(true);
    expect(result.stdout).not.toContain("reason=update-readiness");
    expect(result.engineRuns).toHaveLength(1);
  });

  it("a ':' in the path is refused with the existing message before any docker compose run", () => {
    const result = update(installedFolder({ folderName: "sub:x" }), { FAKE_READINESS_EXIT: "0" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(COLON_REFUSAL);
    expect(result.calls).not.toMatch(/^docker compose /mu);
    expect(result.oneOffs).toEqual([]);
  });
});

describe("#1842 item 3: a named one-off, removed when stopped", () => {
  it("starts the one-off with --name orbit-update-preflight-<pid>", () => {
    const result = update(installedFolder(), { FAKE_READINESS_EXIT: "0" });
    expect(oneOffName(result), "the one-off was given a --name").toMatch(NAME);
  });

  it.each([["124"], ["137"], ["143"], ["128"]])("exit %s runs docker rm -f with that same name, then fails as update-readiness", (code) => {
    const result = update(installedFolder(), { FAKE_READINESS_EXIT: code });
    const name = oneOffName(result);
    expect(name).toMatch(NAME);
    expect(removals(result.calls)).toEqual([`docker rm -f ${name}`]);
    expect(result.status).not.toBe(0);
    expect(eventLines(result.stdout).filter((event) => event.startsWith(TERMINAL))).toHaveLength(1);
    expect(orbitLines(result.stderr)).toContain(COULD_NOT_CHECK);
    expect(result.engineRuns).toHaveLength(0);
  });

  it("the 124 note is unchanged", () => {
    const result = update(installedFolder(), { FAKE_READINESS_EXIT: "124" });
    expect(result.stderr).toContain(TIMEOUT_NOTE);
  });

  it.each([["0"], ["1"]])("exit %s does not run docker rm", (code) => {
    const result = update(installedFolder(), { FAKE_READINESS_EXIT: code, FAKE_READINESS_STDOUT: `${BLOCKED}\n` });
    expect(oneOffName(result)).toMatch(NAME);
    expect(removals(result.calls)).toEqual([]);
  });

  it("a failing docker rm -f changes nothing about the outcome (exit 124)", () => {
    const result = update(installedFolder(), { FAKE_READINESS_EXIT: "124", FAKE_RM_FAIL: "1" });
    const name = oneOffName(result);
    expect(removals(result.calls)).toEqual([`docker rm -f ${name}`]);
    expect(result.status).not.toBe(0);
    expect(eventLines(result.stdout).filter((event) => event.startsWith(TERMINAL))).toHaveLength(1);
    expect(orbitLines(result.stderr)).toContain(COULD_NOT_CHECK);
    expect(result.stderr).toContain(TIMEOUT_NOTE);
    expect(result.engineRuns).toHaveLength(0);
  });
});

/** Runs the installer with a hanging one-off, sends `signal` to the installer process alone once `trigger` holds: "started" (oneoff-started exists), "call" (the one-off's compose run is in the call log) or a marker file name. */
function interrupted(signal, { mode = "hang", trigger = "oneoff-started", extraEnv = {}, group = false } = {}) {
  const targetDir = installedFolder();
  const before = treeSnapshot(targetDir);
  const bin = wrapperBin();
  const logDir = mkdtempSync(join(tmpdir(), "orbit-readiness-hardening-log-"));
  const env = {
    ...baseEnvironment(bin.dir, logDir),
    PATH: bin.path,
    ORBIT_RELEASE_MANIFEST: manifestFile(),
    FAKE_DOCKER_VERSION: TARGET,
    FAKE_ENGINE_EXIT: "1",
    FAKE_ONEOFF_MODE: mode,
    ...extraEnv,
  };
  const ready = () => (trigger === "call" ? /update --preflight/u.test(readOptional(join(logDir, "calls.log"))) : existsSync(join(logDir, trigger)));
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [installScript, "--plain", "--update"], { cwd: targetDir, env, stdio: ["ignore", "pipe", "pipe"], detached: group });
    const send = (name) => { try { process.kill(group ? -child.pid : child.pid, name); } catch { /* gone */ } };
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdout.resume();
    let sentAt = 0;
    const poll = setInterval(() => {
      if (!sentAt && ready()) {
        sentAt = Date.now();
        send(signal);
      }
    }, 10);
    const hungPid = () => Number(readOptional(join(logDir, "oneoff-started")) || readOptional(join(logDir, "oneoff-early")) || readOptional(join(logDir, "hung-engine"))) || 0;
    const watchdog = setTimeout(() => {
      const pid = hungPid();
      if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      send("SIGKILL");
    }, PROCESS_DEADLINE_MS - 5000);
    child.on("error", reject);
    child.on("close", (code, closedBy) => {
      clearInterval(poll);
      clearTimeout(watchdog);
      const pid = hungPid();
      const oneOffAlive = pid > 0 && pidAlive(pid);
      if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      if (group) send("SIGKILL");
      const calls = readOptional(join(logDir, "calls.log"));
      resolve({ code, closedBy, started: sentAt > 0, elapsedMs: sentAt ? Date.now() - sentAt : -1, oneOffAlive, stderr, calls, before, after: treeSnapshot(targetDir) });
    });
  });
}

function expectInterruptedCleanly(result, status) {
  expect(result.started, "the signal was sent").toBe(true);
  expect(result.elapsedMs, "ended well inside the 60 s bound").toBeLessThan(8000);
  expect(result.code).toBe(status);
  const run = result.calls.split("\n").findIndex((line) => line.includes("update --preflight"));
  expect(run).toBeGreaterThanOrEqual(0);
  const name = /--name (orbit-update-preflight-[0-9]+)/u.exec(result.calls)?.[1];
  expect(name, "the one-off was named").toBeDefined();
  expect(removals(result.calls)).toEqual([`docker rm -f ${name}`]);
  const after = result.calls.split("\n").slice(run + 1).join("\n");
  expect(after).not.toMatch(/^docker (compose .* )?(up|start|restart|down|pull|create)\b/mu);
  expect(result.after).toEqual(result.before);
  expect(result.oneOffAlive, "the one-off process was stopped").toBe(false);
}

describe("#1842 item 4: INT, TERM and HUP during the check act at once", () => {
  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGHUP", 129],
  ])("%s ends the installer within a few seconds with exit %i, the one-off stopped and removed, nothing changed", async (signal, status) => {
    expectInterruptedCleanly(await interrupted(signal), status);
  });

  it("a SIGTERM sent the moment the one-off's call is logged, before it has started, is still acted on once", async () => {
    expectInterruptedCleanly(await interrupted("SIGTERM", { mode: "hang-early", trigger: "call" }), 143);
  });

  it("the traps in force before the check are back after it: a SIGTERM to the group during the engine step, after a passing check, ends with 143", async () => {
    const result = await interrupted("SIGTERM", { mode: "huge", trigger: "hung-engine", extraEnv: { FAKE_ONEOFF_BLANK: "10", FAKE_READINESS_EXIT: "0", FAKE_ENGINE_HANG_BEFORE: "1" }, group: true });
    expect(result.started, "the engine was reached").toBe(true);
    expect(result.code).toBe(143);
    expect(result.elapsedMs).toBeLessThan(8000);
    expect(removals(result.calls)).toEqual([]);
  });
});

describe("#1842 item 5: one project-name function", () => {
  it("update_readiness_project_name calls read_compose_project_name and carries no sed of its own", () => {
    const source = readFileSync(installScript, "utf8");
    const body = /^update_readiness_project_name\(\) \{\n[\s\S]*?\n\}\n/mu.exec(source)?.[0] ?? "";
    expect(body).not.toBe("");
    expect(body).toContain("read_compose_project_name");
    expect(body).not.toMatch(/\bsed\b/u);
  });

  it.each([
    ['name: "quoted-name"', "quoted-name"],
    ["name: 'single-quoted'", "single-quoted"],
    ["name: bare-name   # trailing comment", "bare-name"],
  ])("the project the one-off is run under follows the shared function for %s", (line, expected) => {
    const targetDir = installedFolder({ composeFile: `${line}\nservices: {}\n`, projectName: "" });
    const result = update(targetDir, { FAKE_READINESS_EXIT: "0" });
    const argv = result.oneOffs[0]?.argv ?? [];
    expect(argv[argv.indexOf("--project-name") + 1]).toBe(expected);
  });
});
