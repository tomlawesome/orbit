import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runOwner } from "./repair-owner-fixtures.mjs";
import { privShims, realTool } from "./repair-priv-shims.mjs";
import { makeFixture, scratchDir } from "./repair-test-harness.mjs";

// #1897 (spec: note 63862 on the issue, T1-T3; T4, the docs, is not tested), written from the spec alone, on the
// #1857 simulated-root shims and the #1887 / #1890 helpers. In restore_transaction_originals_match_live:
//   T1  as root, the tree-mode `find` over the owner's live tree runs as the owner under the owner-step timeout; a
//       time-out, a flood, a failed `cd`/`find` or a live path that stopped being a directory is "cannot check",
//       never "same"; the listing pipeline fails if any part of it fails (also when not root, T3).
//   T2  engine_lock_idle opens .orbit-engine.lock read-write only: a FIFO swapped in after the -f check refuses at
//       once, a lock that cannot be opened for writing (0444) refuses with the #1890 words.
//   T3  not root: the listing is unchanged but for pipefail; a writable idle lock behaves as before.

vi.setConfig({ testTimeout: 90_000 });

const isRoot = process.getuid?.() === 0;
const LIMIT = { ORBIT_REPAIR_OWNER_STEP_TIMEOUT: "2" };
const BUDGET_MS = 30_000;
const RUNNING = { db: "running", app: "running" };
const SAME_LINE = /would change nothing/u;
const UNWRITABLE = /could not be opened for writing/u;
const STAGING = ".orbit-install-staging.abc123";
const LOCK = ".orbit-engine.lock";
const MANAGED = ["docker-compose.yml", "docker-compose.mail.yml", ".env-orbit.example", "config/tika-config.json", "scripts/configure.sh", "scripts/installer-ui.sh", "scripts/backup.sh", "scripts/restore.sh", "scripts/repair.sh", "update.sh", ".env-orbit", ".orbit-secrets", ".orbit-files"];

const shimsFor = (targetDir, options = {}) => privShims(targetDir, { extraTools: ["diff", "sha256sum"], ...options });
const notRoot = (targetDir, options = {}) => shimsFor(targetDir, { root: false, setpriv: false, getent: "fail", ...options });
const orbitLines = (result) => result.stderr.split("\n").filter((line) => line.startsWith("Orbit repair:"));
const setprivNaming = (shims, re) => shims.setprivCalls().filter((line) => re.test(line));

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

/** A staging folder whose saved originals are every managed file the folder has, byte for byte and mode for mode (as in the #1887 tests). */
function identicalFolder() {
  const targetDir = makeFixture();
  const staging = join(targetDir, STAGING);
  const original = join(staging, "rollback", "original");
  mkdirSync(original, { recursive: true, mode: 0o700 });
  for (const dir of [staging, join(staging, "rollback"), original]) chmodSync(dir, 0o700);
  const present = MANAGED.filter((path) => existsSync(join(targetDir, path)));
  const copied = spawnSync("cp", ["-a", "--parents", ...present, original], { cwd: targetDir, encoding: "utf8" });
  if (copied.status !== 0) throw new Error(copied.stderr);
  return { targetDir, state: { ...RUNNING } };
}

const restore = (shims, folder, options = {}) => runOwner(folder.targetDir, { shims, state: folder.state, args: ["--execute", "--safe-only"], input: "y\n", capSeconds: 40, ...options });

/**
 * A `diff` in front of the real one: for the .orbit-secrets compare (the last call before the tree-mode listing) it
 * replaces the live .orbit-secrets folder with a regular file and reports "no difference", i.e. the live path is
 * swapped to a non-directory after repair's -d check. It writes <dir>/swapped when it does the swap (the folder's final
 * state cannot show it: restore-transaction puts the saved folder back). Every other diff runs for real.
 */
function swapDiff(targetDir) {
  const dir = scratchDir("orbit-1897-diff-");
  writeFileSync(
    join(dir, "diff"),
    `#!/usr/bin/env bash\ncase "$*" in *.orbit-secrets*) ${realTool("rm")} -rf -- '${join(targetDir, ".orbit-secrets")}' && : > '${join(targetDir, ".orbit-secrets")}' && : > '${join(dir, "swapped")}'; exit 0;; esac\nexec '${realTool("diff")}' "$@"\n`,
  );
  chmodSync(join(dir, "diff"), 0o755);
  return dir;
}

/** The saved .orbit-secrets is empty, so a live path that is no longer a directory lists as empty too. */
function emptySavedSecrets(folder) {
  const saved = join(folder.targetDir, STAGING, "rollback", "original", ".orbit-secrets");
  for (const name of readdirSync(saved)) rmSync(join(saved, name), { recursive: true, force: true });
}

// --- T1: the tree-mode listing as the owner ---------------------------------------------------------------------------

