import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { sha256File } from "./recovery-bundle";
import { CORRESPONDENCE_QUERIES, RESTORE_CAPACITY_HEADROOM_KIB, SCAN_RECOVERY_LEASES_SQL, checkRestoreCapacity } from "./restore-engine";

// Byte-for-byte / literal-execution parity between restore.sh and this
// module's restore.sh-derived constants (issue #296 slice 3), following the
// same discipline install-transaction.parity.test.ts established for #295
// slice 1: restore.sh has no standalone entry point for its checkpoint/
// journal/correspondence logic (it always needs a live Docker/Postgres
// deployment to reach past preflight), so these are genuine mechanical
// extractions via `awk` — never hand-copied — either compared as literal
// text (the six validate_correspondence SQL queries and the scan-lease
// reset SQL, which are pure string literals in the Bash source) or actually
// executed as a real Bash subprocess (checkpoint_sha256, which is
// Docker-free on its own). If any cited anchor or function is ever renamed
// or restructured in restore.sh, extraction fails loudly rather than
// silently comparing against stale text.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const restoreScriptPath = join(repoRoot, "scripts", "restore.sh");

/** Finds the first line in restore.sh containing `anchor` (plain substring, via awk's index() — no regex-escaping needed). */
function extractLineContaining(anchor: string): string {
  const result = spawnSync("awk", ["-v", `anchor=${anchor}`, "index($0, anchor) { print; exit }", restoreScriptPath], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Could not find a restore.sh line containing "${anchor}"; it may have been rewritten.`);
  }
  return result.stdout;
}

/**
 * Extracts a single-quoted Bash string literal from the line containing
 * `anchor`, undoing Bash's `'\''`-embedded-quote escaping — the same
 * mechanical transform `sh -c '...'` itself undoes at parse time — so the
 * result is the literal argument text restore.sh actually passes to psql,
 * not the Bash source syntax.
 */
function extractSingleQuotedSqlLiteral(anchor: string): string {
  const line = extractLineContaining(anchor).trim();
  const match = /^'(.*)'\s*\\?\s*$/.exec(line);
  if (!match) {
    throw new Error(`restore.sh line containing "${anchor}" was not a single-quoted literal on its own line: ${line}`);
  }
  return match[1].split("'\\''").join("'");
}

function extractFunction(name: string): string {
  const script = `$0 ~ "^${name}\\\\(\\\\) \\\\{" { found = 1 } found { print; if ($0 == "}") { found = 0; exit } }`;
  const result = spawnSync("awk", [script, restoreScriptPath], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Could not extract ${name}() from restore.sh; it may have been renamed.`);
  }
  return result.stdout;
}

