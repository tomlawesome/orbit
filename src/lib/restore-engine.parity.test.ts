import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readGolden } from "./__fixtures__/golden";
import { sha256File } from "./recovery-bundle";
import {
  CORRESPONDENCE_QUERIES,
  type RestoreCapacityFacts,
  SCAN_RECOVERY_LEASES_STATEMENT,
  checkRestoreCapacity,
  computeCheckpointDigests,
  deriveRestorePaths,
  loadRestoreJournal,
  writeRestoreJournal,
} from "./restore-engine";

// Parity between restore.sh and this module's restore.sh-derived constants
// and rules (issue #296 slice 3). restore.sh is now a thin shell around
// `orbit restore` (#1211), so the bash half was captured once, before the
// rewrite, into src/lib/__fixtures__/restore-sh/ (see its README): the six
// correspondence queries and the scan-lease statement as restore.sh passed
// them to psql, checkpoint_sha256 run on a fixed file, load_recovery_journal's
// format rules, and check_capacity run against fakes at each threshold. The
// engine is compared against those, never against itself (#1210 build note
// D10).

const sandboxes: string[] = [];
afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

function sandbox(): string {
  const directory = mkdtempSync(join(tmpdir(), "orbit-restore-parity-"));
  sandboxes.push(directory);
  return directory;
}

describe("CORRESPONDENCE_QUERIES parity against restore.sh's literal psql --command text (golden)", () => {
  const golden = readGolden<{ queries: Record<string, string>; occurrences: Record<string, number> }>("restore-sh", "correspondence-queries");

  it.each(Object.keys(CORRESPONDENCE_QUERIES) as (keyof typeof CORRESPONDENCE_QUERIES)[])("%s query matches restore.sh's report literally", (name) => {
    expect(CORRESPONDENCE_QUERIES[name]).toBe(golden.queries[name]);
  });

  it("restore.sh ran each query against both the staged and the live database, which this module serves from one constant", () => {
    for (const name of Object.keys(CORRESPONDENCE_QUERIES)) expect(golden.occurrences[name]).toBeGreaterThanOrEqual(2);
  });
});

describe("SCAN_RECOVERY_LEASES_STATEMENT parity", () => {
  it("matches the statement restore.sh's reset_scan_recovery_leases passed to psql", () => {
    const golden = readGolden<{ shellCommand: string; statement: string }>("restore-sh", "scan-recovery-leases");
    expect(SCAN_RECOVERY_LEASES_STATEMENT).toBe(golden.statement);
    expect(golden.shellCommand).toContain(`--command="${SCAN_RECOVERY_LEASES_STATEMENT}"`);
  });
});

describe("checkpoint_sha256 parity (golden)", () => {
  const golden = readGolden<{ content: string; present: { status: number; stdout: string }; missing: { status: number; stdout: string } }>(
    "restore-sh",
    "checkpoint-sha256",
  );

  it("computes the digest restore.sh's checkpoint_sha256 printed for the same content", () => {
    const file = join(sandbox(), "artifact");
    writeFileSync(file, golden.content);
    expect(golden.present.status).toBe(0);
    expect(sha256File(file)).toBe(golden.present.stdout.trim());
  });

  it("fails for a missing file, as checkpoint_sha256 did (nonzero, no digest)", () => {
    expect(golden.missing.status).not.toBe(0);
    expect(golden.missing.stdout).toBe("");
    expect(() => sha256File(join(sandbox(), "does-not-exist"))).toThrow();
  });
});

describe("load_recovery_journal format rules (golden)", () => {
  const golden = readGolden<{ restoreIdPattern: string; states: string[]; requiredMode: string }>("restore-sh", "load-recovery-journal");

  function checkpoint(): { paths: ReturnType<typeof deriveRestorePaths>; restoreId: string } {
    const backupDirectory = sandbox();
    const paths = deriveRestorePaths(backupDirectory, join(backupDirectory, "document-kek"));
    const restoreId = "Ab_9-z";
    expect(new RegExp(golden.restoreIdPattern).test(restoreId)).toBe(true);
    const directory = join(paths.restoreRoot, `checkpoint-${restoreId}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const member of ["database.dump", "documents.tar", "document-kek"]) writeFileSync(join(directory, member), member, { mode: 0o600 });
    return { paths, restoreId };
  }

  it.each(["checkpointed", "documents-replaced", "database-restored", "rollback-failed"])("accepts the %s state restore.sh accepted", (state) => {
    expect(golden.states).toContain(state);
    const { paths, restoreId } = checkpoint();
    const digests = computeCheckpointDigests(join(paths.restoreRoot, `checkpoint-${restoreId}`));
    writeRestoreJournal(paths, { restoreId, state: state as never, ...digests });
    expect(loadRestoreJournal(paths.journalPath, paths.restoreRoot).fields.state).toBe(state);
  });

  it("accepts exactly restore.sh's four states", () => {
    expect([...golden.states].sort()).toEqual(["checkpointed", "database-restored", "documents-replaced", "rollback-failed"]);
  });

  it(`refuses a journal whose mode is not ${golden.requiredMode}, as restore.sh did`, () => {
    const { paths, restoreId } = checkpoint();
    const digests = computeCheckpointDigests(join(paths.restoreRoot, `checkpoint-${restoreId}`));
    writeRestoreJournal(paths, { restoreId, state: "checkpointed", ...digests });
    chmodSync(paths.journalPath, 0o644);
    expect(() => loadRestoreJournal(paths.journalPath, paths.restoreRoot)).toThrow();
  });
});

describe("check_capacity parity (golden, guarantees #11-12)", () => {
  const cases = readGolden<
    {
      name: string;
      scenario: {
        stagedKib: number;
        backupBytes: number;
        databaseBytes: number;
        documentKib: number;
        hostAvailableKib: number;
        tempAvailableKib: number;
        volumeAvailableKib: number;
      };
      status: number;
      stderr: string;
    }[]
  >("restore-sh", "check-capacity");

  function engineRefusal(facts: RestoreCapacityFacts): string | undefined {
    try {
      checkRestoreCapacity(facts);
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
  }

  it.each(cases.map((entry) => [entry.name, entry] as const))("%s: the engine accepts or refuses exactly as restore.sh did, with its message", (_name, entry) => {
    const refusal = engineRefusal({
      stagedDocumentsKib: entry.scenario.stagedKib,
      backupBytes: entry.scenario.backupBytes,
      currentDatabaseBytes: entry.scenario.databaseBytes,
      currentDocumentKib: entry.scenario.documentKib,
      hostAvailableKib: entry.scenario.hostAvailableKib,
      tempAvailableKib: entry.scenario.tempAvailableKib,
      volumeAvailableKib: entry.scenario.volumeAvailableKib,
    });
    if (entry.status === 0) {
      expect(refusal).toBeUndefined();
    } else {
      expect(refusal).toBe(entry.stderr.trim());
    }
  });
});