describe("#1897 T1: as root, the tree-mode listing of the owner's live tree runs as the owner, bounded; a failure is never 'same'", () => {
  it("an identical tree is 'same'; the live listing went through setpriv and root ran none over the live tree", () => {
    const folder = identicalFolder();
    const shims = shimsFor(folder.targetDir);
    const result = restore(shims, folder);
    expect(result.stderr, result.stdout).toMatch(SAME_LINE);
    expect(setprivNaming(shims, /find/u), "the tree-mode find never went through setpriv").not.toEqual([]);
  });

  for (const [kind, reason] of [["stop", /timed out/iu], ["flood", /./u]]) {
    it(`a find that ${kind === "stop" ? "stalls is timed out" : "floods its output fails"}: 'cannot check', never 'same', within the step limit plus grace`, () => {
      const folder = identicalFolder();
      const shims = shimsFor(folder.targetDir, { variant: { kind, match: "*find*" } });
      try {
        const result = restore(shims, folder, { env: LIMIT });
        expect(setprivNaming(shims, /find/u), "the tree-mode find never went through setpriv").not.toEqual([]);
        expect(result.hung, "repair was still running after the test's own cap").toBe(false);
        expect(result.ms, "repair outlived the step limit plus the kill grace").toBeLessThan(BUDGET_MS);
        expect(result.stderr, "a listing that did not finish was compared as the same").not.toMatch(SAME_LINE);
        expect(orbitLines(result).some((line) => reason.test(line)), `no 'Orbit repair:' line ${reason}:\n${result.stderr.slice(0, 1200)}`).toBe(true);
      } finally {
        shims.cleanup();
      }
    });
  }

  it("a find that fails as the owner (any error) is 'cannot check', never 'same'", () => {
    const folder = identicalFolder();
    const shims = shimsFor(folder.targetDir, { setprivFail: "*find*" });
    const result = restore(shims, folder);
    expect(setprivNaming(shims, /find/u), "the tree-mode find never went through setpriv").not.toEqual([]);
    expect(result.stderr, "a failed listing was compared as the same").not.toMatch(SAME_LINE);
  });

  it("the live path swapped to a file after the -d check, with an empty saved folder, is not 'same' (root)", () => {
    const folder = identicalFolder();
    emptySavedSecrets(folder);
    const shims = shimsFor(folder.targetDir);
    const swapDir = swapDiff(folder.targetDir);
    const result = restore(shims, folder, { env: { PATH: `${swapDir}:${shims.env.PATH}` } });
    expect(result.hung).toBe(false);
    expect(existsSync(join(swapDir, "swapped")), "the swap did not happen, so the test proves nothing").toBe(true);
    expect(result.stderr, "a live path that is not a directory listed as empty and compared as the same").not.toMatch(SAME_LINE);
  });
});

/** Saved and live .orbit-secrets both hold a folder `sub`; the live one is then chmod-ed, so only a mode differs (repair puts the known secret files back to 0600 itself, so a file there would not do). */
function modeOnlyDifference(folder) {
  const saved = join(folder.targetDir, STAGING, "rollback", "original", ".orbit-secrets", "sub");
  const live = join(folder.targetDir, ".orbit-secrets", "sub");
  for (const dir of [saved, live]) {
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
  }
  chmodSync(live, 0o700);
}

// --- T3: not root ------------------------------------------------------------------------------------------------------

describe("#1897 T3: not root, the listing is unchanged but for pipefail", () => {
  it("the live path swapped to a file after the -d check, with an empty saved folder, is not 'same'", () => {
    const folder = identicalFolder();
    emptySavedSecrets(folder);
    const shims = notRoot(folder.targetDir);
    const swapDir = swapDiff(folder.targetDir);
    const result = restore(shims, folder, { env: { PATH: `${swapDir}:${shims.env.PATH}` } });
    expect(result.hung).toBe(false);
    expect(existsSync(join(swapDir, "swapped")), "the swap did not happen, so the test proves nothing").toBe(true);
    expect(result.stderr, "a live path that is not a directory listed as empty and compared as the same").not.toMatch(SAME_LINE);
  });

  it("an identical tree is 'same', find run directly, no setpriv (pin)", () => {
    const folder = identicalFolder();
    const shims = notRoot(folder.targetDir);
    const result = restore(shims, folder);
    expect(result.stderr, result.stdout).toMatch(SAME_LINE);
    expect(shims.setprivCalls()).toEqual([]);
    expect(existsSync(join(folder.targetDir, STAGING))).toBe(false);
  });

  it("a live tree whose only difference is a file mode is not 'same' (pin)", () => {
    const folder = identicalFolder();
    modeOnlyDifference(folder);
    const result = restore(notRoot(folder.targetDir), folder);
    expect(result.hung).toBe(false);
    expect(result.stderr).not.toMatch(SAME_LINE);
  });

  it("a live tree whose only difference is a file mode is not 'same' (root, pin)", () => {
    const folder = identicalFolder();
    modeOnlyDifference(folder);
    const result = restore(shimsFor(folder.targetDir), folder);
    expect(result.hung).toBe(false);
    expect(result.stderr).not.toMatch(SAME_LINE);
  });
});

// --- T2: the engine lock is opened read-write only -----------------------------------------------------------------------

