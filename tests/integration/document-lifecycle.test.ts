import { createHash, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, documentCrypto, documentDrafts, documentJobs, documents, items } from "@/db/schema";
import { GET as downloadDocument } from "@/app/api/documents/[documentId]/download/route";
import { DELETE as deleteDocument } from "@/app/api/documents/[documentId]/route";
import { POST as restoreDocumentRoute } from "@/app/api/documents/[documentId]/restore/route";
import { POST as createDocumentDraftRoute } from "@/app/api/documents/[documentId]/draft/route";
import { POST as approveDocumentDraftRoute } from "@/app/api/document-drafts/[draftId]/approve/route";
import { GET as listDocuments, POST as uploadDocument } from "@/app/api/households/[householdId]/items/[itemId]/documents/route";
import { updateDocumentJob } from "@/server/admin-operations";
import { runDocumentMaintenanceCycle } from "@/server/document-worker";
import { getDocumentConfig, resetDocumentConfigForTests } from "@/server/documents/config";
import { LocalDocumentStorage } from "@/server/documents/storage";
import {
  createIntegrationFixture,
  requestForSession,
  sessionHeaders,
} from "./support/fixtures";
import { syntheticPdf as createSyntheticPdf } from "../support/synthetic-documents";

const syntheticPdf = createSyntheticPdf("synthetic authenticated document");

function itemDocumentsContext(householdId: string, itemId: string) {
  return { params: Promise.resolve({ householdId, itemId }) };
}

function documentContext(documentId: string) {
  return { params: Promise.resolve({ documentId }) };
}

