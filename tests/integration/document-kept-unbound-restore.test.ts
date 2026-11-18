import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { documents, items } from "@/db/schema";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";
import { syntheticPdf } from "../support/synthetic-documents";

/* #1605 P-25 review: a kept document whose item was deleted (item_id set to
   null by the foreign key) is unbound but was never a staged upload. Deleted
   and restored, it must come back kept: no staged hold, which the unbound-
   upload sweep would expire, losing the document. */

const { DELETE: deleteDocument } = await loadRoute("documents/[documentId]");
const { POST: restoreDocumentRoute } = await loadRoute("documents/[documentId]/restore");
const { POST: uploadRoute } = await loadRoute("households/[householdId]/items/[itemId]/documents");

vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(),
}));

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

afterEach(() => {
  vi.mocked(scanFileWithClamAv).mockReset();
});

describe("restoring a kept document whose item was deleted (#1605 P-25)", () => {
  it("brings it back kept, with no staged hold to expire it", async () => {
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
    const fixture = await createIntegrationFixture("p25-kept-unbound-restore");
    const member = await fixture.session("member");
    const body = Buffer.from(syntheticPdf("p25 kept unbound restore"));
    const uploaded = await callRouteForSession(uploadRoute, member, {
      url: `http://127.0.0.1:3000/api/households/${fixture.household.id}/items/${fixture.item.id}/documents`,
      method: "POST",
      headers: {
        "content-length": String(body.length),
        "content-type": "application/pdf",
        "x-orbit-filename": encodeURIComponent("Kept.pdf"),
      },
      body: new Uint8Array(body),
      params: { householdId: fixture.household.id, itemId: fixture.item.id },
    });
    expect(uploaded.status).toBe(201);
    const documentId = ((await uploaded.json()) as { document: { id: string } }).document.id;
    await getDb().delete(items).where(eq(items.id, fixture.item.id));
    const [before] = await getDb().select({ itemId: documents.itemId, deleteAfter: documents.deleteAfter }).from(documents).where(eq(documents.id, documentId));
    expect(before).toEqual({ itemId: null, deleteAfter: null });

    const url = `http://127.0.0.1:3000/api/documents/${documentId}`;
    const deletion = await callRouteForSession(deleteDocument, member, { url, method: "DELETE", params: { documentId } });
    expect(deletion.status).toBe(200);
    const restored = await callRouteForSession(restoreDocumentRoute, member, { url: `${url}/restore`, method: "POST", params: { documentId } });
    expect(restored.status).toBe(200);

    const [after] = await getDb().select({ lifecycle: documents.lifecycle, itemId: documents.itemId, deleteAfter: documents.deleteAfter }).from(documents).where(eq(documents.id, documentId));
    expect(after).toEqual({ lifecycle: "available", itemId: null, deleteAfter: null });
  });
});
