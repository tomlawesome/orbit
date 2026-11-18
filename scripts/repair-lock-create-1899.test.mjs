import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import { ACTIONS, runOwner } from "./repair-owner-fixtures.mjs";
import { UID, privShims, realTool } from "./repair-priv-shims.mjs";
import { composeUpCalls, makeFixture, scratchDir } from "./repair-test-harness.mjs";

// #1899 (spec: the issue body), written from the spec alone. Repair opens two locks read-write with `<>` after a
// regular-file check: the engine lock (engine_lock_idle, #1897) and the backup/restore lock (#1890). If the lock is
// removed between the check and the open, `<>` creates it. Revised by design note 64000: the race is accepted and made
// harmless. A lock the open creates is an owner-owned, mode 0600, empty lock (not root: owned by the test uid;
// simulated root: the chown shim was called with the folder owner on /dev/fd/N or /proc/self/fd/N), the action still
// refuses, and a follow-up run as the owner is not refused with "could not be opened for writing". Both sites are tested
// not root and simulated root; each test removes the lock just before the open (a BASH_ENV DEBUG hook).
//
// Chosen outcome: REFUSE (the issue says repair "refuses correctly" today, and the engine lock's open failing is
// `unwritable`, which refuses). Engine site: restore-transaction refuses, status not 0, staging kept. Backup site:
// start-services refuses with exit 4, nothing run.

vi.setConfig({ testTimeout: Math.max(PROCESS_TEST_TIMEOUT_MS, 90_000) });

const NOT_ROOT = { root: false, setpriv: false, getent: "fail" };
const STAGING = ".orbit-install-staging.abc123";
const ENGINE_LOCK = ".orbit-engine.lock";
const BACKUP_LOCK = ["backups", ".orbit-backup-restore.lock"];
const orbitLines = (result) => result.stderr.split("\n").filter((line) => line.startsWith("Orbit repair:"));
const SAME_LINE = /would change nothing/u;
const UNWRITABLE = /could not be opened for writing/u;
const FD_PATH = "/(?:dev|proc/self)/fd/\\d+";
const OWNER_CHOWN = new RegExp(`^(?:-\\S+ )*${UID}(?::\\d+)? ${FD_PATH}$`, "u");

/** If the open created the lock, it is empty, 0600 and owner-owned (simulated root: chown was called on the fd). */
function expectLeftoverIsOwnersLock(path, shims, root, label) {
  if (existsSync(path)) {
    const info = statSync(path);
    expect(info.size, `the created ${label} lock is not empty`).toBe(0);
    expect((info.mode & 0o777).toString(8), `the created ${label} lock is not mode 0600`).toBe("600");
    if (!root) expect(info.uid, `the created ${label} lock is not owned by the test uid`).toBe(UID);
  }
  if (root) {
    const calls = shims.chownCalls();
    expect(calls.some((call) => OWNER_CHOWN.test(call)), `chown was not called with the folder owner on the open descriptor; calls: ${JSON.stringify(calls)}`).toBe(true);
    // The shim runs the real chown, so a root-owned leftover cannot be produced here; the closest check is that every
    // chown of the descriptor named the folder owner (never uid 0), and that the applied owner is what the next run sees.
    for (const call of calls.filter((entry) => new RegExp(` ${FD_PATH}$`, "u").test(entry))) {
      expect(OWNER_CHOWN.test(call), `chown of the descriptor did not name the folder owner (uid ${UID}): ${call}`).toBe(true);
    }
    if (existsSync(path)) expect(statSync(path).uid, `the created ${label} lock is not owned by the folder owner after the chown`).toBe(UID);
  }
}

/** The hook swapped in a file the open did not create: repair must leave its mode and owner alone (no chmod, no chown). */
function expectSwappedFileUntouched(path, shims, root, label) {
  const info = statSync(path);
  expect((info.mode & 0o777).toString(8), `repair changed the mode of the swapped-in ${label} file`).toBe("644");
  if (root) {
    const onDescriptor = shims.chownCalls().filter((call) => new RegExp(` ${FD_PATH}$`, "u").test(call));
    expect(onDescriptor, `chown was called on the swapped-in ${label} file`).toEqual([]);
  }
}

