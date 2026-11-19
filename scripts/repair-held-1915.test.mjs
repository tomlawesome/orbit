import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ACTIONS, runOwner } from "./repair-owner-fixtures.mjs";
import { privShims, realTool } from "./repair-priv-shims.mjs";
import { makeFixture, scratchDir } from "./repair-test-harness.mjs";

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
