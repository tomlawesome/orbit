import { describe, expect, it } from "vitest";
import {
  IMAP_ATTACHMENT_LIMITS,
  classifyImapBodyStructure,
  normalizeImapAttachmentName,
  validateImapAttachmentBytes,
} from "./imap-attachment-validation";
import { syntheticPdf } from "../../tests/support/synthetic-documents";

function structure(overrides: Record<string, unknown> = {}) {
  return {
    part: "1",
    type: "application",
    subtype: "pdf",
    disposition: "attachment",
    dispositionParameters: { filename: "receipt.pdf" },
    size: 12,
    ...overrides,
  } as never;
}

describe("hostile IMAP attachment validation", () => {
  it("accepts exact boundaries and rejects the first byte/count/level beyond them", () => {
    expect(IMAP_ATTACHMENT_LIMITS.rawMessageBytes).toBe(25 * 1024 * 1024);
    expect(classifyImapBodyStructure(structure({ size: IMAP_ATTACHMENT_LIMITS.aggregateAttachmentBytes })).ok).toBe(true);
    expect(classifyImapBodyStructure(structure({ size: IMAP_ATTACHMENT_LIMITS.aggregateAttachmentBytes + 1 })).ok).toBe(false);
    expect(classifyImapBodyStructure(structure({ childNodes: Array.from({ length: IMAP_ATTACHMENT_LIMITS.mimePartCount - 1 }, (_, i) => structure({ part: `1.${i + 1}`, disposition: undefined })) })).ok).toBe(true);
    expect(classifyImapBodyStructure(structure({ childNodes: Array.from({ length: IMAP_ATTACHMENT_LIMITS.mimePartCount }, (_, i) => structure({ part: `1.${i + 1}`, disposition: undefined })) })).ok).toBe(false);
  });

  it("bounds attachment count, depth, and per-document metadata", () => {
    const ten = Array.from({ length: IMAP_ATTACHMENT_LIMITS.attachmentCount }, (_, i) => structure({ part: `1.${i + 1}`, dispositionParameters: { filename: `${i}.pdf` } }));
    expect(classifyImapBodyStructure(structure({ childNodes: ten })).ok).toBe(true);
    expect(classifyImapBodyStructure(structure({ childNodes: [...ten, structure({ part: "1.11", dispositionParameters: { filename: "too-many.pdf" } })] })).ok).toBe(false);

    let nested: Record<string, unknown> = structure();
    for (let i = 0; i < IMAP_ATTACHMENT_LIMITS.mimeNestingDepth; i += 1) nested = structure({ childNodes: [nested], disposition: undefined });
    expect(classifyImapBodyStructure(nested as never).ok).toBe(false);
  });

  it("keeps unnamed attachment parts bounded and gives them a server fallback name", () => {
    const result = classifyImapBodyStructure(structure({ dispositionParameters: {}, filename: undefined }));
    expect(result).toMatchObject({ ok: true, candidates: [{ part: "1", filename: undefined }] });
    expect(normalizeImapAttachmentName(undefined, "application/pdf")).toBe("document.pdf");
  });

  it("represents a message with zero supported attachment parts as an explicit empty set", () => {
    expect(classifyImapBodyStructure(structure({ disposition: undefined, dispositionParameters: {}, filename: undefined })).candidates).toEqual([]);
  });

  it("only accepts supported types when the declaration agrees with detected bytes", () => {
    const validPdf = syntheticPdf();
    expect(validateImapAttachmentBytes(validPdf, "application/pdf")).toMatchObject({ ok: true, mediaType: "application/pdf" });
    expect(validateImapAttachmentBytes(validPdf, "image/png")).toMatchObject({ ok: false, code: "mime_type_mismatch" });
    expect(validateImapAttachmentBytes(Buffer.from("PK\x03\x04"), "application/pdf")).toMatchObject({ ok: false, code: "document_type_unsupported" });
    expect(validateImapAttachmentBytes(Buffer.from("<svg></svg>"), "image/svg+xml")).toMatchObject({ ok: false, code: "document_type_unsupported" });
    expect(validateImapAttachmentBytes(Buffer.from("%PDF-"), "application/pdf")).toMatchObject({ ok: false, code: "mime_structure_invalid" });
    expect(validateImapAttachmentBytes(validPdf, "application/pdf", { pdfOnly: true })).toMatchObject({ ok: true, mediaType: "application/pdf" });
    expect(validateImapAttachmentBytes(Buffer.from([0xff, 0xd8, 0xff]), "application/pdf", { pdfOnly: true })).toMatchObject({ ok: false, code: "mime_type_mismatch" });
  });

  it("selects only metadata-claimed PDFs for the mailbox path while counting other MIME nodes", () => {
    const result = classifyImapBodyStructure({
      part: "1", type: "multipart", subtype: "mixed", childNodes: [
        structure({ part: "1.1", disposition: "inline", type: "image", subtype: "png", dispositionParameters: { filename: "logo.png" } }),
        structure({ part: "1.2", disposition: undefined, type: "application", subtype: "pdf", dispositionParameters: {}, filename: undefined }),
        structure({ part: "1.3", disposition: "attachment", type: "application", subtype: "zip", dispositionParameters: { filename: "archive.zip" } }),
      ],
    }, { mailboxPdfOnly: true });
    expect(result).toMatchObject({ ok: true, partCount: 4, candidates: [{ part: "1.2", filename: undefined, declaredMediaType: "application/pdf" }] });
    expect(classifyImapBodyStructure(structure({ type: "image", subtype: "png", disposition: "inline", dispositionParameters: { filename: "logo.png" } }), { mailboxPdfOnly: true }).candidates).toEqual([]);
    expect(classifyImapBodyStructure(structure({ type: "application", subtype: "octet-stream", disposition: "attachment", dispositionParameters: { filename: "claimed.PdF" } }), { mailboxPdfOnly: true }).candidates).toHaveLength(1);
  });

  it("does not let traversal, absolute, control, bidi, or overlong names influence storage", () => {
    for (const name of ["..\\..\\secret.pdf", "/etc/passwd", "C:\\Windows\\x.pdf", "\\\\server\\share\\x.pdf", "bad\0name.pdf", "bad\u202Efdp.pdf", `${"x".repeat(300)}.pdf`]) {
      const normalized = normalizeImapAttachmentName(name, "application/pdf");
      expect(normalized).not.toContain("/");
      expect(normalized).not.toContain("\\");
      expect(normalized).not.toContain("\0");
      expect(Buffer.byteLength(normalized)).toBeLessThanOrEqual(180);
    }
  });
});
