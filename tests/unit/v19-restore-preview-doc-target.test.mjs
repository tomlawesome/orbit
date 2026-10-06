import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-R12: restorePreviewDoc() read `previewDoc.id` for the restore
 * call itself (always the right document — nothing async happens before
 * that read), but then closed the belt's reader and attributed any
 * failure to whichever document happened to be open AFTER the await, not
 * the one actually being restored. If the reader opened a different
 * document's preview while the restore was still in flight, a success
 * closed the wrong preview and a failure blamed it.
 *
 * The fix captures the target and the preview's own generation
 * (`previewToken`, already used the same way by `openPreview`'s own async
 * image load) before the await, and only acts on the belt/the problem
 * banner if the preview is still on that same generation afterwards.
 *
 * `+page.svelte` is not import-tested here — a `.svelte` file needs the
 * compiler this suite does not pull in for a source check — so this pins
 * the fix the same way `v19-flight-mark-ride.test.mjs` pins a `.svelte`
 * fix it cannot import-test either.
 */

const ITEM_PAGE = readFileSync(
  resolve(import.meta.dirname, "../../web/src/routes/item/[[id]]/+page.svelte"),
  "utf8",
);

describe("#1151 W1-R12: restorePreviewDoc targets the document it started with", () => {
  const fn = ITEM_PAGE.slice(
    ITEM_PAGE.indexOf("async function restorePreviewDoc()"),
    ITEM_PAGE.indexOf("async function restorePreviewDoc()") + 900,
  );

  it("captures the target and the preview's own generation before the await", () => {
    expect(fn).toMatch(/const target = previewDoc;/u);
    expect(fn).toMatch(/const token = previewToken;/u);
    const captureIndex = fn.indexOf("const token = previewToken;");
    const awaitIndex = fn.indexOf("await restoreDocument(");
    expect(captureIndex).toBeGreaterThan(-1);
    expect(awaitIndex).toBeGreaterThan(captureIndex);
  });

  it("only closes the belt's reader if the preview has not moved on", () => {
    expect(fn).toMatch(/if \(token === previewToken\) belt\?\.closeDoc\(\);/u);
  });

  it("only blames the document it was restoring, not whatever is open now", () => {
    expect(fn).toMatch(/if \(token === previewToken\) \{\s*previewProblem\s*=/u);
  });

  it("still restores the right document regardless — the id came from the capture, not live state", () => {
    expect(fn).toMatch(/await restoreDocument\(target\.id\);/u);
  });
});
