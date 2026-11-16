import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createTar } from "./recovery-bundle";
import { type CorrespondenceReports, type RestoreDockerAdapter, CORRESPONDENCE_QUERIES, internal } from "./restore-engine";

// #1838 / ADR-0046 point 7: kept page previews are in the backup, so the
// restore engine's own copy of the document-archive allow-list must accept a
// documents tree that holds previews/ (empty, or with a drawn preview). The
// check swallows a refusal and answers false, so a healthy tree that answers
// false here is a refused archive.

const STORAGE_KEY = "ab".repeat(32);
const PREVIEW_KEY = "12".repeat(32);
const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";

const sandboxes: string[] = [];
afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

const healthyReports: CorrespondenceReports = {
  crypto: `${DOCUMENT_ID}|${STORAGE_KEY}|10|available\n`,
  visible: `${DOCUMENT_ID}|available|${STORAGE_KEY}|10\n`,
  attachments: "",
  staging: "",
  documentStaging: "",
  transientCount: "0\n",
};

function activeCheck(options: { previews: "none" | "empty" | "drawn" }): boolean {
  const root = mkdtempSync(join(tmpdir(), "orbit-restore-previews-"));
  sandboxes.push(root);
  const documentsRoot = join(root, "live");
  const objectDir = join(documentsRoot, "objects", STORAGE_KEY.slice(0, 2), STORAGE_KEY.slice(2, 4));
  mkdirSync(objectDir, { recursive: true });
  writeFileSync(join(objectDir, `${STORAGE_KEY}.bin`), "x".repeat(10));
  mkdirSync(join(documentsRoot, "staging"), { recursive: true });
  if (options.previews !== "none") mkdirSync(join(documentsRoot, "previews"), { recursive: true });
  if (options.previews === "drawn") {
    const previewDir = join(documentsRoot, "previews", PREVIEW_KEY.slice(0, 2), PREVIEW_KEY.slice(2, 4));
    mkdirSync(previewDir, { recursive: true });
    writeFileSync(join(previewDir, `${PREVIEW_KEY}.bin`), "kept-preview");
  }
  const byQuery = new Map<string, keyof CorrespondenceReports>(Object.entries(CORRESPONDENCE_QUERIES).map(([name, query]) => [query, name as keyof CorrespondenceReports]));
  const adapter = {
    collectDocumentsArchive: (path: string) => createTar(documentsRoot, path, ["."]),
    queryActiveReport: (query: string) => healthyReports[byQuery.get(query)!],
  } as unknown as RestoreDockerAdapter;
  const workDir = join(root, "work");
  mkdirSync(workDir);
  return internal.captureAndCheckActiveCorrespondence(adapter, workDir);
}

describe("restore engine accepts kept page previews in the documents archive (#1838)", () => {
  it("control: a tree with no previews/ folder passes the active correspondence check", () => {
    expect(activeCheck({ previews: "none" })).toBe(true);
  });

  it("accepts a tree whose previews/ folder is empty", () => {
    expect(activeCheck({ previews: "empty" })).toBe(true);
  });

  it("accepts a tree with a drawn preview at previews/xx/yy/<key>.bin", () => {
    expect(activeCheck({ previews: "drawn" })).toBe(true);
  });
});
