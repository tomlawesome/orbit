import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { auditLog, documentCrypto, documentJobs, documents } from "@/db/schema";
import { GET as downloadDocument } from "@/app/api/documents/[documentId]/download/route";
import { DELETE as deleteDocument } from "@/app/api/documents/[documentId]/route";
import { POST as restoreDocumentRoute } from "@/app/api/documents/[documentId]/restore/route";
import { GET as listDocuments, POST as uploadDocument } from "@/app/api/households/[householdId]/items/[itemId]/documents/route";
import { runDocumentMaintenanceCycle } from "@/server/document-worker";
import { getDocumentConfig } from "@/server/documents/config";
import { LocalDocumentStorage } from "@/server/documents/storage";
import {
  createIntegrationFixture,
  requestForSession,
  sessionHeaders,
} from "./support/fixtures";

const syntheticPdf = Buffer.from("%PDF-1.7\nsynthetic authenticated document\n");

function itemDocumentsContext(householdId: string, itemId: string) {
  return { params: Promise.resolve({ householdId, itemId }) };
}

function documentContext(documentId: string) {
  return { params: Promise.resolve({ documentId }) };
}

async function uploadSyntheticDocument(fixture: Awaited<ReturnType<typeof createIntegrationFixture>>) {
  const session = await fixture.session("member");
  const url = `http://127.0.0.1:3000/api/households/${fixture.household.id}/items/${fixture.item.id}/documents`;
  const response = await uploadDocument(requestForSession(session, url, {
    method: "POST",
    headers: {
      "content-length": String(syntheticPdf.length),
      "content-type": "application/pdf",
      "x-orbit-filename": encodeURIComponent("synthetic-policy.pdf"),
    },
    body: syntheticPdf,
  }), itemDocumentsContext(fixture.household.id, fixture.item.id));
  expect(response.status).toBe(201);
  const payload = await response.json() as { document: { id: string; lifecycle: string; displayName: string } };
  expect(payload.document).toMatchObject({ lifecycle: "available", displayName: "synthetic-policy.pdf" });
  return { session, documentId: payload.document.id };
}

