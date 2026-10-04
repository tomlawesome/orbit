import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard, processWatchdog } from "./process-budget.mjs";

// Tests here run scripts/web-deploy.sh under sh; a spawn that takes tens of
// milliseconds quiet takes seconds on a starved core (#698). Budget and
// reasoning: scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

/**
 * #735: `pnpm deploy` produces the image's pruned production node_modules, and
 * as a side effect rewrites the WORKSPACE's own
 * `node_modules/.pnpm-workspace-state-v1.json` to say the last install here was
 * `--prod --filter`. It was not — the install went to the target directory —
 * but every later pnpm command believes it, decides node_modules must be
 * rebuilt as a production install, and refuses without a TTY. The failure lands
 * on some unrelated command minutes later as
 * ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY and points at nothing.
 *
 * `scripts/web-deploy.sh` puts the file back. These tests drive it with a stub
 * `pnpm` rather than a real deploy: the behaviour under test is the restore,
 * and a real deploy would put a slow network- and store-dependent step in the
 * fast suite to prove something pnpm is responsible for.
 */
const repoRoot = resolve(import.meta.dirname, "..");
const workspaceState = join(repoRoot, "node_modules", ".pnpm-workspace-state-v1.json");
const lockDir = join(repoRoot, ".web-deploy.lock");

