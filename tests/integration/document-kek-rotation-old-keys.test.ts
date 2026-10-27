import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { documentCrypto, documents, documentStagingObjects, households, imapIngestionAttachments, imapIngestionMessages, mailInSecrets, metadataKeys } from "@/db/schema";
import { deriveDocumentKeyId, getDocumentConfig } from "@/server/documents/config";
import { decryptDocument, encryptDocument, rewrapDocumentKey, type CryptoEnvelope, type DocumentEncryptionContext } from "@/server/documents/crypto";
import { createWrappedMetadataKey } from "@/server/metadata/crypto";
import { encryptMailInSecret, type MailInSecretContext } from "@/server/mail-in/core/secret-crypto";
import {
  rotationComplete,
  rotationRemaining,
  runKekRotationCycle,
  runKekRotationToCompletion,
  type RotationKeys,
} from "@/server/documents/rewrap-worker";
import { purgeHeldImapAttachment, scanAndHoldImapAttachment, type HeldImapAttachment } from "@/server/mail-in/imap-attachment-holding";
import { syntheticPdf } from "../support/synthetic-documents";
import { cleanupIntegrationEnvironment } from "./support/fixtures";

/*
 * #1392: a document-key rotation must finish even when a held mail attachment
 * or a staged scanner-recovery object is wrapped under a key OLDER than the
 * one being rotated from (the previous build never rewrapped those two
 * populations, so a rotation A -> B left them on A, and B -> C then met them).
 * Ratified plan: skip and report such objects in the rewrap batches, leave
 * them out of the remaining count, and prove it with a seeded upgrade test.
 * The tests do not name the report's fields (the spec does not): they only
 * require that SOME field of the worker's results mentions the skip.
 */

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

interface Eras {
  /** The older key a previous build left held objects on (rotation A -> B). */
  oldKek: Buffer;
  oldKeyId: string;
  /** The key being rotated from (the live configuration's key). */
  keys: RotationKeys;
}

function eras(): Eras {
  const current = getDocumentConfig();
  const oldKek = randomBytes(32);
  const nextKek = randomBytes(32);
  return {
    oldKek,
    oldKeyId: deriveDocumentKeyId(oldKek),
    keys: {
      currentKek: current.keyEncryptionKey,
      currentKeyId: current.keyId,
      nextKek,
      nextKeyId: deriveDocumentKeyId(nextKek),
    },
  };
}

function envelopeFromRow(row: { envelopeVersion: number; keyId: string; contentIv: string; contentAuthTag: string; wrappedDek: string; wrapIv: string; wrapAuthTag: string }): CryptoEnvelope {
  return {
    envelopeVersion: row.envelopeVersion as 1,
    algorithm: "aes-256-gcm",
    keyId: row.keyId,
    contentIv: row.contentIv,
    contentAuthTag: row.contentAuthTag,
    wrappedDek: row.wrappedDek,
    wrapIv: row.wrapIv,
    wrapAuthTag: row.wrapAuthTag,
  };
}

async function plantHousehold(): Promise<string> {
  const [row] = await getDb().insert(households).values({ name: `Old-key rotation ${randomUUID()}` }).returning({ id: households.id });
  cleanups.push(async () => { await getDb().delete(households).where(eq(households.id, row.id)); });
  return row.id;
}

async function plantDocument(householdId: string, kek: Buffer, keyId: string): Promise<string> {
  const documentId = randomUUID();
  const plaintext = randomBytes(64);
  const context: DocumentEncryptionContext = { documentId, householdId, itemId: randomUUID(), mediaType: "application/octet-stream", plaintextSize: plaintext.length };
  const encrypted = encryptDocument(plaintext, context, kek, keyId);
  await getDb().insert(documents).values({
    id: documentId, householdId, itemId: null, displayName: `old-key-${documentId}`, mediaType: context.mediaType,
    sizeBytes: plaintext.length, contentSha256: createHash("sha256").update(plaintext).digest("hex"), lifecycle: "available", scanStatus: "clean",
  });
  await getDb().insert(documentCrypto).values({
    documentId, storageKey: createHash("sha256").update(documentId).digest("hex"), ciphertextSize: encrypted.ciphertext.length, ...encrypted.envelope,
  });
  cleanups.push(async () => {
    await getDb().delete(documentCrypto).where(eq(documentCrypto.documentId, documentId));
    await getDb().delete(documents).where(eq(documents.id, documentId));
  });
  return documentId;
}

