import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, processWatchdog } from "./process-budget.mjs";

// #1151 O2-R3: nothing serialized backup.sh against restore.sh, even though
// both stop orbit-app and cut over the document tree/database -- a backup
// finishing mid-restore could start orbit-app back up during restore's own
// document-tree cutover. Both scripts now take the same flock'd lock file
// for their whole run; this proves real mutual exclusion (not merely that
// the code compiles) by running the actual acquire_backup_restore_lock
// function extracted from each script, never a hand-typed duplicate, as two
// real concurrent processes racing for one lock file.
//
// Each test spawns two real bash processes and lets one hold the lock for a
// second; a spawn that takes tens of milliseconds quiet takes seconds on a
// starved core (#698), so each `it` carries its own PROCESS_TEST_TIMEOUT_MS.

const backupScriptSource = readFileSync(join(import.meta.dirname, "backup.sh"), "utf8");
const restoreScriptSource = readFileSync(join(import.meta.dirname, "restore.sh"), "utf8");

function extractFunction(source, name) {
  const pattern = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}`, "mu");
  const match = source.match(pattern);
  if (!match) throw new Error(`Could not find function ${name}() in the given source`);
  return match[0];
}

const scratchDirs = [];

afterEach(() => {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop(), { recursive: true, force: true });
});

function makeLockFile() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-backup-restore-lock-"));
  scratchDirs.push(dir);
  return join(dir, ".orbit-backup-restore.lock");
}

// Runs the real acquire_backup_restore_lock function (from either script --
// both are supposed to be the same mechanism against the same lock file),
// prints a nanosecond timestamp the instant it acquires, sleeps for
// holdSeconds, then prints a second timestamp the instant it is about to
// release (by exiting, closing its lock fd).
function runLockHolder(source, lockFile, holdSeconds) {
  const script = [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    `lock_file=${JSON.stringify(lockFile)}`,
    // backup.sh's acquire function also ensures $backup_directory exists;
    // restore.sh's does not reference it. Set to the lock file's own
    // directory either way, so both extracted functions run unmodified.
    `backup_directory=${JSON.stringify(dirname(lockFile))}`,
    "lock_fd=''",
    'fail() { printf "FAIL: %s\\n" "$*" >&2; exit 1; }',
    extractFunction(source, "acquire_backup_restore_lock"),
    "acquire_backup_restore_lock",
    'printf "ACQUIRED %s\\n" "$(date +%s%N)"',
    `sleep ${holdSeconds}`,
    'printf "RELEASING %s\\n" "$(date +%s%N)"',
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", script]);
    let stdout = "";
    let stderr = "";
    const watchdog = processWatchdog({ label: "runLockHolder", kill: () => child.kill("SIGKILL") });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      watchdog.touch();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      watchdog.touch();
    });
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
      resolve({ status, stdout, stderr });
    });
  });
}

function timestampAfter(stdout, marker) {
  const match = stdout.match(new RegExp(`^${marker} (\\d+)$`, "mu"));
  if (!match) throw new Error(`${marker} never appeared in: ${stdout}`);
  return BigInt(match[1]);
}

describe("backup.sh and restore.sh share one backup/restore lock (#1151 O2-R3)", () => {
  it("a restore waits for a backup already holding the lock, never running concurrently", async () => {
    const lockFile = makeLockFile();
    const first = runLockHolder(backupScriptSource, lockFile, 1);
    // Give the first process a real head start so it reliably acquires
    // first -- this test is about mutual exclusion while held, not about
    // which of two simultaneous callers wins the race.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    const second = runLockHolder(restoreScriptSource, lockFile, 0);

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.status).toBe(0);
    expect(secondResult.status).toBe(0);
    expect(secondResult.stderr).toContain("another backup or restore is already running; waiting for it to finish");

    const firstReleased = timestampAfter(firstResult.stdout, "RELEASING");
    const secondAcquired = timestampAfter(secondResult.stdout, "ACQUIRED");
    expect(secondAcquired > firstReleased).toBe(true);
  }, PROCESS_TEST_TIMEOUT_MS);

  it("a backup waits for a restore already holding the lock, never running concurrently", async () => {
    const lockFile = makeLockFile();
    const first = runLockHolder(restoreScriptSource, lockFile, 1);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    const second = runLockHolder(backupScriptSource, lockFile, 0);

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.status).toBe(0);
    expect(secondResult.status).toBe(0);
    expect(secondResult.stderr).toContain("another backup or restore is already running; waiting for it to finish");

    const firstReleased = timestampAfter(firstResult.stdout, "RELEASING");
    const secondAcquired = timestampAfter(secondResult.stdout, "ACQUIRED");
    expect(secondAcquired > firstReleased).toBe(true);
  }, PROCESS_TEST_TIMEOUT_MS);
});

// #1151 RANGE-R7: backup.sh used to read/materialize the document KEK
// (read_document_kek) before taking this same lock, unlike restore.sh,
// which already locks first. import-recovery-bundle.sh swaps the live
// document-kek file by two renames under this same lock; a backup started
// in the narrow window between those two renames saw the live key file
// transiently absent and hard-failed with "Missing regular document KEK
// file" even though nothing was actually wrong with the key. Locking
// first, like restore.sh, serializes a backup against that swap instead of
// racing it.
describe("backup.sh reads the document KEK after acquiring the backup/restore lock, not before (#1151 RANGE-R7)", () => {
  it("acquire_backup_restore_lock is called before read_document_kek in the bare (no-argument) dispatch path", () => {
    const bareDispatchMatch = backupScriptSource.match(
      /elif \[\[ "\$#" == 0 \]\]; then\n([\s\S]*?)\nelse\n/u,
    );
    expect(bareDispatchMatch).not.toBeNull();
    const bareDispatchBody = bareDispatchMatch[1];
    const lockIndex = bareDispatchBody.indexOf("acquire_backup_restore_lock");
    const readKekIndex = bareDispatchBody.indexOf("read_document_kek");
    expect(lockIndex).toBeGreaterThan(-1);
    expect(readKekIndex).toBeGreaterThan(-1);
    expect(lockIndex).toBeLessThan(readKekIndex);
  });

  it("--verify still reads the document KEK (it needs it to decrypt the bundle) without taking the backup/restore lock", () => {
    const verifyDispatchMatch = backupScriptSource.match(
      /if \[\[ "\$\{1:-\}" == "--verify" \]\]; then\n([\s\S]*?)\nelif /u,
    );
    expect(verifyDispatchMatch).not.toBeNull();
    const verifyDispatchBody = verifyDispatchMatch[1];
    expect(verifyDispatchBody).toContain("read_document_kek");
    expect(verifyDispatchBody).not.toContain("acquire_backup_restore_lock");
  });
});