describe("authenticated encrypted document lifecycle", () => {
  it("uploads, downloads, soft-deletes, restores, and irreversibly purges ciphertext", async () => {
    const fixture = await createIntegrationFixture("document-lifecycle");
    const { session, documentId } = await uploadSyntheticDocument(fixture);
    const downloadUrl = `http://127.0.0.1:3000/api/documents/${documentId}/download`;

    const downloaded = await downloadDocument(requestForSession(session, downloadUrl), documentContext(documentId));
    expect(downloaded.status).toBe(200);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(syntheticPdf);
    expect(downloaded.headers.get("cache-control")).toBe("private, no-store");
    expect(downloaded.headers.get("content-disposition")).toContain("attachment;");
    expect(downloaded.headers.get("content-disposition")).toContain("synthetic-policy.pdf");
    expect(downloaded.headers.get("content-type")).toBe("application/octet-stream");
    expect(downloaded.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(downloaded.headers.get("x-content-type-options")).toBe("nosniff");

    const deletion = await deleteDocument(
      requestForSession(session, downloadUrl, { method: "DELETE" }),
      documentContext(documentId),
    );
    expect(deletion.status).toBe(200);
    expect((await deletion.json()).document).toMatchObject({ lifecycle: "pending_deletion" });

    const [pending] = await getDb().select({ version: documents.version, lifecycle: documents.lifecycle })
      .from(documents).where(eq(documents.id, documentId));
    expect(pending).toMatchObject({ lifecycle: "pending_deletion" });

    const restored = await restoreDocumentRoute(
      requestForSession(session, downloadUrl + "/restore", { method: "POST" }),
      documentContext(documentId),
    );
    expect(restored.status).toBe(200);
    expect((await restored.json()).document).toMatchObject({ lifecycle: "available" });

    const restoredDownload = await downloadDocument(requestForSession(session, downloadUrl), documentContext(documentId));
    expect(Buffer.from(await restoredDownload.arrayBuffer())).toEqual(syntheticPdf);

    const secondDeletion = await deleteDocument(
      requestForSession(session, downloadUrl, { method: "DELETE" }),
      documentContext(documentId),
    );
    expect(secondDeletion.status).toBe(200);
    await getDb().update(documents).set({ deleteAfter: new Date(Date.now() - 1_000) }).where(eq(documents.id, documentId));

    const [cryptoBeforePurge] = await getDb().select({ storageKey: documentCrypto.storageKey })
      .from(documentCrypto).where(eq(documentCrypto.documentId, documentId));
    expect(cryptoBeforePurge?.storageKey).toMatch(/^[a-f0-9]{64}$/u);
    const storage = new LocalDocumentStorage(getDocumentConfig().storageRoot, getDocumentConfig().quarantineRoot);
    expect(await storage.ciphertextExists(cryptoBeforePurge!.storageKey)).toBe(true);

    await runDocumentMaintenanceCycle();

    const [terminal] = await getDb().select({ version: documents.version, lifecycle: documents.lifecycle })
      .from(documents).where(eq(documents.id, documentId));
    expect(terminal?.lifecycle).toBe("deleted");
    expect(await getDb().select().from(documentCrypto).where(eq(documentCrypto.documentId, documentId))).toHaveLength(0);
    expect(await storage.ciphertextExists(cryptoBeforePurge!.storageKey)).toBe(false);

    const [job] = await getDb().select({ status: documentJobs.status, generation: documentJobs.generation })
      .from(documentJobs)
      .where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "purge")))
      .orderBy(desc(documentJobs.generation))
      .limit(1);
    expect(job?.status).toBe("completed");
    expect(job?.generation).toBe(terminal!.version! - 1);
    const purgeAudits = await getDb().select({ id: auditLog.id }).from(auditLog)
      .where(and(eq(auditLog.entityId, documentId), eq(auditLog.action, "document_purged")));
    expect(purgeAudits).toHaveLength(1);

    const unavailable = await downloadDocument(requestForSession(session, downloadUrl), documentContext(documentId));
    expect(unavailable.status).toBe(404);
  });

  it("denies cross-household list, download, delete, and restore without side effects", async () => {
    const fixture = await createIntegrationFixture("document-cross-household");
    const { documentId } = await uploadSyntheticDocument(fixture);
    const outsider = await fixture.session("secondOwner");
    const listUrl = `http://127.0.0.1:3000/api/households/${fixture.household.id}/items/${fixture.item.id}/documents`;
    const downloadUrl = `http://127.0.0.1:3000/api/documents/${documentId}/download`;
    const beforeAudits = await fixture.auditCount(documentId);

    const list = await listDocuments(
      new NextRequest(listUrl, { headers: sessionHeaders(outsider) }),
      itemDocumentsContext(fixture.household.id, fixture.item.id),
    );
    expect(list.status).toBe(404);
    expect((await list.json()).error).toEqual({ code: "item_not_found", message: "That item is not available" });

    for (const response of [
      await downloadDocument(requestForSession(outsider, downloadUrl), documentContext(documentId)),
      await deleteDocument(requestForSession(outsider, downloadUrl, { method: "DELETE" }), documentContext(documentId)),
      await restoreDocumentRoute(requestForSession(outsider, downloadUrl + "/restore", { method: "POST" }), documentContext(documentId)),
    ]) {
      expect(response.status).toBe(404);
    }

    const [unchanged] = await getDb().select({ lifecycle: documents.lifecycle }).from(documents).where(eq(documents.id, documentId));
    expect(unchanged?.lifecycle).toBe("available");
    expect(await fixture.auditCount(documentId)).toBe(beforeAudits);
  });

  it("finalizes a purge when ciphertext was already removed by an interrupted attempt", async () => {
    const fixture = await createIntegrationFixture("document-interrupted-purge");
    const { session, documentId } = await uploadSyntheticDocument(fixture);
    const downloadUrl = `http://127.0.0.1:3000/api/documents/${documentId}/download`;
    await deleteDocument(requestForSession(session, downloadUrl, { method: "DELETE" }), documentContext(documentId));
    await getDb().update(documents).set({ deleteAfter: new Date(Date.now() - 1_000) }).where(eq(documents.id, documentId));
    const [crypto] = await getDb().select({ storageKey: documentCrypto.storageKey }).from(documentCrypto).where(eq(documentCrypto.documentId, documentId));
    const storage = new LocalDocumentStorage(getDocumentConfig().storageRoot, getDocumentConfig().quarantineRoot);
    await storage.deleteCiphertext(crypto!.storageKey);

    await runDocumentMaintenanceCycle();

    const [document] = await getDb().select({ lifecycle: documents.lifecycle }).from(documents).where(eq(documents.id, documentId));
    expect(document?.lifecycle).toBe("deleted");
    expect(await getDb().select().from(documentCrypto).where(eq(documentCrypto.documentId, documentId))).toHaveLength(0);
  });

  it("fails closed and retries when purge metadata is missing", async () => {
    const fixture = await createIntegrationFixture("document-metadata-failure");
    const { session, documentId } = await uploadSyntheticDocument(fixture);
    const downloadUrl = `http://127.0.0.1:3000/api/documents/${documentId}/download`;
    await deleteDocument(requestForSession(session, downloadUrl, { method: "DELETE" }), documentContext(documentId));
    await getDb().update(documents).set({ deleteAfter: new Date(Date.now() - 1_000) }).where(eq(documents.id, documentId));
    await getDb().delete(documentCrypto).where(eq(documentCrypto.documentId, documentId));

    await runDocumentMaintenanceCycle();

    const [document] = await getDb().select({ lifecycle: documents.lifecycle }).from(documents).where(eq(documents.id, documentId));
    const [job] = await getDb().select({ status: documentJobs.status, lastError: documentJobs.lastError })
      .from(documentJobs).where(eq(documentJobs.documentId, documentId)).orderBy(desc(documentJobs.generation)).limit(1);
    expect(document?.lifecycle).toBe("pending_deletion");
    expect(job).toMatchObject({ status: "retry", lastError: "purge_failed" });
  });

  it("uses a synthetic content hash without exposing fixture bytes in metadata", async () => {
    const fixture = await createIntegrationFixture("document-metadata");
    const { documentId } = await uploadSyntheticDocument(fixture);
    const [record] = await getDb().select({ contentSha256: documents.contentSha256 }).from(documents).where(eq(documents.id, documentId));
    expect(record?.contentSha256).toBe(createHash("sha256").update(syntheticPdf).digest("hex"));
    expect(record?.contentSha256).not.toContain(syntheticPdf.toString("utf8"));
  });
});
