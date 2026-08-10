import { createHash, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import * as database from "@/db";
import { auditLog, documentCrypto, documentDrafts, documentJobs, documentStagingObjects, documents, items, reviewedIntakeOperations } from "@/db/schema";
import { GET as downloadDocument } from "@/app/api/documents/[documentId]/download/route";
import { DELETE as deleteDocument } from "@/app/api/documents/[documentId]/route";
import { POST as restoreDocumentRoute } from "@/app/api/documents/[documentId]/restore/route";
import { POST as createDocumentDraftRoute } from "@/app/api/documents/[documentId]/draft/route";
import { POST as approveDocumentDraftRoute } from "@/app/api/document-drafts/[draftId]/approve/route";
import { GET as listDocuments, POST as uploadDocument } from "@/app/api/households/[householdId]/items/[itemId]/documents/route";
import { updateDocumentJob } from "@/server/admin-operations";
import { reconcileDocumentStorage, runDocumentMaintenanceCycle } from "@/server/document-worker";
import { getDocumentConfig, resetDocumentConfigForTests } from "@/server/documents/config";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { approveReviewedIntake } from "@/server/reviewed-intake";
import {
  createIntegrationFixture,
  requestForSession,
  sessionHeaders,
} from "./support/fixtures";
import { syntheticPdf as createSyntheticPdf } from "../support/synthetic-documents";

vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(),
}));

afterEach(() => {
  vi.mocked(scanFileWithClamAv).mockReset();
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
});

const syntheticPdf = createSyntheticPdf("synthetic authenticated document");

/** Captures rendered `orbit`-prefixed log lines without disturbing other console output shape. */
function captureLogLines() {
  const lines: string[] = [];
  const record = (line: unknown) => { lines.push(String(line)); };
  const logSpy = vi.spyOn(console, "log").mockImplementation(record);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(record);
  return {
    lines,
    restore: () => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    },
  };
}

function parseLogLine(line: string): { level: string; component: string; event: string; fields: Record<string, string> } {
  const [, level, , component, event, ...rest] = line.split(" ");
  const fields: Record<string, string> = {};
  for (const token of rest) {
    const separatorIndex = token.indexOf("=");
    if (separatorIndex === -1) continue;
    fields[token.slice(0, separatorIndex)] = token.slice(separatorIndex + 1);
  }
  return { level, component, event, fields };
}

async function uploadWithFilename(fixture: Awaited<ReturnType<typeof createIntegrationFixture>>, filename: string, documentId?: string, body = syntheticPdf) {
  const session = await fixture.session("member");
  const url = `http://127.0.0.1:3000/api/households/${fixture.household.id}/items/${fixture.item.id}/documents`;
  const response = await uploadDocument(requestForSession(session, url, {
    method: "POST",
    headers: {
      "content-length": String(body.length),
      "content-type": "application/pdf",
      "x-orbit-filename": encodeURIComponent(filename),
      ...(documentId ? { "x-orbit-document-id": documentId } : {}),
    },
    body,
  }), itemDocumentsContext(fixture.household.id, fixture.item.id));
  return { session, response };
}

