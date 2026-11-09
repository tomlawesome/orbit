import { describe, expect, it } from "vitest";

import { papersOf } from "$lib/pocket/review.js";

/*
 * #1398 rework (notes 56204, 56230, 56245): the scanner can flag one held
 * attachment of a mail while the member adds it. The review read then says so
 * for that attachment alone (`scanState: "flagged"`), and the card draws it
 * with no view link and no "scanned clean". The other attachments read as
 * before.
 */
const pdf = (/** @type {string} */ id, /** @type {string} */ scanState) => ({
  id, displayName: `${id}.pdf`, mediaType: "application/pdf", sizeBytes: 1234, scanState,
});

describe("papersOf and a flagged attachment (#1398)", () => {
  it("a flagged attachment is flagged, cannot be opened as a page, and is not clean", () => {
    const [paper] = papersOf({ attachments: [pdf("a-bad", "flagged")] });
    expect(paper).toMatchObject({ id: "a-bad", name: "a-bad.pdf", flagged: true, drawable: false, clean: false });
  });

  it("only the flagged attachment of several is flagged; the others stay clean and drawable", () => {
    const papers = papersOf({ attachments: [pdf("a-one", "clean"), pdf("a-bad", "flagged"), pdf("a-two", "clean")] });
    expect(papers.map((paper) => [paper.id, Boolean(paper.flagged), paper.drawable, paper.clean])).toEqual([
      ["a-one", false, true, true],
      ["a-bad", true, false, false],
      ["a-two", false, true, true],
    ]);
  });
});
