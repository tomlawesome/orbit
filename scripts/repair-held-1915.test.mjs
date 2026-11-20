import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ACTIONS, runOwner } from "./repair-owner-fixtures.mjs";
import { UID, privShims, realTool } from "./repair-priv-shims.mjs";
import { composeUpCalls, makeFixture, scratchDir } from "./repair-test-harness.mjs";

// #1915 (held items, repair.sh): O-F8/O-F10 leftover discards cleared on an empty dangerous batch, O-S1 a recovery
// folder that cannot be removed is named, O-S2 and O-R2 a rename that timed out but landed is done, SEC-O3 names are
// cleaned of terminal control characters, O-F11 the checkpoint temp file shape is removable. Written from the
// findings alone; root is simulated by the setpriv shim.

vi.setConfig({ testTimeout: 90_000 });

const LIMIT = { ORBIT_REPAIR_OWNER_STEP_TIMEOUT: "2" };
const RUNNING = { db: "running", app: "running" };
const orbitLines = (result) => result.stderr.split("\n").filter((line) => line.startsWith("Orbit repair:"));
const names = (dir, prefix) => readdirSync(dir).filter((entry) => entry.startsWith(prefix));

function leftoverDiscard(targetDir, name = ".orbit-repair-discard.abc123") {
  const original = join(targetDir, name, "rollback", "original");
  mkdirSync(original, { recursive: true, mode: 0o700 });
  writeFileSync(join(original, "docker-compose.mail.yml"), "services: {}\n");
}

function withStubs(targetDir, stubs, opts = { root: false }) {
  const shims = privShims(targetDir, opts);
  const dir = scratchDir("orbit-held-stubs-");
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return { ...shims, env: { ...shims.env, PATH: `${dir}:${shims.env.PATH}` } };
}

describe("#1915 O-F8 / O-F10: --dangerous with nothing to do still clears leftover discards", () => {
  it("a healthy folder, --execute --dangerous: a leftover .orbit-repair-discard.* is removed and reported", () => {
    const targetDir = makeFixture();
    leftoverDiscard(targetDir);
    const result = runOwner(targetDir, { shims: privShims(targetDir, { root: false }), state: { ...RUNNING }, args: ["--execute", "--dangerous"], capSeconds: 60 });
    expect(result.stdout, result.stderr).toContain("dangerous result=empty");
    expect(names(targetDir, ".orbit-repair-discard."), "the leftover discard folder is still there").toEqual([]);
    expect(result.stderr).toContain("which an earlier repair run left part removed");
  });

  it("--safe-only --dangerous, the operator declines the safe batch and the dangerous set is empty: the discard is kept", () => {
    const targetDir = makeFixture();
    // A safe action is on the table, so the confirmation is really asked.
    chmodSync(join(targetDir, ".orbit-secrets", "postgres-password"), 0o644);
    leftoverDiscard(targetDir);
    const result = runOwner(targetDir, { shims: privShims(targetDir, { root: false }), state: { ...RUNNING }, args: ["--execute", "--safe-only", "--dangerous"], input: "\n", capSeconds: 60 });
    expect(result.stdout, result.stderr).toContain("execution result=declined");
    expect(result.stdout, result.stderr).toContain("dangerous result=empty");
    expect(names(targetDir, ".orbit-repair-discard."), "a declined run removed the leftover discard folder").toEqual([".orbit-repair-discard.abc123"]);
    expect(result.stderr).not.toContain("which an earlier repair run left part removed");
  });

  it("the same run without --dangerous removes it (control)", () => {
    const targetDir = makeFixture();
    leftoverDiscard(targetDir);
    runOwner(targetDir, { shims: privShims(targetDir, { root: false }), state: { ...RUNNING }, args: ["--execute", "--safe-only"], capSeconds: 60 });
    expect(names(targetDir, ".orbit-repair-discard.")).toEqual([]);
  });
});

