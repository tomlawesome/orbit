import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { documentCrypto, documents, households, mailInSecrets, metadataKeys } from "@/db/schema";
import { deriveDocumentKeyId, getDocumentConfig, keyEncryptionKeyFor, resetDocumentConfigForTests, type DocumentConfig } from "@/server/documents/config";
import { decryptDocument, encryptDocument, type DocumentCryptoEnvelope, type DocumentEncryptionContext } from "@/server/documents/crypto";
import { createWrappedMetadataKey, unwrapMetadataKey, type MetadataKeyContext } from "@/server/metadata/crypto";
import { loadMetadataKey, resolveMetadataKey, resetMetadataKeyCacheForTests } from "@/server/metadata/keys";
import { decryptMailInSecret, encryptMailInSecret, type MailInSecretContext, type MailInSecretEnvelope } from "@/server/mail-in/core/secret-crypto";
import {
  rotationComplete,
  rotationRemaining,
  runKekRotationCycle,
  runKekRotationToCompletion,
  type RotationKeys,
} from "@/server/documents/rewrap-worker";
import { cleanupIntegrationEnvironment } from "./support/fixtures";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

/** A bare household row: only its id matters to the rows planted below, and
 * the full fixture in support/fixtures.ts pulls in far more than this needs
 * (users, sessions, items). */
async function plantHousehold(name: string): Promise<string> {
  const [row] = await getDb().insert(households).values({ name }).returning({ id: households.id });
  return row.id;
}

function keysFor(nextKek: Buffer): RotationKeys {
  const current = getDocumentConfig();
  return {
    currentKek: current.keyEncryptionKey,
    currentKeyId: current.keyId,
    nextKek,
    nextKeyId: deriveDocumentKeyId(nextKek),
  };
}

interface PlantedDocument {
  documentId: string;
  context: DocumentEncryptionContext;
  ciphertext: Buffer;
  plaintext: Buffer;
}

async function plantDocument(householdId: string, keyEncryptionKey: Buffer, keyId: string): Promise<PlantedDocument> {
  const documentId = randomUUID();
  const plaintext = randomBytes(64);
  const context: DocumentEncryptionContext = {
    documentId,
    householdId,
    itemId: randomUUID(),
    mediaType: "application/octet-stream",
    plaintextSize: plaintext.length,
  };
  const encrypted = encryptDocument(plaintext, context, keyEncryptionKey, keyId);
  await getDb().insert(documents).values({
    id: documentId,
    householdId,
    itemId: null,
    displayName: `rotation-test-${documentId}`,
    mediaType: context.mediaType,
    sizeBytes: plaintext.length,
    contentSha256: createHash("sha256").update(plaintext).digest("hex"),
    lifecycle: "available",
    scanStatus: "clean",
  });
  await getDb().insert(documentCrypto).values({
    documentId,
    storageKey: createHash("sha256").update(documentId).digest("hex"),
    ciphertextSize: encrypted.ciphertext.length,
    envelopeVersion: encrypted.envelope.envelopeVersion,
    contentIv: encrypted.envelope.contentIv,
    contentAuthTag: encrypted.envelope.contentAuthTag,
    wrappedDek: encrypted.envelope.wrappedDek,
    wrapIv: encrypted.envelope.wrapIv,
    wrapAuthTag: encrypted.envelope.wrapAuthTag,
    keyId: encrypted.envelope.keyId,
  });
  return { documentId, context, ciphertext: encrypted.ciphertext, plaintext };
}

