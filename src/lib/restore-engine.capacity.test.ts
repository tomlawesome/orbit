import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RESTORE_CAPACITY_HEADROOM_KIB,
  type RestoreCapacityFacts,
  RestoreEngineRefusal,
  checkRestoreCapacity,
  directoryUsageKib,
  filesystemAvailableKib,
} from "./restore-engine";

// check_capacity unit coverage (restore.sh:355-397, guarantees #11-12) —
// deferred by #296 slice 3, in scope for slice 4
// (docs/adr-notes/296-backup-port-plan.md). Byte-for-byte formula parity
// against the real, unmodified restore.sh is in
// restore-engine.parity.test.ts (an awk-extracted, real-Bash-executed
// comparison); this file covers the pure arithmetic's own boundary
// behavior and the host-side du/df reimplementations directly.

function baseFacts(overrides: Partial<RestoreCapacityFacts> = {}): RestoreCapacityFacts {
  return {
    stagedDocumentsKib: 100,
    backupBytes: 100 * 1024,
    currentDatabaseBytes: 50 * 1024,
    currentDocumentKib: 40,
    hostAvailableKib: 10_000_000,
    tempAvailableKib: 10_000_000,
    volumeAvailableKib: 10_000_000,
    ...overrides,
  };
}

describe("checkRestoreCapacity (restore.sh:355-397, guarantees #11-12)", () => {
  it("accepts a comfortably-provisioned set of measurements", () => {
    expect(() => checkRestoreCapacity(baseFacts())).not.toThrow();
  });

  it("computes the exact required-backup-directory threshold (backup+db+doc+2*staged+2*headroom) and refuses one KiB under it", () => {
    const facts = baseFacts({ stagedDocumentsKib: 100, backupBytes: 100 * 1024, currentDatabaseBytes: 50 * 1024, currentDocumentKib: 40 });
    const backupKib = Math.ceil(facts.backupBytes / 1024);
    const currentDatabaseKib = Math.ceil(facts.currentDatabaseBytes / 1024);
    const required = backupKib + currentDatabaseKib + facts.currentDocumentKib + facts.stagedDocumentsKib * 2 + RESTORE_CAPACITY_HEADROOM_KIB * 2;

    expect(() => checkRestoreCapacity({ ...facts, hostAvailableKib: required })).not.toThrow();
    expect(() => checkRestoreCapacity({ ...facts, hostAvailableKib: required - 1 })).toThrow(RestoreEngineRefusal);
  });

  it("computes the exact temp-filesystem threshold (staged+doc+headroom) and refuses one KiB under it", () => {
    const facts = baseFacts({ stagedDocumentsKib: 100, currentDocumentKib: 40 });
    const required = facts.stagedDocumentsKib + facts.currentDocumentKib + RESTORE_CAPACITY_HEADROOM_KIB;

    expect(() => checkRestoreCapacity({ ...facts, tempAvailableKib: required })).not.toThrow();
    expect(() => checkRestoreCapacity({ ...facts, tempAvailableKib: required - 1 })).toThrow(RestoreEngineRefusal);
  });

  it("requires volumeAvailable+currentDocument >= stagedDocuments, refusing one KiB under it", () => {
    const facts = baseFacts({ stagedDocumentsKib: 100, currentDocumentKib: 40 });
    const requiredVolumeAvailable = facts.stagedDocumentsKib - facts.currentDocumentKib;

    expect(() => checkRestoreCapacity({ ...facts, volumeAvailableKib: requiredVolumeAvailable })).not.toThrow();
    expect(() => checkRestoreCapacity({ ...facts, volumeAvailableKib: requiredVolumeAvailable - 1 })).toThrow(RestoreEngineRefusal);
  });

  it("checks the backup-directory requirement before the temp/volume requirements, matching restore.sh's own check order", () => {
    // A facts value that fails *both* the backup-directory and temp checks
    // should report the backup-directory failure first (restore.sh:381-384
    // runs before :385-389).
    try {
      checkRestoreCapacity(baseFacts({ hostAvailableKib: 0, tempAvailableKib: 0 }));
      expect.fail("expected a refusal");
    } catch (error) {
      expect((error as RestoreEngineRefusal).message).toContain("private backup location");
    }
  });

  it.each([
    "stagedDocumentsKib",
    "backupBytes",
    "currentDatabaseBytes",
    "currentDocumentKib",
    "hostAvailableKib",
    "tempAvailableKib",
    "volumeAvailableKib",
  ] as const)("guarantee #12: refuses a non-numeric (negative) %s rather than silently treating it as 0", (field) => {
    expect(() => checkRestoreCapacity(baseFacts({ [field]: -1 }))).toThrow(RestoreEngineRefusal);
  });

  it.each(["stagedDocumentsKib", "backupBytes", "currentDatabaseBytes", "currentDocumentKib", "hostAvailableKib", "tempAvailableKib", "volumeAvailableKib"] as const)(
    "guarantee #12: refuses a non-integer %s",
    (field) => {
      expect(() => checkRestoreCapacity(baseFacts({ [field]: 1.5 }))).toThrow(RestoreEngineRefusal);
    },
  );

  it("never includes a measurement value or a path in its refusal message", () => {
    try {
      checkRestoreCapacity(baseFacts({ hostAvailableKib: 0 }));
      expect.fail("expected a refusal");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toMatch(/\d{3,}/); // no raw KiB/byte figures leaked
    }
  });
});

describe("directoryUsageKib (du -sk equivalent, restore.sh:359-362,375-379)", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "orbit-directory-usage-"));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("is zero-or-positive for an empty directory (just the directory's own block allocation)", () => {
    const emptyDir = join(sandbox, "empty");
    mkdirSync(emptyDir);
    expect(directoryUsageKib(emptyDir)).toBeGreaterThanOrEqual(0);
  });

  it("grows as files are added, recursing into subdirectories", () => {
    const root = join(sandbox, "content");
    mkdirSync(join(root, "nested"), { recursive: true });
    const before = directoryUsageKib(root);
    writeFileSync(join(root, "file.bin"), Buffer.alloc(64 * 1024, 7));
    writeFileSync(join(root, "nested", "file2.bin"), Buffer.alloc(64 * 1024, 9));
    const after = directoryUsageKib(root);
    expect(after).toBeGreaterThan(before);
  });
});

describe("filesystemAvailableKib (df -Pk's Avail column equivalent, restore.sh:381-385,390-394)", () => {
  it("reports a positive available figure for a real, writable directory", () => {
    expect(filesystemAvailableKib(tmpdir())).toBeGreaterThan(0);
  });
});
