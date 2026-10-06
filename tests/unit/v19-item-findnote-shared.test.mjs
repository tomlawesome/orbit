import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-Q17: findnote (desk) and pocketFindnote (phone) each derived the
 * same empty-belt/no-query/hit-count/no-match selection from the same
 * inputs (bodies, query, hitList, itemCount, suggestedNote), three of the
 * four branches character-for-character identical — only the no-query
 * branch's wording ("in date order, sooner to later" vs "sooner to later",
 * round-3 §3.2) genuinely differs. A future change to one block had no
 * structural reason to also reach the other.
 *
 * The fix shares the formula in findnoteFor(noQuerySuffix), called once per
 * screen with just the wording that differs.
 */

const ITEM_PAGE = readFileSync(
  resolve(import.meta.dirname, "../../web/src/routes/item/[[id]]/+page.svelte"),
  "utf8",
);

describe("#1151 W1-Q17: one shared findnoteFor() formula", () => {
  it("declares findnoteFor with the shared branches", () => {
    const fn = ITEM_PAGE.slice(ITEM_PAGE.indexOf("function findnoteFor(noQuerySuffix)"), ITEM_PAGE.indexOf("function findnoteFor(noQuerySuffix)") + 650);
    expect(fn).toMatch(/if \(!bodies\.length\) return "the belt is empty";/u);
    expect(fn).toMatch(/if \(!query\.trim\(\)\) return `\$\{itemCount\} items\$\{suggestedNote\} · \$\{noQuerySuffix\}`;/u);
    expect(fn).toMatch(/"nothing matches · the belt keeps its shape"/u);
  });

  it("findnote and pocketFindnote call it with only the differing wording", () => {
    expect(ITEM_PAGE).toMatch(/const findnote = \$derived\(findnoteFor\("in date order, sooner to later"\)\);/u);
    expect(ITEM_PAGE).toMatch(/const pocketFindnote = \$derived\(findnoteFor\("sooner to later"\)\);/u);
  });

  it("the hit-count branch's text appears only once now", () => {
    const matches = [...ITEM_PAGE.matchAll(/of \$\{itemCount\} lit · enter centres the nearest/gu)];
    expect(matches.length).toBe(1);
  });
});