async function plantMetadataKey(householdId: string, kek: Buffer, keyId: string): Promise<void> {
  await getDb().delete(metadataKeys).where(eq(metadataKeys.householdId, householdId));
  const minted = createWrappedMetadataKey(kek, { scope: "household", householdId, keyId });
  await getDb().insert(metadataKeys).values({ scope: "household", householdId, envelopeVersion: 1, keyId, ...minted.wrapped });
  cleanups.push(async () => { await getDb().delete(metadataKeys).where(eq(metadataKeys.householdId, householdId)); });
}

async function plantMailInSecret(kek: Buffer, keyId: string): Promise<string> {
  const secretId = randomUUID();
  const context: MailInSecretContext = { secretId, kind: "imap_password", host: "imap.example.test", user: "orbit@example.test" };
  const encrypted = encryptMailInSecret(Buffer.from(`secret-${secretId}`, "utf8"), context, kek, keyId);
  await getDb().insert(mailInSecrets).values({ id: secretId, kind: "imap_password", ciphertext: encrypted.ciphertext, ...encrypted.envelope });
  cleanups.push(async () => { await getDb().delete(mailInSecrets).where(eq(mailInSecrets.id, secretId)); });
  return secretId;
}

interface HeldPlant { held: HeldImapAttachment }

/** A held attachment as a previous build would have left it after an earlier
 * rotation: written through the real holding path, then its DEK wrapped under
 * `oldKek` (when given) so its key id is older than the live key. */
async function plantHeldAttachment(old?: { kek: Buffer; keyId: string }): Promise<HeldPlant> {
  const held = await scanAndHoldImapAttachment({
    bytes: syntheticPdf(`old-key-held-${randomUUID()}`), filename: "held.pdf", declaredMediaType: "application/pdf",
    recipientUserId: randomUUID(), receiptId: randomUUID(),
  });
  const [message] = await getDb().insert(imapIngestionMessages).values({
    mailbox: "rotation-old-key", mailboxUidValidity: "rotation", mailboxUid: Math.floor(Math.random() * 1_000_000_000),
    contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: "rotation-alias", status: "pending_review",
    expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
  }).returning({ id: imapIngestionMessages.id });
  const envelope = old
    ? rewrapDocumentKey(held.id, held.envelope, getDocumentConfig().keyEncryptionKey, old.kek, old.keyId)
    : held.envelope;
  await getDb().insert(imapIngestionAttachments).values({
    id: held.id, messageId: message.id, displayName: held.displayName, mediaType: held.mediaType, sizeBytes: held.sizeBytes,
    contentSha256: held.contentSha256, storageKey: held.storageKey, ciphertextSize: held.ciphertextSize,
    envelopeVersion: envelope.envelopeVersion, contentIv: envelope.contentIv, contentAuthTag: envelope.contentAuthTag,
    wrappedDek: envelope.wrappedDek, wrapIv: envelope.wrapIv, wrapAuthTag: envelope.wrapAuthTag, keyId: envelope.keyId, status: "stored",
  });
  cleanups.push(async () => {
    await purgeHeldImapAttachment(held.storageKey);
    await getDb().delete(imapIngestionMessages).where(eq(imapIngestionMessages.id, message.id));
  });
  return { held };
}

async function heldRow(id: string) {
  const [row] = await getDb().select().from(imapIngestionAttachments).where(eq(imapIngestionAttachments.id, id));
  return row;
}

interface StagedPlant { documentId: string; context: DocumentEncryptionContext; ciphertext: Buffer; plaintext: Buffer }

