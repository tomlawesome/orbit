/**
 * mail-in/core boundary: pure crypto only, no `getDb`/`db`/schema imports and
 * no `imapflow` import — see src/server/mail-in/README.md.
 *
 * ADR-0017 decision 1: the app-managed mail-in credential (mailbox password,
 * alias-derivation key) is envelope-encrypted exactly as a document is
 * (`src/server/documents/crypto.ts`) — same AES-256-GCM construction, same
 * document KEK as the root key — but bound to its own AAD purpose so a
 * `mail_in_secrets` row can never be re-pointed at a different account,
 * secret kind, or key without failing authentication. This module builds
 * that AAD and calls the generic primitives `documents/crypto.ts` exports
 * rather than adding a second cipher construction.
 */
import { randomBytes } from "node:crypto";
import {
  decryptWithAad,
  encryptWithAad,
  ENVELOPE_ALGORITHM,
  ENVELOPE_KEY_BYTES,
  ENVELOPE_VERSION,
  unwrapKeyWithAad,
  wrapKeyWithAad,
} from "@/server/documents/crypto";

/** `oauth_refresh_token` is reserved for the XOAUTH2 slice; this slice writes only the first two. */
export type MailInSecretKind = "imap_password" | "alias_key" | "oauth_refresh_token";

/**
 * What a `mail_in_secrets` row's ciphertext is bound to. Every field here is
 * part of the content AAD, so decrypting a row whose `mail_in_mailbox`
 * pointer, kind, host, or account user has since changed fails closed
 * instead of returning bytes for the wrong account.
 */
export interface MailInSecretContext {
  secretId: string;
  kind: MailInSecretKind;
  host: string;
  user: string;
}

export interface MailInSecretEnvelope {
  envelopeVersion: 1;
  algorithm: "aes-256-gcm";
  keyId: string;
  contentIv: string;
  contentAuthTag: string;
  wrappedDek: string;
  wrapIv: string;
  wrapAuthTag: string;
}

export interface EncryptedMailInSecret {
  ciphertext: Buffer;
  envelope: MailInSecretEnvelope;
}

function keyAdditionalData(context: MailInSecretContext, keyId: string): Buffer {
  return Buffer.from(JSON.stringify({
    purpose: "orbit-mail-in-secret-dek",
    envelopeVersion: ENVELOPE_VERSION,
    secretId: context.secretId,
    keyId,
  }), "utf8");
}

function contentAdditionalData(context: MailInSecretContext): Buffer {
  return Buffer.from(JSON.stringify({
    envelopeVersion: ENVELOPE_VERSION,
    secretId: context.secretId,
    kind: context.kind,
    host: context.host,
    user: context.user,
  }), "utf8");
}

/** Encrypts a mail-in secret's plaintext bytes and independently wraps a fresh random DEK. */
export function encryptMailInSecret(
  plaintext: Buffer,
  context: MailInSecretContext,
  keyEncryptionKey: Buffer,
  keyId: string,
): EncryptedMailInSecret {
  const dek = randomBytes(ENVELOPE_KEY_BYTES);
  try {
    const encrypted = encryptWithAad(plaintext, dek, contentAdditionalData(context));
    const wrapped = wrapKeyWithAad(dek, keyEncryptionKey, keyAdditionalData(context, keyId));
    return {
      ciphertext: encrypted.ciphertext,
      envelope: {
        envelopeVersion: ENVELOPE_VERSION,
        algorithm: ENVELOPE_ALGORITHM,
        keyId,
        contentIv: encrypted.contentIv,
        contentAuthTag: encrypted.contentAuthTag,
        ...wrapped,
      },
    };
  } finally {
    dek.fill(0);
  }
}

/**
 * Authenticates and decrypts a mail-in secret. Throws — never returns partial
 * or unauthenticated bytes — when the envelope version is unsupported, the
 * wrapping KEK does not match, the row's AAD (kind/host/user/secretId) no
 * longer matches `context`, or the ciphertext or either authentication tag
 * has been tampered with. The thrown error never carries the plaintext, the
 * key, or a provider secret.
 */
export function decryptMailInSecret(
  ciphertext: Buffer,
  context: MailInSecretContext,
  envelope: MailInSecretEnvelope,
  keyEncryptionKey: Buffer,
): Buffer {
  if (envelope.envelopeVersion !== ENVELOPE_VERSION || envelope.algorithm !== ENVELOPE_ALGORITHM) {
    throw new Error("Unsupported mail-in secret envelope");
  }
  const dek = unwrapKeyWithAad(envelope, keyEncryptionKey, keyAdditionalData(context, envelope.keyId));
  try {
    return decryptWithAad(ciphertext, envelope, dek, contentAdditionalData(context));
  } finally {
    dek.fill(0);
  }
}