async function withRequiredScanMode<T>(work: () => Promise<T>): Promise<T> {
  const previous = process.env.DOCUMENT_SCAN_MODE;
  process.env.DOCUMENT_SCAN_MODE = "required";
  resetDocumentConfigForTests();
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.DOCUMENT_SCAN_MODE;
    else process.env.DOCUMENT_SCAN_MODE = previous;
    resetDocumentConfigForTests();
    vi.mocked(scanFileWithClamAv).mockReset();
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
  }
}

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
    const capture = captureLogLines();
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
      expect(capture.lines.join("\n")).not.toContain("injected ciphertext delete outage");

      for (let attempt = 1; attempt < 5; attempt += 1) await runDocumentMaintenanceCycle();
    } finally {
      deleteFailure.mockRestore();
      capture.restore();
    }

    const [failedJob] = await getDb().select({
      id: documentJobs.id,
      status: documentJobs.status,
      attempts: documentJobs.attempts,
      lastError: documentJobs.lastError,
    }).from(documentJobs).where(eq(documentJobs.documentId, documentId));
    expect(failedJob).toMatchObject({ status: "failed", attempts: 5, lastError: "purge_failed" });
    const jobRecords = capture.lines.map(parseLogLine).filter((entry) => entry.event === "document.job");
    expect(jobRecords.some((entry) => entry.fields.state === "retrying" && entry.fields.reason === "purge_failed")).toBe(true);
    expect(jobRecords.some((entry) => entry.fields.state === "exhausted" && entry.fields.reason === "purge_failed")).toBe(true);
    expect(await storage.ciphertextExists(crypto!.storageKey)).toBe(true);

    await updateDocumentJob(fixture.users.admin.id, failedJob!.id, "retry", "failed");
    const completionCapture = captureLogLines();
    try {
      await runDocumentMaintenanceCycle();
    } finally {
      completionCapture.restore();
    }
    const completed = completionCapture.lines.map(parseLogLine).find((entry) =>
      entry.event === "document.job" && entry.fields.state === "ready",
    );
    expect(completed?.fields.state).toBe("ready");

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

  it("emits bounded scan and lifecycle diagnostics for a clean required-mode upload without filenames, host or port", async () => {
    const fixture = await createIntegrationFixture("document-scan-clean-diagnostics");
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
    const capture = captureLogLines();
    try {
      await withRequiredScanMode(async () => {
        const hostileFilename = "<script>alert(1)</script> confidential-report.pdf";
        const { response } = await uploadWithFilename(fixture, hostileFilename);
        expect(response.status).toBe(201);
        await response.json();

        const records = capture.lines.map(parseLogLine);
        const scanAttempt = records.find((entry) => entry.event === "document.scan" && entry.fields.state === "starting");
        const scanClean = records.find((entry) => entry.event === "document.scan" && entry.fields.state === "ready");
        expect(scanAttempt).toBeDefined();
        expect(scanClean?.fields.duration_ms).toMatch(/^\d+$/u);
        expect(scanClean?.fields).not.toHaveProperty("host");
        expect(scanClean?.fields).not.toHaveProperty("port");

        const lifecycleStates = records
          .filter((entry) => entry.event === "document.lifecycle")
          .map((entry) => entry.fields.state);
        expect(lifecycleStates).toEqual(["starting", "starting", "starting", "ready"]);

        const combined = capture.lines.join("\n");
        expect(combined).not.toContain("script");
        expect(combined).not.toContain("confidential-report");
        expect(combined).not.toContain(fixture.household.name);
      });
    } finally {
      capture.restore();
    }
  });

  it("stages retryable scanner outages without exposing bytes, paths or provider text", async () => {
    const fixture = await createIntegrationFixture("document-scan-error-diagnostics");
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason: "unavailable" });
    const capture = captureLogLines();
    try {
      await withRequiredScanMode(async () => {
        const { session, response } = await uploadWithFilename(fixture, "policy.pdf");
        expect(response.status).toBe(202);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const payload = await response.json() as { document: { id: string; lifecycle: string; scanStatus: string; recoverable: boolean; recoveryStatus: string; ready: boolean } };
        const documentId = payload.document.id;
        expect(payload.document).toMatchObject({ lifecycle: "scanning", scanStatus: "error", recoverable: true, recoveryStatus: "retrying", ready: false });

        const records = capture.lines.map(parseLogLine);
        const scanError = records.find((entry) => entry.event === "document.scan" && entry.fields.state === "degraded");
        expect(scanError?.fields.reason).toBe("scanner_unavailable");
        expect(scanError?.fields.duration_ms).toMatch(/^\d+$/u);
        expect(scanError?.fields).not.toHaveProperty("host");
        expect(scanError?.fields).not.toHaveProperty("port");

        const recoverable = records.find((entry) => entry.event === "document.scan" && entry.fields.state === "retrying");
        expect(recoverable?.fields.reason).toBe("scanner_unavailable");

        const [stored] = await getDb().select({ lifecycle: documents.lifecycle, scanStatus: documents.scanStatus, failureCode: documents.failureCode })
          .from(documents).where(eq(documents.id, documentId));
        expect(stored).toMatchObject({ lifecycle: "scanning", scanStatus: "error", failureCode: "scanner_unavailable" });
        const [stage] = await getDb().select({ storageKey: documentStagingObjects.storageKey, status: documentStagingObjects.status })
          .from(documentStagingObjects).where(eq(documentStagingObjects.documentId, documentId));
        expect(stage).toMatchObject({ status: "pending" });
        expect(stage?.storageKey).toMatch(/^[a-f0-9]{64}$/u);
        expect(await getDb().select({ id: documentCrypto.documentId }).from(documentCrypto).where(eq(documentCrypto.documentId, documentId))).toHaveLength(0);
        expect(await getDb().select({ id: documentDrafts.id }).from(documentDrafts).where(eq(documentDrafts.documentId, documentId))).toHaveLength(0);
        const storage = new LocalDocumentStorage(getDocumentConfig().storageRoot, getDocumentConfig().quarantineRoot);
        expect(await storage.stagingExists(stage!.storageKey)).toBe(true);
        expect(await storage.listQuarantineFiles()).toHaveLength(0);
        const documentUrl = `http://127.0.0.1:3000/api/documents/${documentId}`;
        expect((await downloadDocument(requestForSession(session, `${documentUrl}/download`), documentContext(documentId))).status).toBe(404);
        expect((await createDocumentDraftRoute(requestForSession(session, `${documentUrl}/draft`, { method: "POST" }), documentContext(documentId))).status).toBe(404);
      });
    } finally {
      capture.restore();
    }
  });

  it("rejects the scanner-reported error without creating a recovery stage", async () => {
    const fixture = await createIntegrationFixture("document-scan-terminal-error");
    const documentId = randomUUID();
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason: "scanner" });
    await withRequiredScanMode(async () => {
      const { response } = await uploadWithFilename(fixture, "policy.pdf", documentId);
      expect(response.status).toBe(503);
      expect((await response.json() as { error: { code: string } }).error.code).toBe("document_scanner_failed");
      const [stored] = await getDb().select({ lifecycle: documents.lifecycle, failureCode: documents.failureCode })
        .from(documents).where(eq(documents.id, documentId));
      expect(stored).toMatchObject({ lifecycle: "rejected", failureCode: "scanner_failed" });
      expect(await getDb().select({ documentId: documentStagingObjects.documentId }).from(documentStagingObjects).where(eq(documentStagingObjects.documentId, documentId))).toHaveLength(0);
    });
  });

  it("replays a recovery response for the same identity and rejects content reuse", async () => {
    const fixture = await createIntegrationFixture("document-idempotency");
    const documentId = randomUUID();
    vi.mocked(scanFileWithClamAv).mockClear();
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason: "timeout" });
    await withRequiredScanMode(async () => {
      const first = await uploadWithFilename(fixture, "policy.pdf", documentId);
      expect(first.response.status).toBe(202);
      const second = await uploadWithFilename(fixture, "renamed-policy.pdf", documentId);
      expect(second.response.status).toBe(202);
      expect((await second.response.json() as { document: { id: string; recoverable: boolean } }).document)
        .toMatchObject({ id: documentId, recoverable: true });
      expect(scanFileWithClamAv).toHaveBeenCalledTimes(1);

      const mismatch = await uploadWithFilename(fixture, "policy.pdf", documentId, Buffer.concat([syntheticPdf, Buffer.from("changed content")]));
      expect(mismatch.response.status).toBe(409);
      expect((await mismatch.response.json() as { error: { code: string } }).error.code).toBe("document_conflict");
    });
  });

  it("recovers an outage-staged upload after the bounded retry delay without re-upload", async () => {
    const fixture = await createIntegrationFixture("document-scan-recovery");
    const documentId = randomUUID();
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason: "protocol" });
    await withRequiredScanMode(async () => {
      const first = await uploadWithFilename(fixture, "policy.pdf", documentId);
      expect(first.response.status).toBe(202);
      await getDb().update(documentJobs).set({ nextAttemptAt: new Date(Date.now() - 1_000) })
        .where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "scan")));
      vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
      await runDocumentMaintenanceCycle();
      const [document] = await getDb().select({ lifecycle: documents.lifecycle, scanStatus: documents.scanStatus })
        .from(documents).where(eq(documents.id, documentId));
      expect(document).toEqual({ lifecycle: "available", scanStatus: "clean" });
      expect(await getDb().select({ documentId: documentStagingObjects.documentId }).from(documentStagingObjects).where(eq(documentStagingObjects.documentId, documentId))).toHaveLength(0);
      const [job] = await getDb().select({ status: documentJobs.status, attempts: documentJobs.attempts })
        .from(documentJobs).where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "scan")));
      expect(job).toEqual({ status: "completed", attempts: 1 });
      const storage = new LocalDocumentStorage(getDocumentConfig().storageRoot, getDocumentConfig().quarantineRoot);
      expect(await storage.listQuarantineFiles()).toHaveLength(0);
    });
  });

  it("retains available ciphertext when post-finalization stage cleanup bookkeeping fails", async () => {
    const fixture = await createIntegrationFixture("document-scan-post-finalization-cleanup");
    const documentId = randomUUID();
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason: "unavailable" });
    await withRequiredScanMode(async () => {
      const { session, response } = await uploadWithFilename(fixture, "policy.pdf", documentId);
      expect(response.status).toBe(202);
      await getDb().update(documentJobs).set({ nextAttemptAt: new Date(Date.now() - 1_000) })
        .where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "scan")));
      vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });

      const originalGetDb = database.getDb;
      let cleanupStarted = false;
      let bookkeepingFailureInjected = false;
      const databaseFailure = vi.spyOn(database, "getDb").mockImplementation(() => {
        if (cleanupStarted && !bookkeepingFailureInjected) {
          bookkeepingFailureInjected = true;
          throw new Error("synthetic cleanup bookkeeping outage");
        }
        return originalGetDb();
      });
      const purgeFailure = vi.spyOn(LocalDocumentStorage.prototype, "deleteStagingCiphertext")
        .mockImplementation(async () => {
          cleanupStarted = true;
          throw new Error("synthetic staging deletion outage");
        });
      try {
        await expect(runDocumentMaintenanceCycle()).resolves.toBeUndefined();
      } finally {
        purgeFailure.mockRestore();
        databaseFailure.mockRestore();
      }
      expect(bookkeepingFailureInjected).toBe(true);

      const [document] = await getDb().select({ lifecycle: documents.lifecycle, scanStatus: documents.scanStatus })
        .from(documents).where(eq(documents.id, documentId));
      expect(document).toEqual({ lifecycle: "available", scanStatus: "clean" });
      const [crypto] = await getDb().select({ storageKey: documentCrypto.storageKey })
        .from(documentCrypto).where(eq(documentCrypto.documentId, documentId));
      const [stage] = await getDb().select({ storageKey: documentStagingObjects.storageKey, status: documentStagingObjects.status })
        .from(documentStagingObjects).where(eq(documentStagingObjects.documentId, documentId));
      expect(crypto?.storageKey).toMatch(/^[a-f0-9]{64}$/u);
      expect(stage?.status).toBe("purge_pending");
      expect(stage?.storageKey).toMatch(/^[a-f0-9]{64}$/u);
      const storage = new LocalDocumentStorage(getDocumentConfig().storageRoot, getDocumentConfig().quarantineRoot);
      expect(await storage.stagingExists(stage!.storageKey)).toBe(true);
      const downloaded = await downloadDocument(
        requestForSession(session, "http://127.0.0.1:3000/api/documents/" + documentId + "/download"),
        documentContext(documentId),
      );
      expect(downloaded.status).toBe(200);
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(syntheticPdf);
      expect(scanFileWithClamAv).toHaveBeenCalledTimes(2);

      await runDocumentMaintenanceCycle();
      expect(await getDb().select({ documentId: documentStagingObjects.documentId })
        .from(documentStagingObjects).where(eq(documentStagingObjects.documentId, documentId))).toHaveLength(0);
      expect(await storage.stagingExists(stage!.storageKey)).toBe(false);
      expect(scanFileWithClamAv).toHaveBeenCalledTimes(2);
      const downloadedAfterPurge = await downloadDocument(
        requestForSession(session, "http://127.0.0.1:3000/api/documents/" + documentId + "/download"),
        documentContext(documentId),
      );
      expect(downloadedAfterPurge.status).toBe(200);
      expect(Buffer.from(await downloadedAfterPurge.arrayBuffer())).toEqual(syntheticPdf);
    });
  });

  it("reclaims an expired scanner lease and fences a stale worker before recovery", async () => {
    const fixture = await createIntegrationFixture("document-scan-lease-fencing");
    const documentId = randomUUID();
    vi.mocked(scanFileWithClamAv).mockClear();
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason: "protocol" });
    await withRequiredScanMode(async () => {
      expect((await uploadWithFilename(fixture, "policy.pdf", documentId)).response.status).toBe(202);
      let releaseFirstScan!: () => void;
      const firstScanReleased = new Promise<void>((resolve) => { releaseFirstScan = resolve; });
      vi.mocked(scanFileWithClamAv).mockImplementationOnce(async () => {
        await firstScanReleased;
        return { status: "clean" };
      });
      await getDb().update(documentJobs).set({
        status: "processing",
        nextAttemptAt: new Date(Date.now() - 1_000),
        lockedAt: new Date(Date.now() - 20 * 60 * 1_000),
        leaseExpiresAt: new Date(Date.now() - 1_000),
        leaseToken: randomUUID(),
      }).where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "scan")));

      const firstWorker = runDocumentMaintenanceCycle();
      await vi.waitFor(() => expect(scanFileWithClamAv).toHaveBeenCalledTimes(2));
      const duplicateWorker = runDocumentMaintenanceCycle();
      await duplicateWorker;
      expect(vi.mocked(scanFileWithClamAv)).toHaveBeenCalledTimes(2);
      await getDb().update(documentJobs).set({
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1_000),
      }).where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "scan"), eq(documentJobs.status, "processing")));
      releaseFirstScan();
      await firstWorker;

      expect(await getDb().select({ documentId: documentStagingObjects.documentId }).from(documentStagingObjects).where(eq(documentStagingObjects.documentId, documentId))).toHaveLength(1);
      expect(await getDb().select({ documentId: documentCrypto.documentId }).from(documentCrypto).where(eq(documentCrypto.documentId, documentId))).toHaveLength(0);

      await getDb().update(documentJobs).set({
        nextAttemptAt: new Date(Date.now() - 1_000),
        leaseExpiresAt: new Date(Date.now() - 1_000),
      }).where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "scan")));
      vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
      await runDocumentMaintenanceCycle();
      expect(await getDb().select({ lifecycle: documents.lifecycle }).from(documents).where(eq(documents.id, documentId)))
        .toEqual([{ lifecycle: "available" }]);
      expect(vi.mocked(scanFileWithClamAv)).toHaveBeenCalledTimes(3);
    });
  });

  it("exhausts five automatic recovery attempts without rejecting the staged document", async () => {
    const fixture = await createIntegrationFixture("document-scan-attempt-exhaustion");
    const documentId = randomUUID();
    vi.mocked(scanFileWithClamAv).mockClear();
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason: "unavailable" });
    await withRequiredScanMode(async () => {
      expect((await uploadWithFilename(fixture, "policy.pdf", documentId)).response.status).toBe(202);
      await getDb().update(documentJobs).set({
        attempts: 4,
        nextAttemptAt: new Date(Date.now() - 1_000),
      }).where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "scan")));
      await runDocumentMaintenanceCycle();
      const [document] = await getDb().select({ lifecycle: documents.lifecycle, failureCode: documents.failureCode })
        .from(documents).where(eq(documents.id, documentId));
      const [job] = await getDb().select({ status: documentJobs.status, attempts: documentJobs.attempts, lastError: documentJobs.lastError })
        .from(documentJobs).where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "scan")));
      expect(document).toEqual({ lifecycle: "scanning", failureCode: "scanner_unavailable" });
      expect(job).toEqual({ status: "failed", attempts: 5, lastError: "scanner_unavailable" });
      expect(await getDb().select({ status: documentStagingObjects.status }).from(documentStagingObjects).where(eq(documentStagingObjects.documentId, documentId)))
        .toEqual([{ status: "pending" }]);
      expect(vi.mocked(scanFileWithClamAv)).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps terminal staged bytes inaccessible when purge fails, then retries purge without rescanning", async () => {
    const fixture = await createIntegrationFixture("document-scan-purge-failure");
    const documentId = randomUUID();
    vi.mocked(scanFileWithClamAv).mockClear();
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason: "unavailable" });
    await withRequiredScanMode(async () => {
      expect((await uploadWithFilename(fixture, "policy.pdf", documentId)).response.status).toBe(202);
      await getDb().update(documentJobs).set({ nextAttemptAt: new Date(Date.now() - 1_000) })
        .where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "scan")));
      vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "infected", signature: "synthetic-signature" });
      const storage = new LocalDocumentStorage(getDocumentConfig().storageRoot, getDocumentConfig().quarantineRoot);
      const purgeFailure = vi.spyOn(LocalDocumentStorage.prototype, "deleteStagingCiphertext")
        .mockRejectedValue(new Error("synthetic purge outage"));
      try {
        await runDocumentMaintenanceCycle();
      } finally {
        purgeFailure.mockRestore();
      }
      const [rejected] = await getDb().select({ lifecycle: documents.lifecycle, failureCode: documents.failureCode })
        .from(documents).where(eq(documents.id, documentId));
      const [stage] = await getDb().select({ status: documentStagingObjects.status })
        .from(documentStagingObjects).where(eq(documentStagingObjects.documentId, documentId));
      expect(rejected).toEqual({ lifecycle: "rejected", failureCode: "malware_detected" });
      expect(stage).toEqual({ status: "purge_pending" });
      expect(await storage.stagingExists((await getDb().select({ storageKey: documentStagingObjects.storageKey }).from(documentStagingObjects).where(eq(documentStagingObjects.documentId, documentId)))[0]!.storageKey)).toBe(true);
      expect(scanFileWithClamAv).toHaveBeenCalledTimes(2);

      await runDocumentMaintenanceCycle();
      expect(await getDb().select({ documentId: documentStagingObjects.documentId }).from(documentStagingObjects).where(eq(documentStagingObjects.documentId, documentId))).toHaveLength(0);
      const [completed] = await getDb().select({ status: documentJobs.status }).from(documentJobs).where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "scan")));
      expect(completed).toEqual({ status: "completed" });
      expect(scanFileWithClamAv).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps recovery expiry immutable across manual retry and rejects at expiry", async () => {
    const fixture = await createIntegrationFixture("document-scan-recovery-expiry");
    const documentId = randomUUID();
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason: "timeout" });
    await withRequiredScanMode(async () => {
      expect((await uploadWithFilename(fixture, "policy.pdf", documentId)).response.status).toBe(202);
      const [stageBefore] = await getDb().select({ storageKey: documentStagingObjects.storageKey, recoveryExpiresAt: documentStagingObjects.recoveryExpiresAt })
        .from(documentStagingObjects).where(eq(documentStagingObjects.documentId, documentId));
      const [job] = await getDb().select({ id: documentJobs.id }).from(documentJobs)
        .where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "scan")));
      await getDb().update(documentJobs).set({ status: "failed", attempts: 5, lastError: "scanner_timeout" })
        .where(eq(documentJobs.id, job!.id));
      await updateDocumentJob(fixture.users.admin.id, job!.id, "retry", "failed");
      const [stageAfterRetry] = await getDb().select({ recoveryExpiresAt: documentStagingObjects.recoveryExpiresAt })
        .from(documentStagingObjects).where(eq(documentStagingObjects.documentId, documentId));
      expect(stageAfterRetry?.recoveryExpiresAt?.toISOString()).toBe(stageBefore?.recoveryExpiresAt.toISOString());

      await getDb().update(documentStagingObjects).set({ recoveryExpiresAt: new Date(Date.now() - 1_000) })
        .where(eq(documentStagingObjects.documentId, documentId));
      await runDocumentMaintenanceCycle();
      expect(await getDb().select({ documentId: documentStagingObjects.documentId }).from(documentStagingObjects).where(eq(documentStagingObjects.documentId, documentId))).toHaveLength(0);
      expect(await getDb().select({ lifecycle: documents.lifecycle, failureCode: documents.failureCode }).from(documents).where(eq(documents.id, documentId)))
        .toEqual([{ lifecycle: "rejected", failureCode: "scan_recovery_expired" }]);
      expect(await getDb().select({ status: documentJobs.status }).from(documentJobs).where(eq(documentJobs.id, job!.id)))
        .toEqual([{ status: "cancelled" }]);
    });
  });

  it("treats a corrupt recovery envelope as terminal and purges it", async () => {
    const fixture = await createIntegrationFixture("document-scan-corrupt-stage");
    const documentId = randomUUID();
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason: "protocol" });
    await withRequiredScanMode(async () => {
      expect((await uploadWithFilename(fixture, "policy.pdf", documentId)).response.status).toBe(202);
      const [stage] = await getDb().select({ storageKey: documentStagingObjects.storageKey })
        .from(documentStagingObjects).where(eq(documentStagingObjects.documentId, documentId));
      const storage = new LocalDocumentStorage(getDocumentConfig().storageRoot, getDocumentConfig().quarantineRoot);
      await storage.writeStagingCiphertext(stage!.storageKey, Buffer.from("corrupt envelope"));
      await getDb().update(documentJobs).set({ nextAttemptAt: new Date(Date.now() - 1_000) })
        .where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "scan")));
      await runDocumentMaintenanceCycle();
      expect(await getDb().select({ documentId: documentStagingObjects.documentId }).from(documentStagingObjects).where(eq(documentStagingObjects.documentId, documentId))).toHaveLength(0);
      expect(await getDb().select({ lifecycle: documents.lifecycle, failureCode: documents.failureCode }).from(documents).where(eq(documents.id, documentId)))
        .toEqual([{ lifecycle: "rejected", failureCode: "staging_object_invalid" }]);
    });
  });

  it("keeps reviewed direct intake pending until a recovery worker makes the document available", async () => {
    const fixture = await createIntegrationFixture("reviewed-document-recovery");
    const member = await fixture.session("member");
    const operationId = randomUUID();
    const approval = await approveReviewedIntake(member.userId, {
      operationId,
      source: { kind: "direct_upload", expectedDocument: true },
      householdId: fixture.household.id,
      sectionId: fixture.section.id,
      action: "create_separate",
      item: { title: "Reviewed recovery item", currency: "GBP", status: "active" },
      attachmentIds: [],
    });
    const documentId = randomUUID();
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason: "unavailable" });
    await withRequiredScanMode(async () => {
      const url = `http://127.0.0.1:3000/api/households/${fixture.household.id}/items/${approval.itemId}/documents`;
      const response = await uploadDocument(requestForSession(member, url, {
        method: "POST",
        headers: {
          "content-length": String(syntheticPdf.length),
          "content-type": "application/pdf",
          "x-orbit-filename": encodeURIComponent("reviewed-policy.pdf"),
          "x-orbit-review-operation": operationId,
          "x-orbit-document-id": documentId,
        },
        body: syntheticPdf,
      }), itemDocumentsContext(fixture.household.id, approval.itemId));
      expect(response.status).toBe(202);
      const [pending] = await getDb().select({ status: reviewedIntakeOperations.status, attachmentState: reviewedIntakeOperations.attachmentState, documentId: reviewedIntakeOperations.documentId })
        .from(reviewedIntakeOperations).where(eq(reviewedIntakeOperations.id, operationId));
      expect(pending).toEqual({ status: "recoverable", attachmentState: "pending", documentId });

      await getDb().update(documentJobs).set({ nextAttemptAt: new Date(Date.now() - 1_000) })
        .where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "scan")));
      vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
      await runDocumentMaintenanceCycle();
      const [completed] = await getDb().select({ status: reviewedIntakeOperations.status, attachmentState: reviewedIntakeOperations.attachmentState })
        .from(reviewedIntakeOperations).where(eq(reviewedIntakeOperations.id, operationId));
      expect(completed).toEqual({ status: "completed", attachmentState: "attached" });
    });
  });

  it("terminalizes linked reviewed intake while retaining only purge failure recovery", async () => {
    const fixture = await createIntegrationFixture("reviewed-document-terminal-recovery");
    const member = await fixture.session("member");
    const operationId = randomUUID();
    const approval = await approveReviewedIntake(member.userId, {
      operationId,
      source: { kind: "direct_upload", expectedDocument: true },
      householdId: fixture.household.id,
      sectionId: fixture.section.id,
      action: "create_separate",
      item: { title: "Reviewed terminal recovery", currency: "GBP", status: "active" },
      attachmentIds: [],
    });
    const documentId = randomUUID();
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason: "unavailable" });
    await withRequiredScanMode(async () => {
      const url = `http://127.0.0.1:3000/api/households/${fixture.household.id}/items/${approval.itemId}/documents`;
      const response = await uploadDocument(requestForSession(member, url, {
        method: "POST",
        headers: {
          "content-length": String(syntheticPdf.length),
          "content-type": "application/pdf",
          "x-orbit-filename": encodeURIComponent("reviewed-terminal.pdf"),
          "x-orbit-review-operation": operationId,
          "x-orbit-document-id": documentId,
        },
        body: syntheticPdf,
      }), itemDocumentsContext(fixture.household.id, approval.itemId));
      expect(response.status).toBe(202);
      await getDb().update(documentJobs).set({ nextAttemptAt: new Date(Date.now() - 1_000) })
        .where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "scan")));
      vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "infected", signature: "synthetic-signature" });
      const purgeFailure = vi.spyOn(LocalDocumentStorage.prototype, "deleteStagingCiphertext")
        .mockRejectedValue(new Error("synthetic purge outage"));
      try {
        await runDocumentMaintenanceCycle();
      } finally {
        purgeFailure.mockRestore();
      }
      expect(await getDb().select({ lifecycle: documents.lifecycle, failureCode: documents.failureCode })
        .from(documents).where(eq(documents.id, documentId)))
        .toEqual([{ lifecycle: "rejected", failureCode: "malware_detected" }]);
      expect(await getDb().select({ status: reviewedIntakeOperations.status, attachmentState: reviewedIntakeOperations.attachmentState })
        .from(reviewedIntakeOperations).where(eq(reviewedIntakeOperations.id, operationId)))
        .toEqual([{ status: "failed", attachmentState: "pending" }]);
      expect(await getDb().select({ status: documentStagingObjects.status }).from(documentStagingObjects)
        .where(eq(documentStagingObjects.documentId, documentId)))
        .toEqual([{ status: "purge_pending" }]);
      expect(await getDb().select({ status: documentJobs.status, lastError: documentJobs.lastError })
        .from(documentJobs).where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "scan"))))
        .toEqual([{ status: "failed", lastError: "stage_purge_failed" }]);

      await runDocumentMaintenanceCycle();
      expect(await getDb().select({ documentId: documentStagingObjects.documentId }).from(documentStagingObjects)
        .where(eq(documentStagingObjects.documentId, documentId))).toHaveLength(0);
      expect(await getDb().select({ status: reviewedIntakeOperations.status, attachmentState: reviewedIntakeOperations.attachmentState })
        .from(reviewedIntakeOperations).where(eq(reviewedIntakeOperations.id, operationId)))
        .toEqual([{ status: "failed", attachmentState: "pending" }]);
      expect(scanFileWithClamAv).toHaveBeenCalledTimes(2);
    });
  });

  it("preserves synchronous clean reviewed completion and its 201 response", async () => {
    const fixture = await createIntegrationFixture("reviewed-document-clean-unchanged");
    const member = await fixture.session("member");
    const operationId = randomUUID();
    const approval = await approveReviewedIntake(member.userId, {
      operationId,
      source: { kind: "direct_upload", expectedDocument: true },
      householdId: fixture.household.id,
      sectionId: fixture.section.id,
      action: "create_separate",
      item: { title: "Reviewed clean unchanged", currency: "GBP", status: "active" },
      attachmentIds: [],
    });
    const documentId = randomUUID();
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
    await withRequiredScanMode(async () => {
      const url = `http://127.0.0.1:3000/api/households/${fixture.household.id}/items/${approval.itemId}/documents`;
      const response = await uploadDocument(requestForSession(member, url, {
        method: "POST",
        headers: {
          "content-length": String(syntheticPdf.length),
          "content-type": "application/pdf",
          "x-orbit-filename": encodeURIComponent("reviewed-clean.pdf"),
          "x-orbit-review-operation": operationId,
          "x-orbit-document-id": documentId,
        },
        body: syntheticPdf,
      }), itemDocumentsContext(fixture.household.id, approval.itemId));
      expect(response.status).toBe(201);
      const [operation] = await getDb().select({ status: reviewedIntakeOperations.status, attachmentState: reviewedIntakeOperations.attachmentState, documentId: reviewedIntakeOperations.documentId })
        .from(reviewedIntakeOperations).where(eq(reviewedIntakeOperations.id, operationId));
      expect(operation).toEqual({ status: "completed", attachmentState: "attached", documentId });
    });
  });

  it("keeps the scanner's virus signature out of every emitted record for an infected upload", async () => {
    const fixture = await createIntegrationFixture("document-scan-infected-diagnostics");
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "infected", signature: "Eicar-Test-Signature" });
    const capture = captureLogLines();
    try {
      await withRequiredScanMode(async () => {
        const { response } = await uploadWithFilename(fixture, "malware.pdf");
        expect(response.status).toBe(422);
        expect((await response.json() as { error: { code: string } }).error.code).toBe("document_malware_detected");

        const combined = capture.lines.join("\n");
        expect(combined).not.toContain("Eicar");

        const records = capture.lines.map(parseLogLine);
        const infectedScan = records.find((entry) => entry.event === "document.scan" && entry.fields.state === "exhausted");
        expect(infectedScan?.fields.reason).toBe("malware_detected");
        const rejectedLifecycle = records.find((entry) => entry.event === "document.lifecycle" && entry.fields.state === "exhausted");
        expect(rejectedLifecycle?.fields.reason).toBe("malware_detected");
      });
    } finally {
      capture.restore();
    }
  });

  it("records bounded lifecycle and job diagnostics across delete, restore and purge", async () => {
    const fixture = await createIntegrationFixture("document-worker-diagnostics");
    const { session, documentId } = await uploadSyntheticDocument(fixture);
    const downloadUrl = `http://127.0.0.1:3000/api/documents/${documentId}/download`;

    const capture = captureLogLines();
    try {
      await deleteDocument(requestForSession(session, downloadUrl, { method: "DELETE" }), documentContext(documentId));
      expect(capture.lines.map(parseLogLine).some((entry) =>
        entry.event === "document.lifecycle" && entry.fields.state === "stopping",
      )).toBe(true);

      await restoreDocumentRoute(requestForSession(session, downloadUrl + "/restore", { method: "POST" }), documentContext(documentId));
      expect(capture.lines.map(parseLogLine).some((entry) =>
        entry.event === "document.lifecycle" && entry.fields.state === "recovered",
      )).toBe(true);

      await deleteDocument(requestForSession(session, downloadUrl, { method: "DELETE" }), documentContext(documentId));
      await getDb().update(documents).set({ deleteAfter: new Date(Date.now() - 1_000) }).where(eq(documents.id, documentId));

      capture.lines.length = 0;
      await runDocumentMaintenanceCycle();
      const cycleRecords = capture.lines.map(parseLogLine);
      const claimed = cycleRecords.find((entry) => entry.event === "document.job" && entry.fields.state === "starting");
      const completed = cycleRecords.find((entry) => entry.event === "document.job" && entry.fields.state === "ready");
      expect(claimed?.fields.state).toBe("starting");
      expect(completed?.fields.state).toBe("ready");
      expect(cycleRecords.some((entry) =>
        entry.event === "document.lifecycle" && entry.fields.state === "completed",
      )).toBe(true);
    } finally {
      capture.restore();
    }
  });

  it("reclaims a job whose processing lease already expired, distinct from a fresh claim", async () => {
    const fixture = await createIntegrationFixture("document-worker-reclaim-diagnostics");
    const { session, documentId } = await uploadSyntheticDocument(fixture);
    const downloadUrl = `http://127.0.0.1:3000/api/documents/${documentId}/download`;
    await deleteDocument(requestForSession(session, downloadUrl, { method: "DELETE" }), documentContext(documentId));
    await getDb().update(documents).set({ deleteAfter: new Date(Date.now() - 1_000) }).where(eq(documents.id, documentId));
    await getDb().update(documentJobs).set({
      status: "processing",
      lockedAt: new Date(Date.now() - 20 * 60 * 1_000),
      leaseExpiresAt: new Date(Date.now() - 60_000),
      leaseToken: randomUUID(),
    }).where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "purge")));

    const capture = captureLogLines();
    try {
      await runDocumentMaintenanceCycle();
      const records = capture.lines.map(parseLogLine);
      const reclaimed = records.find((entry) => entry.event === "document.job" && entry.fields.state === "starting");
      expect(reclaimed?.fields.state).toBe("starting");
    } finally {
      capture.restore();
    }
  });

  it("emits a bounded rejected lifecycle record when reconciliation finds an available document's ciphertext missing", async () => {
    const fixture = await createIntegrationFixture("document-reconciliation-diagnostics");
    const { documentId } = await uploadSyntheticDocument(fixture);
    const [crypto] = await getDb().select({ storageKey: documentCrypto.storageKey })
      .from(documentCrypto).where(eq(documentCrypto.documentId, documentId));
    const storage = new LocalDocumentStorage(getDocumentConfig().storageRoot, getDocumentConfig().quarantineRoot);
    await storage.deleteCiphertext(crypto!.storageKey);

    const capture = captureLogLines();
    try {
      await reconcileDocumentStorage();
      const records = capture.lines.map(parseLogLine);
      const rejected = records.find((entry) =>
        entry.event === "document.lifecycle" && entry.fields.state === "exhausted",
      );
      expect(rejected?.fields.reason).toBe("storage_object_missing");
    } finally {
      capture.restore();
    }

    const [stored] = await getDb().select({ lifecycle: documents.lifecycle }).from(documents).where(eq(documents.id, documentId));
    expect(stored?.lifecycle).toBe("rejected");
  });
});
