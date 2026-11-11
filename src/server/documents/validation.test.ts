import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NEEDS_POPPLER, popplerIt } from "../../../tests/support/poppler-sandbox";
import { LocalDocumentStorage } from "./storage";
import {
  classifyDocumentStructure,
  detectDocumentMediaType,
  normalizedDocumentFilename,
  validateSupportedDocumentStructure,
} from "./validation";
import { syntheticJpeg, syntheticPdf, syntheticPng } from "../../../tests/support/synthetic-documents";
import {
  classicChainPdf,
  syntheticModernPdf,
  syntheticPdfActiveContent,
  syntheticPdfWithPages,
  syntheticStructurePdfFixtures,
  xrefStmChainPdf,
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

/** The verdict's reason alone: the check also answers the page count (#1436 D3). */
async function reasonOf(bytes: Buffer, mediaType: Parameters<typeof classifyDocumentStructure>[1]): Promise<string> {
  return (await classifyDocumentStructure(bytes, mediaType)).reason;
}

/*
 * The PDF cases run the real pdfinfo (#1436): `popplerIt` skips them where
 * poppler is not installed outside CI, and fails them in CI.
 */
describe(`structural document classification ${NEEDS_POPPLER}`, () => {
  // The hand-made xref-stream fixture is gone from this list: its stream holds
  // no real entries and it has no trailer, which only pdf.js's index model
  // forgave; pdfinfo answers "Couldn't read xref table". Real xref streams
  // are covered by the qpdf producer fixtures below (#1436).
  popplerIt.each([
    [validPdf, "application/pdf", "supported_structure"],
  ] as const)("classifies supported %s as supported_structure", async (bytes, mediaType, expected) => {
    await expect(reasonOf(bytes, mediaType)).resolves.toBe(expected);
    await expect(validateSupportedDocumentStructure(bytes, mediaType)).resolves.toBe(true);
  });

  it.each([
    [validJpeg, "image/jpeg", "supported_structure"],
    [validPng, "image/png", "supported_structure"],
  ] as const)("classifies supported %s as supported_structure", async (bytes, mediaType, expected) => {
    await expect(reasonOf(bytes, mediaType)).resolves.toBe(expected);
    await expect(validateSupportedDocumentStructure(bytes, mediaType)).resolves.toBe(true);
  });

  it("answers an image's page count as 1 (#1436 D8)", async () => {
    await expect(classifyDocumentStructure(validPng, "image/png")).resolves.toEqual({ reason: "supported_structure", pageCount: 1 });
  });

  popplerIt.each([
    ["Chromium PDF producer", chromiumPdf],
    ["qpdf object and xref streams", qpdfObjectStreamPdf],
    ["qpdf incremental update", qpdfIncrementalPdf],
    ["qpdf compressed object streams with a predicted xref stream", qpdfCompressedObjectStreamPdf],
  ] as const)("accepts independent producer fixture: %s", async (_name, bytes) => {
    await expect(reasonOf(bytes, "application/pdf")).resolves.toBe("supported_structure");
    await expect(validateSupportedDocumentStructure(bytes, "application/pdf")).resolves.toBe(true);
  });

  popplerIt.each(syntheticStructurePdfFixtures.map((fixture) => [fixture.name, fixture.bytes] as const))("accepts synthetic standards-valid PDF structure from %s", async (_name, bytes) => {
    await expect(reasonOf(bytes, "application/pdf")).resolves.toBe("supported_structure");
    await expect(validateSupportedDocumentStructure(bytes, "application/pdf")).resolves.toBe(true);
  });

  describe("modern producer structure: object streams indexed by a compressed cross-reference stream", () => {
    popplerIt("accepts the ordinary shape, with a nested /DecodeParms ahead of /Size", async () => {
      await expect(reasonOf(syntheticModernPdf(), "application/pdf")).resolves.toBe("supported_structure");
    });

    popplerIt("accepts a cross-reference dictionary long enough to push /Type /XRef past its first 512 bytes", async () => {
      await expect(reasonOf(syntheticModernPdf({ longIndex: true }), "application/pdf"))
        .resolves.toBe("supported_structure");
    });
  });

  describe("cross-reference chains poppler reads (the index bound of #1316 is retired, ADR-0046)", () => {
    popplerIt("accepts a small xref stream named by /XRefStm from two chained classic tables", async () => {
      await expect(reasonOf(xrefStmChainPdf(), "application/pdf")).resolves.toBe("supported_structure");
    });

    popplerIt("accepts the same chain when the first table's /Prev points back at the final table", async () => {
      await expect(reasonOf(xrefStmChainPdf({ cycle: true }), "application/pdf")).resolves.toBe("supported_structure");
    });

    popplerIt("accepts a chain of 100 classic tables, a file saved incrementally many times (#1397)", async () => {
      await expect(reasonOf(classicChainPdf({ sections: 100 }), "application/pdf")).resolves.toBe("supported_structure");
    });
  });

  describe("poppler opens it with no password and finds page one (ADR-0033, ADR-0046)", () => {
    popplerIt.each(syntheticPdfActiveContent.map((fixture) => [fixture.name, fixture.options] as const))("accepts a PDF carrying %s: the renderer runs none of it", async (_name, options) => {
      await expect(reasonOf(syntheticModernPdf(options), "application/pdf")).resolves.toBe("supported_structure");
    });

    popplerIt("accepts an owner-password-only PDF with an encrypted object stream: poppler decrypts it itself (#1292)", async () => {
      await expect(reasonOf(syntheticOwnerPasswordPdf(), "application/pdf")).resolves.toBe("supported_structure");
    });

    popplerIt("refuses a PDF that needs a password to open, and says that is why", async () => {
      await expect(reasonOf(syntheticUserPasswordPdf(), "application/pdf")).resolves.toBe("password_required");
      await expect(validateSupportedDocumentStructure(syntheticUserPasswordPdf(), "application/pdf")).resolves.toBe(false);
    });

    popplerIt("accepts a PDF whose final offset is wrong but which poppler repairs and draws, since that is the file it shows", async () => {
      const wrongOffset = Buffer.from(validPdf.toString("latin1").replace(/startxref\n\d+/u, "startxref\n1"), "latin1");
      await expect(reasonOf(wrongOffset, "application/pdf")).resolves.toBe("supported_structure");
    });

    it("refuses a file that is not a PDF, JPEG or PNG by its magic bytes, whatever it is called", () => {
      const html = Buffer.from("<!doctype html><title>invoice.pdf</title><script>alert(1)</script>");
      expect(() => detectDocumentMediaType(html)).toThrow(expect.objectContaining({ code: "document_type_unsupported" }));
    });

    popplerIt("refuses a PDF over the page cap of 100, though poppler would open it (#1436 D7)", async () => {
      await expect(classifyDocumentStructure(syntheticPdfWithPages(100), "application/pdf")).resolves.toEqual({ reason: "supported_structure", pageCount: 100 });
      await expect(reasonOf(syntheticPdfWithPages(101), "application/pdf")).resolves.toBe("unsupported_structure");
    });

    it("refuses a file over the size limit as it arrives, before anything reads it", async () => {
      const root = await mkdtemp(join(tmpdir(), "orbit-size-limit-"));
      try {
        const storage = new LocalDocumentStorage(join(root, "objects"), join(root, "quarantine"));
        const bytes = Buffer.concat([validPdf, Buffer.alloc(4_096, 0x20)]);
        const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
        await expect(storage.receive(body, "33333333-3333-4333-8333-333333333333", 1_024))
          .rejects.toMatchObject({ code: "document_too_large" });
        await expect(storage.listQuarantineFiles()).resolves.toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    popplerIt("refuses a PDF whose page tree names no page poppler can find", async () => {
      const noPage = Buffer.from(validPdf.toString("latin1").replace("/Kids [3 0 R] /Count 1", "/Kids [] /Count 0"), "latin1");
      await expect(reasonOf(noPage, "application/pdf")).resolves.toBe("unsupported_structure");
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
      await expect(reasonOf(bytes, mediaType)).resolves.toBe("unsupported_structure");
    });

    it("refuses an image whose header is within the cap but whose data the decoder cannot read", async () => {
      const cutShort = Buffer.concat([validPng.subarray(0, 24), Buffer.from([0, 0, 0, 0])]);
      await expect(reasonOf(cutShort, "image/png")).resolves.toBe("unsupported_structure");
    });
  });

  popplerIt("does not expose parser failure details to console output", async () => {
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
      await expect(reasonOf(Buffer.from(value), "application/pdf"))
        .resolves.toBe("unsupported_structure");
      const output = spies.flatMap((spy) => spy.mock.calls.flat()).map(String).join(" ");
      expect(output).not.toContain(sentinel);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  popplerIt.each([
    [Buffer.from("%PDF-1.7\nheader only"), "application/pdf", "unsupported_structure"],
    [forgedPdfXref(), "application/pdf", "unsupported_structure"],
    [forgedPdfObjectOffset(), "application/pdf", "unsupported_structure"],
  ] as const)("classifies unsupported %s as unsupported_structure", async (bytes, mediaType, expected) => {
    await expect(reasonOf(bytes, mediaType)).resolves.toBe(expected);
    await expect(validateSupportedDocumentStructure(bytes, mediaType)).resolves.toBe(false);
  });

  it.each([
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg", "unsupported_structure"],
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png", "unsupported_structure"],
    [Buffer.concat([validPng.subarray(0, 24), Buffer.from([0, 0, 0, 0])]), "image/png", "unsupported_structure"],
  ] as const)("classifies unsupported %s as unsupported_structure", async (bytes, mediaType, expected) => {
    await expect(reasonOf(bytes, mediaType)).resolves.toBe(expected);
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

  popplerIt("accepts a bounded structurally valid PDF fixture", async () => {
    await expect(validateSupportedDocumentStructure(validPdf, "application/pdf")).resolves.toBe(true);
  });

  it.each([
    [validJpeg, "image/jpeg"],
    [validPng, "image/png"],
  ] as const)("accepts a bounded structurally valid %s fixture", async (bytes, mediaType) => {
    await expect(validateSupportedDocumentStructure(bytes, mediaType)).resolves.toBe(true);
  });

  popplerIt.each([
    [Buffer.from("%PDF-1.7\nheader only"), "application/pdf"],
    [forgedPdfXref(), "application/pdf"],
    [forgedPdfObjectOffset(), "application/pdf"],
  ] as const)("rejects a magic-byte-valid malformed PDF fixture", async (bytes, mediaType) => {
    await expect(validateSupportedDocumentStructure(bytes, mediaType)).resolves.toBe(false);
  });

  it.each([
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"],
    [Buffer.concat([validPng.subarray(0, 24), Buffer.from([0, 0, 0, 0])]), "image/png"],
  ] as const)("rejects a magic-byte-valid malformed fixture", async (bytes, mediaType) => {
    await expect(validateSupportedDocumentStructure(bytes, mediaType)).resolves.toBe(false);
  });
});
