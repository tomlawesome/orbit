import { describe, expect, it } from "vitest";
import type { SkippedOnOlderKey } from "@/server/documents/rewrap-worker";
import { completionReport } from "./rewrap-kek-report";

// Ruling on #1536 (T-Q11/T-Q24, D-F2): the progress carries only the skipped
// counts; the skipped ids are loaded once, at completion, and the report is
// built from those ids alone. It still names every skipped id.

const KEEP_SENTENCE = "Keep the older document key: these objects stay unreadable until a rotation from that key.";
const REPLACE_LINE = "Replace the live document-kek secret";

function skipped(heldAttachmentIds: string[], stagingObjectIds: string[]): SkippedOnOlderKey {
  return { heldAttachmentIds, stagingObjectIds };
}

/** The report may come back as one string or as lines; compare it as lines. */
function lines(result: string | string[]): string[] {
  return (Array.isArray(result) ? result.join("\n") : result).split("\n");
}

describe("completionReport", () => {
  it("lists every skipped id, one per line and labelled, when objects were skipped", () => {
    const out = lines(completionReport(skipped(["att-1", "att-2"], ["stg-1"])));
    for (const id of ["att-1", "att-2", "stg-1"]) {
      const matching = out.filter((line) => line.includes(id));
      expect(matching, `${id} appears on exactly one line`).toHaveLength(1);
    }
    // Held attachments and staging objects carry different labels.
    const attLabel = out.find((line) => line.includes("att-1"))!.replace("att-1", "").trim();
    const stgLabel = out.find((line) => line.includes("stg-1"))!.replace("stg-1", "").trim();
    expect(attLabel).not.toBe("");
    expect(stgLabel).not.toBe("");
    expect(attLabel).not.toBe(stgLabel);
    expect(out.find((line) => line.includes("att-2"))!.replace("att-2", "").trim()).toBe(attLabel);
  });

  it("says to keep the older key, before the replace-the-secret line, when objects were skipped", () => {
    const out = lines(completionReport(skipped(["att-1"], [])));
    const keepAt = out.findIndex((line) => line.includes(KEEP_SENTENCE));
    const replaceAt = out.findIndex((line) => line.includes(REPLACE_LINE));
    expect(keepAt).toBeGreaterThanOrEqual(0);
    expect(replaceAt).toBeGreaterThanOrEqual(0);
    expect(keepAt).toBeLessThan(replaceAt);
  });

  it("prints no ids and no keep-the-older-key sentence when nothing was skipped", () => {
    const text = lines(completionReport(skipped([], []))).join("\n");
    expect(text).not.toContain(KEEP_SENTENCE);
    expect(text).not.toContain("Keep the older document key");
    // No skipped-id lines: nothing but the completion wording and the replace line.
    expect(text).not.toMatch(/att-|stg-/);
  });

  it("keeps the existing completion wording when nothing was skipped", () => {
    const text = lines(completionReport(skipped([], []))).join("\n");
    expect(text).toContain("Rewrap complete: every row now decrypts only under the next key.");
    expect(text).toContain(REPLACE_LINE);
  });
});
