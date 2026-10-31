import {
  type CipherGCM,
  type DecipherGCM,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

export const ENVELOPE_ALGORITHM = "aes-256-gcm";
export const ENVELOPE_VERSION = 1;
export const ENVELOPE_IV_BYTES = 12;
export const ENVELOPE_AUTH_TAG_BYTES = 16;
export const ENVELOPE_KEY_BYTES = 32;

// Retained as unexported aliases so the rest of this file reads exactly as it
// did before the ADR-0017 generalisation below.
const ALGORITHM = ENVELOPE_ALGORITHM;
const IV_BYTES = ENVELOPE_IV_BYTES;
const AUTH_TAG_BYTES = ENVELOPE_AUTH_TAG_BYTES;
const KEY_BYTES = ENVELOPE_KEY_BYTES;

export interface DocumentEncryptionContext {
  documentId: string;
  householdId: string;
  itemId: string;
  mediaType: string;
  plaintextSize: number;
  purpose?: "document" | "scanner_recovery";
}

/**
 * The stored shape of one envelope: how a DEK was wrapped and how the content
 * was sealed. Documents, held attachments, staging objects and the mail-in
 * secrets all keep these eight columns, so they share the one type. The
 * version is the number on the row, not a literal: decryption refuses any
 * but the one it knows, so a stored version 2 is refused rather than read as 1.
 */
export interface CryptoEnvelope {
  envelopeVersion: number;
  algorithm: "aes-256-gcm";
  keyId: string;
  contentIv: string;
  contentAuthTag: string;
  wrappedDek: string;
  wrapIv: string;
  wrapAuthTag: string;
}

/**
 * The envelope held in a database row. Copies the eight envelope columns by
 * name, so extra columns on the row (the ciphertext, storage key, document
 * id) never travel inside the envelope, and the algorithm is the one this
 * module implements. The AAD builders stay separate on purpose: they differ
 * per purpose for domain separation.
 */
export function envelopeOf(row: Omit<CryptoEnvelope, "algorithm">): CryptoEnvelope {
  return {
    envelopeVersion: row.envelopeVersion,
    algorithm: ENVELOPE_ALGORITHM,
    keyId: row.keyId,
    contentIv: row.contentIv,
    contentAuthTag: row.contentAuthTag,
    wrappedDek: row.wrappedDek,
    wrapIv: row.wrapIv,
    wrapAuthTag: row.wrapAuthTag,
  };
}

export interface EncryptedDocument {
  ciphertext: Buffer;
  envelope: CryptoEnvelope;
}

function requireKey(key: Buffer, name: string): void {
  if (key.length !== KEY_BYTES) throw new Error(`${name} must contain exactly 32 bytes`);
}

function decodeFixed(value: string, expectedBytes: number, name: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== expectedBytes) throw new Error(`${name} has an invalid length`);
  return decoded;
}

function contentAdditionalData(context: DocumentEncryptionContext): Buffer {
  return Buffer.from(JSON.stringify({
    envelopeVersion: ENVELOPE_VERSION,
    documentId: context.documentId,
    householdId: context.householdId,
    itemId: context.itemId,
    mediaType: context.mediaType,
    plaintextSize: context.plaintextSize,
    purpose: context.purpose ?? "document",
  }), "utf8");
}

function keyAdditionalData(documentId: string, keyId: string, purpose: DocumentEncryptionContext["purpose"] = "document"): Buffer {
  return Buffer.from(JSON.stringify({
    purpose: purpose === "scanner_recovery" ? "orbit-document-staging-dek" : "orbit-document-dek",
    envelopeVersion: ENVELOPE_VERSION,
    documentId,
    keyId,
  }), "utf8");
}

/**
 * Generic envelope key-wrap primitives (ADR-0017 decision 1): the same
 * AES-256-GCM construction `wrapDocumentKey`/`unwrapDocumentKey` always used,
 * generalised to take caller-supplied AAD instead of building document AAD
 * internally. Every purpose-specific caller — documents, and the mail-in
 * secrets in `src/server/mail-in/core/secret-crypto.ts` — builds its own AAD
 * and calls these rather than a new cipher construction being added per
 * purpose.
 */
export interface WrappedKey {
  wrappedDek: string;
  wrapIv: string;
  wrapAuthTag: string;
}

export function wrapKeyWithAad(dataKey: Buffer, keyEncryptionKey: Buffer, aad: Buffer): WrappedKey {
  requireKey(dataKey, "Data key");
  requireKey(keyEncryptionKey, "Key-encryption key");
  const wrapIv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyEncryptionKey, wrapIv, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(aad);
  const wrappedDek = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return {
    wrappedDek: wrappedDek.toString("base64url"),
    wrapIv: wrapIv.toString("base64url"),
    wrapAuthTag: cipher.getAuthTag().toString("base64url"),
  };
}