/** A `pnpm` that corrupts the workspace state the way the real one does. */
function stubPnpm(directory, { exitCode = 0 } = {}) {
  const path = join(directory, "pnpm");
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '{"corrupted-by-the-stub":true}\\n' > ${JSON.stringify(workspaceState)}\nexit ${exitCode}\n`,
  );
  chmodSync(path, 0o755);
  return directory;
}

/**
 * A `pnpm` that holds on for `holdSeconds` before writing the corrupted
 * workspace state, printing a nanosecond timestamp to `logPath` the instant
 * it starts and again the instant it is about to finish -- #1151 D1-S3's
 * own real two-process race proof, the same ACQUIRED/RELEASING timestamp
 * technique scripts/backup-restore-lock.test.mjs already uses for
 * acquire_backup_restore_lock.
 */
function stubPnpmSlow(directory, { logPath, holdSeconds = 1 }) {
  const path = join(directory, "pnpm");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `printf 'ACQUIRED %s\\n' "$(date +%s%N)" >> ${JSON.stringify(logPath)}`,
      `sleep ${holdSeconds}`,
      `printf '{"corrupted-by-the-stub":true}\\n' > ${JSON.stringify(workspaceState)}`,
      `printf 'RELEASING %s\\n' "$(date +%s%N)" >> ${JSON.stringify(logPath)}`,
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
}

function runDeployAsync(binDir, targetDir) {
  const child = spawn("sh", [join(repoRoot, "scripts", "web-deploy.sh"), targetDir], {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
  });
  const watchdog = processWatchdog({ label: "runDeployAsync", kill: () => child.kill("SIGKILL") });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    watchdog.touch();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    watchdog.touch();
  });
  return new Promise((resolvePromise, reject) => {
    child.on("error", (error) => {
      watchdog.stop();
      reject(error);
    });
    child.on("close", (status) => {
      watchdog.stop();
      if (watchdog.reason) {
        reject(watchdog.error({ stdout, stderr }));
        return;
      }
      resolvePromise({ status, stdout, stderr });
    });
  });
}

function timestampAfter(log, marker) {
  const match = log.match(new RegExp(`^${marker} (\\d+)$`, "mu"));
  if (!match) throw new Error(`${marker} never appeared in: ${log}`);
  return BigInt(match[1]);
}

describe("scripts/web-deploy.sh", () => {
  let stubDir;
  let ownBackup;

  beforeEach(() => {
    stubDir = mkdtempSync(join(tmpdir(), "orbit-web-deploy-"));
    // Held independently of the script, so a regression cannot leave this
    // checkout's pnpm state broken for whoever runs the suite next.
    ownBackup = join(stubDir, "workspace-state.json");
    copyFileSync(workspaceState, ownBackup);
  });

  afterEach(() => {
    copyFileSync(ownBackup, workspaceState);
    rmSync(stubDir, { recursive: true, force: true });
  });

  function runDeploy({ exitCode = 0 } = {}) {
    stubPnpm(stubDir, { exitCode });
    return failOnProcessDeadline(spawnSync("sh", [join(repoRoot, "scripts", "web-deploy.sh"), join(stubDir, "target")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
      ...processGuard(),
    }), { label: "runDeploy" });
  }

  it("leaves the workspace's pnpm state exactly as it found it", () => {
    const before = readFileSync(workspaceState, "utf8");
    const result = runDeploy();
    expect(result.status).toBe(0);
    expect(readFileSync(workspaceState, "utf8")).toBe(before);
  });

  it("restores it even when the deploy fails", () => {
    const before = readFileSync(workspaceState, "utf8");
    const result = runDeploy({ exitCode: 1 });
    expect(result.status).not.toBe(0);
    expect(readFileSync(workspaceState, "utf8")).toBe(before);
  });

  it("refuses without a target directory rather than guessing one", () => {
    const result = failOnProcessDeadline(
      spawnSync("sh", [join(repoRoot, "scripts", "web-deploy.sh")], { encoding: "utf8", ...processGuard() }),
      { label: "web-deploy.sh without a target" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage:");
  });
});

// #1151 D1-S3: two concurrent web-deploy.sh runs shared this workspace's
// node_modules with no lock -- the second run's own snapshot of
// .pnpm-workspace-state-v1.json could already be the first run's
// in-progress (corrupted) content, and whichever restore ran last won
// regardless of which deploy it belonged to, leaving node_modules broken
// until a manual `pnpm install`. A real `mkdir`-based lock (chosen over
// flock: not installed in this script's own build-stage base image, and
// unverifiable here without a Docker build) now serializes them.
describe("scripts/web-deploy.sh serializes concurrent runs (#1151 D1-S3)", () => {
  let stubDir;
  let ownBackup;

  beforeEach(() => {
    stubDir = mkdtempSync(join(tmpdir(), "orbit-web-deploy-lock-"));
    ownBackup = join(stubDir, "workspace-state.json");
    copyFileSync(workspaceState, ownBackup);
  });

  afterEach(() => {
    copyFileSync(ownBackup, workspaceState);
    rmSync(stubDir, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  });

  it("never lets a second run start its own deploy before the first one's cleanup finishes", async () => {
    const logPath = join(stubDir, "timestamps.log");
    const binA = join(stubDir, "bin-a");
    const binB = join(stubDir, "bin-b");
    mkdirSync(binA);
    mkdirSync(binB);
    stubPnpmSlow(binA, { logPath, holdSeconds: 1 });
    stubPnpmSlow(binB, { logPath, holdSeconds: 0 });

    const first = runDeployAsync(binA, join(stubDir, "target-a"));
    // A real head start, so this test is about mutual exclusion while held,
    // not about which of two simultaneous callers wins the race.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    const second = runDeployAsync(binB, join(stubDir, "target-b"));

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.status).toBe(0);
    expect(secondResult.status).toBe(0);
    expect(secondResult.stderr).toContain("another web-deploy is already running; waiting for it to finish");

    const log = readFileSync(logPath, "utf8");
    const firstReleased = timestampAfter(log, "RELEASING");
    // Two ACQUIRED lines are logged (one per run); the second one is B's,
    // since A's own head start means A's ACQUIRED always logs first.
    const acquiredTimestamps = [...log.matchAll(/^ACQUIRED (\d+)$/gmu)].map((match) => BigInt(match[1]));
    expect(acquiredTimestamps).toHaveLength(2);
    const secondAcquiredTimestamp = acquiredTimestamps[1];
    expect(secondAcquiredTimestamp > firstReleased).toBe(true);
  });

  it("reclaims a lock left behind by a process that no longer exists, rather than hanging forever", () => {
    // A short-lived real process whose PID is guaranteed to have exited by
    // the time web-deploy.sh looks at it, standing in for a prior run
    // killed hard (SIGKILL) before it could remove its own lock directory.
    const dead = spawnSync("sh", ["-c", "exit 0"]);
    const deadPid = dead.pid;
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "pid"), `${deadPid}\n`);

    stubPnpm(stubDir);
    const result = failOnProcessDeadline(spawnSync("sh", [join(repoRoot, "scripts", "web-deploy.sh"), join(stubDir, "target")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
      ...processGuard(),
    }), { label: "runDeploy (stale lock)" });

    expect(result.status).toBe(0);
    expect(existsSync(lockDir)).toBe(false);
  });

  it("reclaims a lock dir left with no pid file at all, rather than hanging forever (#1151 RANGE-F4)", () => {
    // Stands in for a run killed (SIGKILL) between `mkdir "$lock_dir"`
    // succeeding and its pid file being written: the directory exists, but
    // held_pid can never become non-empty, so nothing will ever reclaim it
    // except a bound on how long "exists with no pid file" is tolerated.
    mkdirSync(lockDir);

    stubPnpm(stubDir);
    const result = failOnProcessDeadline(spawnSync("sh", [join(repoRoot, "scripts", "web-deploy.sh"), join(stubDir, "target")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
      ...processGuard(),
    }), { label: "runDeploy (lock dir with no pid file)" });

    expect(result.status).toBe(0);
    expect(existsSync(lockDir)).toBe(false);
  });
});
