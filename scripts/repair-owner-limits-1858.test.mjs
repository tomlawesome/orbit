import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ACTIONS, mailFolder, runOwner } from "./repair-owner-fixtures.mjs";
import { expectStalledStepsEnded, privShims, realTool } from "./repair-priv-shims.mjs";
import { scratchDir, treeSnapshot } from "./repair-test-harness.mjs";

// #1858 (spec: note 61727, T1-T5): run as root in a folder another user owns, every child repair runs as that
// owner is bounded in time (ORBIT_REPAIR_OWNER_STEP_TIMEOUT, whole seconds 1-600, default 60; TERM at the limit,
// KILL 5 s later), root's reads of what it prints and of the owner's files are bounded in time and size, and a
// time-out or over-cap read fails the step with one `Orbit repair:` line, releases the backup/restore lock and
// leaves the folder as the step's failure path leaves it. Written from the spec alone. The vehicle is
// retire-smtp-lines (it already runs its writes as the owner); the owner's side is the setpriv shim of
// repair-priv-shims.mjs, in variants that stop, ignore TERM, leave a grandchild on the pipe or flood.

vi.setConfig({ testTimeout: 90_000 });

// #1933 (owner 77a): a stall case is judged by its events (the stalled child got TERM and, if it ignores TERM,
// KILL; the timed-out line; the status; nothing left), not by how long repair took. STALL_CAP is the one cap per
// case, there only to catch a real hang (the default 25 s cap was overrun by a loaded runner). 5 s, not 2: the
// limit is every owner step's, and at 2 s a step that does not stall could overrun on a loaded runner (#1928).
// Cases that stall nothing run under the default limit, or (the control) a long one.
const STALL_SECONDS = 5;
const LIMIT = { ORBIT_REPAIR_OWNER_STEP_TIMEOUT: String(STALL_SECONDS) };
const LONG_LIMIT = { ORBIT_REPAIR_OWNER_STEP_TIMEOUT: "30" };
const STALL_CAP = 60;
const LOCK = ["backups", ".orbit-backup-restore.lock"];
const MAIL_DONE = "execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done";

/** A mail folder; with `prepared`, the backups folder and its lock file already exist (root holds the lock when the first owner step runs). */
function folder({ prepared }) {
  const targetDir = mailFolder();
  if (prepared) {
    mkdirSync(join(targetDir, LOCK[0]), { mode: 0o700 });
    writeFileSync(join(targetDir, ...LOCK), "", { mode: 0o600 });
  }
  return targetDir;
}

const lockFree = (targetDir) => !existsSync(join(targetDir, ...LOCK)) || spawnSync("flock", ["-n", join(targetDir, ...LOCK), "true"], { encoding: "utf8" }).status === 0;
const orbitLines = (result) => result.stderr.split("\n").filter((line) => line.startsWith("Orbit repair:"));

/** The common outcome of every limit: bounded, named, nothing left, lock free. */
function expectBounded(result, targetDir, before, reason, shims) {
  expect(result.hung, `repair was still running after the test's own cap:\n${result.stderr.slice(0, 600)}`).toBe(false);
  expect(result.stdout).not.toContain(MAIL_DONE);
  expect(result.status).not.toBe(0);
  const named = orbitLines(result).filter((line) => reason.test(line));
  expect(named, `no 'Orbit repair:' line gives the reason ${reason}:\n${result.stderr.slice(0, 1500)}`).not.toEqual([]);
  expect(named.every((line) => line.length < 5000), "a line over the 4096-byte cap").toBe(true);
  expect(result.stderr.length, "the child's words were not capped").toBeLessThan(40_000);
  expect(treeSnapshot(targetDir), "something was left behind").toBe(before);
  expect(lockFree(targetDir), "the backup/restore lock is still held").toBe(true);
  shims?.cleanup();
}

const VEHICLES = {
  "the lock step (a plain owner child, root reads its stderr)": { prepared: false, match: "*make-lock*", plain: true },
  "the write step (smtp_owner_write, root reads its stdout and stderr)": { prepared: true, match: "*smtp-owner-write*", plain: false },
};

