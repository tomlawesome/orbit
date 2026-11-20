import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { runOwner } from "./repair-owner-fixtures.mjs";
import { privShims } from "./repair-priv-shims.mjs";
import { makeFixture, scratchDir } from "./repair-test-harness.mjs";

// #1935: in smtp_owner_write the owner step's limit (ORBIT_REPAIR_OWNER_STEP_TIMEOUT) must time only the owner's
// own write. Root's producer (the checkpoint encryption) is collected first, bounded by its own limit, and only
// then fed to the owner step. Harness and shims as in repair-owner-writes-1875.test.mjs (simulated root).
// Assertions are on events (setpriv lines, 'Orbit repair:' lines, exit status, leftovers), never on elapsed time
// (owner decision 77a on #1933).

vi.setConfig({ testTimeout: 120_000 });

const PASSPHRASE = "correct-horse-battery-staple";
const LIMIT = { ORBIT_REPAIR_OWNER_STEP_TIMEOUT: "2" };
const EXTRA = ["cp", "install", "touch", "ln", "tee"];
const HEX = /^[0-9a-f]{64}$/u;
const ORIGINAL = `${"a".repeat(64)}\n`;
const DONE = "execute action=rotate-database-credential resolves=database-credential-mismatch result=done";
const CHECKPOINT_FAILED = /could not create the pre-rotation checkpoint/u;
const RENAME = / -- mv\b.* -[a-zA-Z]*T\b.*\.repair-staged-postgres-password\s+\S*postgres-password$/u;
const RUNNING = { db: "running", app: "running" };

const shimsFor = (targetDir) => privShims(targetDir, { extraTools: EXTRA });
const orbitLines = (result) => result.stderr.split("\n").filter((line) => line.startsWith("Orbit repair:"));
const secretPath = (targetDir) => join(targetDir, ".orbit-secrets", "postgres-password");
const leftovers = (targetDir) => readdirSync(targetDir).filter((entry) => entry.startsWith(".orbit-repair-checkpoint.") || entry.startsWith(".orbit-repair-tmp"));

function mismatchFolder() {
  const targetDir = makeFixture();
  const markers = scratchDir();
  return { targetDir, state: { ...RUNNING, docker: { db: { present: true, ready: true, authResult: "mismatch" }, dbAuthMarkerPath: join(markers, "db-auth-marker") } } };
}

/** A `docker` in front of the harness's own that, on the checkpoint encryption call only, first waits `seconds` (the container starting slowly). */
function slowEncryptDocker(seconds, { replace = false } = {}) {
  const dir = scratchDir("orbit-1935-docker-");
  const wait = replace ? `exec sleep ${seconds}` : `sleep ${seconds}`;
  writeFileSync(join(dir, "docker"), `#!/usr/bin/env bash\nPATH="\${PATH#'${dir}':}"\nif [[ "$*" == *recovery-crypto.mjs*encrypt* ]]; then ${wait}; fi\nexec docker "$@"\n`);
  chmodSync(join(dir, "docker"), 0o755);
  return dir;
}

function rotate(shims, folder, options = {}) {
  return runOwner(folder.targetDir, { shims, state: folder.state, args: ["--execute", "--dangerous"], input: `rotate\n${PASSPHRASE}\n${PASSPHRASE}\n`, capSeconds: 90, ...options });
}

function expectRotated(result, shims, folder) {
  expect(result.hung, `repair was still running after the test's own cap:\n${result.stderr.slice(0, 600)}`).toBe(false);
  expect(result.stderr, "the checkpoint was reported as failed").not.toMatch(CHECKPOINT_FAILED);
  expect(result.stdout, result.stderr.slice(0, 1500)).toContain(DONE);
  expect(shims.setprivCalls().filter((line) => RENAME.test(line)), "the rename never went through setpriv with mv -T").not.toEqual([]);
  const live = readFileSync(secretPath(folder.targetDir), "utf8");
  expect(live.trim()).toMatch(HEX);
  expect(live).not.toBe(ORIGINAL);
  expect(existsSync(join(folder.targetDir, ".orbit-secrets", ".repair-staged-postgres-password"))).toBe(false);
}

function expectNoRotation(result, shims, folder) {
  expect(result.hung, `repair was still running after the test's own cap:\n${result.stderr.slice(0, 600)}`).toBe(false);
  expect(result.stdout).not.toContain(DONE);
  expect(readFileSync(secretPath(folder.targetDir), "utf8"), "the live password changed").toBe(ORIGINAL);
  expect(orbitLines(result).filter((line) => CHECKPOINT_FAILED.test(line)), `no line says the checkpoint failed:\n${result.stderr.slice(0, 1500)}`).not.toEqual([]);
  expect(shims.setprivCalls().filter((line) => RENAME.test(line)), "update-config's rename ran").toEqual([]);
  expect(leftovers(folder.targetDir), "the failed step left files behind").toEqual([]);
}

describe("#1935: the owner step's limit excludes root's producer", () => {
  it("a checkpoint encryption slower than the owner limit (2 s) but within its own does not fail the checkpoint; the rename goes through setpriv", () => {
    const folder = mismatchFolder();
    const shims = shimsFor(folder.targetDir);
    const result = rotate(shims, folder, { env: LIMIT, fakeBin: slowEncryptDocker(3) });
    expectRotated(result, shims, folder);
  });

  it("control: the same run with no encryption delay rotates as before", () => {
    const folder = mismatchFolder();
    const shims = shimsFor(folder.targetDir);
    const result = rotate(shims, folder, { env: LIMIT, fakeBin: slowEncryptDocker(0) });
    expectRotated(result, shims, folder);
  });

  it("an owner step that itself stalls is still timed out: the checkpoint fails, no rotation, nothing left behind, no lock held", () => {
    const folder = mismatchFolder();
    const shims = privShims(folder.targetDir, { extraTools: EXTRA, variant: { kind: "stop", match: "*smtp-owner-write*" } });
    try {
      const result = rotate(shims, folder, { env: LIMIT, fakeBin: slowEncryptDocker(0) });
      expect(shims.setprivCalls().filter((line) => /smtp-owner-write/u.test(line)), "the owner write never went through setpriv").not.toEqual([]);
      expect(orbitLines(result).filter((line) => /timed out/iu.test(line)), `no 'Orbit repair:' line says the step timed out:\n${result.stderr.slice(0, 1500)}`).not.toEqual([]);
      expectNoRotation(result, shims, folder);
    } finally {
      shims.cleanup();
    }
  });

  // Real time: the producer's own 30 s cap (docker_checkpoint_timeout, repair.sh:1726) plus the run itself, about 40 s.
  it("a producer that hangs past its own 30 s cap still ends the step as failed, with no rotation", () => {
    const folder = mismatchFolder();
    const shims = shimsFor(folder.targetDir);
    const result = rotate(shims, folder, { fakeBin: slowEncryptDocker(120, { replace: true }) });
    expectNoRotation(result, shims, folder);
  });
});
