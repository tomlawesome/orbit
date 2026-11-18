import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import { ACTIONS, runOwner } from "./repair-owner-fixtures.mjs";
import { privShims, realTool } from "./repair-priv-shims.mjs";
import { composeUpCalls, makeFixture, runRepair, scratchDir, treeSnapshot } from "./repair-test-harness.mjs";

// #1890 (spec: note 63494 on the issue, L1-L4), written from the spec alone. Repair opens the backup/restore lock
// read-write only, never read-only, whoever runs it; a lock it cannot open that way is `unwritable`, which
// start-services, recreate-services and retire-smtp-lines refuse on (exit 4, nothing run), and nothing is written
// to the lock. The cases that need a lock the user can read but not write use chmod 0444 on the test's own lock,
// so none of them needs root. L4 (docs) is not tested here.

vi.setConfig({ testTimeout: Math.max(PROCESS_TEST_TIMEOUT_MS, 60_000) });

const isRoot = process.getuid?.() === 0;
const STOPPED = { db: "stopped", app: "stopped" };
const RUNNING = { db: "running", app: "running" };
const MACHINE = { ORBIT_REPAIR_PROMPTS: "machine" };
const SMTP_ANSWER = "mail-sending source=imported imported-from-environment=true";
const EXEC = ["--execute", "--safe-only"];
const LOCK = ["backups", ".orbit-backup-restore.lock"];
const lockOf = (targetDir) => join(targetDir, ...LOCK);
const NOT_ROOT = { root: false, setpriv: false };
const orbitLines = (result) => result.stderr.split("\n").filter((line) => line.startsWith("Orbit repair:"));
const NO_COMPOSE_UP = (result) => composeUpCalls(result).filter((line) => !line.includes("--no-recreate"));

// L2: the refusal words (the cause is the one #1873's unwritable refusal pins).
const WORDS = [
  "repair can't check whether a backup, restore or export is running: the lock at",
  "could not be opened for writing by the user running repair",
  "(repair opens it read-write so that the open can never wait)",
  "run repair as root or as the owner of the backups folder",
  "or make the lock file writable for the user running repair",
];

// Everything chmod-ed in a test is put back so the temp dirs can be removed.
const restores = [];
afterEach(() => {
  while (restores.length > 0) {
    const [path, mode] = restores.pop();
    try {
      chmodSync(path, mode);
    } catch {
      // already gone
    }
  }
});

/** A lock file in the folder's own backups folder: `content` bytes, `mode`, and an old mtime so any touch shows. */
function plantLock(targetDir, { content = "", mode = 0o600 } = {}) {
  mkdirSync(join(targetDir, LOCK[0]), { mode: 0o700, recursive: true });
  const path = lockOf(targetDir);
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, mode);
  utimesSync(path, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
  restores.push([path, 0o600]);
  return path;
}

function identity(path) {
  const st = statSync(path);
  return { bytes: readFileSync(path).toString("hex"), size: st.size, mode: st.mode, mtimeMs: st.mtimeMs, uid: st.uid, gid: st.gid, ino: st.ino };
}

function withMail() {
  const targetDir = makeFixture();
  writeFileSync(
    join(targetDir, ".env-orbit"),
    [
      "SMTP_HOST=smtp.example.test",
      "SMTP_PORT=587",
      "SMTP_SECURITY=starttls",
      "SMTP_USER=orbit@example.test",
      "SMTP_PASSWORD_FILE=/run/orbit-secrets/orbit-smtp-password",
      "SMTP_FROM=Orbit <orbit@example.test>",
      "",
    ].join("\n"),
    { flag: "a" },
  );
  return targetDir;
}

function movedLabels() {
  const scratch = scratchDir();
  const labelsPath = join(scratch, "labels");
  writeFileSync(labelsPath, `${join(scratch, "old-orbit-folder")}\n`);
  return { workingDirLabelsPath: labelsPath };
}

