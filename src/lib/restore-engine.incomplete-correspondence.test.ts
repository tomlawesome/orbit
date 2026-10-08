import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createTar } from "./recovery-bundle";
import {
  CORRESPONDENCE_QUERIES,
  type CorrespondenceReports,
  type RestoreDockerAdapter,
  RestoreEngineRefusal,
  RestoreRun,
  computeCheckpointDigests,
  deriveRestorePaths,
  internal,
  preflightValidateBundle,
} from "./restore-engine";

// #678, ported from restore.sh's accept_report/fail_correspondence when the
// engine took over restore (#1211): a correspondence report that could not
// run to completion is not a verdict on the operator's backup. It refuses as
// `<stage>/correspondence-incomplete failed` naming the check, never as the
// "use a complete backup and retry" violation; the real-stack drill
// (scripts/test-backup-restore.sh, test_incomplete_correspondence_query)
// greps exactly these words.

const STORAGE_KEY = "ab".repeat(32);
const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";

const sandboxes: string[] = [];
afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

function stagedTree(): string {
  const root = mkdtempSync(join(tmpdir(), "orbit-incomplete-correspondence-"));
  sandboxes.push(root);
  mkdirSync(join(root, "objects", STORAGE_KEY.slice(0, 2), STORAGE_KEY.slice(2, 4)), { recursive: true });
  writeFileSync(join(root, "objects", STORAGE_KEY.slice(0, 2), STORAGE_KEY.slice(2, 4), `${STORAGE_KEY}.bin`), "x".repeat(10));
  return root;
}

const healthyReports: CorrespondenceReports = {
  crypto: `${DOCUMENT_ID}|${STORAGE_KEY}|10|available\n`,
  visible: `${DOCUMENT_ID}|available|${STORAGE_KEY}|10\n`,
  attachments: "",
  staging: "",
  documentStaging: "",
  transientCount: "0\n",
};

function adapterAnswering(reports: CorrespondenceReports, failing?: keyof CorrespondenceReports) {
  const byQuery = new Map<string, keyof CorrespondenceReports>(Object.entries(CORRESPONDENCE_QUERIES).map(([name, query]) => [query, name as keyof CorrespondenceReports]));
  return {
    createStageDatabase: () => undefined,
    dropStageDatabase: () => undefined,
    restoreDumpToDatabase: () => true,
    queryReport: (_database: string, query: string) => {
      const name = byQuery.get(query)!;
      if (name === failing) throw new RestoreEngineRefusal("A correspondence report did not run to completion.", "query-report-failed");
      return reports[name];
    },
  };
}

function preflight(adapter: ReturnType<typeof adapterAnswering>): void {
  preflightValidateBundle({ adapter, databaseDumpPath: "/unused", stagedDocumentsRoot: stagedTree(), stagingId: "1_2" });
}

describe("correspondence that could not be checked (#678)", () => {
  it("tells the operator which check could not be completed, and does not call their backup corrupt", () => {
    let message = "";
    try {
      preflight(adapterAnswering(healthyReports, "documentStaging"));
    } catch (error) {
      expect(error).toBeInstanceOf(RestoreEngineRefusal);
      expect((error as RestoreEngineRefusal).code).toBe("correspondence-incomplete");
      message = (error as Error).message;
    }
    expect(message).toBe(
      "preflight/correspondence-incomplete failed; the document-stage check did not run to completion, so correspondence could not be verified. This is not a verdict on the backup; retry, and capture the restore output if it recurs.",
    );
    expect(message).not.toContain("use a complete backup and retry");
  });

  it.each([
    ["crypto", "crypto"],
    ["visible", "visible"],
    ["attachments", "attachments"],
    ["staging", "staging"],
    ["documentStaging", "document-stage"],
    ["transientCount", "transient"],
  ] as const)("names the %s report as the %s check, as restore.sh's call sites did", (report, checkName) => {
    expect(() => preflight(adapterAnswering(healthyReports, report))).toThrow(`the ${checkName} check did not run to completion`);
  });

  it("still reports a genuine correspondence violation with its original message", () => {
    expect(() => preflight(adapterAnswering({ ...healthyReports, transientCount: "1\n" }))).toThrow(
      "preflight/correspondence failed; the staged database and document tree do not correspond; use a complete backup and retry.",
    );
  });

  it("passes a healthy correspondence check through without failing", () => {
    expect(() => preflight(adapterAnswering(healthyReports))).not.toThrow();
  });
});

