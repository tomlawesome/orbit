import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classicChainPdf,
  syntheticPdfWithPages,
  xrefStmChainPdf,
  xrefStreamPdf,
} from "../../../tests/support/generated-pdf-documents";
import { syntheticPdf } from "../../../tests/support/synthetic-documents";
import {
  classicTable,
  hiddenXrefObject,
  linearizedHidingOversizedSection,
  linearizedWithSmallSections,
  pdfWithClassicXref,
  pdfWithXrefStream,
  smallPdfWithFirstObject,
  BASE,
} from "../../../tests/support/pdf-budget-shapes";
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
