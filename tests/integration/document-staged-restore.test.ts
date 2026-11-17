import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { documents } from "@/db/schema";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";
import { syntheticPdf } from "../support/synthetic-documents";

/* #1605 P-25: a staged upload (the Add form's pick: no item, a staged hold in
   `delete_after`) that a member deletes the ordinary way and then restores
   must come back as a staged upload, hold included. Restoring it with
   `delete_after` null leaves an unbound copy that nothing ever expires. */

const { DELETE: deleteDocument } = await loadRoute("documents/[documentId]");
const { POST: restoreDocumentRoute } = await loadRoute("documents/[documentId]/restore");
const { POST: stageRoute } = await loadRoute("households/[householdId]/documents");

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

describe("restoring a staged upload that was deleted without stagedDiscard (#1605 P-25)", () => {
  it("brings it back still unbound and still carrying a staged hold in the future", async () => {
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
    const fixture = await createIntegrationFixture("p25-staged-restore");
    const member = await fixture.session("member");
    const body = Buffer.from(syntheticPdf("p25 staged restore"));
    const documentId = randomUUID();
    const staged = await callRouteForSession(stageRoute, member, {
      url: `http://127.0.0.1:3000/api/households/${fixture.household.id}/documents`,
      method: "POST",
      headers: {
        "content-length": String(body.length),
        "content-type": "application/pdf",
        "x-orbit-filename": encodeURIComponent("Staged.pdf"),
        "x-orbit-document-id": documentId,
        "x-orbit-item-id": randomUUID(),
      },
      body: new Uint8Array(body),
      params: { householdId: fixture.household.id },
    });
    expect(staged.status).toBe(201);
    const [before] = await getDb().select({ itemId: documents.itemId, deleteAfter: documents.deleteAfter }).from(documents).where(eq(documents.id, documentId));
    expect(before?.itemId).toBeNull();
    expect(before?.deleteAfter).not.toBeNull();

    const url = `http://127.0.0.1:3000/api/documents/${documentId}`;
    const deletion = await callRouteForSession(deleteDocument, member, { url, method: "DELETE", params: { documentId } });
    expect(deletion.status).toBe(200);
    const restored = await callRouteForSession(restoreDocumentRoute, member, { url: `${url}/restore`, method: "POST", params: { documentId } });
    expect(restored.status).toBe(200);

    const [after] = await getDb().select({ lifecycle: documents.lifecycle, itemId: documents.itemId, deleteAfter: documents.deleteAfter }).from(documents).where(eq(documents.id, documentId));
    expect(after?.lifecycle).toBe("available");
    expect(after?.itemId).toBeNull();
    // The hold is what lets maintenance expire an upload no entry ever claimed.
    expect(after?.deleteAfter).not.toBeNull();
    expect(after!.deleteAfter!.getTime()).toBeGreaterThan(Date.now());
  });
});
