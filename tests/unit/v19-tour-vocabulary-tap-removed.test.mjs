import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W3-Q7: vocabulary.js's `tap()` (visit, press, leave dark again) was
 * built and exported as part of the film's vocabulary, but no chapter file
 * (01 through 12) ever destructured or called it off `ctx` — confirmed by
 * grepping every chapter's own `const { ... } = ctx` list and every
 * film/player/transport call site. A maintainer refactoring
 * goto/press/unlight had to keep an extra exported word working for a
 * caller that does not exist.
 *
 * The fix removes the dead function and its export, and drops `tap` from
 * the header's "this module is those words again" list, which otherwise
 * claimed a counterpart that no longer exists.
 */

const VOCAB = readFileSync(
  resolve(import.meta.dirname, "../../web/src/lib/tour/vocabulary.js"),
  "utf8",
);

describe("#1151 W3-Q7: the dead tap() word is gone", () => {
  it("no longer defines a tap() function", () => {
    expect(VOCAB).not.toMatch(/async function tap\(/u);
  });

  it("no longer exports tap", () => {
    const exportBlock = VOCAB.slice(VOCAB.indexOf("return {"), VOCAB.indexOf("return {") + 2000);
    expect(exportBlock).not.toMatch(/^\s*tap,\s*$/mu);
  });

  it("the header no longer claims tap as a live counterpart", () => {
    expect(VOCAB).toMatch(/all\s*\n?\s*\* but `tap`, which no chapter ever called/u);
  });
});