/** An engine lock older than the stale age (ten minutes), so engine_lock_idle goes on to open it. */
function plantEngineLock(targetDir, mode = 0o600) {
  const path = join(targetDir, LOCK);
  writeFileSync(path, "", { mode: 0o600 });
  chmodSync(path, mode);
  utimesSync(path, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
  restores.push([path, 0o600]);
  return path;
}

/** A BASH_ENV hook that swaps the lock for a FIFO just before engine_lock_idle's open (after its -f check), and records the swap and the open's return. */
function fifoSwapHook(path) {
  const hook = scratchDir("orbit-1897-hook-");
  const flag = join(hook, "swapped");
  const opened = join(hook, "opened");
  writeFileSync(
    join(hook, "env.sh"),
    `set -T
__orbit_lock_swap() {
  if [[ -e '${flag}' && ! -e '${opened}' && " \${FUNCNAME[*]-} " == *" engine_lock_idle "* ]]; then
    printf '%s' "\$EPOCHREALTIME" > '${opened}'
    return 0
  fi
  case "\${BASH_COMMAND-}" in *'exec {fd}<'*) ;; *) return 0;; esac
  [[ " \${FUNCNAME[*]-} " == *" engine_lock_idle "* ]] || return 0
  [[ -e '${flag}' ]] && return 0
  printf '%s' "\$EPOCHREALTIME" > '${flag}'
  ${realTool("rm")} -f -- '${path}'; ${realTool("mkfifo")} '${path}'
  return 0
}
trap __orbit_lock_swap DEBUG
`,
  );
  return { env: { BASH_ENV: join(hook, "env.sh") }, flag, opened };
}

const releaseFifo = (path) => {
  try {
    if (existsSync(path) && lstatSync(path).isFIFO()) closeSync(openSync(path, "r+"));
  } catch {
    // already gone
  }
};
const openMs = (flag, opened) => (existsSync(opened) ? (Number(readFileSync(opened, "utf8")) - Number(readFileSync(flag, "utf8"))) * 1000 : Infinity);

describe.skipIf(isRoot)("#1897 T2/T3: engine_lock_idle opens .orbit-engine.lock read-write only", () => {
  for (const [who, make] of [["not root", notRoot], ["simulated root", shimsFor]]) {
    it(`${who}: a FIFO swapped in after the -f check refuses within 5 s and never hangs`, () => {
      const folder = identicalFolder();
      const path = plantEngineLock(folder.targetDir);
      const hook = fifoSwapHook(path);
      const shims = make(folder.targetDir);
      try {
        const result = restore(shims, folder, { env: hook.env, capSeconds: 15 });
        expect(existsSync(hook.flag), "the swap did not happen, so the test proves nothing").toBe(true);
        expect(result.hung, "repair blocked opening the FIFO").toBe(false);
        expect(openMs(hook.flag, hook.opened), "the lock open waited").toBeLessThan(5_000);
        expect(result.stderr, "a FIFO lock was taken as idle").not.toMatch(SAME_LINE);
        expect(orbitLines(result).some((line) => UNWRITABLE.test(line)), `no refusal naming the cause:\n${result.stderr.slice(0, 1500)}`).toBe(true);
        expect(result.status).not.toBe(0);
      } finally {
        releaseFifo(path);
        shims.cleanup();
      }
    });

    it(`${who}: a read-only (0444) lock is not taken as idle: refused with the unwritable words, staging kept`, () => {
      const folder = identicalFolder();
      const path = plantEngineLock(folder.targetDir, 0o444);
      const shims = make(folder.targetDir);
      try {
        const result = restore(shims, folder);
        expect(result.hung).toBe(false);
        expect(result.stderr, "a lock that could not be opened for writing was taken as idle").not.toMatch(SAME_LINE);
        expect(orbitLines(result).some((line) => UNWRITABLE.test(line)), `no refusal naming the cause:\n${result.stderr.slice(0, 1500)}`).toBe(true);
        expect(result.status).not.toBe(0);
        expect(existsSync(join(folder.targetDir, STAGING)), "the staging folder was removed").toBe(true);
        expect(statSync(path).mode & 0o777).toBe(0o444);
      } finally {
        shims.cleanup();
      }
    });
  }

  it("a writable, idle lock is taken as idle and left as it was (pin)", () => {
    const folder = identicalFolder();
    const path = plantEngineLock(folder.targetDir);
    const before = { bytes: readFileSync(path).toString("hex"), st: statSync(path) };
    const shims = notRoot(folder.targetDir);
    const result = restore(shims, folder);
    expect(result.stderr, result.stdout).toMatch(SAME_LINE);
    expect(existsSync(join(folder.targetDir, STAGING))).toBe(false);
    const st = statSync(path);
    expect(readFileSync(path).toString("hex")).toBe(before.bytes);
    expect([st.size, st.mode, st.mtimeMs, st.ino]).toEqual([before.st.size, before.st.mode, before.st.mtimeMs, before.st.ino]);
  });

  it("a fresh lock (younger than ten minutes) is not idle: not skipped as changing nothing (pin)", () => {
    const folder = identicalFolder();
    const path = join(folder.targetDir, LOCK);
    writeFileSync(path, "", { mode: 0o600 });
    const result = restore(notRoot(folder.targetDir), folder);
    expect(result.stderr).not.toMatch(SAME_LINE);
  });
});
