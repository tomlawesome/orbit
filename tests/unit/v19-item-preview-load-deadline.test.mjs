import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-R10: an accepted (non-staged) document's preview is a bare
 * `<img src={doc.previewHref}>` with only onload/onerror — unlike the
 * staged path, which gets its own AbortController via loadStagedPage — so
 * a hung preview request left previewImgLoaded/Failed unset forever: the
 * reticle (desk) or "Orbit is drawing the page" line (pocket) spun with no
 * way to tell stuck from still loading.
 *
 * The fix starts a plain deadline timer for the non-staged path only
 * (openPreview), cleared the instant either <img> handler actually fires
 * (both now call the same previewLoaded/previewFailed pair) or the preview
 * closes/reopens.
 */

const ITEM_PAGE = readFileSync(
  resolve(import.meta.dirname, "../../web/src/routes/item/[[id]]/+page.svelte"),
  "utf8",
);

describe("#1151 W1-R10: a non-staged preview gets a load deadline", () => {
  it("openPreview starts the deadline only for a non-staged doc with a page to draw", () => {
    const fn = ITEM_PAGE.slice(ITEM_PAGE.indexOf("function openPreview(doc, side)"), ITEM_PAGE.indexOf("function closePreview"));
    /* #1300: every drawable paper's page now comes through loadPreviewPage,
       so "has a src" became "is available and names a preview" -- the line
       before the deadline returns for every other paper. */
    expect(fn).toMatch(/if \(documentPreviewStateOf\(doc\) !== "available" \|\| !doc\.previewHref\) return;\s*\n\s*if \(!doc\.staged\) \{\s*\n\s*previewLoadTimer = setTimeout\(\(\) => \{\s*\n\s*if \(token === previewToken\) previewFailed\(\);/u);
  });

  it("previewLoaded/previewFailed both clear the deadline timer", () => {
    const loaded = ITEM_PAGE.slice(ITEM_PAGE.indexOf("function previewLoaded()"), ITEM_PAGE.indexOf("function previewFailed()"));
    expect(loaded).toMatch(/clearTimeout\(previewLoadTimer\);/u);
    const failed = ITEM_PAGE.slice(ITEM_PAGE.indexOf("function previewFailed()"), ITEM_PAGE.indexOf("function previewFailed()") + 150);
    expect(failed).toMatch(/clearTimeout\(previewLoadTimer\);/u);
  });

  it("closePreview also clears it, so a closed-and-reopened preview starts clean", () => {
    const start = ITEM_PAGE.indexOf("function closePreview()");
    const fn = ITEM_PAGE.slice(start, ITEM_PAGE.indexOf("\n  function ", start + 1));
    expect(fn).toMatch(/clearTimeout\(previewLoadTimer\);/u);
  });

  it("both <img> tags (desk reticle and pocket sheet) share the same two handlers", () => {
    const matches = [...ITEM_PAGE.matchAll(/onload=\{previewLoaded\} onerror=\{previewFailed\}/gu)];
    expect(matches.length).toBe(2);
  });
});