describe("#1858 T1, T2, T5: a stopped, TERM-proof or pipe-holding owner child ends the step in time", () => {
  for (const [what, vehicle] of Object.entries(VEHICLES)) {
    for (const [kind, reason] of [
      ["stop", /timed out/iu],
      ["ignore-term", /timed out/iu],
      ["grandchild", /timed out/iu],
    ]) {
      it(`${what}: a child that ${kind === "stop" ? "stops itself (SIGSTOP)" : kind === "ignore-term" ? "ignores TERM" : "leaves a grandchild holding the pipe"} is refused as timed out; a stalled child gets TERM (and KILL if it ignores TERM) and is gone`, () => {
        const targetDir = folder(vehicle);
        const shims = privShims(targetDir, { variant: { kind, match: vehicle.match } });
        const before = treeSnapshot(targetDir);
        try {
          const result = runOwner(targetDir, { shims, state: { db: "running", app: "running" }, env: LIMIT, capSeconds: STALL_CAP });
          expect(shims.setprivCalls().length, "no owner child was started").toBeGreaterThan(0);
          if (kind !== "grandchild") expectStalledStepsEnded(shims.stalledSteps(), result, STALL_SECONDS);
          expectBounded(result, targetDir, before, reason, shims);
        } finally {
          shims.cleanup();
        }
      });
    }
  }

  it("the write step: a child that floods its name output is refused as too large, and nothing is left", () => {
    const targetDir = folder({ prepared: true });
    const shims = privShims(targetDir, { variant: { kind: "flood", match: "*smtp-owner-write*" } });
    const before = treeSnapshot(targetDir);
    try {
      const result = runOwner(targetDir, { shims, state: { db: "running", app: "running" } });
      expect(shims.setprivCalls().length, "no owner child was started").toBeGreaterThan(0);
      expectBounded(result, targetDir, before, /too large|capped|4096/iu, shims);
    } finally {
      shims.cleanup();
    }
  });

  it("control: with a well-behaved owner, the step limit changes nothing", () => {
    const targetDir = folder({ prepared: true });
    const shims = privShims(targetDir);
    const result = runOwner(targetDir, { shims, state: { db: "running", app: "running" }, env: LONG_LIMIT });
    expect(result.stdout, result.stderr).toContain(MAIL_DONE);
  });
});

describe("#1858 T1: ORBIT_REPAIR_OWNER_STEP_TIMEOUT is whole seconds 1-600; anything else refuses at the start", () => {
  for (const value of ["0", "601", "-3", "1.5", "abc", "2s", "999999999999"]) {
    it(`${JSON.stringify(value)} refuses before anything runs, naming the variable, changing nothing`, () => {
      const targetDir = folder({ prepared: false });
      const shims = privShims(targetDir);
      const before = treeSnapshot(targetDir);
      const result = runOwner(targetDir, { shims, state: { db: "running", app: "running" }, env: { ORBIT_REPAIR_OWNER_STEP_TIMEOUT: value } });
      expect(result.stderr, "no refusal naming the variable").toContain("ORBIT_REPAIR_OWNER_STEP_TIMEOUT");
      expect(orbitLines(result).some((line) => line.includes("ORBIT_REPAIR_OWNER_STEP_TIMEOUT"))).toBe(true);
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toMatch(/^(execute|plan|diagnosis) /mu);
      expect(shims.setprivCalls()).toEqual([]);
      expect(treeSnapshot(targetDir)).toBe(before);
    });
  }
});