async function readDocumentEnvelope(documentId: string): Promise<DocumentCryptoEnvelope> {
  const [row] = await getDb().select().from(documentCrypto).where(eq(documentCrypto.documentId, documentId));
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

interface PlantedMetadataKey {
  householdId: string;
  context: MetadataKeyContext;
  dataKey: Buffer;
}

async function plantMetadataKey(householdId: string, keyEncryptionKey: Buffer, keyId: string): Promise<PlantedMetadataKey> {
  await getDb().delete(metadataKeys).where(eq(metadataKeys.householdId, householdId));
  const context: MetadataKeyContext = { scope: "household", householdId, keyId };
  const minted = createWrappedMetadataKey(keyEncryptionKey, context);
  await getDb().insert(metadataKeys).values({
    scope: "household",
    householdId,
    envelopeVersion: 1,
    keyId,
    ...minted.wrapped,
  });
  return { householdId, context, dataKey: minted.dataKey };
}

async function readMetadataKeyRow(householdId: string) {
  const [row] = await getDb().select().from(metadataKeys).where(eq(metadataKeys.householdId, householdId));
  return row;
}

interface PlantedSecret {
  secretId: string;
  context: MailInSecretContext;
  plaintext: Buffer;
}

async function plantMailInSecret(keyEncryptionKey: Buffer, keyId: string): Promise<PlantedSecret> {
  const secretId = randomUUID();
  const plaintext = Buffer.from(`super-secret-${secretId}`, "utf8");
  const context: MailInSecretContext = { secretId, kind: "imap_password", host: "imap.example.test", user: "orbit@example.test" };
  const encrypted = encryptMailInSecret(plaintext, context, keyEncryptionKey, keyId);
  await getDb().insert(mailInSecrets).values({
    id: secretId,
    kind: "imap_password",
    ciphertext: encrypted.ciphertext,
    envelopeVersion: encrypted.envelope.envelopeVersion,
    contentIv: encrypted.envelope.contentIv,
    contentAuthTag: encrypted.envelope.contentAuthTag,
    wrappedDek: encrypted.envelope.wrappedDek,
    wrapIv: encrypted.envelope.wrapIv,
    wrapAuthTag: encrypted.envelope.wrapAuthTag,
    keyId: encrypted.envelope.keyId,
  });
  return { secretId, context, plaintext };
}

async function readSecretRow(secretId: string) {
  const [row] = await getDb().select().from(mailInSecrets).where(eq(mailInSecrets.id, secretId));
  return row;
}

function secretEnvelopeFromRow(row: { envelopeVersion: number; keyId: string; contentIv: string; contentAuthTag: string; wrappedDek: string; wrapIv: string; wrapAuthTag: string }): MailInSecretEnvelope {
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

describe("the KEK rewrap worker (#932, ADR-0017's contract, ADR-0024 decision 4)", () => {
  it("rewraps document_crypto, metadata_keys and mail_in_secrets rows so they read only under the next key", async () => {
    const householdId = await plantHousehold("Rotation test household");
    const current = getDocumentConfig();
    const nextKek = randomBytes(32);
    const keys = keysFor(nextKek);

    const planted = await plantDocument(householdId, current.keyEncryptionKey, current.keyId);
    const plantedKey = await plantMetadataKey(householdId, current.keyEncryptionKey, current.keyId);
    const plantedSecret = await plantMailInSecret(current.keyEncryptionKey, current.keyId);

    const before = await rotationRemaining(keys);
    expect(before.documentsRemaining).toBeGreaterThanOrEqual(1);
    expect(before.metadataKeysRemaining).toBeGreaterThanOrEqual(1);
    expect(before.mailInSecretsRemaining).toBeGreaterThanOrEqual(1);

    const after = await runKekRotationToCompletion(keys);
    expect(rotationComplete(after)).toBe(true);

    const documentEnvelope = await readDocumentEnvelope(planted.documentId);
    expect(documentEnvelope.keyId).toBe(keys.nextKeyId);
    expect(decryptDocument(planted.ciphertext, planted.context, documentEnvelope, keys.nextKek).equals(planted.plaintext)).toBe(true);
    expect(() => decryptDocument(planted.ciphertext, planted.context, documentEnvelope, keys.currentKek)).toThrow();

    const keyRow = await readMetadataKeyRow(householdId);
    expect(keyRow.keyId).toBe(keys.nextKeyId);
    const rewrappedDek = unwrapMetadataKey(keyRow, keys.nextKek, { ...plantedKey.context, keyId: keys.nextKeyId });
    expect(rewrappedDek.equals(plantedKey.dataKey)).toBe(true);
    expect(() => unwrapMetadataKey(keyRow, keys.currentKek, { ...plantedKey.context, keyId: keys.currentKeyId })).toThrow();

    const secretRow = await readSecretRow(plantedSecret.secretId);
    expect(secretRow.keyId).toBe(keys.nextKeyId);
    const secretEnvelope = secretEnvelopeFromRow(secretRow);
    expect(decryptMailInSecret(secretRow.ciphertext, plantedSecret.context, secretEnvelope, keys.nextKek).equals(plantedSecret.plaintext)).toBe(true);
    expect(() => decryptMailInSecret(secretRow.ciphertext, plantedSecret.context, secretEnvelope, keys.currentKek)).toThrow();

    await getDb().delete(documentCrypto).where(eq(documentCrypto.documentId, planted.documentId));
    await getDb().delete(documents).where(eq(documents.id, planted.documentId));
    await getDb().delete(metadataKeys).where(eq(metadataKeys.householdId, householdId));
    await getDb().delete(mailInSecrets).where(eq(mailInSecrets.id, plantedSecret.secretId));
    await getDb().delete(households).where(eq(households.id, householdId));
  });

  it("leaves every row readable under one key or the other, never neither, when a rotation is interrupted part-way", async () => {
    const householdOne = await plantHousehold("Interrupt test household 1");
    const householdTwo = await plantHousehold("Interrupt test household 2");
    const current = getDocumentConfig();
    const nextKek = randomBytes(32);
    const keys = keysFor(nextKek);

    const documentsPlanted = [
      await plantDocument(householdOne, current.keyEncryptionKey, current.keyId),
      await plantDocument(householdTwo, current.keyEncryptionKey, current.keyId),
      await plantDocument(householdOne, current.keyEncryptionKey, current.keyId),
    ];
    const keysPlanted = [
      await plantMetadataKey(householdOne, current.keyEncryptionKey, current.keyId),
      await plantMetadataKey(householdTwo, current.keyEncryptionKey, current.keyId),
    ];
    const secretsPlanted = [
      await plantMailInSecret(current.keyEncryptionKey, current.keyId),
      await plantMailInSecret(current.keyEncryptionKey, current.keyId),
    ];

    // One cycle, one row per population claimed: an interruption after the
    // first batch of each, well before the whole rotation finishes.
    await runKekRotationCycle(keys, 1);
    const midway = await rotationRemaining(keys);
    expect(rotationComplete(midway)).toBe(false);

    for (const planted of documentsPlanted) {
      const envelope = await readDocumentEnvelope(planted.documentId);
      expect([keys.currentKeyId, keys.nextKeyId]).toContain(envelope.keyId);
      const matchingKek = envelope.keyId === keys.currentKeyId ? keys.currentKek : keys.nextKek;
      const otherKek = envelope.keyId === keys.currentKeyId ? keys.nextKek : keys.currentKek;
      expect(decryptDocument(planted.ciphertext, planted.context, envelope, matchingKek).equals(planted.plaintext)).toBe(true);
      expect(() => decryptDocument(planted.ciphertext, planted.context, envelope, otherKek)).toThrow();
    }

    for (const plantedKey of keysPlanted) {
      const row = await readMetadataKeyRow(plantedKey.householdId);
      expect([keys.currentKeyId, keys.nextKeyId]).toContain(row.keyId);
      const matchingKek = row.keyId === keys.currentKeyId ? keys.currentKek : keys.nextKek;
      const otherKek = row.keyId === keys.currentKeyId ? keys.nextKek : keys.currentKek;
      const dek = unwrapMetadataKey(row, matchingKek, { ...plantedKey.context, keyId: row.keyId });
      expect(dek.equals(plantedKey.dataKey)).toBe(true);
      expect(() => unwrapMetadataKey(row, otherKek, { ...plantedKey.context, keyId: row.keyId })).toThrow();
    }

    for (const plantedSecret of secretsPlanted) {
      const row = await readSecretRow(plantedSecret.secretId);
      expect([keys.currentKeyId, keys.nextKeyId]).toContain(row.keyId);
      const matchingKek = row.keyId === keys.currentKeyId ? keys.currentKek : keys.nextKek;
      const otherKek = row.keyId === keys.currentKeyId ? keys.nextKek : keys.currentKek;
      const envelope = secretEnvelopeFromRow(row);
      expect(decryptMailInSecret(row.ciphertext, plantedSecret.context, envelope, matchingKek).equals(plantedSecret.plaintext)).toBe(true);
      expect(() => decryptMailInSecret(row.ciphertext, plantedSecret.context, envelope, otherKek)).toThrow();
    }

    // Resuming finishes the interrupted rotation; nothing was lost.
    const finished = await runKekRotationToCompletion(keys);
    expect(rotationComplete(finished)).toBe(true);
    for (const planted of documentsPlanted) {
      const envelope = await readDocumentEnvelope(planted.documentId);
      expect(envelope.keyId).toBe(keys.nextKeyId);
      expect(decryptDocument(planted.ciphertext, planted.context, envelope, keys.nextKek).equals(planted.plaintext)).toBe(true);
    }

    for (const planted of documentsPlanted) {
      await getDb().delete(documentCrypto).where(eq(documentCrypto.documentId, planted.documentId));
      await getDb().delete(documents).where(eq(documents.id, planted.documentId));
    }
    await getDb().delete(metadataKeys).where(eq(metadataKeys.householdId, householdOne));
    await getDb().delete(metadataKeys).where(eq(metadataKeys.householdId, householdTwo));
    for (const plantedSecret of secretsPlanted) {
      await getDb().delete(mailInSecrets).where(eq(mailInSecrets.id, plantedSecret.secretId));
    }
    await getDb().delete(households).where(eq(households.id, householdOne));
    await getDb().delete(households).where(eq(households.id, householdTwo));
  });
});

describe("the running application holds both keys during a rotation (#954, ADR-0024 decision 4)", () => {
  it("keeps every row in all three populations readable before, during and after a part-finished rotation, with no restart in between", async () => {
    const householdOne = await plantHousehold("Dual-key test household 1");
    const householdTwo = await plantHousehold("Dual-key test household 2");
    const current = getDocumentConfig();
    const originalDocumentKek = process.env.DOCUMENT_KEK;
    const nextKek = randomBytes(32);
    const nextHex = nextKek.toString("hex");
    const keys: RotationKeys = { currentKek: current.keyEncryptionKey, currentKeyId: current.keyId, nextKek, nextKeyId: deriveDocumentKeyId(nextKek) };

    const documentsPlanted = [
      await plantDocument(householdOne, current.keyEncryptionKey, current.keyId),
      await plantDocument(householdTwo, current.keyEncryptionKey, current.keyId),
    ];
    const keysPlanted = [
      await plantMetadataKey(householdOne, current.keyEncryptionKey, current.keyId),
      await plantMetadataKey(householdTwo, current.keyEncryptionKey, current.keyId),
    ];
    const secretsPlanted = [
      await plantMailInSecret(current.keyEncryptionKey, current.keyId),
      await plantMailInSecret(current.keyEncryptionKey, current.keyId),
    ];

    // Picks by each row's own key_id against whatever `config` holds —
    // exactly the app-level selection this issue adds — then proves the
    // result decrypts, using the same production functions the repository,
    // metadata and mail-in modules call (`loadMetadataKey` is the real
    // production entry point; the document and mail-in checks use
    // `keyEncryptionKeyFor` directly, the same helper document-repository.ts
    // and mailbox-config.ts now call).
    async function assertEveryRowReadable(config: DocumentConfig): Promise<void> {
      for (const planted of documentsPlanted) {
        const envelope = await readDocumentEnvelope(planted.documentId);
        const kek = keyEncryptionKeyFor(config, envelope.keyId);
        expect(kek, `document ${planted.documentId} should be readable`).toBeDefined();
        expect(decryptDocument(planted.ciphertext, planted.context, envelope, kek!).equals(planted.plaintext)).toBe(true);
      }
      for (const plantedKey of keysPlanted) {
        const material = await loadMetadataKey("household", plantedKey.householdId);
        expect(material, `metadata key for household ${plantedKey.householdId} should be readable`).toBeDefined();
        expect(material!.dataKey.equals(plantedKey.dataKey)).toBe(true);
      }
      for (const plantedSecret of secretsPlanted) {
        const row = await readSecretRow(plantedSecret.secretId);
        const kek = keyEncryptionKeyFor(config, row.keyId);
        expect(kek, `mail-in secret ${plantedSecret.secretId} should be readable`).toBeDefined();
        const envelope = secretEnvelopeFromRow(row);
        expect(decryptMailInSecret(row.ciphertext, plantedSecret.context, envelope, kek!).equals(plantedSecret.plaintext)).toBe(true);
      }
    }

    try {
      // Stage 1: before the rotation starts — the ordinary single-key state.
      await assertEveryRowReadable(current);

      // Stage 2: the operator's step 2 — the running application is given
      // the next key. In production this is a container restart; here,
      // setting the environment and resetting the process-cached config
      // stands in for it, because nothing about the mechanism this test
      // exercises depends on the process having actually restarted.
      process.env.DOCUMENT_KEK_NEXT = nextHex;
      resetDocumentConfigForTests();
      resetMetadataKeyCacheForTests();
      const dualKeyConfig = getDocumentConfig();
      expect(dualKeyConfig.nextKeyId).toBe(keys.nextKeyId);

      // Stage 3: midway — one cycle, one row per population claimed, so the
      // rotation is genuinely split across both keys.
      await runKekRotationCycle(keys, 1);
      const midway = await rotationRemaining(keys);
      expect(rotationComplete(midway)).toBe(false);
      await assertEveryRowReadable(dualKeyConfig);

      // A freshly minted metadata key still wraps only under the current
      // key while both are held — exactly one key is ever the wrapping key
      // for new writes, even mid-rotation.
      const freshHousehold = await plantHousehold("Dual-key test household 3 (fresh write)");
      const minted = await resolveMetadataKey("household", freshHousehold);
      expect(minted.keyId).toBe(current.keyId);
      await getDb().delete(metadataKeys).where(eq(metadataKeys.householdId, freshHousehold));
      await getDb().delete(households).where(eq(households.id, freshHousehold));

      // Stage 4: the rotation completes — still no restart, still readable.
      const finished = await runKekRotationToCompletion(keys);
      expect(rotationComplete(finished)).toBe(true);
      await assertEveryRowReadable(dualKeyConfig);

      // Stage 5: the operator's step 4 — promote the next key to current and
      // drop the overlay. Every row, now uniformly on the (former) next key,
      // stays readable under the single promoted key.
      process.env.DOCUMENT_KEK = nextHex;
      delete process.env.DOCUMENT_KEK_NEXT;
      resetDocumentConfigForTests();
      resetMetadataKeyCacheForTests();
      const promotedConfig = getDocumentConfig();
      expect(promotedConfig.nextKeyId).toBeNull();
      expect(promotedConfig.keyId).toBe(keys.nextKeyId);
      await assertEveryRowReadable(promotedConfig);
    } finally {
      if (originalDocumentKek === undefined) delete process.env.DOCUMENT_KEK;
      else process.env.DOCUMENT_KEK = originalDocumentKek;
      delete process.env.DOCUMENT_KEK_NEXT;
      resetDocumentConfigForTests();
      resetMetadataKeyCacheForTests();
    }

    for (const planted of documentsPlanted) {
      await getDb().delete(documentCrypto).where(eq(documentCrypto.documentId, planted.documentId));
      await getDb().delete(documents).where(eq(documents.id, planted.documentId));
    }
    await getDb().delete(metadataKeys).where(eq(metadataKeys.householdId, householdOne));
    await getDb().delete(metadataKeys).where(eq(metadataKeys.householdId, householdTwo));
    for (const plantedSecret of secretsPlanted) {
      await getDb().delete(mailInSecrets).where(eq(mailInSecrets.id, plantedSecret.secretId));
    }
    await getDb().delete(households).where(eq(households.id, householdOne));
    await getDb().delete(households).where(eq(households.id, householdTwo));
  });
});