describe("#1915 O-S1: a recovery folder that cannot be removed is named", () => {
  // rm that refuses (and removes nothing) for a recovery folder.
  const RM_REFUSES = `for a in "$@"; do case "$a" in *orbit-repair-recovery*) echo "rm: cannot remove: Input/output error" >&2; exit 1;; esac; done
exec '${realTool("rm")}' "$@"`;

  it("restore-config-rollback (the owner's recovery folder): the folder left behind is named on an \"Orbit repair:\" line", () => {
    const { targetDir, state, fakeBin } = ACTIONS["restore-config-rollback"].make();
    const result = runOwner(targetDir, { shims: withStubs(targetDir, { rm: RM_REFUSES }), state, fakeBin });
    const left = names(targetDir, ".orbit-repair-recovery.");
    expect(left.length, "no recovery folder remained, so the test proves nothing").toBeGreaterThan(0);
    for (const folder of left) {
      expect(orbitLines(result).some((line) => line.includes(folder)), `no 'Orbit repair:' line names ${folder}:\n${result.stderr.slice(0, 1500)}`).toBe(true);
    }
  });

  it("restore-transaction (the second recovery folder): the folder left behind is named on an \"Orbit repair:\" line", () => {
    const targetDir = makeFixture();
    const original = join(targetDir, ".orbit-install-staging.abc123", "rollback", "original");
    mkdirSync(original, { recursive: true, mode: 0o700 });
    for (const dir of [join(targetDir, ".orbit-install-staging.abc123"), join(targetDir, ".orbit-install-staging.abc123", "rollback"), original]) chmodSync(dir, 0o700);
    writeFileSync(join(original, ".env-orbit"), "APP_URL=https://orbit.old-good-state.internal\nCOMPOSE_PROJECT_NAME=repairtest\n", { mode: 0o600 });
    writeFileSync(join(original, "docker-compose.yml"), "services:\n  orbit-app:\n    image: old-good\n");
    writeFileSync(join(targetDir, "docker-compose.mail.yml"), "services: {}\n");
    const result = runOwner(targetDir, { shims: withStubs(targetDir, { rm: RM_REFUSES }), state: { ...RUNNING }, capSeconds: 60 });
    const left = names(targetDir, ".orbit-repair-recovery.");
    expect(left.length, `no recovery folder remained, so the test proves nothing:\n${result.stderr.slice(0, 1500)}`).toBeGreaterThan(0);
    for (const folder of left) {
      expect(orbitLines(result).some((line) => line.includes(folder)), `no 'Orbit repair:' line names ${folder}:\n${result.stderr.slice(0, 1500)}`).toBe(true);
    }
  });
});

describe("#1915 O-S2: discard_staging_root counts a timed-out rename that landed as done", () => {
  const STAGING = ".orbit-install-staging.abc123";
  const DONE = "execute action=restore-transaction resolves=staging-evidence-present result=done";
  const FAILED = DONE.replace("result=done", "result=failed");

  function stagingFolder(name = STAGING, discardName = null) {
    const targetDir = makeFixture();
    const original = join(targetDir, name, "rollback", "original");
    mkdirSync(original, { recursive: true, mode: 0o700 });
    for (const dir of [join(targetDir, name), join(targetDir, name, "rollback"), original]) chmodSync(dir, 0o700);
    writeFileSync(join(original, ".env-orbit"), "APP_URL=https://orbit.old-good-state.internal\nCOMPOSE_PROJECT_NAME=repairtest\n", { mode: 0o600 });
    writeFileSync(join(original, "docker-compose.yml"), "services:\n  orbit-app:\n    image: old-good\n");
    writeFileSync(join(targetDir, "docker-compose.mail.yml"), "services: {}\n");
    if (discardName) writeFileSync(join(targetDir, discardName), "in the way\n");
    return { targetDir, state: { ...RUNNING } };
  }

  it("the owner's rename lands and then stalls past the limit: the step is done, the staging name is gone", () => {
    const folder = stagingFolder();
    const shims = privShims(folder.targetDir, { variant: { kind: "run-then-stop", match: "*mv*-n*-T*orbit-install-staging*" } });
    try {
      const result = runOwner(folder.targetDir, { shims, state: folder.state, env: LIMIT, capSeconds: 40 });
      expect(shims.setprivCalls().some((line) => /mv\s+-n\s+-T/u.test(line)), "the owner's rename never ran").toBe(true);
      expect(result.hung, result.stderr.slice(0, 600)).toBe(false);
      expect(result.stdout, `the landed rename was reported failed:\n${result.stderr.slice(0, 1500)}`).not.toContain(FAILED);
      expect(result.stdout, result.stderr.slice(0, 1500)).toContain(DONE);
      expect(names(folder.targetDir, ".orbit-install-staging.")).toEqual([]);
    } finally {
      shims.cleanup();
    }
  });

  it("pin: a rename that timed out without landing is still failed", () => {
    const folder = stagingFolder();
    const shims = privShims(folder.targetDir, { variant: { kind: "stop", match: "*mv*-n*-T*orbit-install-staging*" } });
    try {
      const result = runOwner(folder.targetDir, { shims, state: folder.state, env: LIMIT, capSeconds: 40 });
      expect(result.stdout).not.toContain(DONE);
      expect(names(folder.targetDir, ".orbit-install-staging.")).toEqual([STAGING]);
    } finally {
      shims.cleanup();
    }
  });
});