describe("#1858 T4: root reads only a regular file, at most 1 MiB, in time", () => {
  /** A `stat` shim that, once repair has read the mail overlay's mode (the file is a regular file at that point), swaps it for a FIFO. */
  function fifoSwap(targetDir) {
    const dir = scratchDir("orbit-limits-stat-");
    const overlay = join(targetDir, "docker-compose.mail.yml");
    writeFileSync(
      join(dir, "stat"),
      `#!/usr/bin/env bash\nout="$('${realTool("stat")}' "$@")" || exit $?\nif [[ "$*" == *%a* && "$*" == *docker-compose.mail.yml* ]]; then rm -f -- '${overlay}'; mkfifo '${overlay}'; fi\nprintf '%s\\n' "$out"\n`,
    );
    chmodSync(join(dir, "stat"), 0o755);
    return dir;
  }

  it("the mail overlay turned into a FIFO between the regular-file check and the read: refused as not a regular file, in time, nothing left", () => {
    const targetDir = folder({ prepared: true });
    const shims = privShims(targetDir);
    const overlay = join(targetDir, "docker-compose.mail.yml");
    const statDir = fifoSwap(targetDir);
    // The overlay is a FIFO afterwards in every outcome, so the folder is compared with it taken out of the way.
    const before = treeSnapshot(targetDir).split("\n").filter((line) => !line.startsWith("./docker-compose.mail.yml ")).join("\n");
    try {
      const result = runOwner(targetDir, { shims, state: { db: "running", app: "running" }, env: { ...LIMIT, PATH: `${statDir}:${shims.env.PATH}` } });
      expect(result.hung, "root blocked on the FIFO").toBe(false);
      expect(orbitLines(result).filter((line) => /timed out/iu.test(line)), "root blocked until a step limit stopped it").toEqual([]);
      expect(result.stdout).not.toContain(MAIL_DONE);
      expect(orbitLines(result).some((line) => /not a regular file/iu.test(line)), `no line says 'not a regular file':\n${result.stderr.slice(0, 1500)}`).toBe(true);
      expect(treeSnapshot(targetDir).split("\n").filter((line) => !line.startsWith("./docker-compose.mail.yml ")).join("\n")).toBe(before);
      expect(lockFree(targetDir)).toBe(true);
    } finally {
      // Release a reader still blocked in open() on the FIFO.
      try {
        if (existsSync(overlay)) closeSync(openSync(overlay, "r+"));
      } catch {
        // already gone
      }
      shims.cleanup();
    }
  });

  it("a mail overlay over 1 MiB is refused as too large, in time, and the folder is as it was", () => {
    const targetDir = folder({ prepared: true });
    const overlay = join(targetDir, "docker-compose.mail.yml");
    writeFileSync(overlay, `${readFileSync(overlay, "utf8")}${"# padding padding padding padding padding\n".repeat(52_000)}`);
    chmodSync(overlay, 0o640);
    expect(readFileSync(overlay).length).toBeGreaterThan(1024 * 1024);
    const shims = privShims(targetDir);
    const before = treeSnapshot(targetDir);
    const result = runOwner(targetDir, { shims, state: { db: "running", app: "running" } });
    expectBounded(result, targetDir, before, /too large/iu, shims);
  });

  it("the configuration-rollback copy over 1 MiB is refused as too large; .env-orbit and the rollback copy are left as they were", () => {
    const { targetDir, state } = ACTIONS["restore-config-rollback"].make();
    const rollback = join(targetDir, ".env-orbit.orbit-config.rollback");
    writeFileSync(rollback, `${readFileSync(rollback, "utf8")}${"# padding padding padding padding padding\n".repeat(52_000)}`);
    chmodSync(rollback, 0o600);
    const shims = privShims(targetDir);
    const before = treeSnapshot(targetDir);
    const envBefore = readFileSync(join(targetDir, ".env-orbit"));
    try {
      const result = runOwner(targetDir, { shims, state });
      expect(result.hung).toBe(false);
      expect(result.stdout).toContain("execute action=restore-transaction resolves=configuration-migration-interrupted result=failed");
      expect(orbitLines(result).some((line) => /too large/iu.test(line)), `no line says 'too large':\n${result.stderr.slice(0, 1500)}`).toBe(true);
      expect(readFileSync(join(targetDir, ".env-orbit")).equals(envBefore)).toBe(true);
      expect(existsSync(rollback)).toBe(true);
      expect(treeSnapshot(targetDir)).toBe(before);
    } finally {
      shims.cleanup();
    }
  });
});
