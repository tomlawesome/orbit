import { describe, expect, it } from "vitest";
import { PDF_STRUCTURE_MAX_PAGES } from "./validation";
import { parseDocumentPreviewPage } from "./preview-page";

/** The `page` query parameter every preview route reads (#1300). */
const parse = (query: string) => parseDocumentPreviewPage(new URLSearchParams(query));

describe("parseDocumentPreviewPage", () => {
  it("is page one when the parameter is absent, so older callers answer as before", () => {
    expect(parse("")).toBe(1);
    expect(parse("other=2")).toBe(1);
  });

  it("reads a plain whole page number up to the structure check's page cap", () => {
    expect(parse("page=1")).toBe(1);
    expect(parse("page=7")).toBe(7);
    expect(parse(`page=${PDF_STRUCTURE_MAX_PAGES}`)).toBe(PDF_STRUCTURE_MAX_PAGES);
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
    ["a page past the cap", `page=${PDF_STRUCTURE_MAX_PAGES + 1}`],
    ["a huge number", "page=99999999999999999999"],
    ["the parameter twice", "page=1&page=2"],
  ])("refuses %s with a 400 in its own words", (_name, query) => {
    expect(() => parse(query)).toThrow(expect.objectContaining({ code: "document_preview_page_invalid", status: 400 }));
  });
});