/** A BASH_ENV hook: just before the open (`exec {fd}<`) inside `fn`, removes the lock; records that it did in `flag`. */
function removeHook(path, fn, swap = "") {
  const hook = scratchDir("orbit-1899-hook-");
  const flag = join(hook, "removed");
  writeFileSync(
    join(hook, "env.sh"),
    `set -T
__orbit_lock_remove() {
  case "\${BASH_COMMAND-}" in *'exec {fd}<'*) ;; *) return 0;; esac
  [[ " \${FUNCNAME[*]-} " == *" ${fn} "* ]] || return 0
  [[ -e '${flag}' ]] && return 0
  : > '${flag}'
  ${realTool("rm")} -f -- '${path}'
  ${swap}
  return 0
}
trap __orbit_lock_remove DEBUG
`,
  );
  return { env: { BASH_ENV: join(hook, "env.sh") }, flag };
}

/** Swap-in kinds: a non-empty regular file, and an empty one with a second hard link; both mode 0644. */
const SWAPS = {
  "a non-empty file": (path) => `printf x > '${path}' && ${realTool("chmod")} 644 '${path}'`,
  "a file with a second hard link": (path) => `: > '${path}' && ${realTool("chmod")} 644 '${path}' && ${realTool("ln")} '${path}' '${path}.second'`,
};

// --- engine lock (engine_lock_idle) -----------------------------------------------------------------------------

const MANAGED = ["docker-compose.yml", "docker-compose.mail.yml", ".env-orbit.example", "config/tika-config.json", "scripts/configure.sh", "scripts/installer-ui.sh", "scripts/backup.sh", "scripts/restore.sh", "scripts/repair.sh", "update.sh", ".env-orbit", ".orbit-secrets", ".orbit-files"];