describe("beforeCheckpointRestore hook (restore.sh's ORBIT_RESTORE_TEST_FAILURE_STAGE=checkpoint-restore)", () => {
  it("makes reapplying a checkpoint fail before anything live is touched", () => {
    let touched = false;
    const adapter = {
      restoreActiveDatabase: () => {
        touched = true;
        return true;
      },
    } as unknown as Parameters<typeof internal.applyCheckpointState>[0];
    const result = internal.applyCheckpointState(adapter, "/unused", "/unused", "/unused", {
      beforeCheckpointRestore: () => {
        throw new Error("requested");
      },
    });
    expect(result).toBe(false);
    expect(touched).toBe(false);
  });
});

describe("every correspondence call site names its stage and check (#678 call sites)", () => {
  function runFixture(): { run: RestoreRun; adapter: RestoreDockerAdapter; root: string } {
    const root = stagedTree();
    const documentsRoot = join(root, "live");
    mkdirSync(join(documentsRoot, "objects"), { recursive: true });
    const keyFile = join(root, "document-kek");
    writeFileSync(keyFile, `${"a".repeat(64)}\n`, { mode: 0o600 });
    const adapter = {
      stopApp: () => true,
      startApp: () => true,
      waitForHealth: () => true,
      dumpDatabase: (path: string) => writeFileSync(path, "dump"),
      pgRestoreListOk: () => true,
      collectDocumentsArchive: (path: string) => createTar(documentsRoot, path, ["."]),
      createStageDatabase: () => undefined,
      dropStageDatabase: () => undefined,
      restoreDumpToDatabase: () => true,
      queryReport: () => {
        throw new RestoreEngineRefusal("A correspondence report did not run to completion.", "query-report-failed");
      },
      queryActiveReport: () => {
        throw new RestoreEngineRefusal("A correspondence report did not run to completion.", "query-report-failed");
      },
    } as unknown as RestoreDockerAdapter;
    const paths = deriveRestorePaths(join(root, "backups"), keyFile);
    mkdirSync(paths.backupDirectory, { recursive: true });
    mkdirSync(join(root, "work"));
    const run = RestoreRun.prepare({ adapter, paths, workDir: join(root, "work") });
    return { run, adapter, root };
  }

  it("checkpoint: the self-verification of a new checkpoint", () => {
    const { run } = runFixture();
    expect(() => run.createCheckpoint()).toThrow("checkpoint/correspondence-incomplete failed; the crypto check did not run to completion");
    run.dispose();
  });

  it("recovery: --recover's re-verification of the journaled checkpoint", () => {
    const { run, adapter, root } = runFixture();
    writeFileSync(join(run.checkpointDirectory, "database.dump"), "dump");
    createTar(join(root, "live"), join(run.checkpointDirectory, "documents.tar"), ["."]);
    writeFileSync(join(run.checkpointDirectory, "document-kek"), `${"a".repeat(64)}\n`);
    const resumed = RestoreRun.resume(
      { adapter, paths: deriveRestorePaths(join(root, "backups"), join(root, "document-kek")), workDir: join(root, "work-recover") },
      run.checkpointDirectory,
      run.restoreId,
      computeCheckpointDigests(run.checkpointDirectory),
    );
    expect(() => resumed.reverifyCheckpointForRecovery()).toThrow("recovery/correspondence-incomplete failed; the crypto check did not run to completion");
  });

  it("cutover: the active check after the cutover, which a rollback then follows", () => {
    const { run } = runFixture();
    expect(() => run.finalize()).toThrow("cutover/correspondence-incomplete failed; the crypto check did not run to completion");
  });
});
