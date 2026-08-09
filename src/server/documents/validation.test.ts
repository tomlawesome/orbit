import { describe, expect, it } from "vitest";
import {
  classifyDocumentStructure,
  detectDocumentMediaType,
  normalizedDocumentFilename,
  validateSupportedDocumentStructure,
} from "./validation";
import { syntheticJpeg, syntheticPdf, syntheticPdfWithXrefStream, syntheticPng } from "../../../tests/support/synthetic-documents";
import {
  generatedPdfFixtures,
  generatedPdfWithCatalogFeature,
  generatedPdfWithCompressedJavaScript,
  generatedPdfWithHarmlessFeatureName,
} from "../../../tests/support/generated-pdf-documents";

const validPdf = syntheticPdf();
const validPng = syntheticPng();
const validJpeg = syntheticJpeg();

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

  it.each(generatedPdfFixtures)("accepts generated standards-valid PDF from $name", async ({ bytes }) => {
    await expect(classifyDocumentStructure(bytes, "application/pdf")).resolves.toBe("supported_structure");
    await expect(validateSupportedDocumentStructure(bytes, "application/pdf")).resolves.toBe(true);
  });

  it("does not classify feature names inside compressed page content as active content", async () => {
    await expect(classifyDocumentStructure(generatedPdfWithHarmlessFeatureName(), "application/pdf"))
      .resolves.toBe("supported_structure");
  });

  it("rejects JavaScript hidden in a compressed object stream", async () => {
    await expect(classifyDocumentStructure(generatedPdfWithCompressedJavaScript(), "application/pdf"))
      .resolves.toBe("prohibited_content");
  });

  it.each([
    "/OpenAction 6 0 R /Names << /JavaScript << /Names [(run) 6 0 R] >> >>",
    "/OpenAction 6 0 R /Launch",
    "/Names << /EmbeddedFiles << /Names [(payload.bin) 6 0 R] >> >>",
    "/RichMedia 6 0 R",
    "/XFA 6 0 R",
  ])("classifies parsed prohibited catalog feature %s as prohibited_content", async (feature) => {
    await expect(classifyDocumentStructure(generatedPdfWithCatalogFeature(feature), "application/pdf"))
      .resolves.toBe("prohibited_content");
  });

  it.each([
    [Buffer.from("%PDF-1.7\nheader only"), "application/pdf", "unsupported_structure"],
    [forgedPdfXref(), "application/pdf", "unsupported_structure"],
    [forgedPdfObjectOffset(), "application/pdf", "unsupported_structure"],
    [Buffer.from(validPdf.toString("latin1").replace(/startxref\n\d+/u, "startxref\n1"), "latin1"), "application/pdf", "unsupported_structure"],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg", "unsupported_structure"],
    [validJpeg.subarray(0, -2), "image/jpeg", "unsupported_structure"],
    [Buffer.from(validJpeg.map((value, index) => index === 6 ? 0 : value)), "image/jpeg", "unsupported_structure"],
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
    [generatedPdfWithCatalogFeature("/Names << /EmbeddedFiles << /Names [(payload.bin) 6 0 R] >> >>"), "application/pdf"],
    [Buffer.from(validPdf.toString("latin1").replace(/startxref\n\d+/u, "startxref\n1"), "latin1"), "application/pdf"],
    [forgedPdfXref(), "application/pdf"],
    [forgedPdfObjectOffset(), "application/pdf"],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
    [validJpeg.subarray(0, -2), "image/jpeg"],
    [Buffer.from(validJpeg.map((value, index) => index === 6 ? 0 : value)), "image/jpeg"],
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"],
    [Buffer.concat([validPng.subarray(0, 24), Buffer.from([0, 0, 0, 0])]), "image/png"],
  ] as const)("rejects a magic-byte-valid malformed fixture", async (bytes, mediaType) => {
    await expect(validateSupportedDocumentStructure(bytes, mediaType)).resolves.toBe(false);
  });
});
