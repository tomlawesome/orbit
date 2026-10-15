import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classicChainPdf,
  syntheticPdfWithPages,
  xrefStmChainPdf,
  xrefStreamPdf,
} from "../../../tests/support/generated-pdf-documents";
import { syntheticPdf } from "../../../tests/support/synthetic-documents";
import {
  pdfStructureSandboxInFlightForTests,
  setPdfStructureInspectorForTests,
  setPdfStructureSandboxLimitsForTests,
} from "./pdf-structure-sandbox";
import { classifyDocumentStructure } from "./validation";

/**
 * The parser now runs in a worker thread (pdf-structure-sandbox), so a module
 * mock can no longer see it. "Was the parser reached" is observed instead
 * through the sandbox's test inspector: a spy that stands in for the sandbox
 * call and resolves "supported_structure".
 */
let inspector = vi.fn();

function mockParserReachable(): void {
  inspector = vi.fn().mockResolvedValue("supported_structure");
  setPdfStructureInspectorForTests(inspector);
}

describe("bounded PDF inspection", () => {
  afterEach(() => {
    setPdfStructureInspectorForTests(undefined);
    setPdfStructureSandboxLimitsForTests(undefined);
    inspector = vi.fn();
  });

  it("maps PDFs over the page cap to unsupported_structure", async () => {
    await expect(classifyDocumentStructure(syntheticPdfWithPages(1001), "application/pdf"))
      .resolves.toBe("unsupported_structure");
    expect(pdfStructureSandboxInFlightForTests()).toBe(0);
  });

  it("maps an expired sandbox wall-clock budget to unsupported_structure and leaves no worker running", async () => {
    setPdfStructureSandboxLimitsForTests({ wallMs: 1 });

    await expect(classifyDocumentStructure(syntheticPdf(), "application/pdf"))
      .resolves.toBe("unsupported_structure");
    expect(pdfStructureSandboxInFlightForTests()).toBe(0);
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

    it("rejects a cross-reference stream whose /Index declares 2,000,000,000 entries without calling the parser", async () => {
      mockParserReachable();
      const bytes = pdfWithXrefStream("/Size 5 /Index [0 2000000000]");

      await expect(classifyDocumentStructure(bytes, "application/pdf")).resolves.toBe("unsupported_structure");
      expect(inspector).not.toHaveBeenCalled();
    });

    it("rejects a cross-reference stream with no /Index and /Size 2,000,000,000 without calling the parser", async () => {
      mockParserReachable();
      const bytes = pdfWithXrefStream("/Size 2000000000");

      await expect(classifyDocumentStructure(bytes, "application/pdf")).resolves.toBe("unsupported_structure");
      expect(inspector).not.toHaveBeenCalled();
    });

    it("rejects a classic xref table whose subsection headers sum to more than 1,250,000 entries without calling the parser", async () => {
      mockParserReachable();
      const bytes = pdfWithClassicXref(["0 1000000", "1000000 250001"]);

      await expect(classifyDocumentStructure(bytes, "application/pdf")).resolves.toBe("unsupported_structure");
      expect(inspector).not.toHaveBeenCalled();
    });

    it("still reaches the parser for a cross-reference stream declaring a normal /Index [0 12]", async () => {
      mockParserReachable();
      const bytes = pdfWithXrefStream("/Size 12 /Index [0 12]");

      await expect(classifyDocumentStructure(bytes, "application/pdf")).resolves.toBe("supported_structure");
      expect(inspector).toHaveBeenCalledOnce();
    });
  });

  describe("linearized files, whose parser starts at the first-page cross-reference", () => {
    const pad = (value: number): string => String(value).padStart(10, "0");
    const TINY_XREF = "xref\n0 1\n0000000000 65535 f \n";

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
      expect(inspector).not.toHaveBeenCalled();
    });

    it.each([
      ["a three-section classic chain", () => classicChainPdf({ sections: 3 })],
      ["a cross-reference stream hybrid chain", () => xrefStmChainPdf()],
      ["a single cross-reference stream", () => xrefStreamPdf()],
    ])("still reaches the parser for %s", async (_name, build) => {
      mockParserReachable();

      await expect(classifyDocumentStructure(build(), "application/pdf")).resolves.toBe("supported_structure");
      expect(inspector).toHaveBeenCalledOnce();
    });

    it("still reaches the parser for a legitimate linearized file with small first-page and /Prev sections", async () => {
      mockParserReachable();

      await expect(classifyDocumentStructure(linearizedWithSmallSections(), "application/pdf"))
        .resolves.toBe("supported_structure");
      expect(inspector).toHaveBeenCalledOnce();
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
      expect(inspector).toHaveBeenCalledOnce();
    });
  });

  describe("the parser's recovery scan and sections it cannot read", () => {
    const BASE = "%PDF-1.7\n"
      + "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"
      + "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"
      + "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n";

    function hiddenXrefObject(index: string): string {
      return `4 0 obj << /Type /XRef /W [0 0 0] /Index ${index} /Size 3 /Length 0 >>\nstream\n\nendstream\nendobj\n`;
    }

    function classicTable(headerLine: string, extraObject = ""): Buffer {
      let value = BASE + extraObject;
      const xrefOffset = Buffer.byteLength(value);
      value += `xref\n${headerLine}\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n`;
      value += `trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
      return Buffer.from(value);
    }

    async function expectRefused(bytes: Buffer): Promise<void> {
      mockParserReachable();
      await expect(classifyDocumentStructure(bytes, "application/pdf")).resolves.toBe("unsupported_structure");
      expect(inspector).not.toHaveBeenCalled();
    }

    async function expectReachesParser(bytes: Buffer): Promise<void> {
      mockParserReachable();
      await expect(classifyDocumentStructure(bytes, "application/pdf")).resolves.toBe("supported_structure");
      expect(inspector).toHaveBeenCalledOnce();
    }

    it("A1: refuses an oversized hidden cross-reference stream when startxref points past the end of the file", async () => {
      await expectRefused(Buffer.from(`${BASE}${hiddenXrefObject("[0 2000000]")}startxref\n99999999\n%%EOF\n`));
    });

    it("A2: refuses an oversized hidden cross-reference stream when there is no startxref at all", async () => {
      await expectRefused(Buffer.from(`${BASE}${hiddenXrefObject("[0 2000000]")}%%EOF\n`));
    });

    it("A3: still reaches the parser for a hidden cross-reference stream with a small /Index [0 12] behind a broken startxref", async () => {
      await expectReachesParser(Buffer.from(`${BASE}${hiddenXrefObject("[0 12]")}startxref\n99999999\n%%EOF\n`));
    });

    it("A4: still reaches the parser for a valid single cross-reference stream that the scan would also find", async () => {
      await expectReachesParser(xrefStreamPdf());
    });

    it("B5: refuses a classic subsection header whose count is hidden by a trailing comment", async () => {
      await expectRefused(classicTable("0 2000000 %pad"));
    });

    it("B6: still reaches the parser for a classic subsection header with a small count and a trailing comment", async () => {
      await expectReachesParser(classicTable("0 3 %ok"));
    });

    it("B7: still reaches the parser when an object has a /XRefStm key and the startxref is good and small", async () => {
      await expectReachesParser(classicTable("0 3", "5 0 obj\n<< /Type /Foo /XRefStm 0 >>\nendobj\n"));
    });
  });
});