describe("CORRESPONDENCE_QUERIES parity against restore.sh's literal psql --command text (awk-extracted)", () => {
  it("crypto query matches restore.sh's document_crypto report literally", () => {
    expect(extractSingleQuotedSqlLiteral("FROM document_crypto c LEFT JOIN documents d")).toBe(CORRESPONDENCE_QUERIES.crypto);
  });

  it("visible query matches restore.sh's documents/document_crypto report literally", () => {
    expect(extractSingleQuotedSqlLiteral("FROM documents d LEFT JOIN document_crypto c")).toBe(CORRESPONDENCE_QUERIES.visible);
  });

  it("attachments query matches restore.sh's imap_ingestion_attachments report literally", () => {
    expect(extractSingleQuotedSqlLiteral("FROM imap_ingestion_attachments a")).toBe(CORRESPONDENCE_QUERIES.attachments);
  });

  it("staging query matches restore.sh's imap_ingestion_staging_objects report literally", () => {
    expect(extractSingleQuotedSqlLiteral("FROM imap_ingestion_staging_objects s")).toBe(CORRESPONDENCE_QUERIES.staging);
  });

  it("documentStaging query matches restore.sh's document_staging_objects report literally", () => {
    expect(extractSingleQuotedSqlLiteral("FROM document_staging_objects s WHERE s.status IN")).toBe(CORRESPONDENCE_QUERIES.documentStaging);
  });

  it("transientCount query matches restore.sh's transient-lifecycle count literally", () => {
    expect(extractSingleQuotedSqlLiteral("count(*)::text FROM documents d WHERE d.lifecycle IN (")).toBe(CORRESPONDENCE_QUERIES.transientCount);
  });

  it("the same six queries appear byte-for-byte at restore.sh's query_active_report call sites too (restore.sh:623-652)", () => {
    // validate_active_correspondence's query_active_report calls duplicate
    // the identical query text against the live database instead of a
    // private stage — this module intentionally shares one constant for
    // both (see restore-engine.ts's module comment on consolidating the
    // duplication), so every query text must appear at least twice in the
    // real script.
    const script = readFileSync(restoreScriptPath, "utf8");
    for (const query of Object.values(CORRESPONDENCE_QUERIES)) {
      // Re-escape the query the same way restore.sh embeds it, to count occurrences robustly.
      const escaped = query.replace(/'/g, "'\\''");
      const occurrences = script.split(escaped).length - 1;
      expect(occurrences).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("SCAN_RECOVERY_LEASES_SQL parity", () => {
  it("matches restore.sh's reset_scan_recovery_leases psql command literally", () => {
    expect(extractSingleQuotedSqlLiteral("UPDATE document_jobs AS job SET status")).toBe(SCAN_RECOVERY_LEASES_SQL);
  });
});

describe("checkpoint_sha256 parity (extracted and executed as a real Bash subprocess, no Docker)", () => {
  let driverDir: string;

  afterEach(() => {
    if (driverDir) rmSync(driverDir, { recursive: true, force: true });
  });

  it("computes the identical digest sha256File does, for the same file content, using restore.sh's own unmodified function body", () => {
    const extracted = extractFunction("checkpoint_sha256");
    driverDir = mkdtempSync(join(tmpdir(), "orbit-restore-checkpoint-sha256-parity-"));
    const targetFile = join(driverDir, "artifact");
    writeFileSync(targetFile, "some checkpoint artifact bytes\n");
    const driverPath = join(driverDir, "driver.sh");
    writeFileSync(driverPath, ["#!/usr/bin/env bash", "set -Eeuo pipefail", extracted, 'checkpoint_sha256 "$1"', ""].join("\n"), { mode: 0o755 });

    const result = spawnSync("bash", [driverPath, targetFile], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(sha256File(targetFile));
    expect(result.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses (empty stdout, nonzero exit) for a nonexistent file, exactly as sha256File's caller must treat a failure", () => {
    const extracted = extractFunction("checkpoint_sha256");
    driverDir = mkdtempSync(join(tmpdir(), "orbit-restore-checkpoint-sha256-parity-missing-"));
    const driverPath = join(driverDir, "driver.sh");
    writeFileSync(driverPath, ["#!/usr/bin/env bash", "set -Eeuo pipefail", extracted, 'checkpoint_sha256 "$1"', ""].join("\n"), { mode: 0o755 });

    const result = spawnSync("bash", [driverPath, join(driverDir, "does-not-exist")], { encoding: "utf8" });

    expect(result.status).not.toBe(0);
  });
});

describe("load_recovery_journal format-validation regex parity", () => {
  it("restore.sh's restore_id/state enum validation regex text matches this module's own patterns", () => {
    const extracted = extractFunction("load_recovery_journal");
    // RESTORE_ID_PATTERN's source, and the four-state enum this module's
    // RestoreJournalState/RESTORE_JOURNAL_STATES mirror exactly.
    expect(extracted).toContain("[A-Za-z0-9_-]+");
    expect(extracted).toContain("checkpointed|documents-replaced|database-restored|rollback-failed");
    expect(extracted).toContain('"600"'); // mode-600 permission check this module's loadRestoreJournal also enforces.
  });
});

describe("check_capacity parity (extracted and executed as a real Bash subprocess, guarantees #11-12)", () => {
  // check_capacity (restore.sh:355-397) is deferred by slice 3, in scope for
  // slice 4 (docs/adr-notes/296-backup-port-plan.md). Its own `du`/`stat`/
  // `df` calls (host-side) and `compose exec`/`compose run` calls
  // (container-side psql/du/df) are all replaced by PATH-shim fakes and an
  // inline `compose` shell function — the same "spawn the real, unmodified
  // function body against fakes" technique checkpoint_sha256's own parity
  // test above uses, extended to a function with more external dependents.
  // No Docker daemon is reached; the function body itself is never edited.
  let driverDir: string;

  afterEach(() => {
    if (driverDir) rmSync(driverDir, { recursive: true, force: true });
  });

  interface CapacityScenario {
    stagedKib: number;
    backupBytes: number;
    databaseBytes: number;
    documentKib: number;
    hostAvailableKib: number;
    tempAvailableKib: number;
    volumeAvailableKib: number;
  }

  function runExtractedCheckCapacity(scenario: CapacityScenario): { status: number | null; stderr: string } {
    driverDir = mkdtempSync(join(tmpdir(), "orbit-check-capacity-parity-"));
    const binDir = join(driverDir, "bin");
    mkdirSync(binDir, { recursive: true });

    const backupDirectory = join(driverDir, "backup-directory");
    const temporaryDirectory = join(driverDir, "temporary-directory");
    mkdirSync(join(temporaryDirectory, "staged-documents"), { recursive: true });
    mkdirSync(backupDirectory, { recursive: true });
    const backupFile = join(driverDir, "backup-file.tar");
    writeFileSync(backupFile, "x");

    // Fakes: `du`/`stat` each have exactly one host-side call site in
    // check_capacity, so a single fixed value suffices; `df` has two
    // (backup_directory vs. temporary_directory), distinguished by its path
    // argument, matching real `df -Pk <path>`'s own argv shape.
    writeFileSync(join(binDir, "du"), `#!/bin/sh\nprintf '%s\\t%s\\n' "${scenario.stagedKib}" "$*"\n`, { mode: 0o755 });
    writeFileSync(join(binDir, "stat"), `#!/bin/sh\nprintf '%s\\n' "${scenario.backupBytes}"\n`, { mode: 0o755 });
    writeFileSync(
      join(binDir, "df"),
      [
        "#!/bin/sh",
        `case "$2" in`,
        `  "${backupDirectory}") avail="${scenario.hostAvailableKib}" ;;`,
        `  "${temporaryDirectory}") avail="${scenario.tempAvailableKib}" ;;`,
        `  *) avail=0 ;;`,
        "esac",
        `printf 'Filesystem 1024-blocks Used Available Capacity Mounted-on\\nfake 1 1 %s 1%% /\\n' "$avail"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    for (const name of ["du", "stat", "df"]) chmodSync(join(binDir, name), 0o755);

    const extracted = extractFunction("check_capacity");
    const driverPath = join(driverDir, "driver.sh");
    writeFileSync(
      driverPath,
      [
        "#!/usr/bin/env bash",
        "set -Eeuo pipefail",
        `backup_directory=${JSON.stringify(backupDirectory)}`,
        `temporary_directory=${JSON.stringify(temporaryDirectory)}`,
        `backup_file=${JSON.stringify(backupFile)}`,
        "fail() { printf '%s\\n' \"$*\" >&2; exit 1; }",
        "compose() {",
        '  case "$*" in',
        "    *pg_database_size*) printf '%s' " + JSON.stringify(String(scenario.databaseBytes)) + " ;;",
        `    *"du -sk /var/lib/orbit/documents"*) printf '%s' ${JSON.stringify(String(scenario.documentKib))} ;;`,
        `    *"df -Pk /var/lib/orbit/documents"*) printf '%s' ${JSON.stringify(String(scenario.volumeAvailableKib))} ;;`,
        "    *) return 1 ;;",
        "  esac",
        "}",
        extracted,
        "check_capacity",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync("bash", [driverPath], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });
    return { status: result.status, stderr: result.stderr };
  }

  function tsCapacityOk(scenario: CapacityScenario): boolean {
    try {
      checkRestoreCapacity({
        stagedDocumentsKib: scenario.stagedKib,
        backupBytes: scenario.backupBytes,
        currentDatabaseBytes: scenario.databaseBytes,
        currentDocumentKib: scenario.documentKib,
        hostAvailableKib: scenario.hostAvailableKib,
        tempAvailableKib: scenario.tempAvailableKib,
        volumeAvailableKib: scenario.volumeAvailableKib,
      });
      return true;
    } catch {
      return false;
    }
  }

  const comfortable: CapacityScenario = {
    stagedKib: 100,
    backupBytes: 100 * 1024,
    databaseBytes: 50 * 1024,
    documentKib: 40,
    hostAvailableKib: 10_000_000,
    tempAvailableKib: 10_000_000,
    volumeAvailableKib: 10_000_000,
  };

  it("both implementations accept the same comfortably-provisioned measurements", () => {
    const bashResult = runExtractedCheckCapacity(comfortable);
    expect(bashResult.status).toBe(0);
    expect(tsCapacityOk(comfortable)).toBe(true);
  });

  it("both implementations refuse at the exact same backup-directory threshold (backup+db+doc+2*staged+2*64MiB headroom)", () => {
    const requiredKib =
      Math.ceil(comfortable.backupBytes / 1024) + Math.ceil(comfortable.databaseBytes / 1024) + comfortable.documentKib + comfortable.stagedKib * 2 + RESTORE_CAPACITY_HEADROOM_KIB * 2;

    const atThreshold = { ...comfortable, hostAvailableKib: requiredKib };
    const belowThreshold = { ...comfortable, hostAvailableKib: requiredKib - 1 };

    expect(runExtractedCheckCapacity(atThreshold).status).toBe(0);
    expect(tsCapacityOk(atThreshold)).toBe(true);

    expect(runExtractedCheckCapacity(belowThreshold).status).not.toBe(0);
    expect(tsCapacityOk(belowThreshold)).toBe(false);
  });

  it("both implementations refuse at the exact same temp-filesystem threshold (staged+doc+64MiB headroom)", () => {
    const requiredKib = comfortable.stagedKib + comfortable.documentKib + RESTORE_CAPACITY_HEADROOM_KIB;
    const atThreshold = { ...comfortable, tempAvailableKib: requiredKib };
    const belowThreshold = { ...comfortable, tempAvailableKib: requiredKib - 1 };

    expect(runExtractedCheckCapacity(atThreshold).status).toBe(0);
    expect(tsCapacityOk(atThreshold)).toBe(true);

    expect(runExtractedCheckCapacity(belowThreshold).status).not.toBe(0);
    expect(tsCapacityOk(belowThreshold)).toBe(false);
  });

  it("both implementations refuse at the exact same document-volume threshold (volumeAvailable + currentDocument >= staged)", () => {
    const requiredVolumeAvailable = comfortable.stagedKib - comfortable.documentKib;
    const atThreshold = { ...comfortable, volumeAvailableKib: requiredVolumeAvailable };
    const belowThreshold = { ...comfortable, volumeAvailableKib: requiredVolumeAvailable - 1 };

    expect(runExtractedCheckCapacity(atThreshold).status).toBe(0);
    expect(tsCapacityOk(atThreshold)).toBe(true);

    expect(runExtractedCheckCapacity(belowThreshold).status).not.toBe(0);
    expect(tsCapacityOk(belowThreshold)).toBe(false);
  });
});
