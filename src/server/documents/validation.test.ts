import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  classifyDocumentStructure,
  detectDocumentMediaType,
  normalizedDocumentFilename,
  PDF_STRUCTURE_PARSER_OPTIONS,
  validateSupportedDocumentStructure,
} from "./validation";
import { syntheticJpeg, syntheticPdf, syntheticPdfWithXrefStream, syntheticPng } from "../../../tests/support/synthetic-documents";
import {
  syntheticModernPdf,
  syntheticPdfWithHarmlessFeatureName,
  syntheticStructurePdfFixtures,
} from "../../../tests/support/generated-pdf-documents";
import { syntheticOwnerPasswordPdf, syntheticUserPasswordPdf } from "../../../tests/support/encrypted-pdf-documents";

const validPdf = syntheticPdf();
const validPng = syntheticPng();
const validJpeg = syntheticJpeg();
const chromiumPdf = readFileSync(new URL("../../../tests/support/fixtures/chromium-synthetic.pdf", import.meta.url));
const qpdfObjectStreamPdf = readFileSync(new URL("../../../tests/support/fixtures/qpdf-object-stream.pdf", import.meta.url));
const qpdfIncrementalPdf = readFileSync(new URL("../../../tests/support/fixtures/qpdf-incremental-3.pdf", import.meta.url));
const qpdfCompressedObjectStreamPdf = readFileSync(new URL("../../../tests/support/fixtures/qpdf-compress-objstm-xref.pdf", import.meta.url));

function forgedPdfXref(): Buffer {
  let value = "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n";
  const xrefOffset = Buffer.byteLength(value);
  value += "xref\nnot a table\ntrailer\n<< /Root 1 0 R >>\n";
  value += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(value);
}

function forgedPdfObjectOffset(): Buffer {
  let value = "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n";
  const xrefOffset = Buffer.byteLength(value);
  value += "xref\n0 2\n0000000000 65535 f \n0000000001 00000 n \n";
  value += "trailer\n<< /Size 2 /Root 1 0 R >>\n";
  value += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(value);
}

