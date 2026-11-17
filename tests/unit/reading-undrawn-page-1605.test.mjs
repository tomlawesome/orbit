import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1605 W-F8 and W-R10, static checks of the two reading components (as
 * v19-item-reader-img-onerror.test.mjs does): neither runs without a browser,
 * and these touch only the failed-page wording and the retry guard, not how
 * pages are loaded (#1446 reworks that).
 */
const read = (name) => readFileSync(resolve(import.meta.dirname, `../../web/src/lib/reading/${name}`), "utf8");
const READER = read("Reader.svelte");
const CARD = read("PreviewCard.svelte");

/** The body of `function <name>(...) {` up to its first line-start close. */
const bodyOf = (source, name) => {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `function ${name} exists`).toBeGreaterThan(-1);
  const end = source.indexOf("\n  }\n", start);
  return source.slice(start, end);
};

describe("W-F8: the reader's undrawn-page line carries the same hint as the card beneath", () => {
  it("UNDRAWN says to try again, as PreviewCard's UNDRAWN_PAGE does", () => {
    expect(CARD).toMatch(/const UNDRAWN_PAGE = "this page could not be drawn — try again"/u);
    expect(READER).toMatch(/const UNDRAWN = "this page could not be drawn — try again"/u);
  });
});

describe("W-R10: pressing the control of a page that failed to draw tries it again", () => {
  it("the card's turn() does not drop a turn to the page it is on while that page is lost", () => {
    const guard = bodyOf(CARD, "turn").split("\n").find((line) => /return;/u.test(line) && /n === pageNo/u.test(line)) ?? "";
    expect(guard, "turn() has the same-page guard").not.toBe("");
    expect(guard).toMatch(/turnLost/u);
  });

  it("the reader's turnTo() does not drop it either, while its page is lost", () => {
    const guard = bodyOf(READER, "turnTo").split("\n").find((line) => /target === pageNo/u.test(line)) ?? "";
    expect(guard, "turnTo() has the same-page guard").not.toBe("");
    expect(guard).toMatch(/lost|ownLost|failed/u);
  });
});
