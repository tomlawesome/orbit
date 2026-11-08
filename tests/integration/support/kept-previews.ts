import { expect, vi } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import type { createIntegrationFixture } from "./fixtures";
import { callRouteForSession, loadRoute } from "./request-event";

/**
 * What the kept-preview integration files share: routes, an upload, the worker
 * run to completion, and the preview rows and jobs read with SQL. A test file
 * using it mocks the scanner itself (`vi.mock` is per file).
 */

export const { GET: previewDocument } = await loadRoute("documents/[documentId]/preview");
export const { DELETE: deleteDocument } = await loadRoute("documents/[documentId]");
export const { POST: restoreDocumentRoute } = await loadRoute("documents/[documentId]/restore");
const { POST: uploadDocument } = await loadRoute("households/[householdId]/items/[itemId]/documents");

export type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
export type Session = Awaited<ReturnType<Fixture["session"]>>;

export const documentUrl = (documentId: string): string => `http://127.0.0.1:3000/api/documents/${documentId}`;

export async function upload(fixture: Fixture, bytes: Buffer, filename = "kept.pdf", contentType = "application/pdf") {
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
  const session = await fixture.session("member");
  const response = await callRouteForSession(uploadDocument, session, {
    url: `http://127.0.0.1:3000/api/households/${fixture.household.id}/items/${fixture.item.id}/documents`,
    method: "POST",
    headers: { "content-length": String(bytes.length), "content-type": contentType, "x-orbit-filename": encodeURIComponent(filename) },
    body: new Uint8Array(bytes),
    params: { householdId: fixture.household.id, itemId: fixture.item.id },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const payload = await response.json() as { document: { id: string } };
  return { session, documentId: payload.document.id };
}

export function askPreview(session: Session, documentId: string, page: number) {
  return callRouteForSession(previewDocument, session, {
    url: `${documentUrl(documentId)}/preview?page=${page}`,
    params: { documentId },
  });
}

export const removeDocument = (session: Session, documentId: string) =>
  callRouteForSession(deleteDocument, session, { url: documentUrl(documentId), method: "DELETE", params: { documentId } });

export const restoreDocument = (session: Session, documentId: string) =>
  callRouteForSession(restoreDocumentRoute, session, { url: `${documentUrl(documentId)}/restore`, method: "POST", params: { documentId } });

const PREVIEW_JOBS_MODULE = "@/server/document-maintenance/preview-jobs";

export async function previewWorker(): Promise<{ runPreviewWorkerOnce(): Promise<unknown> }> {
  return await import(/* @vite-ignore */ PREVIEW_JOBS_MODULE) as { runPreviewWorkerOnce(): Promise<unknown> };
}

/** Runs worker passes until one finds nothing to claim (at most `limit`). */
export async function drainPreviewWorker(limit = 50): Promise<void> {
  const worker = await previewWorker();
  for (let round = 0; round < limit; round += 1) {
    if (!await worker.runPreviewWorkerOnce()) return;
  }
}

export type PreviewRow = { page: number; status: "drawn" | "refused"; refusal: string | null; attempts: number; storage_key: string | null };

export async function previewRows(documentId: string): Promise<PreviewRow[]> {
  return await getDb().execute(sql`select page, status, refusal, attempts, storage_key from document_previews where document_id = ${documentId} order by page`) as unknown as PreviewRow[];
}

export type JobRow = { kind: string; status: string; generation: number };

export async function previewJobs(documentId: string): Promise<JobRow[]> {
  return await getDb().execute(sql`select kind::text as kind, status::text as status, generation from document_jobs where document_id = ${documentId} and kind::text = 'preview' order by generation`) as unknown as JobRow[];
}

export async function storedPageCount(documentId: string): Promise<number | null> {
  const rows = await getDb().execute(sql`select page_count from documents where id = ${documentId}`);
  return (rows[0] as { page_count: number | null }).page_count;
}

export async function errorCodeOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}
