/**
 * #1799 L7: the document_storage_missing audit entry carries the document's
 * size in bytes and never its name. The rejected purge still removes
 * storage_object_missing rows after 45 days.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, documentCrypto, documents } from "@/db/schema";
import { purgeExpiredRejectedDocuments } from "@/server/document-maintenance/rejected-purge";
import { reconcileDocumentStorage } from "@/server/document-worker";
import { getDocumentConfig } from "@/server/documents/config";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";
import { syntheticPdf as createSyntheticPdf } from "../support/synthetic-documents";

const { POST: uploadDocument } = await loadRoute("households/[householdId]/items/[itemId]/documents");

vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(),
}));

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});
afterEach(() => {
  vi.mocked(scanFileWithClamAv).mockReset();
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
});

const DAY_MS = 86_400_000;
const FILENAME = "grandmothers-secret-will-1799.pdf";
const pdf = createSyntheticPdf("storage missing 1799");

async function uploadThenLoseBytes(label: string) {
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
  const fixture = await createIntegrationFixture(label);
  const session = await fixture.session("member");
  const response = await callRouteForSession(uploadDocument, session, {
    url: `http://127.0.0.1:3000/api/households/${fixture.household.id}/items/${fixture.item.id}/documents`,
    method: "POST",
    headers: {
      "content-length": String(pdf.length),
      "content-type": "application/pdf",
      "x-orbit-filename": encodeURIComponent(FILENAME),
    },
    body: new Uint8Array(pdf),
    params: { householdId: fixture.household.id, itemId: fixture.item.id },
  });
  expect(response.status).toBe(201);
  const documentId = ((await response.json()) as { document: { id: string } }).document.id;
  // Settle the fixture's placeholder documents first so only this one is reported.
  await reconcileDocumentStorage();
  const [crypto] = await getDb().select({ storageKey: documentCrypto.storageKey })
    .from(documentCrypto).where(eq(documentCrypto.documentId, documentId));
  const config = getDocumentConfig();
  await new LocalDocumentStorage(config.storageRoot, config.quarantineRoot).deleteCiphertext(crypto!.storageKey);
  await reconcileDocumentStorage();
  return { fixture, documentId };
}

describe("storage reconciliation audit (#1799 L7)", () => {
  it("records the size in bytes and no filename on document_storage_missing", async () => {
    const { fixture, documentId } = await uploadThenLoseBytes("storage-missing-audit-1799");
    const [doc] = await getDb().select({ sizeBytes: documents.sizeBytes, displayName: documents.displayName })
      .from(documents).where(eq(documents.id, documentId));
    expect(doc!.displayName).toBe(FILENAME);
    const rows = await getDb().select({ changes: auditLog.changes }).from(auditLog)
      .where(and(eq(auditLog.entityId, documentId), eq(auditLog.action, "document_storage_missing")));
    expect(rows).toHaveLength(1);
    const changes = rows[0]!.changes as Record<string, unknown>;
    expect(changes.itemId).toBe(fixture.item.id);
    expect(Object.values(changes)).toContain(doc!.sizeBytes);
    const text = JSON.stringify(changes);
    expect(text).not.toContain(FILENAME);
    expect(text).not.toContain("grandmothers");
    expect(text).not.toContain(".pdf");
  });

  // Pin: the purge already removes storage_object_missing rows; kept so the L7 change cannot break it.
  it("still purges a storage_object_missing rejected row 45 days after updated_at (pin)", async () => {
    const { documentId } = await uploadThenLoseBytes("storage-missing-purge-1799");
    const [stored] = await getDb().select({ lifecycle: documents.lifecycle, failureCode: documents.failureCode })
      .from(documents).where(eq(documents.id, documentId));
    expect(stored).toEqual({ lifecycle: "rejected", failureCode: "storage_object_missing" });
    const now = new Date();
    await getDb().update(documents).set({ updatedAt: new Date(now.getTime() - 44 * DAY_MS) }).where(eq(documents.id, documentId));
    await purgeExpiredRejectedDocuments(getDb(), { now });
    expect(await getDb().select({ id: documents.id }).from(documents).where(eq(documents.id, documentId))).toHaveLength(1);
    await getDb().update(documents).set({ updatedAt: new Date(now.getTime() - 45 * DAY_MS - 60_000) }).where(eq(documents.id, documentId));
    await purgeExpiredRejectedDocuments(getDb(), { now });
    expect(await getDb().select({ id: documents.id }).from(documents).where(eq(documents.id, documentId))).toHaveLength(0);
    void randomUUID;
  });
});
