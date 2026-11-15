import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import { makeFixture, runRepair, runRepairBetweenPlanAndExecute, scratchDir, treeSnapshot } from "./repair-test-harness.mjs";

// #1849: one `repair.sh --execute` run per deployment folder. The run takes
// `flock -n` on a read-only descriptor of the folder itself (`.`), before
// snapshot_run_checkpoints, and holds it until the process exits. No lock
// file. --check and --plan take no lock. Without a usable flock the run goes
// on and says so on stderr.

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const STOPPED = { db: "stopped", app: "stopped" };
const SAFE = ["--execute", "--safe-only"];
const REFUSED = "execution result=refused done=0 failed=0 reason=repair-running";
const DANGEROUS_REFUSED = "dangerous result=refused done=0 failed=0 reason=repair-running";
const RUNNING_LINE = /another Repair run is working on this folder.*wait for it to finish.*run Repair again/iu;
const WITHOUT_LOCK = /without the lock/iu;

// Holds `flock -x <dir>` (a directory, read-only descriptor) from a background process.
async function holdFolderLock(dir) {
  const holder = spawn("flock", ["-x", dir, "sleep", "30"], { stdio: "ignore" });
  const deadline = Date.now() + 10_000;
  while (spawnSync("flock", ["-n", dir, "true"]).status === 0) {
    if (Date.now() > deadline) {
      holder.kill("SIGKILL");
      throw new Error("the background flock never took the folder lock");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return holder;
}

function contents(dir) {
  const out = {};
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out[full.slice(dir.length)] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

// Fails only when asked to lock a directory (the run lock); the backup/restore lock file still goes to the real flock.
function stubFlock(body, code) {
  const shimDir = scratchDir("orbit-flock-1849-");
  const script = [
    "#!/usr/bin/env bash",
    'target="${@: -1}"',
    '[[ "$target" =~ ^[0-9]+$ ]] && target="/proc/self/fd/$target"',
    'if [[ -d "$target" ]]; then',
    body,
    `  exit ${code}`,
    "fi",
    'exec /usr/bin/flock "$@"',
    "",
  ].join("\n");
  writeFileSync(join(shimDir, "flock"), script);
  chmodSync(join(shimDir, "flock"), 0o755);
  return { PATH: `${shimDir}${delimiter}${process.env.PATH}` };
}

function pathWithoutFlock() {
  const dir = scratchDir("orbit-noflock-1849-");
  for (const source of new Set(process.env.PATH.split(delimiter))) {
    let names = [];
    try {
      names = readdirSync(source);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name === "flock") continue;
      try {
        symlinkSync(join(source, name), join(dir, name));
      } catch {
        // an earlier PATH entry already provides it
      }
    }
  }
  return dir;
}

describe("#1849: a held folder lock refuses --execute", () => {
  it("1: --safe-only exits 6 with the refusal line and stderr line, and changes nothing", async () => {
    const targetDir = makeFixture();
    const holder = await holdFolderLock(targetDir);
    try {
      const before = treeSnapshot(targetDir);
      const beforeContents = contents(targetDir);
      const result = runRepair(targetDir, SAFE, STOPPED);
      expect(result.stdout.split("\n")).toContain(REFUSED);
      expect(result.status).toBe(6);
      expect(result.stderr).toMatch(RUNNING_LINE);
      expect(result.stderr.split("\n").filter((line) => RUNNING_LINE.test(line))).toHaveLength(1);
      expect(result.argv.filter((line) => /\bup\b/u.test(line))).toEqual([]);
      expect(readdirSync(targetDir).filter((name) => name.startsWith(".orbit-repair-checkpoint."))).toEqual([]);
      expect(treeSnapshot(targetDir)).toBe(before);
      expect(contents(targetDir)).toEqual(beforeContents);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("2: --dangerous also prints the dangerous refused line", async () => {
    const targetDir = makeFixture();
    const holder = await holdFolderLock(targetDir);
    try {
      const before = treeSnapshot(targetDir);
      const result = runRepair(targetDir, ["--execute", "--dangerous"], { ...STOPPED, env: { ORBIT_REPAIR_PROMPTS: "machine" }, input: "y\n" });
      const lines = result.stdout.split("\n");
      expect(lines).toContain(REFUSED);
      expect(lines).toContain(DANGEROUS_REFUSED);
      expect(result.status).toBe(6);
      expect(result.stderr).toMatch(RUNNING_LINE);
      expect(treeSnapshot(targetDir)).toBe(before);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("3: --check and --plan take no lock and run as usual", async () => {
    const targetDir = makeFixture();
    const usual = { check: runRepair(targetDir, ["--check"], STOPPED).status, plan: runRepair(targetDir, ["--plan"], STOPPED).status };
    const holder = await holdFolderLock(targetDir);
    try {
      for (const mode of ["check", "plan"]) {
        const result = runRepair(targetDir, [`--${mode}`], STOPPED);
        expect(result.status).toBe(usual[mode]);
        expect(result.status).not.toBe(6);
        expect(result.stdout).not.toContain("reason=repair-running");
        expect(result.stderr).not.toMatch(RUNNING_LINE);
      }
    } finally {
      holder.kill("SIGKILL");
    }
  });
});

describe("#1849: no lock file", () => {
  it("4: a normal --execute run creates no lock entry in the folder", () => {
    const targetDir = makeFixture();
    const entries = () => treeSnapshot(targetDir).split("\n").filter(Boolean).map((line) => line.split(" ")[0]);
    const before = new Set(entries());
    // the existing backup/restore lock file (#1823) is not this run lock
    const isBackupsEntry = (path) => path.startsWith("./backups");
    const result = runRepair(targetDir, SAFE, STOPPED);
    expect(result.stdout).toContain("execute action=start-services resolves=services-not-running result=done");
    expect(result.stdout).not.toContain("reason=repair-running");
    const created = entries().filter((path) => !before.has(path) && !isBackupsEntry(path));
    expect(created.filter((path) => /lock|\.orbit-repair-run/iu.test(path))).toEqual([]);
    // the run ends clean: no checkpoint, no other leftover
    expect(created).toEqual([]);
    // the lock ended with the process
    expect(spawnSync("flock", ["-n", targetDir, "true"]).status).toBe(0);
  });
});

describe("#1849: flock unavailable", () => {
  it("5: a flock that cannot lock (exit 69, words) is skipped with one stderr line", () => {
    const targetDir = makeFixture();
    const env = stubFlock(`printf 'flock: %s: Function not implemented\\n' "\${@: -1}" >&2`, 69);
    const result = runRepair(targetDir, SAFE, { ...STOPPED, env });
    expect(result.stdout).toContain("execute action=start-services resolves=services-not-running result=done");
    expect(result.stdout).not.toContain("reason=repair-running");
    expect(result.status).toBe(0);
    expect(result.stderr.split("\n").filter((line) => WITHOUT_LOCK.test(line))).toHaveLength(1);
  });

  it("6: no flock on PATH is skipped with one stderr line", () => {
    const targetDir = makeFixture();
    const noFlock = pathWithoutFlock();
    expect(spawnSync("bash", ["-c", "command -v flock"], { env: { PATH: noFlock } }).status).not.toBe(0);
    const result = runRepair(targetDir, SAFE, { ...STOPPED, env: { PATH: noFlock } });
    expect(result.stdout).toContain("execute action=start-services resolves=services-not-running result=done");
    expect(result.stdout).not.toContain("reason=repair-running");
    expect(result.status).toBe(0);
    expect(result.stderr.split("\n").filter((line) => WITHOUT_LOCK.test(line))).toHaveLength(1);
  });
});

describe("#1849: the lock is held for the whole run", () => {
  it("7: while a first run waits at the typed confirmation, a second --execute refuses", async () => {
    const targetDir = makeFixture();
    let second;
    const first = await runRepairBetweenPlanAndExecute(targetDir, SAFE, STOPPED, () => {
      second = runRepair(targetDir, SAFE, STOPPED);
    });
    expect(second.stdout.split("\n")).toContain(REFUSED);
    expect(second.status).toBe(6);
    expect(second.stderr).toMatch(RUNNING_LINE);
    // the first run is unaffected and finishes
    expect(first.stdout).toContain("execute action=start-services resolves=services-not-running result=done");
    expect(first.stdout).not.toContain("reason=repair-running");
    // and the lock is gone once it exits
    expect(spawnSync("flock", ["-n", targetDir, "true"]).status).toBe(0);
  });
});