/** Reverses `wrapKeyWithAad`; throws unless `aad` matches exactly what wrapped it. */
export function unwrapKeyWithAad(wrapped: WrappedKey, keyEncryptionKey: Buffer, aad: Buffer): Buffer {
  requireKey(keyEncryptionKey, "Key-encryption key");
  const wrapIv = decodeFixed(wrapped.wrapIv, IV_BYTES, "Key-wrap IV");
  const wrapTag = decodeFixed(wrapped.wrapAuthTag, AUTH_TAG_BYTES, "Key-wrap authentication tag");
  const wrappedDek = Buffer.from(wrapped.wrappedDek, "base64url");
  if (wrappedDek.length !== KEY_BYTES) throw new Error("Wrapped key has an invalid length");
  const decipher = createDecipheriv(ALGORITHM, keyEncryptionKey, wrapIv, { authTagLength: AUTH_TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(wrapTag);
  const dataKey = Buffer.concat([decipher.update(wrappedDek), decipher.final()]);
  requireKey(dataKey, "Unwrapped key");
  return dataKey;
}

export interface EncryptedContent {
  ciphertext: Buffer;
  contentIv: string;
  contentAuthTag: string;
}

/** Generic content-encryption primitive underlying `encryptDocument`. */
export function encryptWithAad(plaintext: Buffer, dataKey: Buffer, aad: Buffer): EncryptedContent {
  requireKey(dataKey, "Data key");
  const contentIv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, dataKey, contentIv, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext,
    contentIv: contentIv.toString("base64url"),
    contentAuthTag: cipher.getAuthTag().toString("base64url"),
  };
}

/** Reverses `encryptWithAad`; throws unless `aad` and the tag both authenticate. */
export function decryptWithAad(
  ciphertext: Buffer,
  envelope: { contentIv: string; contentAuthTag: string },
  dataKey: Buffer,
  aad: Buffer,
): Buffer {
  requireKey(dataKey, "Data key");
  const contentIv = decodeFixed(envelope.contentIv, IV_BYTES, "Content IV");
  const contentTag = decodeFixed(envelope.contentAuthTag, AUTH_TAG_BYTES, "Content authentication tag");
  const decipher = createDecipheriv(ALGORITHM, dataKey, contentIv, { authTagLength: AUTH_TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(contentTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function wrapDocumentKey(
  documentKey: Buffer,
  documentId: string,
  keyEncryptionKey: Buffer,
  keyId: string,
  purpose: DocumentEncryptionContext["purpose"] = "document",
): Pick<CryptoEnvelope, "wrappedDek" | "wrapIv" | "wrapAuthTag"> {
  return wrapKeyWithAad(documentKey, keyEncryptionKey, keyAdditionalData(documentId, keyId, purpose));
}

function unwrapDocumentKey(
  documentId: string,
  envelope: CryptoEnvelope,
  keyEncryptionKey: Buffer,
  purpose: DocumentEncryptionContext["purpose"] = "document",
): Buffer {
  if (envelope.envelopeVersion !== ENVELOPE_VERSION || envelope.algorithm !== ALGORITHM) {
    throw new Error("Unsupported document encryption envelope");
  }
  return unwrapKeyWithAad(envelope, keyEncryptionKey, keyAdditionalData(documentId, envelope.keyId, purpose));
}

/**
 * The document cipher fed in pieces (#1567). `update` returns the ciphertext
 * for one chunk; `final` returns the last bytes and the envelope, the content
 * tag included. It is the construction `encryptDocument` has always used
 * (ADR-0017), called more than once: AES-GCM is a counter mode, so the stored
 * bytes are the same however the plaintext is cut.
 */
export interface DocumentSealer {
  update(chunk: Buffer): Buffer;
  final(): { tail: Buffer; envelope: CryptoEnvelope };
}

/**
 * Draws a random DEK, wraps it at once under the key-encryption key (the same
 * AAD as ever), starts the content cipher with the document's AAD and zeroes
 * the DEK: the cipher keeps its own copy. `context.plaintextSize` is known up
 * front, so the caller must feed exactly that many bytes; `final` refuses
 * anything else, because the size is bound into the content AAD and a
 * document sealed under the wrong size could never be opened.
 */
export function createDocumentSealer(
  context: DocumentEncryptionContext,
  keyEncryptionKey: Buffer,
  keyId: string,
): DocumentSealer {
  requireKey(keyEncryptionKey, "Key-encryption key");

  const documentKey = randomBytes(KEY_BYTES);
  let cipher: CipherGCM;
  let contentIv: Buffer;
  let wrapped: Pick<CryptoEnvelope, "wrappedDek" | "wrapIv" | "wrapAuthTag">;
  try {
    wrapped = wrapDocumentKey(documentKey, context.documentId, keyEncryptionKey, keyId, context.purpose);
    contentIv = randomBytes(IV_BYTES);
    cipher = createCipheriv(ALGORITHM, documentKey, contentIv, { authTagLength: AUTH_TAG_BYTES });
    cipher.setAAD(contentAdditionalData(context));
  } finally {
    documentKey.fill(0);
  }

  let fed = 0;
  let finished = false;
  return {
    update(chunk: Buffer): Buffer {
      if (finished) throw new Error("Document sealer is already finished");
      fed += chunk.length;
      return cipher.update(chunk);
    },
    final(): { tail: Buffer; envelope: CryptoEnvelope } {
      if (finished) throw new Error("Document sealer is already finished");
      finished = true;
      if (fed !== context.plaintextSize) throw new Error("Plaintext size does not match encryption context");
      const tail = cipher.final();
      return {
        tail,
        envelope: {
          envelopeVersion: ENVELOPE_VERSION,
          algorithm: ALGORITHM,
          keyId,
          contentIv: contentIv.toString("base64url"),
          contentAuthTag: cipher.getAuthTag().toString("base64url"),
          ...wrapped,
        },
      };
    },
  };
}

/** Encrypts validated document bytes and independently wraps their random DEK. */
export function encryptDocument(
  plaintext: Buffer,
  context: DocumentEncryptionContext,
  keyEncryptionKey: Buffer,
  keyId: string,
): EncryptedDocument {
  if (plaintext.length !== context.plaintextSize) throw new Error("Plaintext size does not match encryption context");
  const sealer = createDocumentSealer(context, keyEncryptionKey, keyId);
  const body = sealer.update(plaintext);
  const { tail, envelope } = sealer.final();
  return { ciphertext: tail.length === 0 ? body : Buffer.concat([body, tail]), envelope };
}

/** A document's ciphertext failed its tag, or is not the length that was sealed. */
export class DocumentIntegrityError extends Error {
  constructor() {
    super("Document failed its integrity check");
    this.name = "DocumentIntegrityError";
  }
}

/**
 * The document decipher fed in pieces (#1571), the mirror of `DocumentSealer`
 * over the same `createDecipheriv` call. `update` returns the plaintext of one
 * chunk, which is NOT yet authenticated: `final` is GCM's tag check, and
 * nothing may release plaintext to anyone before it has returned.
 */
export interface DocumentUnsealer {
  update(chunk: Buffer): Buffer;
  final(): void;
}

/**
 * Unwraps the DEK, starts the content decipher with the document's AAD and
 * tag, and zeroes the DEK: the decipher keeps its own copy. `final` throws
 * `DocumentIntegrityError` unless the bytes fed total `plaintextSize` (GCM
 * ciphertext is as long as its plaintext) and the tag authenticates.
 */
export function createDocumentUnsealer(
  context: DocumentEncryptionContext,
  envelope: CryptoEnvelope,
  keyEncryptionKey: Buffer,
): DocumentUnsealer {
  const documentKey = unwrapDocumentKey(context.documentId, envelope, keyEncryptionKey, context.purpose);
  let decipher: DecipherGCM;
  try {
    const contentIv = decodeFixed(envelope.contentIv, IV_BYTES, "Content IV");
    const contentTag = decodeFixed(envelope.contentAuthTag, AUTH_TAG_BYTES, "Content authentication tag");
    decipher = createDecipheriv(ALGORITHM, documentKey, contentIv, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(contentAdditionalData(context));
    decipher.setAuthTag(contentTag);
  } finally {
    documentKey.fill(0);
  }

  let fed = 0;
  let finished = false;
  return {
    update(chunk: Buffer): Buffer {
      if (finished) throw new Error("Document unsealer is already finished");
      fed += chunk.length;
      return decipher.update(chunk);
    },
    final(): void {
      if (finished) throw new Error("Document unsealer is already finished");
      finished = true;
      if (fed !== context.plaintextSize) throw new DocumentIntegrityError();
      try {
        decipher.final();
      } catch {
        throw new DocumentIntegrityError();
      }
    },
  };
}

/** Authenticates the complete ciphertext before returning any plaintext bytes. */
export function decryptDocument(
  ciphertext: Buffer,
  context: DocumentEncryptionContext,
  envelope: CryptoEnvelope,
  keyEncryptionKey: Buffer,
): Buffer {
  const unsealer = createDocumentUnsealer(context, envelope, keyEncryptionKey);
  const plaintext = unsealer.update(ciphertext);
  unsealer.final();
  return plaintext;
}

/** Rewraps a DEK without decrypting or rewriting document ciphertext. The
 * purpose must match the one the DEK was wrapped under: a scanner-recovery
 * staging object's DEK carries its own AAD. */
export function rewrapDocumentKey(
  documentId: string,
  envelope: CryptoEnvelope,
  currentKeyEncryptionKey: Buffer,
  nextKeyEncryptionKey: Buffer,
  nextKeyId: string,
  purpose: DocumentEncryptionContext["purpose"] = "document",
): CryptoEnvelope {
  const documentKey = unwrapDocumentKey(documentId, envelope, currentKeyEncryptionKey, purpose);
  try {
    return {
      ...envelope,
      keyId: nextKeyId,
      ...wrapDocumentKey(documentKey, documentId, nextKeyEncryptionKey, nextKeyId, purpose),
    };
  } finally {
    documentKey.fill(0);
  }
}
