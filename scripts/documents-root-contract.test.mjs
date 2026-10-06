import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// #1151 SF2-F1: docker-compose.yml documents DOCUMENTS_ROOT as operator-
// configurable (README.md, src/server/documents/config.ts's own default),
// but the compose volume mount and every backup.sh/restore.sh command that
// reads or replaces the document tree used to hard-code
// /var/lib/orbit/documents regardless of it. An operator who changed
// DOCUMENTS_ROOT got an app that wrote documents outside the mounted
// volume, and backups that silently archived the wrong (empty) directory.
//
// Fix: the compose volume target and every backup.sh/restore.sh command now
// read the container's own DOCUMENTS_ROOT (already passed through by
// env_file: .env-orbit) via `${DOCUMENTS_ROOT:-/var/lib/orbit/documents}`,
// so they track whatever the app itself resolves, with the same default.

const backupScriptSource = readFileSync(join(import.meta.dirname, "backup.sh"), "utf8");
const restoreScriptSource = readFileSync(join(import.meta.dirname, "restore.sh"), "utf8");
const composeSource = readFileSync(join(import.meta.dirname, "..", "docker-compose.yml"), "utf8");

const defaultDocumentsRoot = "/var/lib/orbit/documents";

// A literal occurrence of the default path that is NOT the fallback half of
// "${DOCUMENTS_ROOT:-...}" is exactly the regression this fix closes: a
// reader that forgot the operator's own value. Matches the literal path
// only when it is not immediately preceded by "DOCUMENTS_ROOT:-".
function bareLiteralOccurrences(source) {
  const pattern = /(?<!DOCUMENTS_ROOT:-)\/var\/lib\/orbit\/documents/gu;
  return [...source.matchAll(pattern)].map((match) => match[0]);
}

describe("DOCUMENTS_ROOT is read consistently, never hard-coded (#1151 SF2-F1)", () => {
  it("docker-compose.yml mounts the documents volume at ${DOCUMENTS_ROOT:-/var/lib/orbit/documents}", () => {
    expect(composeSource).toContain("- orbit-documents-data:${DOCUMENTS_ROOT:-/var/lib/orbit/documents}");
    expect(bareLiteralOccurrences(composeSource)).toEqual([]);
  });

  it("backup.sh never hard-codes the default path outside the DOCUMENTS_ROOT fallback", () => {
    expect(bareLiteralOccurrences(backupScriptSource)).toEqual([]);
    expect(backupScriptSource).toContain('"${DOCUMENTS_ROOT:-/var/lib/orbit/documents}"');
  });

  it("restore.sh never hard-codes the default path outside the DOCUMENTS_ROOT fallback, at every one of its five document-tree call sites", () => {
    expect(bareLiteralOccurrences(restoreScriptSource)).toEqual([]);
    const occurrences = restoreScriptSource.match(/\$\{DOCUMENTS_ROOT:-\/var\/lib\/orbit\/documents\}/gu) ?? [];
    expect(occurrences.length).toBe(5);
  });
});

// Extracts the exact single-quoted `sh -c '...'` argument backup.sh passes
// to the one-off `compose run --entrypoint sh orbit-app` call that archives
// documents -- pulled from the real file, never a hand-typed duplicate, so
// a drift in the live script is what this test actually runs.
function extractBackupDocumentsShellScript() {
  const match = backupScriptSource.match(
    /compose run --rm --no-deps --entrypoint sh orbit-app -c \\\n\s*'([^']*)'/u,
  );
  if (!match) throw new Error("Could not find backup.sh's documents-archive compose invocation");
  return match[1];
}

const scratchDirs = [];

afterEach(() => {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop(), { recursive: true, force: true });
});

function makeFakeTarBin() {
  const binDir = mkdtempSync(join(tmpdir(), "orbit-documents-root-fakebin-"));
  scratchDirs.push(binDir);
  const logPath = join(binDir, "tar.log");
  writeFileSync(join(binDir, "tar"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(logPath)}\nexit 0\n`);
  chmodSync(join(binDir, "tar"), 0o755);
  return { binDir, logPath };
}

describe("backup.sh's documents-archive command, run for real against a fake tar", () => {
  it("passes the operator's DOCUMENTS_ROOT to tar's -C when set", () => {
    const script = extractBackupDocumentsShellScript();
    const { binDir, logPath } = makeFakeTarBin();
    const result = failOnProcessDeadline(
      spawnSync("sh", ["-c", script], {
        encoding: "utf8",
        env: { PATH: `${binDir}:${process.env.PATH}`, DOCUMENTS_ROOT: "/srv/orbit-documents" },
        ...processGuard(),
      }),
      { label: "backupDocumentsScriptCustom" },
    );
    expect(result.status).toBe(0);
    expect(readFileSync(logPath, "utf8").trim()).toBe("-C /srv/orbit-documents -cf - .");
  });

  it("falls back to the documented default when DOCUMENTS_ROOT is unset, matching src/server/documents/config.ts's own default", () => {
    const script = extractBackupDocumentsShellScript();
    const { binDir, logPath } = makeFakeTarBin();
    const result = failOnProcessDeadline(
      spawnSync("sh", ["-c", script], {
        encoding: "utf8",
        env: { PATH: `${binDir}:${process.env.PATH}` },
        ...processGuard(),
      }),
      { label: "backupDocumentsScriptDefault" },
    );
    expect(result.status).toBe(0);
    expect(readFileSync(logPath, "utf8").trim()).toBe(`-C ${defaultDocumentsRoot} -cf - .`);
  });
});