// The three actions that take the lock: how to build the folder and the options of the run.
const TAKERS = {
  "start-services": () => ({ targetDir: makeFixture(), options: STOPPED, done: "execute action=start-services resolves=services-not-running result=done" }),
  "recreate-services": () => ({ targetDir: makeFixture(), options: { ...RUNNING, docker: movedLabels() }, done: "execute action=recreate-services resolves=folder-moved result=done" }),
  "retire-smtp-lines": () => ({
    targetDir: withMail(),
    options: { ...RUNNING, mailStatus: SMTP_ANSWER, env: MACHINE },
    input: "y\n",
    done: "execute action=retire-smtp-lines",
  }),
};

function runTaker(name, prepare) {
  const made = TAKERS[name]();
  const lock = prepare(made.targetDir);
  const options = { ...made.options };
  if (made.input) options.input = made.input;
  const before = treeSnapshot(made.targetDir);
  const result = runRepair(made.targetDir, EXEC, options);
  return { ...made, lock, before, result };
}

function expectUnwritableRefusal(name, run) {
  const { result, targetDir, before } = run;
  expect(result.status, result.stderr.slice(0, 1500)).toBe(4);
  expect(result.stdout).toContain(`execute action=${name}`);
  expect(result.stdout).toContain("result=failed");
  expect(result.stdout).not.toMatch(new RegExp(`execute action=${name} \\S+ result=done`, "u"));
  const line = orbitLines(result).find((l) => l.includes(`${name} refused, nothing was changed:`));
  expect(line, `no refusal line:\n${result.stderr.slice(0, 1500)}`).toBeTruthy();
  expect(line).toContain(lockOf(targetDir));
  for (const words of WORDS) expect(line, `the refusal does not say: ${words}`).toContain(words);
  expect(line).not.toContain("can't be read");
  expect(NO_COMPOSE_UP(result), "compose ran although the lock could not be opened for writing").toEqual([]);
  expect(treeSnapshot(targetDir)).toBe(before);
}

describe.skipIf(isRoot)("#1890 L1/L2: a lock the user can read but not write is `unwritable`, never opened read-only", () => {
  for (const name of Object.keys(TAKERS)) {
    it(`${name}: chmod 0444 on the lock: refused, exit 4, nothing run, the refusal says it could not be opened for writing`, () => {
      const run = runTaker(name, (targetDir) => plantLock(targetDir, { mode: 0o444 }));
      expectUnwritableRefusal(name, run);
    });
  }

  it("the refusal is not an unreadable one: a lock that is readable and writable is not named 'can't be read' either", () => {
    const run = runTaker("start-services", (targetDir) => plantLock(targetDir, { mode: 0o444 }));
    expect(run.result.stderr).not.toContain("can't be read");
    expect(run.result.stderr).not.toContain("although its permissions say it can be");
  });

  it("start-services leaves the 0444 lock exactly as it was (no byte, mode, owner or mtime change)", () => {
    const targetDir = makeFixture();
    const path = plantLock(targetDir, { content: "LOCK-BYTES\n", mode: 0o444 });
    const before = identity(path);
    const result = runRepair(targetDir, EXEC, STOPPED);
    expect(result.status).toBe(4);
    expect(identity(path)).toEqual(before);
  });

  it("--plan is unchanged by an unwritable lock: the lock is checked at execution only, so start-services is still planned", () => {
    const targetDir = makeFixture();
    plantLock(targetDir, { mode: 0o444 });
    const result = runRepair(targetDir, ["--plan"], STOPPED);
    expect(result.stdout).toContain("plan action=start-services resolves=services-not-running");
    expect(result.stderr).not.toContain("could not be opened for writing");
  });

  it("--check is unchanged by an unwritable lock: it still reports the stopped services and does not touch the lock", () => {
    const targetDir = makeFixture();
    const path = plantLock(targetDir, { content: "LOCK-BYTES\n", mode: 0o444 });
    const before = identity(path);
    const result = runRepair(targetDir, ["--check"], STOPPED);
    expect(result.stdout).toContain("services-not-running");
    expect(identity(path)).toEqual(before);
  });
});

