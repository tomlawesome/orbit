import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Process-level interruption characterization for issue #296 slice 3: a
// SIGKILL cannot be trapped by Node any more than by Bash, so this proves
// RestoreRun/recoverRestore leave the exact same recovery evidence
// scripts/test-backup-restore.sh's own test_hard_interruption_recovery
// asserts for restore.sh (catalogue Part 2 / restore.sh — guarantees
// #15-17,#31-37): a durable journal + a durable, self-verified checkpoint
// survive the kill, and a fresh `--recover`-equivalent process, run
// afterwards, always restores the *original* (checkpointed) state —
// regardless of which live mutation had or hadn't completed at the moment
// of the kill. Drives the hidden, undocumented
// `orbit __restore-engine-rehearse` subcommand (src/cli/orbit.ts), wired
// only to make this characterization possible — not a shipped flow, and
// restore.sh itself is never invoked or modified.
//
// Unlike install-transaction.interruption.test.ts (which pauses and is
// killed externally, because it needs to interrupt *before* a specific
// write at an arbitrary point), this mirrors restore.sh's own test harness
// (ORBIT_RESTORE_TEST_HARD_INTERRUPT_STAGE): the rehearsal process signals
// *itself* once the target step has genuinely completed — deterministic,
// no race window between "the step ran" and "the kill lands".

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliEntry = fileURLToPath(new URL("../cli/orbit.ts", import.meta.url));
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

interface DocumentSpec {
  storageKey: string;
  contentLength: number;
  fillByte: number;
}

const ORIGINAL: DocumentSpec = { storageKey: "a".repeat(64), contentLength: 11, fillByte: 1 };
const UPDATED: DocumentSpec = { storageKey: "b".repeat(64), contentLength: 22, fillByte: 2 };

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "orbit-restore-engine-interrupt-"));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function objectPath(documentsRoot: string, spec: DocumentSpec): string {
  return join(documentsRoot, "objects", spec.storageKey.slice(0, 2), spec.storageKey.slice(2, 4), `${spec.storageKey}.bin`);
}

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
}

function runRehearsal(scenario: Record<string, unknown>): Promise<RunResult> {
  const scenarioPath = join(sandbox, `scenario-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  return new Promise((resolvePromise, reject) => {
    const child = spawn("node", [tsxCli, cliEntry, "__restore-engine-rehearse", scenarioPath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      // A self-delivered SIGKILL is reported as signal="SIGKILL" (code=null)
      // by Node directly, or as the POSIX 128+SIGKILL exit code 137 when an
      // intervening layer (a container/sandbox init) converts the signal
      // into a wait-status exit code — both are the same underlying kill,
      // so both are accepted as "the process was killed", not a failure.
      const wasKilled = signal === "SIGKILL" || code === 137;
      if (code !== 0 && !wasKilled && !stdout.includes("outcome=")) {
        reject(new Error(`rehearsal process failed unexpectedly (code=${code}, signal=${signal}): ${stderr}`));
        return;
      }
      resolvePromise({ code, signal, stdout });
    });
  });
}

function baseScenario(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const backupDirectory = join(sandbox, "backups");
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const documentKekFile = join(sandbox, "document-kek");
  writeFileSync(documentKekFile, `${"a".repeat(64)}\n`, { mode: 0o600 });
  return {
    backupDirectory,
    documentKekFile,
    liveDocumentsRoot: join(sandbox, "live-documents"),
    liveDatabaseFile: join(sandbox, "live-database.json"),
    original: ORIGINAL,
    updated: UPDATED,
    mode: "forward",
    ...overrides,
  };
}

describe.each([
  ["checkpoint", "checkpointed"],
  ["documents-replaced", "documents-replaced"],
  ["database-restored", "database-restored"],
] as const)("SIGKILL after %s: journal/checkpoint survive, and --recover always restores the original state", (hardKillAfter, expectedState) => {
  it(`leaves a durable journal (state=${expectedState}) and self-verified checkpoint, then recovers cleanly`, async () => {
    const scenario = baseScenario({ hardKillAfter });
    const result = await runRehearsal(scenario);

    // A self-delivered SIGKILL means the process never runs its own
    // `process.exit`: Node reports this as signal="SIGKILL" (code=null)
    // directly, or — under this sandbox's process supervision — as the
    // POSIX wait-status exit code 137 (128+SIGKILL). Either way, the
    // process never reached its own `outcome=` stdout line.
    expect(result.signal === "SIGKILL" || result.code === 137).toBe(true);
    expect(result.stdout).not.toContain("outcome=");

    const journalPath = join(scenario.backupDirectory as string, ".orbit-restore", "restore.journal");
    const journalContent = readFileSync(journalPath, "utf8");
    expect(journalContent).toContain(`state=${expectedState}\n`);
    expect(journalContent).toMatch(/^format_version=1\n/);
    expect(journalContent).toMatch(/database_sha256=[0-9a-f]{64}\n/);
    expect(journalContent).toMatch(/documents_sha256=[0-9a-f]{64}\n/);
    expect(journalContent).toMatch(/document_kek_sha256=[0-9a-f]{64}\n/);

    const restoreRoot = join(scenario.backupDirectory as string, ".orbit-restore");
    const checkpointDirs = readdirSync(restoreRoot).filter((name) => name.startsWith("checkpoint-"));
    expect(checkpointDirs.length).toBe(1);
    const checkpointDirectory = join(restoreRoot, checkpointDirs[0]);
    for (const member of ["database.dump", "documents.tar", "document-kek"]) {
      expect(existsSync(join(checkpointDirectory, member))).toBe(true);
    }

    // A fresh process, run afterwards, always fully recovers — regardless
    // of which live mutation had (or hadn't) already completed.
    const recoverResult = await runRehearsal(baseScenario({ mode: "recover", backupDirectory: scenario.backupDirectory, documentKekFile: scenario.documentKekFile, liveDocumentsRoot: scenario.liveDocumentsRoot, liveDatabaseFile: scenario.liveDatabaseFile }));
    expect(recoverResult.signal).toBeNull();
    expect(recoverResult.code).toBe(0);
    expect(recoverResult.stdout).toContain("outcome=recovered");

    // Live documents must reflect the ORIGINAL checkpointed state, never
    // the interrupted, half-applied UPDATED one.
    expect(readFileSync(objectPath(scenario.liveDocumentsRoot as string, ORIGINAL))).toHaveLength(ORIGINAL.contentLength);
    expect(existsSync(objectPath(scenario.liveDocumentsRoot as string, UPDATED))).toBe(false);
    expect(() => readFileSync(journalPath)).toThrow();
    expect(existsSync(restoreRoot) ? readdirSync(restoreRoot).filter((name) => name.startsWith("checkpoint-")) : []).toHaveLength(0);
  }, 20_000);
});

describe("SIGKILL before any checkpoint exists", () => {
  it("running --recover with no journal at all fails closed rather than guessing", async () => {
    const scenario = baseScenario({ mode: "recover" });
    const result = await runRehearsal(scenario);
    expect(result.signal).toBeNull();
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("outcome=failed");
  });
});
