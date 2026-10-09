import {
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

/** Encrypts validated document bytes and independently wraps their random DEK. */
export function encryptDocument(
  plaintext: Buffer,
  context: DocumentEncryptionContext,
  keyEncryptionKey: Buffer,
  keyId: string,
): EncryptedDocument {
  if (plaintext.length !== context.plaintextSize) throw new Error("Plaintext size does not match encryption context");
  requireKey(keyEncryptionKey, "Key-encryption key");

  const documentKey = randomBytes(KEY_BYTES);
  try {
    const encrypted = encryptWithAad(plaintext, documentKey, contentAdditionalData(context));
    const wrapped = wrapDocumentKey(documentKey, context.documentId, keyEncryptionKey, keyId, context.purpose);
    return {
      ciphertext: encrypted.ciphertext,
      envelope: {
        envelopeVersion: ENVELOPE_VERSION,
        algorithm: ALGORITHM,
        keyId,
        contentIv: encrypted.contentIv,
        contentAuthTag: encrypted.contentAuthTag,
        ...wrapped,
      },
    };
  } finally {
    documentKey.fill(0);
  }
}

/** Authenticates the complete ciphertext before returning any plaintext bytes. */
export function decryptDocument(
  ciphertext: Buffer,
  context: DocumentEncryptionContext,
  envelope: CryptoEnvelope,
  keyEncryptionKey: Buffer,
): Buffer {
  const documentKey = unwrapDocumentKey(context.documentId, envelope, keyEncryptionKey, context.purpose);
  try {
    const plaintext = decryptWithAad(ciphertext, envelope, documentKey, contentAdditionalData(context));
    if (plaintext.length !== context.plaintextSize) throw new Error("Decrypted document size does not match metadata");
    return plaintext;
  } finally {
    documentKey.fill(0);
  }
}

/** Rewraps a DEK without decrypting or rewriting document ciphertext. */
export function rewrapDocumentKey(
  documentId: string,
  envelope: CryptoEnvelope,
  currentKeyEncryptionKey: Buffer,
  nextKeyEncryptionKey: Buffer,
  nextKeyId: string,
): CryptoEnvelope {
  const documentKey = unwrapDocumentKey(documentId, envelope, currentKeyEncryptionKey);
  try {
    return {
      ...envelope,
      keyId: nextKeyId,
      ...wrapDocumentKey(documentKey, documentId, nextKeyEncryptionKey, nextKeyId),
    };
  } finally {
    documentKey.fill(0);
  }
}
