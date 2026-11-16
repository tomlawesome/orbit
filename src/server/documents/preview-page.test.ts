import { describe, expect, it } from "vitest";
import { parseDocumentPreviewPage } from "./preview-page";

/** The `page` query parameter every preview route reads (#1300). */
const parse = (query: string) => parseDocumentPreviewPage(new URLSearchParams(query));

describe("parseDocumentPreviewPage", () => {
  it("is page one when the parameter is absent, so older callers answer as before", () => {
    expect(parse("")).toBe(1);
    expect(parse("other=2")).toBe(1);
  });

  // Up to the old 1,000-page cap, not today's 100: documents stored then keep
  // their pages, drawn when viewed past 100 (#1433, owner answer 10a).
  it("reads a plain whole page number up to the highest page a stored document can have", () => {
    expect(parse("page=1")).toBe(1);
    expect(parse("page=7")).toBe(7);
    // Literal numbers, so the bound cannot move with the constant that sets it.
    expect(parse("page=100")).toBe(100);
    expect(parse("page=101")).toBe(101);
    expect(parse("page=1000")).toBe(1000);
  });

  it.each([
    ["page 0", "page=0"],
    ["a negative page", "page=-1"],
    ["a fraction", "page=1.5"],
    ["a word", "page=two"],
    ["an empty value", "page="],
    ["an exponent", "page=1e2"],
    ["a leading zero", "page=02"],
    ["a sign", "page=%2B2"],
    ["whitespace", "page=%202"],
    ["hex", "page=0x2"],
    ["a page past the cap", "page=1001"],
    ["a huge number", "page=99999999999999999999"],
    ["the parameter twice", "page=1&page=2"],
  ])("refuses %s with a 400 in its own words", (_name, query) => {
    expect(() => parse(query)).toThrow(expect.objectContaining({ code: "document_preview_page_invalid", status: 400 }));
  });
});
