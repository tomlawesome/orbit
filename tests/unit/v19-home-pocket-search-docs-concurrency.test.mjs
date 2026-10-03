import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-R9: loadSearchDocuments() mapped every active item carrying
 * documents straight into Promise.all, with no cap — a household with
 * hundreds or thousands of such items fired that many simultaneous
 * requests the instant the search sheet opened.
 *
 * The fix runs a small fixed pool of workers (SEARCH_DOC_CONCURRENCY) that
 * each pull the next item off a shared cursor, so at most that many
 * readItemDocuments() calls are ever in flight at once. Same additive
 * behaviour on a single item's failure, same "household changed mid-flight"
 * guard.
 */

const POCKET = readFileSync(
  resolve(import.meta.dirname, "../../web/src/routes/home/pocket.svelte"),
  "utf8",
);

describe("#1151 W1-R9: loadSearchDocuments caps concurrent reads", () => {
  it("declares a fixed concurrency cap", () => {
    expect(POCKET).toMatch(/const SEARCH_DOC_CONCURRENCY = \d+;/u);
  });

  it("runs a worker pool sized to the cap, not one request per item", () => {
    const fn = POCKET.slice(POCKET.indexOf("async function loadSearchDocuments()"), POCKET.indexOf("async function loadSearchDocuments()") + 1200);
    expect(fn).toMatch(/async function worker\(\)/u);
    expect(fn).toMatch(/Array\.from\(\{ length: Math\.min\(SEARCH_DOC_CONCURRENCY, carrying\.length\) \}, worker\)/u);
    // the cursor, not the array index, decides what each worker takes next
    expect(fn).toMatch(/carrying\[cursor\+\+\]/u);
  });

  it("still drops only the failing item's own papers, not the whole search", () => {
    const fn = POCKET.slice(POCKET.indexOf("async function loadSearchDocuments()"), POCKET.indexOf("async function loadSearchDocuments()") + 1200);
    expect(fn).toMatch(/catch \{ \/\* this item's papers drop out, not the whole search \*\/ \}/u);
  });
});
