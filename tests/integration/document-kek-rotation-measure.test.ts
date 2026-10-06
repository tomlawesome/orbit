/**
 * Measures a real document-KEK rotation against a seeded database (#956), so
 * `docs/administrator-operations.md` can state an expected duration from a
 * measurement rather than an estimate. Gated behind
 * `ORBIT_MEASURE_KEK_ROTATION=1` because it seeds thousands of rows and runs
 * two full rotations — a measurement to re-take when the worker changes, not
 * a check for every pipeline:
 *
 *     ORBIT_MEASURE_KEK_ROTATION=1 node scripts/test-integration.mjs
 *
 * It reports rows per second from its own timing output at two scales, one
 * thousand rows and four thousand, so "scales with row count, not stored
 * bytes" is confirmed rather than assumed — the rewrap touches only each
 * row's wrapped key, never document bytes, and the per-row rate should hold
 * roughly steady as the row count quadruples.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { documentCrypto, documentJobs, documents, households } from "@/db/schema";
import { deriveDocumentKeyId, getDocumentConfig } from "@/server/documents/config";
import { encryptDocument, type DocumentEncryptionContext } from "@/server/documents/crypto";
import {
  rotationComplete,
  runKekRotationToCompletion,
  type RotationKeys,
} from "@/server/documents/rewrap-worker";
import { cleanupIntegrationEnvironment } from "./support/fixtures";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

const SEED_CHUNK = 250;

async function seedDocuments(householdId: string, count: number, kek: Buffer, keyId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; offset < count; offset += SEED_CHUNK) {
    const chunk = Math.min(SEED_CHUNK, count - offset);
    const documentRows = [];
    const cryptoRows = [];
    for (let index = 0; index < chunk; index += 1) {
      const documentId = randomUUID();
      const plaintext = randomBytes(64);
      const context: DocumentEncryptionContext = {
        documentId,
        householdId,
        itemId: randomUUID(),
        mediaType: "application/octet-stream",
        plaintextSize: plaintext.length,
      };
      const encrypted = encryptDocument(plaintext, context, kek, keyId);
      documentRows.push({
        id: documentId,
        householdId,
        itemId: null,
        displayName: `measure-${documentId}`,
        mediaType: context.mediaType,
        sizeBytes: plaintext.length,
        contentSha256: createHash("sha256").update(plaintext).digest("hex"),
        lifecycle: "available" as const,
        scanStatus: "clean" as const,
      });
      cryptoRows.push({
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
      ids.push(documentId);
    }
    await getDb().insert(documents).values(documentRows);
    await getDb().insert(documentCrypto).values(cryptoRows);
  }
  return ids;
}

async function measureRotation(label: string, rows: number, keys: RotationKeys): Promise<number> {
  const startedAt = process.hrtime.bigint();
  const progress = await runKekRotationToCompletion(keys);
  const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
  expect(rotationComplete(progress)).toBe(true);
  const perSecond = rows / seconds;
  // The tool's own output — the number docs/administrator-operations.md cites.
  console.log(`[kek-rotation-measure] ${label}: ${rows} rows in ${seconds.toFixed(2)}s = ${perSecond.toFixed(0)} rows/s`);
  return perSecond;
}

describe.runIf(process.env.ORBIT_MEASURE_KEK_ROTATION === "1")("document-KEK rotation duration, measured (#956)", () => {
  it("rotates 1,000 then 4,000 seeded rows to completion and reports rows per second", async () => {
    const [household] = await getDb().insert(households).values({ name: "Measurement household" }).returning({ id: households.id });
    const current = getDocumentConfig();

    const kekB = randomBytes(32);
    const kekC = randomBytes(32);
    const toB: RotationKeys = {
      currentKek: current.keyEncryptionKey,
      currentKeyId: current.keyId,
      nextKek: kekB,
      nextKeyId: deriveDocumentKeyId(kekB),
    };
    const toC: RotationKeys = {
      currentKek: kekB,
      currentKeyId: toB.nextKeyId,
      nextKek: kekC,
      nextKeyId: deriveDocumentKeyId(kekC),
    };

    const firstBatch = await seedDocuments(household.id, 1_000, toB.currentKek, toB.currentKeyId);
    await measureRotation("1k rows", 1_000, toB);

    const secondBatch = await seedDocuments(household.id, 3_000, toC.currentKek, toC.currentKeyId);
    await measureRotation("4k rows", 4_000, toC);

    const allIds = [...firstBatch, ...secondBatch];
    for (let offset = 0; offset < allIds.length; offset += SEED_CHUNK) {
      const chunk = allIds.slice(offset, offset + SEED_CHUNK);
      await getDb().delete(documentJobs).where(inArray(documentJobs.documentId, chunk));
      await getDb().delete(documentCrypto).where(inArray(documentCrypto.documentId, chunk));
      await getDb().delete(documents).where(inArray(documents.id, chunk));
    }
    // The integration suite shares one database across files (#593), so the
    // seeded household goes too.
    await getDb().delete(households).where(inArray(households.id, [household.id]));
  }, 600_000);
});