describe("#1915 O-R2: a config-rollback restore whose rename timed out but landed is done", () => {
  const action = ACTIONS["restore-config-rollback"];

  it("the owner's mv -fT lands and then stalls: reported done, .env-orbit is a regular file, the staged name is gone", () => {
    const { targetDir, state } = action.make();
    const shims = privShims(targetDir, { variant: { kind: "run-then-stop", match: "*mv*-fT*" } });
    try {
      const result = runOwner(targetDir, { shims, state, env: LIMIT, capSeconds: 40 });
      expect(shims.setprivCalls().some((line) => /mv\s+-fT/u.test(line)), "the owner's mv was never run").toBe(true);
      expect(result.hung, result.stderr.slice(0, 600)).toBe(false);
      expect(result.stdout, `the landed restore was reported failed:\n${result.stderr.slice(0, 1500)}`).not.toContain(action.done.replace("result=done", "result=failed"));
      expect(result.stdout, result.stderr.slice(0, 1500)).toContain(action.done);
      expect(lstatSync(join(targetDir, ".env-orbit")).isFile()).toBe(true);
      expect(names(targetDir, ".env-orbit.repair-restore.")).toEqual([]);
    } finally {
      shims.cleanup();
    }
  });

  it("pin: a timed-out mv that did not land is still failed", () => {
    const { targetDir, state } = action.make();
    const shims = privShims(targetDir, { variant: { kind: "stop", match: "*mv*-fT*" } });
    try {
      const result = runOwner(targetDir, { shims, state, env: LIMIT, capSeconds: 40 });
      expect(result.stdout).not.toContain(action.done);
    } finally {
      shims.cleanup();
    }
  });
});

describe("#1915 SEC-O3: discard_staging_root's messages clean the names", () => {
  it("a staging name with a control sequence prints cleaned, in the 'in the way' line", () => {
    const targetDir = makeFixture();
    const staging = ".orbit-install-staging.ab\x1b[31mcd";
    const discard = ".orbit-repair-discard.ab\x1b[31mcd";
    const original = join(targetDir, staging, "rollback", "original");
    mkdirSync(original, { recursive: true, mode: 0o700 });
    for (const dir of [join(targetDir, staging), join(targetDir, staging, "rollback"), original]) chmodSync(dir, 0o700);
    writeFileSync(join(original, ".env-orbit"), "APP_URL=https://orbit.old-good-state.internal\nCOMPOSE_PROJECT_NAME=repairtest\n", { mode: 0o600 });
    writeFileSync(join(original, "docker-compose.yml"), "services:\n  orbit-app:\n    image: old-good\n");
    writeFileSync(join(targetDir, "docker-compose.mail.yml"), "services: {}\n");
    writeFileSync(join(targetDir, discard), "in the way\n");
    const result = runOwner(targetDir, { shims: privShims(targetDir, { root: false }), state: { ...RUNNING }, capSeconds: 60 });
    expect(existsSync(join(targetDir, discard)), "the discard name was not left in the way, so the test proves nothing").toBe(true);
    const lines = result.stderr.split("\n").filter((line) => line.includes("could not be removed:"));
    expect(lines.length, result.stderr.slice(0, 1500)).toBeGreaterThan(0);
    expect(lines.join("\n"), "an escape character reached the terminal").not.toContain("\x1b");
    expect(lines.join("\n")).toContain(".orbit-install-staging.abcd could not be removed: .orbit-repair-discard.abcd is in the way");
  });
});

describe("#1915 O-F11: a checkpoint folder holding the bundle's temp file is removed", () => {
  const checkpoints = (targetDir) => names(targetDir, ".orbit-repair-checkpoint.");
  for (const leftover of ["postgres-password.orbkek.AbC123", "postgres-password.orbkek"]) {
    it(`a clean --execute removes a checkpoint holding ${leftover}`, () => {
      const targetDir = makeFixture();
      const dir = join(targetDir, ".orbit-repair-checkpoint.zzzzzz");
      mkdirSync(dir, { mode: 0o700 });
      writeFileSync(join(dir, leftover), "bundle\n", { mode: 0o600 });
      const result = runOwner(targetDir, { shims: privShims(targetDir, { root: false }), state: { ...RUNNING }, capSeconds: 60 });
      expect(result.status, result.stderr).toBe(0);
      expect(checkpoints(targetDir), result.stderr.slice(0, 1500)).toEqual([]);
    });
  }
});

