import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const ENVELOPE_VERSION = 1;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface DocumentEncryptionContext {
  documentId: string;
  householdId: string;
  itemId: string;
  mediaType: string;
  plaintextSize: number;
}

export interface DocumentCryptoEnvelope {
  envelopeVersion: 1;
  algorithm: "aes-256-gcm";
  keyId: string;
  contentIv: string;
  contentAuthTag: string;
  wrappedDek: string;
  wrapIv: string;
  wrapAuthTag: string;
}

export interface EncryptedDocument {
  ciphertext: Buffer;
  envelope: DocumentCryptoEnvelope;
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
  }), "utf8");
}

function keyAdditionalData(documentId: string, keyId: string): Buffer {
  return Buffer.from(JSON.stringify({
    purpose: "orbit-document-dek",
    envelopeVersion: ENVELOPE_VERSION,
    documentId,
    keyId,
  }), "utf8");
}

function wrapDocumentKey(
  documentKey: Buffer,
  documentId: string,
  keyEncryptionKey: Buffer,
  keyId: string,
): Pick<DocumentCryptoEnvelope, "wrappedDek" | "wrapIv" | "wrapAuthTag"> {
  requireKey(documentKey, "Document key");
  requireKey(keyEncryptionKey, "Key-encryption key");
  const wrapIv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyEncryptionKey, wrapIv, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(keyAdditionalData(documentId, keyId));
  const wrappedDek = Buffer.concat([cipher.update(documentKey), cipher.final()]);
  return {
    wrappedDek: wrappedDek.toString("base64url"),
    wrapIv: wrapIv.toString("base64url"),
    wrapAuthTag: cipher.getAuthTag().toString("base64url"),
  };
}

function unwrapDocumentKey(
  documentId: string,
  envelope: DocumentCryptoEnvelope,
  keyEncryptionKey: Buffer,
): Buffer {
  requireKey(keyEncryptionKey, "Key-encryption key");
  if (envelope.envelopeVersion !== ENVELOPE_VERSION || envelope.algorithm !== ALGORITHM) {
    throw new Error("Unsupported document encryption envelope");
  }
  const wrapIv = decodeFixed(envelope.wrapIv, IV_BYTES, "Key-wrap IV");
  const wrapTag = decodeFixed(envelope.wrapAuthTag, AUTH_TAG_BYTES, "Key-wrap authentication tag");
  const wrappedDek = Buffer.from(envelope.wrappedDek, "base64url");
  if (wrappedDek.length !== KEY_BYTES) throw new Error("Wrapped document key has an invalid length");
  const decipher = createDecipheriv(ALGORITHM, keyEncryptionKey, wrapIv, { authTagLength: AUTH_TAG_BYTES });
  decipher.setAAD(keyAdditionalData(documentId, envelope.keyId));
  decipher.setAuthTag(wrapTag);
  const documentKey = Buffer.concat([decipher.update(wrappedDek), decipher.final()]);
  requireKey(documentKey, "Unwrapped document key");
  return documentKey;
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
  const contentIv = randomBytes(IV_BYTES);
  try {
    const cipher = createCipheriv(ALGORITHM, documentKey, contentIv, { authTagLength: AUTH_TAG_BYTES });
    cipher.setAAD(contentAdditionalData(context), { plaintextLength: plaintext.length });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const wrapped = wrapDocumentKey(documentKey, context.documentId, keyEncryptionKey, keyId);
    return {
      ciphertext,
      envelope: {
        envelopeVersion: ENVELOPE_VERSION,
        algorithm: ALGORITHM,
        keyId,
        contentIv: contentIv.toString("base64url"),
        contentAuthTag: cipher.getAuthTag().toString("base64url"),
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
  envelope: DocumentCryptoEnvelope,
  keyEncryptionKey: Buffer,
): Buffer {
  const documentKey = unwrapDocumentKey(context.documentId, envelope, keyEncryptionKey);
  try {
    const contentIv = decodeFixed(envelope.contentIv, IV_BYTES, "Content IV");
    const contentTag = decodeFixed(envelope.contentAuthTag, AUTH_TAG_BYTES, "Content authentication tag");
    const decipher = createDecipheriv(ALGORITHM, documentKey, contentIv, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(contentAdditionalData(context), { plaintextLength: context.plaintextSize });
    decipher.setAuthTag(contentTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length !== context.plaintextSize) throw new Error("Decrypted document size does not match metadata");
    return plaintext;
  } finally {
    documentKey.fill(0);
  }
}

/** Rewraps a DEK without decrypting or rewriting document ciphertext. */
export function rewrapDocumentKey(
  documentId: string,
  envelope: DocumentCryptoEnvelope,
  currentKeyEncryptionKey: Buffer,
  nextKeyEncryptionKey: Buffer,
  nextKeyId: string,
): DocumentCryptoEnvelope {
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
