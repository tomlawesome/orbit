/**
 * #1786 (rejected document rows are never purged), written from the spec only.
 *
 * Names the builder must provide:
 *   - `REJECTED_DOCUMENT_RETENTION_MS` (45 days) exported from
 *     src/server/retention-windows.ts, beside RECEIPT_RETENTION_MS.
 *   - `purgeExpiredRejectedDocuments(db, { now })` exported from
 *     src/server/document-maintenance/rejected-purge.ts. `db` is the value of
 *     `getDb()`; `now` is a Date. It deletes, in batches, each `rejected`
 *     document row whose `updated_at` is at least the retention window before
 *     `now` and which has no staging row left. Safe to run twice at once.
 *
 * "purge_failed" in the spec is modelled here as a staging row in
 * `purge_pending` with a purge_failure_code, the only failed state the staging
 * table's check constraint allows.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, documentStagingObjects, documents } from "@/db/schema";
import { purgeExpiredRejectedDocuments } from "@/server/document-maintenance/rejected-purge";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { REJECTED_DOCUMENT_RETENTION_MS } from "@/server/retention-windows";
import { cleanupIntegrationEnvironment, createIntegrationFixture, withRequiredScanMode as withRequiredScanModeKeepingConfig } from "./support/fixtures";
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
const pdf = createSyntheticPdf("rejected purge 1786");
type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;

const withRequiredScanMode = <T>(work: () => Promise<T>) => withRequiredScanModeKeepingConfig(work, () => {
  vi.mocked(scanFileWithClamAv).mockReset();
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
});

async function insertRejected(fixture: Fixture, rejectedAt: Date, failureCode = "scanner_unavailable"): Promise<string> {
  const id = randomUUID();
  await getDb().insert(documents).values({
    id,
    householdId: fixture.household.id,
    itemId: fixture.item.id,
    sealedItemId: fixture.item.id,
    displayName: "refused.pdf",
    mediaType: "application/pdf",
    sizeBytes: pdf.length,
    contentSha256: "0".repeat(64),
    lifecycle: "rejected",
    scanStatus: failureCode === "malware_detected" ? "infected" : "error",
    failureCode,
    createdAt: rejectedAt,
    updatedAt: rejectedAt,
  });
  return id;
}

async function exists(id: string): Promise<boolean> {
  return (await getDb().select({ id: documents.id }).from(documents).where(eq(documents.id, id))).length === 1;
}

async function upload(fixture: Fixture, documentId: string) {
  const session = await fixture.session("member");
  return callRouteForSession(uploadDocument, session, {
    url: `http://127.0.0.1:3000/api/households/${fixture.household.id}/items/${fixture.item.id}/documents`,
    method: "POST",
    headers: {
      "content-length": String(pdf.length),
      "content-type": "application/pdf",
      "x-orbit-filename": encodeURIComponent("policy.pdf"),
      "x-orbit-document-id": documentId,
    },
    body: pdf,
    params: { householdId: fixture.household.id, itemId: fixture.item.id },
  });
}

describe("rejected document purge (#1786)", () => {
  it("states a 45 day retention", () => {
    expect(REJECTED_DOCUMENT_RETENTION_MS).toBe(45 * DAY_MS);
  });

  it("deletes a rejected row with no bytes after 45 days and keeps it at 44", async () => {
    const fixture = await createIntegrationFixture("rejected-purge-window");
    const now = new Date();
    const old = await insertRejected(fixture, new Date(now.getTime() - 45 * DAY_MS - 60_000));
    const recent = await insertRejected(fixture, new Date(now.getTime() - 44 * DAY_MS));
    await purgeExpiredRejectedDocuments(getDb(), { now });
    expect(await exists(old)).toBe(false);
    expect(await exists(recent)).toBe(true);
  });

  it("keeps an old rejected row whose staged bytes may remain", async () => {
    const fixture = await createIntegrationFixture("rejected-purge-bytes");
    const now = new Date();
    const oldAt = new Date(now.getTime() - 60 * DAY_MS);
    const failed = await insertRejected(fixture, oldAt);
    const pending = await insertRejected(fixture, oldAt);
    for (const [documentId, status, purgeFailureCode] of [[failed, "purge_pending", "stage_purge_failed"], [pending, "pending", null]] as const) {
      await getDb().insert(documentStagingObjects).values({
        documentId,
        storageKey: `staging/${randomUUID()}`,
        ciphertextSize: 10,
        envelopeVersion: 1,
        contentIv: "iv",
        contentAuthTag: "tag",
        wrappedDek: "dek",
        wrapIv: "wiv",
        wrapAuthTag: "wtag",
        keyId: "k",
        status,
        purgeFailureCode,
        recoveryExpiresAt: oldAt,
      });
    }
    await purgeExpiredRejectedDocuments(getDb(), { now });
    expect(await exists(failed)).toBe(true);
    expect(await exists(pending)).toBe(true);
  });

  it("deletes an old malware row and scans a repeat upload under the same id again", async () => {
    const fixture = await createIntegrationFixture("rejected-purge-malware");
    const documentId = randomUUID();
    await withRequiredScanMode(async () => {
      vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "infected", signature: "Eicar-Test-Signature" });
      expect((await upload(fixture, documentId)).status).toBe(422);
      const scansBefore = vi.mocked(scanFileWithClamAv).mock.calls.length;
      // Within the window the verdict is remembered: refused with no new scan.
      expect((await upload(fixture, documentId)).status).toBe(422);
      expect(vi.mocked(scanFileWithClamAv).mock.calls.length).toBe(scansBefore);

      const now = new Date();
      await getDb().update(documents).set({ updatedAt: new Date(now.getTime() - 45 * DAY_MS - 60_000) }).where(eq(documents.id, documentId));
      await purgeExpiredRejectedDocuments(getDb(), { now });
      expect(await exists(documentId)).toBe(false);

      const again = await upload(fixture, documentId);
      expect(again.status).toBe(422);
      expect((await again.json() as { error: { code: string } }).error.code).toBe("document_malware_detected");
      expect(vi.mocked(scanFileWithClamAv).mock.calls.length).toBeGreaterThan(scansBefore);
    });
  });

  it("lets two concurrent sweeps delete each row once without error", async () => {
    const fixture = await createIntegrationFixture("rejected-purge-concurrent");
    const now = new Date();
    const ids: string[] = [];
    for (let index = 0; index < 12; index += 1) ids.push(await insertRejected(fixture, new Date(now.getTime() - 50 * DAY_MS)));
    const results = await Promise.allSettled([
      purgeExpiredRejectedDocuments(getDb(), { now }),
      purgeExpiredRejectedDocuments(getDb(), { now }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    for (const id of ids) expect(await exists(id)).toBe(false);
    // A later sweep finds nothing and is still fine (idempotent).
    await expect(purgeExpiredRejectedDocuments(getDb(), { now })).resolves.not.toThrow();
  });

  it("keeps the document_rejected audit row after the row is deleted", async () => {
    const fixture = await createIntegrationFixture("rejected-purge-audit");
    const now = new Date();
    const id = await insertRejected(fixture, new Date(now.getTime() - 50 * DAY_MS), "malware_detected");
    await getDb().insert(auditLog).values({
      householdId: fixture.household.id,
      actorUserId: null,
      entityType: "document",
      entityId: id,
      action: "document_rejected_malware",
      changes: { itemId: fixture.item.id },
    });
    await purgeExpiredRejectedDocuments(getDb(), { now });
    expect(await exists(id)).toBe(false);
    const audits = await getDb().select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, id));
    expect(audits).toEqual([{ action: "document_rejected_malware" }]);
  });
});
