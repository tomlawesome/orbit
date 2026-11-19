import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1915 W-S1 + A-F3: the staged-upload refusal (two places in
 * document-repository.ts) is built from STAGED_UPLOADS_PER_MEMBER_LIMIT, so
 * no hand-written count can drift from it, and it never tells the member to
 * delete (a staged upload cannot be deleted from where they are told this).
 * Pinned against the source text; the integration test document-staged-limit-1605
 * checks the live answer.
 */
const SOURCE = readFileSync(resolve(import.meta.dirname, "../../src/server/document-repository.ts"), "utf8");
const WORDS = "`You already have ${STAGED_UPLOADS_PER_MEMBER_LIMIT} uploads waiting to be attached to an item. Add the item they belong to, or wait a day and they are cleared`";

describe("#1915 the staged-limit refusal text", () => {
  it("is the ruled text, built from the constant, in both places", () => {
    expect(SOURCE.split(WORDS).length - 1, "both refusals say exactly the ruled words").toBe(2);
  });

  it("has no hand-written 100 and never says delete", () => {
    const refusals = SOURCE.split("\n").filter((line) => line.includes("uploads waiting to be attached"));
    expect(refusals).toHaveLength(2);
    for (const line of refusals) {
      expect(line).not.toMatch(/You already have \d+/u);
      expect(line.toLowerCase()).not.toContain("delete");
    }
  });
});
