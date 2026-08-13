import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { evaluateReadiness, type OidcSecretFileFacts } from "../lib/config-contract";
import { parseEnvOrbitContent } from "../lib/env-orbit-file";
import { InstallTransaction, type ManagedPath } from "../lib/install-transaction";
import { CORRESPONDENCE_QUERIES, type CorrespondenceReports, type RestoreDockerAdapter, RestoreRun, deriveRestorePaths, recoverRestore } from "../lib/restore-engine";
import { createTar, extractTar } from "../lib/recovery-bundle";

// The orbit engine CLI (ADR-0011, issue #294). First flow: `check` — the
// value-free readiness report, output-identical to `configure.sh --check`
// (proven by src/lib/config-contract.parity.test.ts). Non-interactive by
// design; interactive presentation belongs to orbit-launcher.

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function gatherOidcSecretFacts(deployDir: string): OidcSecretFileFacts {
  const secretsDirectory = join(deployDir, ".orbit-secrets");
  const secretFile = join(secretsDirectory, "oidc-client-secret");
  const directoryStat = statSync(secretsDirectory, { throwIfNoEntry: false });
  const directoryLstat = lstatSync(secretsDirectory, { throwIfNoEntry: false });
  const fileLstat = lstatSync(secretFile, { throwIfNoEntry: false });
  return {
    secretsDirectoryExists: directoryStat?.isDirectory() ?? false,
    secretsDirectoryIsSymlink: directoryLstat?.isSymbolicLink() ?? false,
    secretsDirectoryMode: directoryStat ? directoryStat.mode & 0o777 : null,
    secretFileExists: fileLstat !== undefined,
    secretFileIsRegular: fileLstat?.isFile() ?? false,
    secretFileIsSymlink: fileLstat?.isSymbolicLink() ?? false,
    secretFileMode: fileLstat ? fileLstat.mode & 0o777 : null,
    secretFileSize: fileLstat?.size ?? 0,
  };
}

function commandCheck(deployDir: string): never {
  const environmentFile = join(deployDir, ".env-orbit");
  // Open first with O_NOFOLLOW, then verify and read through the same
  // descriptor: the safety check and the content read cannot be split by a
  // file swap (CodeQL js/file-system-race).
  let descriptor: number;
  try {
    descriptor = openSync(environmentFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    fail("configuration_syntax");
  }
  let content: string;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      fail("configuration_syntax");
    }
    content = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }

  const parsed = parseEnvOrbitContent(content);
  if (!parsed.ok) fail(parsed.code);

  const facts = gatherOidcSecretFacts(deployDir);
  const report = evaluateReadiness(parsed.record, facts);
  process.stdout.write(report.lines.join("\n") + "\n");
  process.exit(report.ok ? 0 : 1);
}

// Scenario shape for the hidden __install-transaction-rehearse subcommand
// below: JSON-serialisable so it can be handed to a child process for the
// SIGKILL interruption characterization test in
// src/lib/install-transaction.test.ts. Not a documented interface.
interface RehearsalScenario {
  targetDir: string;
  managedPaths: ManagedPath[];
  steps: RehearsalStep[];
}

type RehearsalStep =
  | { kind: "write"; path: string; contentBase64: string; mode?: number }
  | { kind: "commitMove"; path: string; type: "file" | "directory" }
  | { kind: "mkdir"; path: string }
  | { kind: "pause"; resumeSignalPath: string }
  | { kind: "commit" };

// Blocks the event loop synchronously (Node has no sync sleep primitive
// otherwise) so a test harness has a stable window to SIGKILL this process
// mid-transaction, mirroring how scripts/test-install-acceptance.sh waits
// for a known installer log line before its own kill -9.
function blockUntil(predicate: () => boolean, pollMs = 25): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  while (!predicate()) {
    Atomics.wait(signal, 0, 0, pollMs);
  }
}

// Hidden/experimental: exercises InstallTransaction end-to-end for issue
// #295 slice 1's interruption characterization test. Never invoked by any
// shipped install/update/check flow, and deliberately undocumented in the
// usage message below.
function commandInstallTransactionRehearse(scenarioPath: string): never {
  const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as RehearsalScenario;
  const transaction = InstallTransaction.begin(scenario.targetDir, scenario.managedPaths);
  try {
    for (const step of scenario.steps) {
      switch (step.kind) {
        case "write":
          transaction.writeStagedFile(step.path, Buffer.from(step.contentBase64, "base64"), step.mode);
          break;
        case "commitMove":
          transaction.commitMove(step.path, step.type);
          break;
        case "mkdir":
          transaction.ensureManagedDirectory(step.path);
          break;
        case "pause":
          process.stdout.write("phase=paused\n");
          blockUntil(() => existsSync(step.resumeSignalPath));
          break;
        case "commit":
          transaction.commit();
          break;
      }
    }
  } finally {
    transaction.dispose();
  }
  process.exit(0);
}