async function plantStagedObject(householdId: string, kek: Buffer, keyId: string): Promise<StagedPlant> {
  const documentId = randomUUID();
  const plaintext = randomBytes(64);
  const context: DocumentEncryptionContext = {
    documentId, householdId, itemId: randomUUID(), mediaType: "application/octet-stream", plaintextSize: plaintext.length, purpose: "scanner_recovery",
  };
  const staged = encryptDocument(plaintext, context, kek, keyId);
  await getDb().insert(documents).values({
    id: documentId, householdId, itemId: null, displayName: `old-key-staged-${documentId}`, mediaType: context.mediaType,
    sizeBytes: plaintext.length, contentSha256: createHash("sha256").update(plaintext).digest("hex"), lifecycle: "scanning", scanStatus: "error",
  });
  await getDb().insert(documentStagingObjects).values({
    documentId, storageKey: createHash("sha256").update(`staged-${documentId}`).digest("hex"), purpose: "scanner_recovery",
    ciphertextSize: staged.ciphertext.length, ...staged.envelope, status: "pending", recoveryExpiresAt: new Date(Date.now() + 86_400_000),
  });
  cleanups.push(async () => {
    await getDb().delete(documentStagingObjects).where(eq(documentStagingObjects.documentId, documentId));
    await getDb().delete(documents).where(eq(documents.id, documentId));
  });
  return { documentId, context, ciphertext: staged.ciphertext, plaintext };
}

async function stagedRow(documentId: string) {
  const [row] = await getDb().select().from(documentStagingObjects).where(eq(documentStagingObjects.documentId, documentId));
  return row;
}

async function documentRow(documentId: string) {
  const [row] = await getDb().select().from(documentCrypto).where(eq(documentCrypto.documentId, documentId));
  return row;
}

/** Sum of every numeric field, without naming them. */
function totalRemaining(progress: object): number {
  return Object.values(progress).reduce<number>((sum, value) => sum + (typeof value === "number" ? value : 0), 0);
}

const KNOWN_PROGRESS_FIELDS = new Set([
  "documentsRemaining", "metadataKeysRemaining", "mailInSecretsRemaining", "heldAttachmentsRemaining", "stagingObjectsRemaining",
  "documentsEnqueued", "documentJobsProcessed", "metadataKeysRewrapped", "mailInSecretsRewrapped", "heldAttachmentsRewrapped", "stagingObjectsRewrapped",
]);

/** True when a result carries a field the worker has today that is not one of
 * its existing counts, and that field reports something (a count of 1 or more,
 * a non-empty list, or a non-empty string/object): the skip report. The spec
 * fixes no field names, so none is assumed. */
function reportsSkip(result: object): boolean {
  return Object.entries(result).some(([name, value]) => {
    if (KNOWN_PROGRESS_FIELDS.has(name)) return false;
    if (typeof value === "number") return value >= 1;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "string") return value.length > 0;
    return typeof value === "object" && value !== null && Object.keys(value).length > 0;
  });
}

