import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { documentJobs, documents } from "@/db/schema";
import { reconcileDocumentStorage } from "@/server/document-worker";
import { requestDocumentDeletion, restoreDocument } from "@/server/document-repository";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";
import { syntheticPdf as createSyntheticPdf } from "../support/synthetic-documents";

/* #1605 P-25 (from #1426): a staged upload (#1316) that its uploader deletes
   and then restores comes back with no `delete_after` and no item. Nothing
   retires such a row (the sweep only takes `delete_after <= now()`), so it
   stays against the household's quota for good. A restored unbound upload
   must carry a fresh hold again, so the sweep still retires it if no item
   binds it. */

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

const HOUR_MS = 3_600_000;
const syntheticPdf = createSyntheticPdf("synthetic staged restore");

async function stage(fixture: Awaited<ReturnType<typeof createIntegrationFixture>>, session: Awaited<ReturnType<typeof fixture.session>>, documentId: string) {
  const { POST } = await loadRoute("households/[householdId]/documents");
  return callRouteForSession(POST, session, {
    url: `http://127.0.0.1:3000/api/households/${fixture.household.id}/documents`,
    method: "POST",
    headers: {
      "content-length": String(syntheticPdf.length),
      "content-type": "application/pdf",
      "x-orbit-filename": encodeURIComponent("policy.pdf"),
      "x-orbit-document-id": documentId,
      "x-orbit-item-id": randomUUID(),
    },
    body: new Uint8Array(syntheticPdf),
    params: { householdId: fixture.household.id },
  });
}

async function row(id: string) {
  const [one] = await getDb().select({ lifecycle: documents.lifecycle, itemId: documents.itemId, deleteAfter: documents.deleteAfter })
    .from(documents).where(eq(documents.id, id));
  return one;
}

describe("a staged upload that is deleted and then restored (P-25)", () => {
  it("gets a fresh hold of about a day, not an open-ended one", async () => {
    const fixture = await createIntegrationFixture("p25-hold");
    const owner = await fixture.session("owner");
    const documentId = randomUUID();
    expect((await stage(fixture, owner, documentId)).status).toBe(201);

    await requestDocumentDeletion(owner.userId, documentId);
    await restoreDocument(owner.userId, documentId);

    const restored = await row(documentId);
    expect(restored).toMatchObject({ lifecycle: "available", itemId: null });
    expect(restored.deleteAfter).not.toBeNull();
    const ahead = restored.deleteAfter!.getTime() - Date.now();
    expect(ahead).toBeGreaterThan(23 * HOUR_MS);
    expect(ahead).toBeLessThan(49 * HOUR_MS);
  });

  it("is retired by the storage sweep once that hold passes, with a purge job", async () => {
    const fixture = await createIntegrationFixture("p25-sweep");
    const owner = await fixture.session("owner");
    const documentId = randomUUID();
    expect((await stage(fixture, owner, documentId)).status).toBe(201);

    await requestDocumentDeletion(owner.userId, documentId);
    await restoreDocument(owner.userId, documentId);
    // The restore must have re-armed the hold; only then can it be back-dated.
    expect((await row(documentId)).deleteAfter).not.toBeNull();
    await getDb().update(documents).set({ deleteAfter: new Date(Date.now() - 60_000) }).where(eq(documents.id, documentId));

    await reconcileDocumentStorage();

    expect((await row(documentId)).lifecycle).toBe("pending_deletion");
    const jobs = await getDb().select({ id: documentJobs.id }).from(documentJobs)
      .where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "purge"), eq(documentJobs.status, "pending")));
    expect(jobs.length).toBeGreaterThanOrEqual(1);
  });
});