// SEC-O3, the "was kept" line of remove_leftover_discards prints the same untrusted name.
describe("#1915 SEC-O3: remove_leftover_discards' 'was kept' line cleans the name", () => {
  it("a leftover .orbit-repair-discard.* that is a file, with a control sequence in its name, is named cleaned", () => {
    const targetDir = makeFixture();
    writeFileSync(join(targetDir, ".orbit-repair-discard.ab\x1b[31mcd"), "not a folder\n");
    const result = runOwner(targetDir, { shims: privShims(targetDir, { root: false }), state: { ...RUNNING }, capSeconds: 60 });
    const lines = result.stderr.split("\n").filter((line) => line.includes("was kept: it is not a folder repair made"));
    expect(lines.length, result.stderr.slice(0, 1500)).toBe(1);
    expect(lines[0], "an escape character reached the terminal").not.toContain("\x1b");
    expect(lines[0]).toContain("./.orbit-repair-discard.abcd was kept");
  });
});

// --- O-S3 (ruling, note 66727): engine_lock_idle removes the empty lock its own open created ---------------------------

describe("#1915 O-S3: an engine lock that vanishes before repair's open is not left behind empty", () => {
  const STAGING = ".orbit-install-staging.abc123";
  const MANAGED = ["docker-compose.yml", "docker-compose.mail.yml", ".env-orbit.example", "config/tika-config.json", "scripts/configure.sh", "scripts/installer-ui.sh", "scripts/backup.sh", "scripts/restore.sh", "scripts/repair.sh", "update.sh", ".env-orbit", ".orbit-secrets", ".orbit-files"];
  const VANISHED = "Orbit repair: the engine lock .orbit-engine.lock vanished while repair was checking it (an install or update just finished) and repair's open created an empty one in its place; repair removed that file again, so no install waits on it; run repair again.";

  function engineFolder() {
    const targetDir = makeFixture();
    const original = join(targetDir, STAGING, "rollback", "original");
    mkdirSync(original, { recursive: true, mode: 0o700 });
    for (const dir of [join(targetDir, STAGING), join(targetDir, STAGING, "rollback"), original]) chmodSync(dir, 0o700);
    const present = MANAGED.filter((path) => existsSync(join(targetDir, path)));
    const copied = spawnSync("cp", ["-a", "--parents", ...present, original], { cwd: targetDir, encoding: "utf8" });
    if (copied.status !== 0) throw new Error(copied.stderr);
    const path = join(targetDir, ".orbit-engine.lock");
    writeFileSync(path, "", { mode: 0o600 });
    utimesSync(path, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    return { targetDir, path };
  }

  /** BASH_ENV hook (the #1899 seam): just before `exec {fd}<` inside `fn`, removes the lock; the flag file records it. */
  function removeHook(path, fn) {
    const hook = scratchDir("orbit-1915-hook-");
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
  return 0
}
trap __orbit_lock_remove DEBUG
`,
    );
    return { env: { BASH_ENV: join(hook, "env.sh") }, flag };
  }

  for (const [who, opts] of [["not root", { root: false, setpriv: false, getent: "fail" }], ["simulated root", {}]]) {
    it(`${who}: the created empty lock is removed, the run refuses as unwritable, and the vanished line is printed`, () => {
      const { targetDir, path } = engineFolder();
      const hook = removeHook(path, "engine_lock_idle");
      const shims = privShims(targetDir, { extraTools: ["diff", "sha256sum"], ...opts });
      try {
        const result = runOwner(targetDir, { shims, state: { ...RUNNING }, args: ["--execute", "--safe-only"], capSeconds: 40, env: hook.env });
        expect(existsSync(hook.flag), "the removal did not happen, so the test proves nothing").toBe(true);
        expect(result.hung).toBe(false);
        expect(existsSync(path), "the empty lock repair's open created is still there").toBe(false);
        expect(result.stderr.split("\n"), result.stderr.slice(0, 1500)).toContain(VANISHED);
        expect(orbitLines(result).some((line) => line.includes("refusing restore-transaction") && line.includes("could not be opened for writing")), "not refused as unwritable").toBe(true);
        expect(result.status).not.toBe(0);
        expect(existsSync(join(targetDir, STAGING)), "the staging folder was removed").toBe(true);
      } finally {
        shims.cleanup();
      }
    });
  }

  it("pin: the backup/restore lock a repair open creates is kept (own_created_lock, creating is intended), no vanished line", () => {
    const { targetDir, state } = ACTIONS["start-services"].make();
    mkdirSync(join(targetDir, "backups"), { mode: 0o700, recursive: true });
    const path = join(targetDir, "backups", ".orbit-backup-restore.lock");
    writeFileSync(path, "", { mode: 0o600 });
    const hook = removeHook(path, "probe_backup_restore_lock");
    const shims = privShims(targetDir, { root: false, setpriv: false, getent: "fail" });
    try {
      const result = runOwner(targetDir, { shims, state, env: hook.env, capSeconds: 20 });
      expect(existsSync(hook.flag), "the removal did not happen, so the test proves nothing").toBe(true);
      expect(existsSync(path), "the backup/restore lock was removed").toBe(true);
      expect(statSync(path).size).toBe(0);
      expect(result.stderr).not.toContain("vanished while repair was checking it");
    } finally {
      shims.cleanup();
    }
  });
});

// --- O-S4 (ruling): the owner has no user-database entry -----------------------------------------------------------------

describe("#1915 O-S4: root, and the folder's owner is not in the user database", () => {
  it("start-services is refused with the way back, the uid named twice", () => {
    const { targetDir, state, fakeBin } = ACTIONS["start-services"].make();
    const shims = privShims(targetDir, { getent: "fail" });
    try {
      const result = runOwner(targetDir, { shims, state, fakeBin });
      const want = `Orbit repair: start-services refused, nothing was changed: run as root, it could not look up the deployment folder's owner (uid ${UID}) in the user database (getent passwd), so it cannot write in the deployment folder as that user; add a user with that uid to the user database (for example: useradd --uid ${UID} --no-create-home <name>), then run repair again as root or as that user; do not start or change Orbit as root by hand, which leaves root-owned files in the deployment folder.`;
      expect(result.stderr.split("\n"), result.stderr.slice(0, 1500)).toContain(want);
      expect(result.stdout).not.toContain(ACTIONS["start-services"].done);
      expect(composeUpCalls(result)).toEqual([]);
    } finally {
      shims.cleanup();
    }
  });
});

