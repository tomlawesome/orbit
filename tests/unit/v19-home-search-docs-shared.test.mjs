import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-Q8: loadSearchDocuments() was copied verbatim between the desk
 * (home/+page.svelte) and the phone (home/pocket.svelte), already
 * diverging (only the phone set papersReady). A fix to the fetch pattern
 * (like the concurrency cap in W1-R9) would have had to be made twice.
 *
 * Both now call pocket-search.js's readSearchDocuments. Since #1352 the
 * caller itself is shared too: home/drawer-acts.svelte.js holds
 * loadSearchDocuments (the searchDocumentsFor cache check, papersReady), and
 * the phone passes its open row (`lit`) as the item to admit whatever its
 * status.
 */

const read = (/** @type {string} */ p) => readFileSync(resolve(import.meta.dirname, "../..", p), "utf8");
const HOME_PAGE = read("web/src/routes/home/+page.svelte");
const POCKET = read("web/src/routes/home/pocket.svelte");
const ACTS = read("web/src/routes/home/drawer-acts.svelte.js");

describe("#1151 W1-Q8: one shared loadSearchDocuments helper", () => {
  it("the shared acts import readSearchDocuments from pocket-search.js; neither screen does", () => {
    expect(ACTS).toMatch(/import \{ readSearchDocuments \} from "\.\/pocket-search\.js";/u);
    expect(HOME_PAGE).not.toMatch(/\breadSearchDocuments\b/u);
    expect(POCKET).not.toMatch(/\breadSearchDocuments\b/u);
  });

  it("both screens load through acts.loadSearchDocuments, which calls it instead of its own Promise.all/worker loop", () => {
    expect(HOME_PAGE).toMatch(/\bacts\.loadSearchDocuments\(/u);
    expect(POCKET).toMatch(/\bacts\.loadSearchDocuments\(lit\)/u);
    const start = ACTS.indexOf("async function loadSearchDocuments(");
    const fn = ACTS.slice(start, start + 900);
    expect(fn).toMatch(/await readSearchDocuments\(\s*\n\s*carrying, readItemDocuments, householdId, \(\) => searchDocumentsFor !== household,\s*\n\s*\);/u);
    expect(fn).not.toMatch(/Promise\.all/u);
    expect(fn).not.toMatch(/async function worker\(\)/u);
  });

  it("papersReady is set in the shared acts, and the desk does not read it", () => {
    expect(ACTS).toMatch(/searchDocuments = found;\s*\n\s*papersReady = true;/u);
    expect(HOME_PAGE).not.toContain("papersReady");
  });

  /* #1316 W1-F7: the phone's filter admitted only active items, so an
     archived item's drawer (/home?item=<id>) lost its Documents section. */
  it("the shared loadSearchDocuments filter admits the open row's item whatever its status", () => {
    const start = ACTS.indexOf("async function loadSearchDocuments(");
    const fn = ACTS.slice(start, ACTS.indexOf("readSearchDocuments(", start));
    const filter = fn.slice(fn.indexOf("const carrying"), fn.indexOf(";", fn.indexOf("const carrying")));
    expect(filter).toMatch(/documentCount/u);
    // not active-only: an alternative clause names the open row (`also`, the phone's lit)
    expect(filter).toMatch(/\|\|/u);
    expect(filter).toMatch(/\balso\b/u);
  });
});