describe("a rotation finishes while held objects carry a key older than the one being rotated from (#1392)", () => {
  it("skips, reports and preserves a held mail attachment on an older key, and the rotation completes", async () => {
    const { oldKek, oldKeyId, keys } = eras();
    const { held } = await plantHeldAttachment({ kek: oldKek, keyId: oldKeyId });
    const before = await heldRow(held.id);
    expect(before.keyId).toBe(oldKeyId);

    const after = await runKekRotationToCompletion(keys);

    // The rotation reached done: nothing remains, and it says so.
    expect(rotationComplete(after)).toBe(true);
    expect(totalRemaining(after)).toBe(0);
    expect(reportsSkip(after) || reportsSkip(await rotationRemaining(keys))).toBe(true);

    // Skipped, not rewrapped and not destroyed: the row is byte-for-byte as it
    // was, and its DEK still unwraps under its own (older) key.
    const row = await heldRow(held.id);
    expect(row).toBeDefined();
    expect(row.keyId).toBe(oldKeyId);
    expect(row.wrappedDek).toBe(before.wrappedDek);
    expect(row.wrapIv).toBe(before.wrapIv);
    expect(row.wrapAuthTag).toBe(before.wrapAuthTag);
    expect(() => rewrapDocumentKey(held.id, envelopeFromRow(row), oldKek, randomBytes(32), "any-key-id")).not.toThrow();
  });

  it("skips, reports and preserves a staged scanner-recovery object on an older key, and the rotation completes", async () => {
    const { oldKek, oldKeyId, keys } = eras();
    const household = await plantHousehold();
    const staged = await plantStagedObject(household, oldKek, oldKeyId);
    const before = await stagedRow(staged.documentId);
    expect(before.keyId).toBe(oldKeyId);

    const after = await runKekRotationToCompletion(keys);

    expect(rotationComplete(after)).toBe(true);
    expect(totalRemaining(after)).toBe(0);
    expect(reportsSkip(after) || reportsSkip(await rotationRemaining(keys))).toBe(true);

    const row = await stagedRow(staged.documentId);
    expect(row).toBeDefined();
    expect(row.keyId).toBe(oldKeyId);
    expect(row.wrappedDek).toBe(before.wrappedDek);
    expect(row.wrapIv).toBe(before.wrapIv);
    expect(row.wrapAuthTag).toBe(before.wrapAuthTag);
    // Still readable with its own key, with the scanner-recovery purpose.
    expect(decryptDocument(staged.ciphertext, staged.context, envelopeFromRow(row), oldKek).equals(staged.plaintext)).toBe(true);
  });

  it("does not count skipped objects as remaining, and a single batch pass reports them instead of stalling or throwing", async () => {
    const { oldKek, oldKeyId, keys } = eras();
    const household = await plantHousehold();
    await plantHeldAttachment({ kek: oldKek, keyId: oldKeyId });
    await plantStagedObject(household, oldKek, oldKeyId);

    // Before any batch has run, the remaining count already leaves them out.
    const remaining = await rotationRemaining(keys);
    expect(totalRemaining(remaining)).toBe(0);
    expect(rotationComplete(remaining)).toBe(true);

    // A batch pass does not throw on them, rewraps none, and reports them.
    const cycle = await runKekRotationCycle(keys);
    expect(cycle.heldAttachmentsRewrapped).toBe(0);
    expect(cycle.stagingObjectsRewrapped).toBe(0);
    expect(reportsSkip(cycle)).toBe(true);
  });

  it("still rewraps held objects on the rotate-from key while skipping those on an older key (seeded upgrade)", async () => {
    // Seeded as a build from before #1316 left it: key A is the old key, key B
    // the live one. Documents, the household metadata key and the mail-in
    // secret were moved A -> B by that rotation; the held attachment and the
    // staged object were not, so one of each stays on A. Another pair was
    // written after it, on B. Now B -> C runs.
    const { oldKek, oldKeyId, keys } = eras();
    const current = { kek: keys.currentKek, keyId: keys.currentKeyId };
    const household = await plantHousehold();

    const documentId = await plantDocument(household, current.kek, current.keyId);
    await plantMetadataKey(household, current.kek, current.keyId);
    const secretId = await plantMailInSecret(current.kek, current.keyId);

    const heldOld = await plantHeldAttachment({ kek: oldKek, keyId: oldKeyId });
    const stagedOld = await plantStagedObject(household, oldKek, oldKeyId);
    const heldLive = await plantHeldAttachment();
    const stagedLive = await plantStagedObject(household, current.kek, current.keyId);
    const heldOldBefore = await heldRow(heldOld.held.id);
    const stagedOldBefore = await stagedRow(stagedOld.documentId);

    const after = await runKekRotationToCompletion(keys);

    // Done, with the rows on the rotate-from key all moved to the next key...
    expect(rotationComplete(after)).toBe(true);
    expect(totalRemaining(after)).toBe(0);
    expect((await documentRow(documentId)).keyId).toBe(keys.nextKeyId);
    const [metadata] = await getDb().select().from(metadataKeys).where(eq(metadataKeys.householdId, household));
    expect(metadata.keyId).toBe(keys.nextKeyId);
    const [secret] = await getDb().select().from(mailInSecrets).where(eq(mailInSecrets.id, secretId));
    expect(secret.keyId).toBe(keys.nextKeyId);
    expect((await heldRow(heldLive.held.id)).keyId).toBe(keys.nextKeyId);
    expect((await stagedRow(stagedLive.documentId)).keyId).toBe(keys.nextKeyId);

    // ...the two on the older key skipped and untouched, and reported.
    expect((await heldRow(heldOld.held.id)).keyId).toBe(oldKeyId);
    expect((await heldRow(heldOld.held.id)).wrappedDek).toBe(heldOldBefore.wrappedDek);
    expect((await stagedRow(stagedOld.documentId)).keyId).toBe(oldKeyId);
    expect((await stagedRow(stagedOld.documentId)).wrappedDek).toBe(stagedOldBefore.wrappedDek);
    expect(reportsSkip(after) || reportsSkip(await rotationRemaining(keys))).toBe(true);
  });
});
