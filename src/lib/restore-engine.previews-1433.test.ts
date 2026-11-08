import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { type CorrespondenceReports, checkCorrespondence } from "./restore-engine";

// #1433, design note §2.6 line 14 and D19, at the restore engine: kept page
// previews travel in the document tree under previews/ (the backup tars the
// whole root), but correspondence stays per document: previews are derived,
// not evidence, so a restore never fails on them. A tree holding previews, or
// missing one a row still names, corresponds as long as the documents do;
// the first reconciliation re-enqueues a missing page (the integration side
// of line 14 is in tests/integration/document-kept-previews.test.ts).

const STORAGE_KEY = "ab".repeat(32);
const PREVIEW_KEYS = ["cd".repeat(32), "ef".repeat(32)];
const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";

const sandboxes: string[] = [];
afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

function place(root: string, directory: string, key: string, bytes: string): void {
  mkdirSync(join(root, directory, key.slice(0, 2), key.slice(2, 4)), { recursive: true });
  writeFileSync(join(root, directory, key.slice(0, 2), key.slice(2, 4), `${key}.bin`), bytes);
}

function treeWithPreviews(previewKeys: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "orbit-restore-previews-"));
  sandboxes.push(root);
  place(root, "objects", STORAGE_KEY, "x".repeat(10));
  for (const key of previewKeys) place(root, "previews", key, "p".repeat(20));
  return root;
}

const reports: CorrespondenceReports = {
  crypto: `${DOCUMENT_ID}|${STORAGE_KEY}|10|available\n`,
  visible: `${DOCUMENT_ID}|available|${STORAGE_KEY}|10\n`,
  attachments: "",
  staging: "",
  documentStaging: "",
  transientCount: "0\n",
};

describe("restore correspondence with kept previews (#1433 §2.6 line 14, D19)", () => {
  it("a document tree whose previews/ holds every kept page corresponds", () => {
    expect(checkCorrespondence(reports, treeWithPreviews(PREVIEW_KEYS))).toBe(true);
  });

  it("a document tree missing one kept page's object still corresponds: a restore never fails on previews", () => {
    expect(checkCorrespondence(reports, treeWithPreviews(PREVIEW_KEYS.slice(0, 1)))).toBe(true);
  });

  it("a missing document object still fails, previews or not (control)", () => {
    const root = treeWithPreviews(PREVIEW_KEYS);
    rmSync(join(root, "objects"), { recursive: true });
    expect(checkCorrespondence(reports, root)).toBe(false);
  });
});
