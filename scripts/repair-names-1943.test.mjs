import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { runOwner } from "./repair-owner-fixtures.mjs";
import { privShims } from "./repair-priv-shims.mjs";
import { makeFixture } from "./repair-test-harness.mjs";

// #1943 SEC-O1 (CWE-150): the checkpoint and staging folder names that repair.sh prints in
// restore_transaction's refusals and in settle_credential_checkpoints are printed raw, while
// their sibling lines already go through clean_name. A folder named with an escape sequence
// (ESC [ 2 J, clear screen) must reach root's terminal without its ESC byte. Written from the
// finding alone; each case drives repair.sh as the other #1915 SEC-O3 tests do.

vi.setConfig({ testTimeout: 90_000 });

const RUNNING = { db: "running", app: "running" };
const ESC = "\x1b";
const SUFFIX = "ab\x1b[2Jcd";
const CLEANED = "abcd";
const STAGING = `.orbit-install-staging.${SUFFIX}`;
const CHECKPOINT = `.orbit-repair-checkpoint.${SUFFIX}`;
const names = (dir, prefix) => readdirSync(dir).filter((entry) => entry.startsWith(prefix));
const linesWith = (result, text) => result.stderr.split("\n").filter((line) => line.includes(text));

function expectCleaned(result, marker, cleanedName) {
  const lines = linesWith(result, marker);
  expect(lines.length, `no line containing "${marker}":\n${result.stderr.slice(0, 2000)}`).toBeGreaterThan(0);
  expect(lines.join("\n"), "an escape character reached the terminal").not.toContain(ESC);
  expect(lines.join("\n")).toContain(cleanedName);
}

/** A staging folder whose .env-orbit backup differs from the live file, so its restore is not a no-op. */
function stagingWithEnvBackup(targetDir, { committed, name = STAGING }) {
  const staging = join(targetDir, name);
  const original = join(staging, "rollback", "original");
  mkdirSync(original, { recursive: true, mode: 0o700 });
  for (const dir of [staging, join(staging, "rollback"), original]) chmodSync(dir, 0o700);
  writeFileSync(join(original, ".env-orbit"), "APP_URL=https://orbit.old-good-state.internal\nCOMPOSE_PROJECT_NAME=repairtest\n", { mode: 0o600 });
  if (committed) writeFileSync(join(staging, "committed"), "");
}

function checkpointFolder(targetDir, extra = false) {
  const dir = join(targetDir, CHECKPOINT);
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, "postgres-password.orbkek"), "bundle\n", { mode: 0o600 });
  if (extra) writeFileSync(join(dir, "not-the-bundle"), "other\n", { mode: 0o600 });
}

describe("#1943 SEC-O1: restore-transaction's refusals clean the staging folder name", () => {
  it("a staging folder marked committed: the 'is marked committed' line has no raw ESC", () => {
    const targetDir = makeFixture();
    stagingWithEnvBackup(targetDir, { committed: true });
    const result = runOwner(targetDir, { shims: privShims(targetDir, { root: false }), state: { ...RUNNING }, capSeconds: 60 });
    expectCleaned(result, "is marked committed by a completed install", `.orbit-install-staging.${CLEANED} is marked committed`);
  });

  it("a staging folder carrying a live .env-orbit backup, run unattended: the 'would restore the live' line has no raw ESC", () => {
    const targetDir = makeFixture();
    stagingWithEnvBackup(targetDir, { committed: false });
    // Unattended: no terminal, and not the harness's ORBIT_REPAIR_PROMPTS=machine.
    const result = runOwner(targetDir, { shims: privShims(targetDir, { root: false }), state: { ...RUNNING }, env: { ORBIT_REPAIR_PROMPTS: "" }, capSeconds: 60 });
    expectCleaned(result, "would restore the live", `.orbit-install-staging.${CLEANED} would restore the live .env-orbit`);
  });
});

describe("#1943 SEC-O1: settle_credential_checkpoints cleans the checkpoint folder name", () => {
  it("a clean re-check removes the checkpoint: the 'was removed' line has no raw ESC", () => {
    const targetDir = makeFixture();
    checkpointFolder(targetDir);
    const result = runOwner(targetDir, { shims: privShims(targetDir, { root: false }), state: { ...RUNNING }, capSeconds: 60 });
    expect(names(targetDir, ".orbit-repair-checkpoint."), "the checkpoint was not removed, so this line was not reached").toEqual([]);
    expectCleaned(result, "(the old database password) was removed", `.orbit-repair-checkpoint.${CLEANED}`);
  });

  it("a clean re-check, a checkpoint not of repair's shape: the 'was kept: it is not the shape' line has no raw ESC", () => {
    const targetDir = makeFixture();
    checkpointFolder(targetDir, true);
    const result = runOwner(targetDir, { shims: privShims(targetDir, { root: false }), state: { ...RUNNING }, capSeconds: 60 });
    expect(names(targetDir, ".orbit-repair-checkpoint.")).toHaveLength(1);
    expectCleaned(result, "it is not the shape repair created", `.orbit-repair-checkpoint.${CLEANED}`);
  });

  it("Docker unavailable: the 'could not check Docker' kept line has no raw ESC", () => {
    const targetDir = makeFixture();
    checkpointFolder(targetDir);
    const result = runOwner(targetDir, { shims: privShims(targetDir, { root: false }), state: { ...RUNNING, docker: { unavailable: true } }, capSeconds: 60 });
    expect(names(targetDir, ".orbit-repair-checkpoint.")).toHaveLength(1);
    expectCleaned(result, "could not check Docker (docker-unavailable)", `.orbit-repair-checkpoint.${CLEANED}`);
  });

  it("deployment version unsupported: the 'refused to act on this deployment' kept line has no raw ESC", () => {
    const targetDir = makeFixture();
    checkpointFolder(targetDir);
    const envPath = join(targetDir, ".env-orbit");
    writeFileSync(envPath, readFileSync(envPath, "utf8").split("\n").filter((line) => !line.startsWith("ORBIT_CONFIG_APPLIED_")).join("\n"));
    chmodSync(envPath, 0o600);
    const result = runOwner(targetDir, { shims: privShims(targetDir, { root: false }), state: { ...RUNNING }, capSeconds: 60 });
    expect(result.stdout, result.stderr.slice(0, 1500)).toContain("reason=deployment-version-unsupported");
    expectCleaned(result, "repair refused to act on this deployment", `.orbit-repair-checkpoint.${CLEANED}`);
  });

  it("a re-check that is not clean: the 'is not clean' kept line has no raw ESC", () => {
    const targetDir = makeFixture();
    checkpointFolder(targetDir);
    // A committed staging folder makes restore-transaction fail, so the safe batch fails and the re-check is not clean.
    stagingWithEnvBackup(targetDir, { committed: true, name: ".orbit-install-staging.abc123" });
    const result = runOwner(targetDir, { shims: privShims(targetDir, { root: false }), state: { ...RUNNING }, capSeconds: 60 });
    expect(names(targetDir, ".orbit-repair-checkpoint.")).toHaveLength(1);
    expectCleaned(result, "re-check is not clean", `.orbit-repair-checkpoint.${CLEANED}`);
  });
});
