import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-R10: a preview whose page request hangs left the image neither
 * loaded nor failed forever, so the reticle spun with no way to tell stuck
 * from still loading.
 *
 * The belt that first carried this fix is gone (#1319); the drawer's
 * PreviewCard (lib/reading/PreviewCard.svelte) carries the same behaviour:
 * show() starts a deadline timer (LOAD_TIMEOUT_MS) for a paper that is
 * available and names a preview, loaded()/failed() clear it, and
 * stopLoading() (called by show() and hide()) clears it too, so a closed and
 * reopened preview starts clean. A `.svelte` file is pinned against its own
 * text, as v19-flight-mark-ride.test.mjs does.
 */

const CARD = readFileSync(
  resolve(import.meta.dirname, "../../web/src/lib/reading/PreviewCard.svelte"),
  "utf8",
);

/** @param {string} name */
const bodyOf = (name) => {
  const start = CARD.indexOf(`function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  return CARD.slice(start, CARD.indexOf("\n  }\n", start));
};

describe("#1151 W1-R10: a preview gets a load deadline", () => {
  it("show() starts the deadline only for a paper that is available and names a preview", () => {
    const fn = bodyOf("show");
    expect(fn).toMatch(/if \(!available \|\| !next\.previewHref\) return;\s*\n\s*loadTimer = setTimeout\(\(\) => \{ if \(mine === token\) failed\(\); \}, LOAD_TIMEOUT_MS\);/u);
    expect(CARD).toMatch(/const LOAD_TIMEOUT_MS = \d/u);
  });

  it("loaded() and failed() both clear the deadline timer", () => {
    expect(bodyOf("loaded")).toMatch(/clearTimeout\(loadTimer\);/u);
    expect(bodyOf("failed")).toMatch(/clearTimeout\(loadTimer\);/u);
  });

  it("stopLoading() clears it, and both show() and hide() call it, so a reopened preview starts clean", () => {
    expect(bodyOf("stopLoading")).toMatch(/clearTimeout\(loadTimer\);/u);
    expect(bodyOf("show")).toMatch(/stopLoading\(\);/u);
    expect(bodyOf("hide")).toMatch(/stopLoading\(\);/u);
  });

  it("the image shares the same two handlers", () => {
    expect([...CARD.matchAll(/onload=\{loaded\} onerror=\{failed\}/gu)].length).toBe(1);
  });
});
