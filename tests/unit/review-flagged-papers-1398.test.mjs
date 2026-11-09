import { describe, expect, it } from "vitest";

import { papersOf } from "$lib/pocket/review.js";
import { suggestionPapersOf } from "$lib/data/belt.js";
import { archiveOf } from "$lib/data/documents.js";

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

/*
 * Review findings (#1398): a flagged file is never offered as something to
 * open or attach. The home suggestion drawer lists `suggestionPapersOf` rows,
 * each an "Open {name}" button with the "attached on acceptance" meta; the
 * documents archive lists a relay mail's attachments as waiting for approval.
 */
const mail = (/** @type {Record<string, unknown>[]} */ attachments) => ({
  id: "r-1398", receiptId: "r-1398", title: "Boiler service", receivedAt: "2026-03-01T09:00:00.000Z",
  canApprove: true, attachmentCount: attachments.length, attachments,
});

describe("a flagged attachment is not offered (#1398 review findings)", () => {
  it("the home suggestion drawer lists no paper for a flagged attachment, so no Open button and no 'attached on acceptance'", () => {
    const rows = suggestionPapersOf(/** @type {any} */ (mail([pdf("a-ok", "clean"), pdf("a-bad", "flagged")])));
    expect(rows.map((row) => row.name)).toEqual(["a-ok.pdf"]);
    expect(rows.every((row) => row.meta === "attached on acceptance")).toBe(true);
  });

  it("the documents archive does not list a flagged attachment as a relay document waiting for approval", () => {
    const archive = archiveOf({
      receipts: /** @type {any} */ ([{ ...mail([pdf("a-ok", "clean"), pdf("a-bad", "flagged")]), proposal: { title: "Boiler service" } }]),
      today: "2026-03-10",
    });
    const names = archive.groups.flatMap((group) => group.rows.map((row) => row.name));
    expect(names).toEqual(["a-ok.pdf"]);
    expect(archive.total).toBe(1);
  });
});
