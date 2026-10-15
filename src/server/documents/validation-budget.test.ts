import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classicChainPdf,
  xrefStmChainPdf,
  xrefStreamPdf,
} from "../../../tests/support/generated-pdf-documents";
import { syntheticPdf } from "../../../tests/support/synthetic-documents";

const mocks = vi.hoisted(() => ({ getDocument: vi.fn() }));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: mocks.getDocument,
  VerbosityLevel: { ERRORS: 0 },
}));

import {
  classifyDocumentStructure,
  PDF_STRUCTURE_INSPECTION_BUDGET_MS,
  PDF_STRUCTURE_MAX_PAGES,
} from "./validation";

describe("bounded PDF inspection", () => {
  afterEach(() => {
    mocks.getDocument.mockReset();
    vi.useRealTimers();
  });

  it("maps PDFs over the page cap to unsupported_structure", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    mocks.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: PDF_STRUCTURE_MAX_PAGES + 1 }),
      destroy,
    });

    await expect(classifyDocumentStructure(syntheticPdf(), "application/pdf"))
      .resolves.toBe("unsupported_structure");
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("maps an asynchronous parser budget expiry to unsupported_structure and destroys the task", async () => {
    vi.useFakeTimers();
    const destroy = vi.fn().mockResolvedValue(undefined);
    mocks.getDocument.mockReturnValue({
      promise: new Promise(() => undefined),
      destroy,
    });

    const result = classifyDocumentStructure(syntheticPdf(), "application/pdf");
    await vi.advanceTimersByTimeAsync(PDF_STRUCTURE_INSPECTION_BUDGET_MS + 1);

    await expect(result).resolves.toBe("unsupported_structure");
    expect(destroy).toHaveBeenCalledOnce();
  });
  describe("declared cross-reference entry count", () => {
    function pdfWithXrefStream(dictionaryTail: string): Buffer {
      let value = "%PDF-1.7\n";
      value += "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
      value += "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n";
      value += "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n";
      const xrefOffset = Buffer.byteLength(value);
      const entries = "11111111111111111111";
      value += `4 0 obj\n<< /Type /XRef /Root 1 0 R /Length ${entries.length} /W [1 2 1] ${dictionaryTail} >>\nstream\n`;
      value += `${entries}\nendstream\nendobj\n`;
      value += `startxref\n${xrefOffset}\n%%EOF\n`;
      return Buffer.from(value);
    }

    function pdfWithClassicXref(subsectionHeaders: string[]): Buffer {
      let value = "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
      const xrefOffset = Buffer.byteLength(value);
      value += `xref\n${subsectionHeaders.join("\n")}\n0000000000 65535 f \n`;
      value += `trailer\n<< /Size 3000000 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
      return Buffer.from(value);
    }

    function mockParserReachable(): void {
      mocks.getDocument.mockReturnValue({
        promise: Promise.resolve({ numPages: 1, getPage: vi.fn().mockResolvedValue({}) }),
        destroy: vi.fn().mockResolvedValue(undefined),
      });
    }

    it("rejects a cross-reference stream whose /Index declares 2,000,000,000 entries without calling the parser", async () => {
      mockParserReachable();
      const bytes = pdfWithXrefStream("/Size 5 /Index [0 2000000000]");

      await expect(classifyDocumentStructure(bytes, "application/pdf")).resolves.toBe("unsupported_structure");
      expect(mocks.getDocument).not.toHaveBeenCalled();
    });

    it("rejects a cross-reference stream with no /Index and /Size 2,000,000,000 without calling the parser", async () => {
      mockParserReachable();
      const bytes = pdfWithXrefStream("/Size 2000000000");

      await expect(classifyDocumentStructure(bytes, "application/pdf")).resolves.toBe("unsupported_structure");
      expect(mocks.getDocument).not.toHaveBeenCalled();
    });

    it("rejects a classic xref table whose subsection headers sum to more than 1,250,000 entries without calling the parser", async () => {
      mockParserReachable();
      const bytes = pdfWithClassicXref(["0 1000000", "1000000 250001"]);

      await expect(classifyDocumentStructure(bytes, "application/pdf")).resolves.toBe("unsupported_structure");
      expect(mocks.getDocument).not.toHaveBeenCalled();
    });

    it("still reaches the parser for a cross-reference stream declaring a normal /Index [0 12]", async () => {
      mockParserReachable();
      const bytes = pdfWithXrefStream("/Size 12 /Index [0 12]");

      await expect(classifyDocumentStructure(bytes, "application/pdf")).resolves.toBe("supported_structure");
      expect(mocks.getDocument).toHaveBeenCalledOnce();
    });
  });

  describe("linearized files, whose parser starts at the first-page cross-reference", () => {
    const pad = (value: number): string => String(value).padStart(10, "0");
    const TINY_XREF = "xref\n0 1\n0000000000 65535 f \n";

    function mockParserReachable(): void {
      mocks.getDocument.mockReturnValue({
        promise: Promise.resolve({ numPages: 1, getPage: vi.fn().mockResolvedValue({}) }),
        destroy: vi.fn().mockResolvedValue(undefined),
      });
    }

    function linearizationObject(total: number): string {
      return `1 0 obj << /Linearized 1 /L ${pad(total)} /H [0000000100 0000000020] /O 2 /E 100 /N 1 /T 0000000200 >>\nendobj\n`;
    }

    // Builds the file with a placeholder length, measures it, then rebuilds with the real /L.
    function withMeasuredLength(build: (total: number) => string): Buffer {
      const total = Buffer.byteLength(build(0));
      const value = build(total);
      expect(Buffer.byteLength(value)).toBe(total);
      return Buffer.from(value);
    }

    function linearizedHidingOversizedSection(): Buffer {
      return withMeasuredLength((total) => {
        let value = "%PDF-1.7\n" + linearizationObject(total);
        value += "4 0 obj << /Type /XRef /W [0 0 0] /Index [0 2000000000] /Size 2000000000 /Root 1 0 R /Length 0 >>\n";
        value += "stream\n\nendstream\nendobj\n";
        const tinyOffset = Buffer.byteLength(value);
        value += `${TINY_XREF}trailer\n<< /Size 1 /Root 1 0 R >>\nstartxref\n${tinyOffset}\n%%EOF\n`;
        return value;
      });
    }

    function linearizedWithSmallSections(): Buffer {
      return withMeasuredLength((total) => {
        let value = "%PDF-1.7\n" + linearizationObject(total);
        const firstPageOffset = Buffer.byteLength(value);
        // Fixed-width /Prev keeps the length stable; the main section follows the first-page one.
        const firstPage = (prev: number): string =>
          `${TINY_XREF}trailer\n<< /Size 1 /Root 1 0 R /Prev ${pad(prev)} >>\nstartxref\n0\n%%EOF\n`;
        const mainOffset = firstPageOffset + Buffer.byteLength(firstPage(0));
        value += firstPage(mainOffset);
        value += `${TINY_XREF}trailer\n<< /Size 1 /Root 1 0 R >>\nstartxref\n${firstPageOffset}\n%%EOF\n`;
        return value;
      });
    }

    function smallPdfWithFirstObject(firstObject: string): Buffer {
      let value = `%PDF-1.7\n${firstObject}`;
      const xrefOffset = Buffer.byteLength(value);
      value += `${TINY_XREF}trailer\n<< /Size 1 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
      return Buffer.from(value);
    }

    it("rejects a linearized file hiding an oversized cross-reference stream after the first endobj without calling the parser", async () => {
      mockParserReachable();

      await expect(classifyDocumentStructure(linearizedHidingOversizedSection(), "application/pdf"))
        .resolves.toBe("unsupported_structure");
      expect(mocks.getDocument).not.toHaveBeenCalled();
    });

    it.each([
      ["a three-section classic chain", () => classicChainPdf({ sections: 3 })],
      ["a cross-reference stream hybrid chain", () => xrefStmChainPdf()],
      ["a single cross-reference stream", () => xrefStreamPdf()],
    ])("still reaches the parser for %s", async (_name, build) => {
      mockParserReachable();

      await expect(classifyDocumentStructure(build(), "application/pdf")).resolves.toBe("supported_structure");
      expect(mocks.getDocument).toHaveBeenCalledOnce();
    });

    it("still reaches the parser for a legitimate linearized file with small first-page and /Prev sections", async () => {
      mockParserReachable();

      await expect(classifyDocumentStructure(linearizedWithSmallSections(), "application/pdf"))
        .resolves.toBe("supported_structure");
      expect(mocks.getDocument).toHaveBeenCalledOnce();
    });

    it.each([
      [
        "/L does not equal the file length",
        () => smallPdfWithFirstObject(
          "1 0 obj << /Linearized 1 /L 0000000999 /H [0000000100 0000000020] /O 2 /E 100 /N 1 /T 0000000200 >>\nendobj\n",
        ),
      ],
      [
        "/Linearized is 0",
        () => smallPdfWithFirstObject(
          "1 0 obj << /Linearized 0 /L 0000000000 /H [0000000100 0000000020] /O 2 /E 100 /N 1 /T 0000000200 >>\nendobj\n",
        ),
      ],
      [
        "the first object is not a dictionary",
        () => smallPdfWithFirstObject("1 0 obj\n(/Linearized 1)\nendobj\n"),
      ],
    ])("treats a file as ordinary when %s", async (_name, build) => {
      mockParserReachable();

      await expect(classifyDocumentStructure(build(), "application/pdf")).resolves.toBe("supported_structure");
      expect(mocks.getDocument).toHaveBeenCalledOnce();
    });
  });
});
