import { afterEach, describe, expect, it, vi } from "vitest";
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
});
