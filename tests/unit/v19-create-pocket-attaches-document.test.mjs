import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1245, the phone half (owner, 2026-10-07, "11a"): a document picked on the
 * pocket's /create used to be dropped at the save. It is kept, under a
 * document id minted once per file picked, so a retry after a lost answer
 * re-sends the same id with the same bytes and is not stored twice.
 *
 * #1316 (owner, 2026-10-13): and it goes with the item all-or-nothing. The
 * save STAGES the file first (workspace.js's stageDocument, a document with
 * no item) and then sends one item.upsert carrying `documentIds`; the item
 * is no longer created first and the file attached after. attachItemDocument
 * stays for the home drawer only.
 *
 * Neither form has an import surface a plain test can drive without a
 * browser, so -- as v19-create-attaches-document.test.js does for the desk --
 * the save is pinned against the files' own text; the behaviour of both forms
 * is driven in v19-create-partial-landing-words.test.mjs and
 * tests/e2e/v19-create.spec.ts proves the journey on both dialects.
 * stageDocument itself is driven with a stubbed fetch in
 * v19-create-attaches-document.test.js.
 */

const root = resolve(import.meta.dirname, "../..");
const read = (/** @type {string} */ p) => readFileSync(resolve(root, p), "utf8");

const pocket = read("web/src/routes/create/pocket.svelte");
const form = read("web/src/routes/create/EntryForm.svelte");
const saveFn = pocket.slice(pocket.indexOf("async function save()"), pocket.indexOf("/* ---- leaving"));

describe("#1316: the pocket's create form stages its document, then sends one command", () => {
  it("stages the attachment through the desk's own helper, not onto a saved item", () => {
    expect(pocket).toMatch(/import \{[^}]*\bstageDocument\b[^}]*\} from "\$lib\/data\/workspace\.js"/u);
    expect(pocket).not.toMatch(/attachItemDocument/u);
    // The file is taken at submit (`held`), so a read refused mid-save cannot drop it.
    expect(saveFn).toMatch(/const held = attachment;/u);
    expect(saveFn).toMatch(/stageDocument\(household\.id, held, documentIdOf\(held\), draftId\)/u);
  });

  it("stages before the command and counts the entry as saved only once the command lands", () => {
    expect(saveFn.indexOf("stageDocument(")).toBeGreaterThan(-1);
    expect(saveFn.indexOf("applyCommand(")).toBeGreaterThan(saveFn.indexOf("stageDocument("));
    expect(saveFn).toMatch(/documentIds/u);
    expect(saveFn.indexOf("saved = true")).toBeGreaterThan(saveFn.indexOf("applyCommand("));
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