// --- #1874 O-S2 (ruling, note 66728): no checkpoint removal when Docker was never checked ---------------------------------

describe("#1874 O-S2: a healthy re-check that could not check Docker keeps the credential checkpoint", () => {
  const checkpoint = () => {
    const targetDir = makeFixture();
    const dir = join(targetDir, ".orbit-repair-checkpoint.zzzzzz");
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, "postgres-password.orbkek"), "bundle\n", { mode: 0o600 });
    return targetDir;
  };

  it("docker unavailable: the checkpoint is kept and both docker-unavailable lines are printed", () => {
    const targetDir = checkpoint();
    const result = runOwner(targetDir, { shims: privShims(targetDir, { root: false }), state: { ...RUNNING, docker: { unavailable: true } }, capSeconds: 60 });
    const lines = result.stderr.split("\n");
    expect(names(targetDir, ".orbit-repair-checkpoint."), result.stderr.slice(0, 1500)).toEqual([".orbit-repair-checkpoint.zzzzzz"]);
    expect(lines).toContain("Orbit repair: the pre-rotation credential checkpoint ./.orbit-repair-checkpoint.zzzzzz was kept, because this run's re-check could not check Docker (docker-unavailable), so it could not confirm the rotated database password works.");
    expect(lines).toContain("Orbit repair: next step: ensure the docker CLI is installed and the daemon is reachable, then run repair again; the first run whose re-check is clean removes the checkpoint.");
  });

  it("control: docker available and a healthy re-check removes the checkpoint", () => {
    const targetDir = checkpoint();
    const result = runOwner(targetDir, { shims: privShims(targetDir, { root: false }), state: { ...RUNNING }, capSeconds: 60 });
    expect(names(targetDir, ".orbit-repair-checkpoint."), result.stderr.slice(0, 1500)).toEqual([]);
    expect(result.stderr).not.toContain("docker-unavailable");
  });
});
