import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-Q8: loadSearchDocuments() was copied verbatim between the desk
 * (home/+page.svelte) and the phone (home/pocket.svelte), already
 * diverging (only the phone set papersReady). A fix to the fetch pattern
 * (like the concurrency cap in W1-R9) would have had to be made twice.
 *
 * Both now call pocket-search.js's readSearchDocuments, keeping only the
 * per-screen bits (the searchDocumentsFor cache check, papersReady) local.
 */

const HOME_PAGE = readFileSync(
  resolve(import.meta.dirname, "../../web/src/routes/home/+page.svelte"),
  "utf8",
);
const POCKET = readFileSync(
  resolve(import.meta.dirname, "../../web/src/routes/home/pocket.svelte"),
  "utf8",
);

describe("#1151 W1-Q8: one shared loadSearchDocuments helper", () => {
  it("both screens import readSearchDocuments from pocket-search.js", () => {
    expect(HOME_PAGE).toMatch(/import \{ readSearchDocuments, searchPocket \} from "\.\/pocket-search\.js";/u);
    expect(POCKET).toMatch(/import \{ readSearchDocuments, searchPocket \} from "\.\/pocket-search\.js";/u);
  });

  it("both call it instead of their own Promise.all/worker loop", () => {
    const deskFn = HOME_PAGE.slice(HOME_PAGE.indexOf("async function loadSearchDocuments()"), HOME_PAGE.indexOf("async function loadSearchDocuments()") + 700);
    expect(deskFn).toMatch(/await readSearchDocuments\(\s*\n\s*carrying, readItemDocuments, householdId, \(\) => searchDocumentsFor !== household,\s*\n\s*\);/u);
    expect(deskFn).not.toMatch(/Promise\.all/u);

    const pocketFn = POCKET.slice(POCKET.indexOf("async function loadSearchDocuments()"), POCKET.indexOf("async function loadSearchDocuments()") + 700);
    expect(pocketFn).toMatch(/await readSearchDocuments\(\s*\n\s*carrying, readItemDocuments, householdId, \(\) => searchDocumentsFor !== household,\s*\n\s*\);/u);
    expect(pocketFn).not.toMatch(/async function worker\(\)/u);
  });

  it("only the pocket still sets its own papersReady", () => {
    expect(POCKET).toMatch(/searchDocuments = found;\s*\n\s*papersReady = true;/u);
    expect(HOME_PAGE).not.toContain("papersReady");
  });
});