describe("#1890 L1: no open of the lock waits, read-only lock or not", () => {
  const start = ACTIONS["start-services"];

  /**
   * A start-services folder whose lock exists as a regular file of `mode`; a BASH_ENV hook swaps it for `kind` just
   * before repair's open (after its lstat). The hook writes the time of the swap to `flag` and, at the next command
   * in probe_backup_restore_lock (so once the open has returned), the time to `opened`: their gap is the open alone.
   */
  function swapped(kind, mode) {
    const { targetDir, state } = start.make();
    const path = plantLock(targetDir, { mode });
    const hook = scratchDir("orbit-lockrw-hook-");
    const flag = join(hook, "swapped");
  const opened = join(hook, "opened");
    const outside = scratchDir("orbit-lockrw-dest-");
    const dest = join(outside, "lock-elsewhere");
    writeFileSync(dest, "");
    const swap = kind === "fifo" ? `${realTool("rm")} -f -- "$L"; ${realTool("mkfifo")} "$L"` : `${realTool("rm")} -f -- "$L"; ${realTool("ln")} -s '${dest}' "$L"`;
    writeFileSync(
      join(hook, "env.sh"),
      `set -T
__orbit_lock_swap() {
  if [[ -e '${flag}' && ! -e '${opened}' && " \${FUNCNAME[*]-} " == *" probe_backup_restore_lock "* ]]; then
    printf '%s' "\$EPOCHREALTIME" > '${opened}'
    return 0
  fi
  case "\${BASH_COMMAND-}" in *'exec {fd}<'*) ;; *) return 0;; esac
  [[ " \${FUNCNAME[*]-} " == *" probe_backup_restore_lock "* ]] || return 0
  [[ -e '${flag}' ]] && return 0
  local L='${path}'
  printf '%s' "\$EPOCHREALTIME" > '${flag}'
  ${swap}
  return 0
}
trap __orbit_lock_swap DEBUG
`,
    );
    return { targetDir, state, env: { BASH_ENV: join(hook, "env.sh") }, flag, opened, path };
  }

  const release = (path) => {
    // Release a reader still blocked in open() on the FIFO.
    try {
      if (existsSync(path) && lstatSync(path).isFIFO()) closeSync(openSync(path, "r+"));
    } catch {
      // already gone
    }
  };
  /** Milliseconds from the swap to the open's return, as the hook recorded them; Infinity if the open never returned. */
  const openMs = (flag, opened) => (existsSync(opened) ? (Number(readFileSync(opened, "utf8")) - Number(readFileSync(flag, "utf8"))) * 1000 : Infinity);
  const lockLine = (result) => orbitLines(result).some((line) => /the lock at .*(can't be read|could not be opened for writing)/u.test(line));

  for (const [who, shimOptions, mode] of [
    ["a lock the user can only read (0444)", NOT_ROOT, 0o444],
    ["a writable lock (0600)", NOT_ROOT, 0o600],
  ]) {
    it.skipIf(isRoot)(`${who}: swapped for a FIFO between the lstat and the open, repair refuses within 5 s and never hangs`, () => {
      const { targetDir, state, env, flag, opened, path } = swapped("fifo", mode);
      const shims = privShims(targetDir, shimOptions);
      try {
        const result = runOwner(targetDir, { shims, state, env, capSeconds: 12 });
        expect(existsSync(flag), "the swap did not happen, so the test proves nothing").toBe(true);
        expect(result.hung, "repair blocked opening the FIFO").toBe(false);
        // The spec's 5 s, timed on the open alone (swap to return, from the hook), so host load on repair's start-up
        // and its other checks cannot fail it; `hung` (the 12 s cap on the whole run) stays the backstop.
        expect(openMs(flag, opened), "repair waited on the lock").toBeLessThan(5_000);
        expect(result.stdout).not.toContain(start.done);
        expect(result.status).not.toBe(0);
        expect(lockLine(result), `no lock refusal line:\n${result.stderr.slice(0, 1500)}`).toBe(true);
        expect(composeUpCalls(result)).toEqual([]);
      } finally {
        release(path);
        shims.cleanup();
      }
    });

    it.skipIf(isRoot)(`${who}: swapped for a link to a regular file between the lstat and the open, the link is not followed`, () => {
      const { targetDir, state, env, flag } = swapped("link", mode);
      const shims = privShims(targetDir, shimOptions);
      try {
        const result = runOwner(targetDir, { shims, state, env, capSeconds: 12 });
        expect(existsSync(flag), "the swap did not happen, so the test proves nothing").toBe(true);
        expect(result.hung).toBe(false);
        expect(result.stdout, "repair followed a swapped link and took the lock").not.toContain(start.done);
        expect(lockLine(result), `no lock refusal line:\n${result.stderr.slice(0, 1500)}`).toBe(true);
        expect(composeUpCalls(result)).toEqual([]);
      } finally {
        shims.cleanup();
      }
    });
  }

  it("pin, root (simulated, the owner's folder): a FIFO swapped in after the lstat is refused without a wait", () => {
    const { targetDir, state, env, flag, path } = swapped("fifo", 0o600);
    const shims = privShims(targetDir);
    try {
      const result = runOwner(targetDir, { shims, state, env, capSeconds: 12 });
      expect(existsSync(flag)).toBe(true);
      expect(result.hung).toBe(false);
      expect(result.ms).toBeLessThan(10_000);
      expect(result.stdout).not.toContain(start.done);
      expect(lockLine(result), result.stderr.slice(0, 1500)).toBe(true);
    } finally {
      release(path);
      shims.cleanup();
    }
  });
});

describe.skipIf(isRoot)("#1890 L3: nothing is written to the lock", () => {
  for (const name of Object.keys(TAKERS)) {
    it(`${name}: after the probe, the acquire and the release the lock's bytes, size, mode, mtime and owner are unchanged`, () => {
      const run = runTaker(name, (targetDir) => plantLock(targetDir, { content: "LOCK-BYTES\n", mode: 0o640 }));
      const before = { bytes: Buffer.from("LOCK-BYTES\n").toString("hex"), size: 11, mode: 0o100640, mtimeMs: new Date("2020-01-01T00:00:00Z").getTime(), uid: process.getuid(), gid: statSync(run.lock).gid, ino: statSync(run.lock).ino };
      expect(run.result.stdout, run.result.stderr.slice(0, 1500)).toContain(run.done);
      expect(run.result.status).toBe(0);
      expect(identity(run.lock)).toEqual(before);
    });
  }

  it("a lock made by repair (it was missing) is empty, owner-only (0600) and is not truncated by a second run", () => {
    const targetDir = makeFixture();
    const first = runRepair(targetDir, EXEC, STOPPED);
    expect(first.stdout, first.stderr).toContain(TAKERS["start-services"]().done);
    expect(statSync(lockOf(targetDir)).mode & 0o777).toBe(0o600);
    expect(statSync(lockOf(targetDir)).size).toBe(0);
    const path = lockOf(targetDir);
    writeFileSync(path, "KEEP\n");
    utimesSync(path, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    const before = identity(path);
    const second = runRepair(targetDir, EXEC, STOPPED);
    expect(second.stdout, second.stderr).toContain("execute action=start-services");
    expect(identity(path)).toEqual(before);
  });
});

describe.skipIf(isRoot)("#1890 L3: `held` and `untestable` keep their meaning", () => {
  const LOCK_REASON = "a backup, restore or export is running right now; wait for it to end, then re-run repair.";

  async function holdLock(path) {
    const holder = spawn("flock", ["-x", path, "sleep", "60"], { stdio: "ignore" });
    const deadline = Date.now() + 10_000;
    while (spawnSync("flock", ["-n", path, "true"]).status === 0) {
      if (Date.now() > deadline) throw new Error("the background flock never took the lock");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return () => holder.kill("SIGKILL");
  }

  it("a lock another process holds flock on is reported held (writable lock), not unwritable", async () => {
    const targetDir = makeFixture();
    const path = plantLock(targetDir);
    const release = await holdLock(path);
    try {
      const result = runRepair(targetDir, EXEC, STOPPED);
      expect(result.status).toBe(4);
      expect(result.stderr).toContain(`Orbit repair: start-services refused, nothing was changed: ${LOCK_REASON}`);
      expect(result.stderr).not.toContain("could not be opened for writing");
      expect(composeUpCalls(result)).toEqual([]);
    } finally {
      release();
    }
  });

  it("a lock flock cannot test is untestable with flock's words, not unwritable", () => {
    const targetDir = makeFixture();
    const path = plantLock(targetDir);
    const dir = scratchDir("orbit-lockrw-flock-");
    writeFileSync(join(dir, "flock"), `#!/usr/bin/env bash\nprintf 'flock: %s: Bad file descriptor\\n' "\${@: -1}" >&2\nexit 65\n`);
    chmodSync(join(dir, "flock"), 0o755);
    const result = runRepair(targetDir, EXEC, { ...STOPPED, env: { PATH: `${dir}:${process.env.PATH}` } });
    expect(result.status).toBe(4);
    expect(result.stderr).toContain(`the lock at ${path} can't be tested on that filesystem (flock said: flock:`);
    expect(result.stderr).not.toContain("could not be opened for writing");
  });
});

describe.skipIf(isRoot)("#1890 pins: not root, a writable lock behaves as today", () => {
  it("start-services takes the lock, runs the compose call, then releases it", () => {
    const targetDir = makeFixture();
    const path = plantLock(targetDir);
    const dir = scratchDir("orbit-lockrw-probe-");
    const out = join(dir, "probe.log");
    const rc = join(dir, "probe.sh");
    // A printf injected into the fake docker wrapper probes the lock with a second flock at the moment `compose up` runs.
    writeFileSync(
      rc,
      `printf() {
  if [[ -n "\${S:-}" && "\${1:-}" == '%s\\n' && "\${2:-}" == compose* && " \${2} " == *" up "* ]]; then
    /usr/bin/flock -n '${path}' true 2>/dev/null; case $? in 0) builtin printf 'free\\n' >> '${out}' ;; 1) builtin printf 'held\\n' >> '${out}' ;; *) builtin printf 'error\\n' >> '${out}' ;; esac
  fi
  builtin printf "$@"
}
`,
    );
    const result = runRepair(targetDir, EXEC, { ...STOPPED, env: { BASH_ENV: rc } });
    expect(result.stdout, result.stderr).toContain("execute action=start-services resolves=services-not-running result=done");
    expect(composeUpCalls(result).length).toBeGreaterThan(0);
    expect(readFileSync(out, "utf8").split("\n").filter(Boolean)).toEqual(["held"]);
    expect(spawnSync("flock", ["-n", path, "true"]).status, "the lock was not released").toBe(0);
  });

  it("no lock file at all: repair makes it owner-only and the action runs", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, EXEC, STOPPED);
    expect(result.stdout, result.stderr).toContain("execute action=start-services resolves=services-not-running result=done");
    expect(statSync(lockOf(targetDir)).mode & 0o777).toBe(0o600);
  });
});

describe("#1890 pins: root in the owner's folder (simulated) behaves as under #1873", () => {
  const start = ACTIONS["start-services"];

  it("the lock is made as the folder's owner when missing, opened, and start-services runs", () => {
    const { targetDir, state } = start.make();
    const shims = privShims(targetDir);
    try {
      const result = runOwner(targetDir, { shims, state });
      expect(result.stdout, result.stderr).toContain(start.done);
      expect(lstatSync(lockOf(targetDir)).isFile()).toBe(true);
      expect(statSync(lockOf(targetDir)).mode & 0o777).toBe(0o600);
    } finally {
      shims.cleanup();
    }
  });

  it("a lock already there is not rewritten: bytes, mode and mtime are unchanged after the run", () => {
    const { targetDir, state } = start.make();
    const path = plantLock(targetDir, { content: "LOCK-BYTES\n" });
    const before = identity(path);
    const shims = privShims(targetDir);
    try {
      const result = runOwner(targetDir, { shims, state });
      expect(result.stdout, result.stderr).toContain(start.done);
      expect(identity(path)).toEqual(before);
    } finally {
      shims.cleanup();
    }
  });
});
