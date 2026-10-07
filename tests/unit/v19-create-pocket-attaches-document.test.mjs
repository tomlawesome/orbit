import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1245, the phone half (owner, 2026-10-07, "11a"): a document picked on the
 * pocket's /create used to be dropped at the save -- the reading card said
 * "Orbit does not read or keep documents from this form yet" and the wake
 * said "<file> was not kept". It is now attached to the saved item the same
 * way the desk's form attaches it: workspace.js's attachItemDocument, onto
 * the draft's item, under a document id minted once per file picked, so a
 * retry after a lost answer re-sends the same id and is not stored twice.
 *
 * Neither form has an import surface a plain test can drive without a
 * browser, so -- as v19-create-attaches-document.test.js does for the desk --
 * the save is pinned against the files' own text; tests/e2e/v19-create.spec.ts
 * proves the journey on both dialects. attachItemDocument itself is driven
 * with a stubbed fetch in v19-create-attaches-document.test.js.
 */

const root = resolve(import.meta.dirname, "../..");
const read = (/** @type {string} */ p) => readFileSync(resolve(root, p), "utf8");

const pocket = read("web/src/routes/create/pocket.svelte");
const form = read("web/src/routes/create/EntryForm.svelte");
const saveFn = pocket.slice(pocket.indexOf("async function save()"), pocket.indexOf("/* ---- leaving"));

describe("#1245 (11a): the pocket's create form keeps the document it was given", () => {
  it("uploads the attachment onto the draft's item through the desk's own helper", () => {
    expect(pocket).toMatch(/import \{[^}]*\battachItemDocument\b[^}]*\} from "\$lib\/data\/workspace\.js"/u);
    expect(saveFn).toMatch(/attachItemDocument\(household\.id, draftId, attachment, documentIdOf\(attachment\)\)/u);
  });

  it("counts the entry as saved only once the document is attached", () => {
    expect(saveFn.indexOf("attachItemDocument(")).toBeGreaterThan(saveFn.indexOf("applyCommand("));
    expect(saveFn.indexOf("saved = true")).toBeGreaterThan(saveFn.indexOf("attachItemDocument("));
  });

  it("mints the document id per file picked, not per save attempt", () => {
    expect(saveFn).not.toMatch(/crypto\.randomUUID/u);
    const minter = pocket.slice(pocket.indexOf("function documentIdOf"), pocket.indexOf("async function save()"));
    expect(minter).toMatch(/crypto\.randomUUID\(\)/u);
  });

  it("no longer says the document is not kept, on the card or in the wake", () => {
    expect(form).not.toMatch(/does not read or keep documents/u);
    expect(pocket).not.toMatch(/was not kept/u);
  });
});