// Scenario shape and fake adapter for the hidden __restore-engine-rehearse
// subcommand below: exercises RestoreRun/recoverRestore (issue #296 slice 3)
// end-to-end, including a real, self-delivered SIGKILL at a chosen mutating
// step, for the interruption characterization test in
// src/lib/restore-engine.interruption.test.ts. Not a documented interface,
// and — unlike the install-transaction rehearsal, which pauses for an
// external kill — this mirrors restore.sh's own test harness
// (ORBIT_RESTORE_TEST_HARD_INTERRUPT_STAGE) by having the process signal
// itself once the target step completes: deterministic, no race window.
// The "Docker/Postgres" this fake adapter stands in for are a real
// on-disk document tree and a JSON file (never a live daemon) — restore.sh
// itself is not invoked or modified.
interface RestoreRehearsalDocumentSpec {
  storageKey: string;
  contentLength: number;
  fillByte: number;
}

interface RestoreRehearsalScenario {
  backupDirectory: string;
  documentKekFile: string;
  liveDocumentsRoot: string;
  liveDatabaseFile: string;
  original: RestoreRehearsalDocumentSpec;
  updated: RestoreRehearsalDocumentSpec;
  mode: "forward" | "recover";
  hardKillAfter?: "checkpoint" | "documents-replaced" | "database-restored";
}

const REHEARSAL_DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";

function buildCorrespondenceReports(spec: RestoreRehearsalDocumentSpec): CorrespondenceReports {
  return {
    crypto: `${REHEARSAL_DOCUMENT_ID}|${spec.storageKey}|${spec.contentLength}|available\n`,
    visible: `${REHEARSAL_DOCUMENT_ID}|available|${spec.storageKey}|${spec.contentLength}\n`,
    attachments: "",
    staging: "",
    documentStaging: "",
    transientCount: "0",
  };
}

function buildDocumentTree(root: string, spec: RestoreRehearsalDocumentSpec): void {
  rmSync(root, { recursive: true, force: true });
  const objectDir = join(root, "objects", spec.storageKey.slice(0, 2), spec.storageKey.slice(2, 4));
  mkdirSync(objectDir, { recursive: true });
  mkdirSync(join(root, "staging"), { recursive: true });
  writeFileSync(join(objectDir, `${spec.storageKey}.bin`), Buffer.alloc(spec.contentLength, spec.fillByte));
}

function writeFakeDatabaseBlob(path: string, spec: RestoreRehearsalDocumentSpec): void {
  writeFileSync(path, JSON.stringify({ reports: buildCorrespondenceReports(spec) }), { mode: 0o600 });
}

function lookupReportField(reports: CorrespondenceReports, query: string): string {
  const entry = (Object.entries(CORRESPONDENCE_QUERIES) as Array<[keyof CorrespondenceReports, string]>).find(([, text]) => text === query);
  if (!entry) throw new Error("orbit: rehearsal fake adapter received an unrecognised correspondence query");
  return reports[entry[0]];
}

class RestoreRehearsalFakeAdapter implements RestoreDockerAdapter {
  private readonly stageContents = new Map<string, CorrespondenceReports>();
  private appRunning = true;

  constructor(
    private readonly liveDocumentsRoot: string,
    private readonly liveDatabaseFile: string,
  ) {}

