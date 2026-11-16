import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptDocument,
  type DocumentEncryptionContext,
  DocumentIntegrityError,
  ENVELOPE_VERSION,
  encryptDocument,
  rewrapDocumentKey,
  unwrapKeyWithAad,
} from "./crypto";

/**
 * #1433 D15, design note §2.6 line 3 (at the cipher): a kept page is sealed
 * under the document key hierarchy with its own purpose, "preview", and its
 * page number in the content AAD; its DEK is wrapped under the key AAD
 * purpose "orbit-document-preview-dek". So a preview never opens as a
 * document, one page never opens as another, and document AAD bytes do not
 * change. `purpose: "preview"` and `page` are not in the type yet, so the
 * contexts are cast.
 */

const kek = randomBytes(32);
const keyId = "test-key";

function documentContext(plaintextSize: number): DocumentEncryptionContext {
  return { documentId: randomUUID(), householdId: randomUUID(), itemId: randomUUID(), mediaType: "application/pdf", plaintextSize };
}

function previewContext(base: DocumentEncryptionContext, page: number, plaintextSize: number): DocumentEncryptionContext {
  return { ...base, mediaType: "image/jpeg", plaintextSize, purpose: "preview", page } as unknown as DocumentEncryptionContext;
}

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(500)]);

describe("preview envelopes (#1433 D15)", () => {
  it("control: a page sealed with the preview context opens with the same context", () => {
    const context = previewContext(documentContext(10), 2, jpeg.length);
    const sealed = encryptDocument(jpeg, context, kek, keyId);
    expect(decryptDocument(sealed.ciphertext, context, sealed.envelope, kek).equals(jpeg)).toBe(true);
  });

  it("§2.6 line 3: a kept page cannot be unsealed with the document's context (purpose document)", () => {
    const base = documentContext(10);
    const context = previewContext(base, 2, jpeg.length);
    const sealed = encryptDocument(jpeg, context, kek, keyId);
    const asDocument = { ...base, mediaType: "image/jpeg", plaintextSize: jpeg.length, purpose: "document" } as DocumentEncryptionContext;
    expect(() => decryptDocument(sealed.ciphertext, asDocument, sealed.envelope, kek)).toThrow(DocumentIntegrityError);
  });

  it("§2.6 line 3: a kept page cannot be unsealed as another page number (AAD mismatch)", () => {
    const base = documentContext(10);
    const sealed = encryptDocument(jpeg, previewContext(base, 2, jpeg.length), kek, keyId);
    expect(() => decryptDocument(sealed.ciphertext, previewContext(base, 3, jpeg.length), sealed.envelope, kek)).toThrow(DocumentIntegrityError);
  });

  it("§2.6 line 3: a document object cannot be unsealed with the preview context", () => {
    const plaintext = randomBytes(600);
    const base = documentContext(plaintext.length);
    const sealed = encryptDocument(plaintext, base, kek, keyId);
    const asPreview = { ...base, purpose: "preview", page: 1 } as unknown as DocumentEncryptionContext;
    expect(() => decryptDocument(sealed.ciphertext, asPreview, sealed.envelope, kek)).toThrow(DocumentIntegrityError);
  });

  it("D15: a page's DEK is wrapped under key AAD purpose orbit-document-preview-dek", () => {
    const context = previewContext(documentContext(10), 1, jpeg.length);
    const sealed = encryptDocument(jpeg, context, kek, keyId);
    const aad = Buffer.from(JSON.stringify({ purpose: "orbit-document-preview-dek", envelopeVersion: ENVELOPE_VERSION, documentId: context.documentId, keyId }), "utf8");
    expect(unwrapKeyWithAad(sealed.envelope, kek, aad)).toHaveLength(32);
  });

  it("D15/D17: a page's DEK rewraps under purpose preview and the page still opens under the next key", () => {
    const context = previewContext(documentContext(10), 4, jpeg.length);
    const sealed = encryptDocument(jpeg, context, kek, keyId);
    const nextKek = randomBytes(32);
    const purpose = "preview" as unknown as DocumentEncryptionContext["purpose"];
    const envelope = rewrapDocumentKey(context.documentId, sealed.envelope, kek, nextKek, "next-key", purpose);
    expect(decryptDocument(sealed.ciphertext, context, envelope, nextKek).equals(jpeg)).toBe(true);
  });

  it("D15 (2.5 note): document AAD bytes are unchanged: page is ignored unless the purpose is preview", () => {
    const plaintext = randomBytes(300);
    const base = documentContext(plaintext.length);
    const sealed = encryptDocument(plaintext, base, kek, keyId);
    const withPage = { ...base, page: 7 } as unknown as DocumentEncryptionContext;
    expect(decryptDocument(sealed.ciphertext, withPage, sealed.envelope, kek).equals(plaintext)).toBe(true);
  });
});
