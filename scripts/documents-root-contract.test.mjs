import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #1151 SF2-F1: docker-compose.yml documents DOCUMENTS_ROOT as operator-
// configurable (README.md, src/server/documents/config.ts's own default),
// but the compose volume mount and every backup.sh/restore.sh command that
// reads or replaces the document tree used to hard-code
// /var/lib/orbit/documents regardless of it. An operator who changed
// DOCUMENTS_ROOT got an app that wrote documents outside the mounted
// volume, and backups that silently archived the wrong (empty) directory.
//
// Fix: the compose volume target reads the container's own DOCUMENTS_ROOT
// (already passed through by env_file: .env-orbit) via
// `${DOCUMENTS_ROOT:-/var/lib/orbit/documents}`, and so does the backup/
// restore engine that runs inside the deployment (#1211), so both track
// whatever the app itself resolves, with the same default.

const composeSource = readFileSync(join(import.meta.dirname, "..", "docker-compose.yml"), "utf8");
const shellSources = ["backup.sh", "restore.sh", "export-recovery-bundle.sh", "import-recovery-bundle.sh"].map((name) => [
  name,
  readFileSync(join(import.meta.dirname, name), "utf8"),
]);

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

  // #1211: the shells no longer touch the document tree at all. The engine
  // reads it inside the deployment, from the container's own DOCUMENTS_ROOT
  // (src/lib/in-container-adapter.ts; in-container-adapter.test.ts proves
  // the tar argv with and without it).
  it.each(shellSources)("%s never names the document tree; the engine finds it from DOCUMENTS_ROOT", (_name, source) => {
    expect(source).not.toContain("/var/lib/orbit/documents");
    expect(source).not.toContain("DOCUMENTS_ROOT");
  });
});