function engineFolder() {
  const targetDir = makeFixture();
  const original = join(targetDir, STAGING, "rollback", "original");
  mkdirSync(original, { recursive: true, mode: 0o700 });
  for (const dir of [join(targetDir, STAGING), join(targetDir, STAGING, "rollback"), original]) chmodSync(dir, 0o700);
  const present = MANAGED.filter((path) => existsSync(join(targetDir, path)));
  const copied = spawnSync("cp", ["-a", "--parents", ...present, original], { cwd: targetDir, encoding: "utf8" });
  if (copied.status !== 0) throw new Error(copied.stderr);
  const path = join(targetDir, ENGINE_LOCK);
  writeFileSync(path, "", { mode: 0o600 });
  utimesSync(path, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
  return { targetDir, path };
}

describe("#1899: engine_lock_idle's open leaves only an owner's lock", () => {
  for (const [who, make] of [["not root", (dir) => privShims(dir, { extraTools: ["diff", "sha256sum"], ...NOT_ROOT })], ["simulated root", (dir) => privShims(dir, { extraTools: ["diff", "sha256sum"] })]]) {
    it(`${who}: the lock removed just before the open: any created lock is the owner's, restore-transaction is refused`, () => {
      const { targetDir, path } = engineFolder();
      const hook = removeHook(path, "engine_lock_idle");
      const shims = make(targetDir);
      try {
        const result = runOwner(targetDir, { shims, state: { db: "running", app: "running" }, args: ["--execute", "--safe-only"], input: "y\n", capSeconds: 40, env: hook.env });
        expect(existsSync(hook.flag), "the removal did not happen, so the test proves nothing").toBe(true);
        expect(result.hung).toBe(false);
        expectLeftoverIsOwnersLock(path, shims, who === "simulated root", "engine");
        expect(result.stderr, "a missing lock was taken as idle").not.toMatch(SAME_LINE);
        expect(orbitLines(result).some((line) => line.includes("refusing restore-transaction")), `no refusal line:\n${result.stderr.slice(0, 1500)}`).toBe(true);
        expect(result.status).not.toBe(0);
        expect(existsSync(join(targetDir, STAGING)), "the staging folder was removed").toBe(true);
        const again = runOwner(targetDir, { shims, state: { db: "running", app: "running" }, args: ["--execute", "--safe-only"], input: "y\n", capSeconds: 40 });
        expect(again.hung).toBe(false);
        expect(again.stderr, "the owner's next run was refused by the leftover lock").not.toMatch(UNWRITABLE);
      } finally {
        shims.cleanup();
      }
    });
  }
});

describe("#1899: engine_lock_idle's guard leaves a swapped-in file alone", () => {
  for (const [who, make] of [["not root", (dir) => privShims(dir, { extraTools: ["diff", "sha256sum"], ...NOT_ROOT })], ["simulated root", (dir) => privShims(dir, { extraTools: ["diff", "sha256sum"] })]]) {
    for (const [kind, swap] of Object.entries(SWAPS)) {
      it(`${who}: ${kind} swapped in at the open: no chmod, no chown, restore-transaction still refused`, () => {
        const { targetDir, path } = engineFolder();
        const hook = removeHook(path, "engine_lock_idle", swap(path));
        const shims = make(targetDir);
        try {
          const result = runOwner(targetDir, { shims, state: { db: "running", app: "running" }, args: ["--execute", "--safe-only"], input: "y\n", capSeconds: 40, env: hook.env });
          expect(existsSync(hook.flag), "the swap did not happen, so the test proves nothing").toBe(true);
          expect(result.hung).toBe(false);
          expectSwappedFileUntouched(path, shims, who === "simulated root", "engine");
          expect(orbitLines(result).some((line) => line.includes("refusing restore-transaction")), `no refusal line:\n${result.stderr.slice(0, 1500)}`).toBe(true);
          expect(result.status).not.toBe(0);
        } finally {
          shims.cleanup();
        }
      });
    }
  }
});

// --- backup/restore lock (probe_backup_restore_lock) -------------------------------------------------------------

describe("#1899: probe_backup_restore_lock's open leaves only an owner's lock", () => {
  const start = ACTIONS["start-services"];
  for (const [who, shimOptions] of [["not root", NOT_ROOT], ["simulated root", {}]]) {
    it(`${who}: the lock removed just before the open: any created lock is the owner's, start-services is refused with exit 4`, () => {
      const { targetDir, state } = start.make();
      mkdirSync(join(targetDir, BACKUP_LOCK[0]), { mode: 0o700, recursive: true });
      const path = join(targetDir, ...BACKUP_LOCK);
      writeFileSync(path, "", { mode: 0o600 });
      const hook = removeHook(path, "probe_backup_restore_lock");
      const shims = privShims(targetDir, shimOptions);
      try {
        const result = runOwner(targetDir, { shims, state, env: hook.env, capSeconds: 20 });
        expect(existsSync(hook.flag), "the removal did not happen, so the test proves nothing").toBe(true);
        expect(result.hung).toBe(false);
        expectLeftoverIsOwnersLock(path, shims, who === "simulated root", "backup/restore");
        expect(result.stdout).not.toContain(start.done);
        expect(result.status, result.stderr.slice(0, 1500)).toBe(4);
        expect(orbitLines(result).some((line) => line.includes("start-services refused, nothing was changed:") && line.includes(path)), `no refusal line:\n${result.stderr.slice(0, 1500)}`).toBe(true);
        expect(composeUpCalls(result)).toEqual([]);
        const again = runOwner(targetDir, { shims, state, capSeconds: 20 });
        expect(again.hung).toBe(false);
        expect(again.stderr, "the owner's next run was refused by the leftover lock").not.toMatch(UNWRITABLE);
      } finally {
        shims.cleanup();
      }
    });
  }
});

describe("#1899: probe_backup_restore_lock's guard leaves a swapped-in file alone", () => {
  const start = ACTIONS["start-services"];
  for (const [who, shimOptions] of [["not root", NOT_ROOT], ["simulated root", {}]]) {
    for (const [kind, swap] of Object.entries(SWAPS)) {
      it(`${who}: ${kind} swapped in at the open: no chmod, no chown, start-services still refused with exit 4`, () => {
        const { targetDir, state } = start.make();
        mkdirSync(join(targetDir, BACKUP_LOCK[0]), { mode: 0o700, recursive: true });
        const path = join(targetDir, ...BACKUP_LOCK);
        writeFileSync(path, "", { mode: 0o600 });
        const hook = removeHook(path, "probe_backup_restore_lock", swap(path));
        const shims = privShims(targetDir, shimOptions);
        try {
          const result = runOwner(targetDir, { shims, state, env: hook.env, capSeconds: 20 });
          expect(existsSync(hook.flag), "the swap did not happen, so the test proves nothing").toBe(true);
          expect(result.hung).toBe(false);
          expectSwappedFileUntouched(path, shims, who === "simulated root", "backup/restore");
          expect(result.stdout).not.toContain(start.done);
          expect(result.status, result.stderr.slice(0, 1500)).toBe(4);
          expect(composeUpCalls(result)).toEqual([]);
        } finally {
          shims.cleanup();
        }
      });
    }
  }
});