describe("structural document classification", () => {
  it.each([
    [validPdf, "application/pdf", "supported_structure"],
    [syntheticPdfWithXrefStream(), "application/pdf", "supported_structure"],
    [validJpeg, "image/jpeg", "supported_structure"],
    [validPng, "image/png", "supported_structure"],
  ] as const)("classifies supported %s as supported_structure", async (bytes, mediaType, expected) => {
    await expect(classifyDocumentStructure(bytes, mediaType)).resolves.toBe(expected);
    await expect(validateSupportedDocumentStructure(bytes, mediaType)).resolves.toBe(true);
  });

  it.each([
    ["Chromium PDF producer", chromiumPdf],
    ["qpdf object and xref streams", qpdfObjectStreamPdf],
    ["qpdf incremental update", qpdfIncrementalPdf],
    ["qpdf compressed object streams with a predicted xref stream", qpdfCompressedObjectStreamPdf],
  ] as const)("accepts independent producer fixture: %s", async (_name, bytes) => {
    await expect(classifyDocumentStructure(bytes, "application/pdf")).resolves.toBe("supported_structure");
    await expect(validateSupportedDocumentStructure(bytes, "application/pdf")).resolves.toBe(true);
  });

  it.each(syntheticStructurePdfFixtures)("accepts synthetic standards-valid PDF structure from $name", async ({ bytes }) => {
    await expect(classifyDocumentStructure(bytes, "application/pdf")).resolves.toBe("supported_structure");
    await expect(validateSupportedDocumentStructure(bytes, "application/pdf")).resolves.toBe(true);
  });

  describe("modern producer structure: object streams indexed by a compressed cross-reference stream", () => {
    it("accepts the ordinary shape, with a nested /DecodeParms ahead of /Size", async () => {
      await expect(classifyDocumentStructure(syntheticModernPdf(), "application/pdf")).resolves.toBe("supported_structure");
    });

    it("accepts a cross-reference dictionary long enough to push /Type /XRef past its first 512 bytes", async () => {
      await expect(classifyDocumentStructure(syntheticModernPdf({ longIndex: true }), "application/pdf"))
        .resolves.toBe("supported_structure");
    });
  });

  it("does not classify feature names inside compressed page content as active content", async () => {
    await expect(classifyDocumentStructure(syntheticPdfWithHarmlessFeatureName(), "application/pdf"))
      .resolves.toBe("supported_structure");
  });

  describe("pdf.js opens it with no password and finds page one (ADR-0033)", () => {
    it("accepts an owner-password-only PDF with an encrypted object stream: pdf.js decrypts it itself (#1292)", async () => {
      await expect(classifyDocumentStructure(syntheticOwnerPasswordPdf(), "application/pdf")).resolves.toBe("supported_structure");
    });

    it("refuses a PDF that needs a password to open, and says that is why", async () => {
      await expect(classifyDocumentStructure(syntheticUserPasswordPdf(), "application/pdf")).resolves.toBe("password_required");
      await expect(validateSupportedDocumentStructure(syntheticUserPasswordPdf(), "application/pdf")).resolves.toBe(false);
    });

    it("accepts a PDF whose final offset is wrong but which pdf.js repairs and draws, since that is the file it shows", async () => {
      const wrongOffset = Buffer.from(validPdf.toString("latin1").replace(/startxref\n\d+/u, "startxref\n1"), "latin1");
      await expect(classifyDocumentStructure(wrongOffset, "application/pdf")).resolves.toBe("supported_structure");
    });

    it("refuses a PDF whose page tree names no page pdf.js can find", async () => {
      const noPage = Buffer.from(validPdf.toString("latin1").replace("/Kids [3 0 R] /Count 1", "/Kids [] /Count 0"), "latin1");
      await expect(classifyDocumentStructure(noPage, "application/pdf")).resolves.toBe("unsupported_structure");
    });
  });

  describe("images: the header is within the cap and the decoder reads it (ADR-0033)", () => {
    function pngWithDeclaredSize(width: number, height: number): Buffer {
      const bytes = Buffer.from(validPng);
      bytes.writeUInt32BE(width, 16);
      bytes.writeUInt32BE(height, 20);
      return bytes;
    }

    function jpegWithDeclaredSize(width: number, height: number): Buffer {
      const bytes = Buffer.from(validJpeg);
      const frame = bytes.indexOf(Buffer.from([0xff, 0xc0]));
      bytes.writeUInt16BE(height, frame + 5);
      bytes.writeUInt16BE(width, frame + 7);
      return bytes;
    }

    it.each([
      ["PNG over the edge cap", pngWithDeclaredSize(20_001, 1), "image/png"],
      ["PNG over the pixel cap", pngWithDeclaredSize(10_000, 10_000), "image/png"],
      ["JPEG over the pixel cap", jpegWithDeclaredSize(10_000, 10_000), "image/jpeg"],
      ["PNG declaring no pixels", pngWithDeclaredSize(0, 1), "image/png"],
    ] as const)("refuses a %s from its header, before decoding", async (_name, bytes, mediaType) => {
      await expect(classifyDocumentStructure(bytes, mediaType)).resolves.toBe("unsupported_structure");
    });

    it("refuses an image whose header is within the cap but whose data the decoder cannot read", async () => {
      const cutShort = Buffer.concat([validPng.subarray(0, 24), Buffer.from([0, 0, 0, 0])]);
      await expect(classifyDocumentStructure(cutShort, "image/png")).resolves.toBe("unsupported_structure");
    });
  });

  it("keeps parser security options explicit", () => {
    expect(PDF_STRUCTURE_PARSER_OPTIONS).toMatchObject({
      disableAutoFetch: true,
      disableFontFace: true,
      disableRange: true,
      disableStream: true,
      enableScripting: false,
      enableXfa: false,
      isEvalSupported: false,
      isImageDecoderSupported: false,
      isOffscreenCanvasSupported: false,
      stopAtErrors: true,
      useSystemFonts: false,
      useWasm: false,
      useWorkerFetch: false,
    });
  });

  it("does not expose parser failure details to console output", async () => {
    const sentinel = "hostile-filename-provider-sentinel";
    let value = `%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Title (${sentinel}) >>\nendobj\n`;
    const xrefOffset = Buffer.byteLength(value);
    value += `xref\nnot a table\ntrailer\n<< /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    const spies = [
      vi.spyOn(console, "error"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "log"),
      vi.spyOn(console, "warn"),
    ];
    spies.forEach((spy) => spy.mockImplementation(() => undefined));
    try {
      await expect(classifyDocumentStructure(Buffer.from(value), "application/pdf"))
        .resolves.toBe("unsupported_structure");
      const output = spies.flatMap((spy) => spy.mock.calls.flat()).map(String).join(" ");
      expect(output).not.toContain(sentinel);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  it.each([
    [Buffer.from("%PDF-1.7\nheader only"), "application/pdf", "unsupported_structure"],
    [forgedPdfXref(), "application/pdf", "unsupported_structure"],
    [forgedPdfObjectOffset(), "application/pdf", "unsupported_structure"],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg", "unsupported_structure"],
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png", "unsupported_structure"],
    [Buffer.concat([validPng.subarray(0, 24), Buffer.from([0, 0, 0, 0])]), "image/png", "unsupported_structure"],
  ] as const)("classifies unsupported %s as unsupported_structure", async (bytes, mediaType, expected) => {
    await expect(classifyDocumentStructure(bytes, mediaType)).resolves.toBe(expected);
    await expect(validateSupportedDocumentStructure(bytes, mediaType)).resolves.toBe(false);
  });
});

describe("document content validation", () => {
  it.each([
    [Buffer.from("%PDF-1.7"), "application/pdf"],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"],
  ] as const)("identifies supported magic bytes", (bytes, expected) => {
    expect(detectDocumentMediaType(bytes)).toBe(expected);
  });

  it("rejects WebP content", () => {
    expect(() => detectDocumentMediaType(Buffer.from("RIFF0000WEBP"))).toThrow(
      "Choose a PDF, JPEG, or PNG document",
    );
  });

  it("rejects unsupported content and strips path/control data from display names", () => {
    expect(() => detectDocumentMediaType(Buffer.from("MZ executable"))).toThrow("Choose a PDF");
    expect(normalizedDocumentFilename("../private/\u0000\u202epolicy.pdf", "application/pdf")).toBe("policy.pdf");
  });

  it.each([
    [validPdf, "application/pdf"],
    [validJpeg, "image/jpeg"],
    [validPng, "image/png"],
  ] as const)("accepts a bounded structurally valid %s fixture", async (bytes, mediaType) => {
    await expect(validateSupportedDocumentStructure(bytes, mediaType)).resolves.toBe(true);
  });

  it.each([
    [Buffer.from("%PDF-1.7\nheader only"), "application/pdf"],
    [forgedPdfXref(), "application/pdf"],
    [forgedPdfObjectOffset(), "application/pdf"],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"],
    [Buffer.concat([validPng.subarray(0, 24), Buffer.from([0, 0, 0, 0])]), "image/png"],
  ] as const)("rejects a magic-byte-valid malformed fixture", async (bytes, mediaType) => {
    await expect(validateSupportedDocumentStructure(bytes, mediaType)).resolves.toBe(false);
  });
});