  dumpDatabase(outputPath: string): void {
    copyFileSync(this.liveDatabaseFile, outputPath);
  }
  pgRestoreListOk(dumpPath: string): boolean {
    try {
      JSON.parse(readFileSync(dumpPath, "utf8"));
      return true;
    } catch {
      return false;
    }
  }
  collectDocumentsArchive(outputPath: string): void {
    createTar(this.liveDocumentsRoot, outputPath, ["."]);
  }
  stopApp(): boolean {
    this.appRunning = false;
    return true;
  }
  startApp(): boolean {
    this.appRunning = true;
    return true;
  }
  createStageDatabase(): void {
    // No real database in this fake: restoreDumpToDatabase records content
    // keyed by name, which is all queryReport needs.
  }
  dropStageDatabase(name: string): void {
    this.stageContents.delete(name);
  }
  restoreDumpToDatabase(name: string, dumpPath: string): boolean {
    const blob = JSON.parse(readFileSync(dumpPath, "utf8")) as { reports: CorrespondenceReports };
    this.stageContents.set(name, blob.reports);
    return true;
  }
  restoreActiveDatabase(dumpPath: string): boolean {
    copyFileSync(dumpPath, this.liveDatabaseFile);
    return true;
  }
  replaceDocumentsFromArchive(archivePath: string): boolean {
    rmSync(this.liveDocumentsRoot, { recursive: true, force: true });
    mkdirSync(this.liveDocumentsRoot, { recursive: true });
    extractTar(archivePath, this.liveDocumentsRoot);
    return true;
  }
  resetScanRecoveryLeases(): boolean {
    return true;
  }
  queryReport(name: string, query: string): string {
    const reports = this.stageContents.get(name);
    if (!reports) throw new Error("orbit: rehearsal fake adapter has no staged content for this database name");
    return lookupReportField(reports, query);
  }
  queryActiveReport(query: string): string {
    const blob = JSON.parse(readFileSync(this.liveDatabaseFile, "utf8")) as { reports: CorrespondenceReports };
    return lookupReportField(blob.reports, query);
  }
  waitForHealth(): boolean {
    return this.appRunning;
  }
}

function commandRestoreEngineRehearse(scenarioPath: string): never {
  const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as RestoreRehearsalScenario;
  const adapter = new RestoreRehearsalFakeAdapter(scenario.liveDocumentsRoot, scenario.liveDatabaseFile);
  const paths = deriveRestorePaths(scenario.backupDirectory, scenario.documentKekFile);

  if (scenario.mode === "recover") {
    const workDir = mkdtempSync(join(scenario.backupDirectory, ".rehearsal-recover-work."));
    try {
      recoverRestore({ adapter, paths, workDir });
      process.stdout.write("outcome=recovered\n");
      process.exit(0);
    } catch (error) {
      process.stdout.write(`outcome=failed message=${(error as Error).message}\n`);
      process.exit(1);
    }
  }

  buildDocumentTree(scenario.liveDocumentsRoot, scenario.original);
  writeFakeDatabaseBlob(scenario.liveDatabaseFile, scenario.original);

  const workDir = mkdtempSync(join(scenario.backupDirectory, ".rehearsal-work."));
  const run = RestoreRun.prepare({ adapter, paths, workDir });

  try {
    run.createCheckpoint();
    if (scenario.hardKillAfter === "checkpoint") process.kill(process.pid, "SIGKILL");

    const updatedDocumentsRoot = mkdtempSync(join(scenario.backupDirectory, ".rehearsal-updated-docs."));
    buildDocumentTree(updatedDocumentsRoot, scenario.updated);
    const updatedDocumentsTar = join(workDir, "updated-documents.tar");
    createTar(updatedDocumentsRoot, updatedDocumentsTar, ["."]);
    run.cutoverDocuments(updatedDocumentsTar);
    if (scenario.hardKillAfter === "documents-replaced") process.kill(process.pid, "SIGKILL");

    const updatedDatabaseDump = join(workDir, "updated-database.dump");
    writeFakeDatabaseBlob(updatedDatabaseDump, scenario.updated);
    run.cutoverDatabase(updatedDatabaseDump);
    if (scenario.hardKillAfter === "database-restored") process.kill(process.pid, "SIGKILL");

    run.finalize();
    process.stdout.write("outcome=completed\n");
    process.exit(0);
  } catch (error) {
    run.dispose();
    process.stdout.write(`outcome=failed message=${(error as Error).message}\n`);
    process.exit(1);
  }
}

function main(): void {
  const [, , command, ...rest] = process.argv;

  if (command === "__install-transaction-rehearse") {
    const scenarioPath = rest[0];
    if (!scenarioPath) fail("orbit: __install-transaction-rehearse requires a scenario file path");
    commandInstallTransactionRehearse(scenarioPath);
    return;
  }

  if (command === "__restore-engine-rehearse") {
    const scenarioPath = rest[0];
    if (!scenarioPath) fail("orbit: __restore-engine-rehearse requires a scenario file path");
    commandRestoreEngineRehearse(scenarioPath);
    return;
  }

  let deployDir = process.cwd();
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--dir" && rest[index + 1]) {
      deployDir = resolve(rest[index + 1]);
      index += 1;
    } else {
      fail(`orbit: unknown option ${rest[index]}`);
    }
  }
  switch (command) {
    case "check":
      commandCheck(deployDir);
      break;
    default:
      fail("orbit: supported commands: check [--dir <deployment>]");
  }
}

main();