function draftContext(draftId: string) {
  return { params: Promise.resolve({ draftId }) };
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
    await getDb().insert(documentDrafts).values({
      documentId,
      householdId: fixture.household.id,
      requestedByUserId: fixture.users.member.id,
      extractedTextSha256: createHash("sha256").update("synthetic draft evidence").digest("hex"),
      evidence: { excerpt: "synthetic draft evidence" },
      proposal: { title: "Synthetic draft" },
    });

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
    expect(await getDb().select().from(documentDrafts).where(eq(documentDrafts.documentId, documentId))).toHaveLength(0);
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

  it("rejects structurally invalid supported uploads before durable metadata or scanning", async () => {
    const fixture = await createIntegrationFixture("document-invalid-structure");
    const session = await fixture.session("member");
    const beforeDocuments = await getDb().select({ id: documents.id })
      .from(documents).where(eq(documents.householdId, fixture.household.id));
    const beforeAudits = await getDb().select({ id: auditLog.id })
      .from(auditLog).where(eq(auditLog.householdId, fixture.household.id));
    const malformed = [
      { name: "truncated.pdf", type: "application/pdf", bytes: Buffer.from("%PDF-1.7\ntruncated") },
      { name: "truncated.jpg", type: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) },
      { name: "truncated.png", type: "image/png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    ];

    for (const fixtureDocument of malformed) {
      const response = await uploadDocument(requestForSession(
        session,
        `http://127.0.0.1:3000/api/households/${fixture.household.id}/items/${fixture.item.id}/documents`,
        {
          method: "POST",
          headers: {
            "content-length": String(fixtureDocument.bytes.length),
            "content-type": fixtureDocument.type,
            "x-orbit-filename": encodeURIComponent(fixtureDocument.name),
          },
          body: fixtureDocument.bytes,
        },
      ), itemDocumentsContext(fixture.household.id, fixture.item.id));
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: {
          code: "document_structure_invalid",
          message: "Choose a structurally valid PDF, JPEG, or PNG document",
        },
      });
    }

    expect(await getDb().select({ id: documents.id })
      .from(documents).where(eq(documents.householdId, fixture.household.id))).toEqual(beforeDocuments);
    expect(await getDb().select({ id: auditLog.id })
      .from(auditLog).where(eq(auditLog.householdId, fixture.household.id))).toEqual(beforeAudits);
  });

  it("applies only explicitly reviewed draft fields and sanitizes stored parser evidence", async () => {
    const fixture = await createIntegrationFixture("document-explicit-draft-review");
    const { session, documentId } = await uploadSyntheticDocument(fixture);
    await getDb().update(items).set({ provider: "Old Provider", reference: "OLD-12345" })
      .where(eq(items.id, fixture.item.id));
    const createResponse = await createDocumentDraftRoute(
      requestForSession(session, `http://127.0.0.1:3000/api/documents/${documentId}/draft`, { method: "POST" }),
      documentContext(documentId),
    );
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json() as { draft: { id: string } };
    await getDb().update(documentDrafts).set({
      evidence: {
        excerpt: "<script>fetch('https://example.invalid')</script>\u202e private parser sentinel",
        characters: 9_999,
        extracted: true,
      },
      proposal: {
        title: "<img src=x>",
        provider: "Parser\u202e Provider",
        reference: "<PARSER-SECRET>",
        tool: "delete",
        householdId: "other-household",
      },
    }).where(eq(documentDrafts.id, created.draft.id));

    const sanitizedResponse = await createDocumentDraftRoute(
      requestForSession(session, `http://127.0.0.1:3000/api/documents/${documentId}/draft`, { method: "POST" }),
      documentContext(documentId),
    );
    const sanitizedBody = await sanitizedResponse.json() as {
      draft: { proposal: Record<string, unknown>; evidence: { excerpt: string; characters: number } };
    };
    expect(sanitizedBody.draft.proposal).toEqual({
      title: "synthetic-policy",
      provider: "Parser Provider",
      dates: [],
    });
    expect(sanitizedBody.draft.proposal).not.toHaveProperty("reference");
    expect(sanitizedBody.draft.proposal).not.toHaveProperty("tool");
    expect(sanitizedBody.draft.proposal).not.toHaveProperty("householdId");
    expect(sanitizedBody.draft.evidence.excerpt).not.toMatch(/[<>\u202e]/u);
    expect(sanitizedBody.draft.evidence.characters).toBe(sanitizedBody.draft.evidence.excerpt.length);

    const rejectedAuthority = await approveDocumentDraftRoute(
      requestForSession(session, `http://127.0.0.1:3000/api/document-drafts/${created.draft.id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sectionId: fixture.section.id,
          title: "Reviewed title",
          provider: "Reviewed Provider",
          reference: null,
          mode: "merge",
          targetItemId: fixture.item.id,
          tool: "delete",
          url: "https://example.invalid",
          secret: "parser-controlled",
        }),
      }),
      draftContext(created.draft.id),
    );
    expect(rejectedAuthority.status).toBe(422);
    expect(await getDb().select({ provider: items.provider, reference: items.reference })
      .from(items).where(eq(items.id, fixture.item.id)))
      .toEqual([{ provider: "Old Provider", reference: "OLD-12345" }]);

    const approval = await approveDocumentDraftRoute(
      requestForSession(session, `http://127.0.0.1:3000/api/document-drafts/${created.draft.id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sectionId: fixture.section.id,
          title: "Reviewed title",
          provider: "Reviewed Provider",
          reference: null,
          mode: "merge",
          targetItemId: fixture.item.id,
        }),
      }),
      draftContext(created.draft.id),
    );
    expect(approval.status).toBe(200);
    expect(await getDb().select({ provider: items.provider, reference: items.reference })
      .from(items).where(eq(items.id, fixture.item.id)))
      .toEqual([{ provider: "Reviewed Provider", reference: null }]);
  });

  it("serializes duplicate draft approval so one explicit write wins", async () => {
    const fixture = await createIntegrationFixture("document-draft-approval-race");
    const { session, documentId } = await uploadSyntheticDocument(fixture);
    const draftResponse = await createDocumentDraftRoute(
      requestForSession(session, `http://127.0.0.1:3000/api/documents/${documentId}/draft`, { method: "POST" }),
      documentContext(documentId),
    );
    const payload = await draftResponse.json() as { draft: { id: string } };
    const approve = () => approveDocumentDraftRoute(
      requestForSession(session, `http://127.0.0.1:3000/api/document-drafts/${payload.draft.id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sectionId: fixture.section.id,
          title: "Concurrent reviewed draft",
          provider: null,
          reference: null,
          mode: "create",
        }),
      }),
      draftContext(payload.draft.id),
    );

    const responses = await Promise.all([approve(), approve()]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 404]);
    expect(await getDb().select({ id: items.id }).from(items).where(and(
      eq(items.householdId, fixture.household.id),
      eq(items.title, "Concurrent reviewed draft"),
    ))).toHaveLength(1);
    expect(await getDb().select({ id: auditLog.id }).from(auditLog).where(and(
      eq(auditLog.entityId, payload.draft.id),
      eq(auditLog.action, "document_draft_create"),
    ))).toHaveLength(1);
  });

  it("keeps a failed ciphertext purge recoverable through bounded administrator retry", async () => {
    const fixture = await createIntegrationFixture("document-storage-delete-failure");
    const { session, documentId } = await uploadSyntheticDocument(fixture);
    const downloadUrl = `http://127.0.0.1:3000/api/documents/${documentId}/download`;
    await getDb().insert(documentDrafts).values({
      documentId,
      householdId: fixture.household.id,
      requestedByUserId: fixture.users.member.id,
      extractedTextSha256: createHash("sha256").update("retryable draft evidence").digest("hex"),
      evidence: { excerpt: "retryable draft evidence" },
      proposal: { title: "Retryable draft" },
    });
    await deleteDocument(
      requestForSession(session, downloadUrl, { method: "DELETE" }),
      documentContext(documentId),
    );
    await getDb().update(documents).set({ deleteAfter: new Date(Date.now() - 1_000) })
      .where(eq(documents.id, documentId));

    const [crypto] = await getDb().select({ storageKey: documentCrypto.storageKey })
      .from(documentCrypto).where(eq(documentCrypto.documentId, documentId));
    const storage = new LocalDocumentStorage(getDocumentConfig().storageRoot, getDocumentConfig().quarantineRoot);
    const deleteFailure = vi.spyOn(LocalDocumentStorage.prototype, "deleteCiphertext")
      .mockRejectedValue(new Error("injected ciphertext delete outage"));
    try {
      await runDocumentMaintenanceCycle();

      expect(await storage.ciphertextExists(crypto!.storageKey)).toBe(true);
      expect(await getDb().select({ documentId: documentCrypto.documentId }).from(documentCrypto)
        .where(eq(documentCrypto.documentId, documentId))).toEqual([{ documentId }]);
      expect(await getDb().select({ documentId: documentDrafts.documentId }).from(documentDrafts)
        .where(eq(documentDrafts.documentId, documentId))).toEqual([{ documentId }]);
      expect(await getDb().select({ lifecycle: documents.lifecycle }).from(documents)
        .where(eq(documents.id, documentId))).toEqual([{ lifecycle: "pending_deletion" }]);
      expect(await getDb().select({ status: documentJobs.status, attempts: documentJobs.attempts, lastError: documentJobs.lastError })
        .from(documentJobs).where(eq(documentJobs.documentId, documentId)))
        .toEqual([expect.objectContaining({ status: "retry", attempts: 1, lastError: "purge_failed" })]);
      expect(await getDb().select({ id: auditLog.id }).from(auditLog).where(and(
        eq(auditLog.entityId, documentId),
        eq(auditLog.action, "document_purged"),
      ))).toHaveLength(0);

      for (let attempt = 1; attempt < 5; attempt += 1) await runDocumentMaintenanceCycle();
    } finally {
      deleteFailure.mockRestore();
    }

    const [failedJob] = await getDb().select({
      id: documentJobs.id,
      status: documentJobs.status,
      attempts: documentJobs.attempts,
      lastError: documentJobs.lastError,
    }).from(documentJobs).where(eq(documentJobs.documentId, documentId));
    expect(failedJob).toMatchObject({ status: "failed", attempts: 5, lastError: "purge_failed" });
    expect(await storage.ciphertextExists(crypto!.storageKey)).toBe(true);

    await updateDocumentJob(fixture.users.admin.id, failedJob!.id, "retry", "failed");
    await runDocumentMaintenanceCycle();

    expect(await storage.ciphertextExists(crypto!.storageKey)).toBe(false);
    expect(await getDb().select({ lifecycle: documents.lifecycle }).from(documents)
      .where(eq(documents.id, documentId))).toEqual([{ lifecycle: "deleted" }]);
    expect(await getDb().select({ id: documentCrypto.documentId }).from(documentCrypto)
      .where(eq(documentCrypto.documentId, documentId))).toHaveLength(0);
    expect(await getDb().select({ id: documentDrafts.id }).from(documentDrafts)
      .where(eq(documentDrafts.documentId, documentId))).toHaveLength(0);
    expect(await getDb().select({ status: documentJobs.status, attempts: documentJobs.attempts })
      .from(documentJobs).where(eq(documentJobs.id, failedJob!.id)))
      .toEqual([{ status: "completed", attempts: 1 }]);
    expect(await getDb().select({ id: auditLog.id }).from(auditLog).where(and(
      eq(auditLog.entityId, documentId),
      eq(auditLog.action, "document_purged"),
    ))).toHaveLength(1);
  });

  it("serializes concurrent uploads at the instance quota boundary", async () => {
    const fixture = await createIntegrationFixture("document-instance-quota-race");
    const filler = await createIntegrationFixture("document-instance-quota-filler");
    const quotaBytes = 25 * 1_048_576;
    const previousHouseholdQuota = process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES;
    const previousInstanceQuota = process.env.DOCUMENT_INSTANCE_QUOTA_BYTES;
    process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES = String(quotaBytes);
    process.env.DOCUMENT_INSTANCE_QUOTA_BYTES = String(quotaBytes);
    resetDocumentConfigForTests();
    try {
      const [usage] = await getDb().select({
        total: sql<number>`coalesce(sum(${documents.sizeBytes}), 0)`,
      }).from(documents).where(notInArray(documents.lifecycle, ["deleted", "rejected"]));
      const fillerBytes = quotaBytes - Number(usage.total) - syntheticPdf.length;
      expect(fillerBytes).toBeGreaterThan(0);
      await getDb().insert(documents).values({
        id: randomUUID(),
        householdId: filler.household.id,
        itemId: filler.item.id,
        uploadedByUserId: filler.users.member.id,
        displayName: "quota-boundary-reservation.pdf",
        mediaType: "application/pdf",
        sizeBytes: fillerBytes,
        contentSha256: createHash("sha256").update("quota-boundary-reservation").digest("hex"),
        lifecycle: "quarantined",
        scanStatus: "skipped",
      });

      const member = await fixture.session("member");
      const secondOwner = await fixture.session("secondOwner");
      const uploadAtBoundary = (
        currentSession: Awaited<ReturnType<typeof fixture.session>>,
        householdId: string,
        itemId: string,
        filename: string,
      ) => uploadDocument(requestForSession(
        currentSession,
        `http://127.0.0.1:3000/api/households/${householdId}/items/${itemId}/documents`,
        {
          method: "POST",
          headers: {
            "content-length": String(syntheticPdf.length),
            "content-type": "application/pdf",
            "x-orbit-filename": encodeURIComponent(filename),
          },
          body: syntheticPdf,
        },
      ), itemDocumentsContext(householdId, itemId));

      const responses = await Promise.all([
        uploadAtBoundary(member, fixture.household.id, fixture.item.id, "quota-primary.pdf"),
        uploadAtBoundary(secondOwner, fixture.secondHousehold.id, fixture.secondItem.id, "quota-secondary.pdf"),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 413]);
      const denied = responses.find((response) => response.status === 413)!;
      expect((await denied.json()).error).toEqual({
        code: "document_instance_quota",
        message: "Orbit document storage has reached its configured limit",
      });
      const [finalUsage] = await getDb().select({
        total: sql<number>`coalesce(sum(${documents.sizeBytes}), 0)`,
      }).from(documents).where(notInArray(documents.lifecycle, ["deleted", "rejected"]));
      expect(Number(finalUsage.total)).toBe(quotaBytes);
    } finally {
      if (previousHouseholdQuota === undefined) delete process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES;
      else process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES = previousHouseholdQuota;
      if (previousInstanceQuota === undefined) delete process.env.DOCUMENT_INSTANCE_QUOTA_BYTES;
      else process.env.DOCUMENT_INSTANCE_QUOTA_BYTES = previousInstanceQuota;
      resetDocumentConfigForTests();
    }
  });

  it("uses a synthetic content hash without exposing fixture bytes in metadata", async () => {
    const fixture = await createIntegrationFixture("document-metadata");
    const { documentId } = await uploadSyntheticDocument(fixture);
    const [record] = await getDb().select({ contentSha256: documents.contentSha256 }).from(documents).where(eq(documents.id, documentId));
    expect(record?.contentSha256).toBe(createHash("sha256").update(syntheticPdf).digest("hex"));
    expect(record?.contentSha256).not.toContain(syntheticPdf.toString("utf8"));
  });
});
