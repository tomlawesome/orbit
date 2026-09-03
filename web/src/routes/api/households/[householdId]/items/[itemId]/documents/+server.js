import { json } from "@sveltejs/kit";
import { z } from "zod";

import { AppError } from "orbit/lib/app-error";
import { listItemDocuments, requestDocumentDeletion, uploadItemDocument } from "orbit/server/document-repository";
import {
  authorizeDirectReviewedUpload,
  completeDirectReviewedUpload,
  markDirectReviewedUploadRecoverable,
  recordDirectReviewedUploadPending,
} from "orbit/server/reviewed-intake";

import { DOCUMENTS_FIXTURE } from "$lib/data/fixtures/workspace.js";
import { read, write } from "$lib/server/api.js";

export const GET = read(
  async (event, session) => {
    const householdId = /** @type {string} */ (event.params.householdId);
    const itemId = /** @type {string} */ (event.params.itemId);
    const documents = await listItemDocuments(session.user.id, householdId, itemId);
    return json({ documents }, { headers: { "cache-control": "no-store" } });
  },
  {
    fixture: (event) => json(
      { documents: DOCUMENTS_FIXTURE[event.params.itemId] ?? [] },
      { headers: { "cache-control": "no-store" } },
    ),
  },
);

/**
 * Uploads a document, standing alone or completing a reviewed-intake
 * operation begun elsewhere (#735 port).
 *
 * The recoverable-failure bookkeeping on the reviewed-intake path only fires
 * once an upload was actually attempted — a validation error before that
 * point (bad filename, bad size) never touched the operation, so marking it
 * recoverable would misreport an operation that never started.
 */
export const POST = write(async (event, session) => {
  let reviewedOperationId;
  let reviewedOperationUserId;
  let uploadAttempted = false;
  try {
    const householdId = /** @type {string} */ (event.params.householdId);
    const itemId = /** @type {string} */ (event.params.itemId);
    const operationIdHeader = event.request.headers.get("x-orbit-review-operation");
    const documentIdHeader = event.request.headers.get("x-orbit-document-id");
    const documentIdResult = documentIdHeader ? z.uuid().safeParse(documentIdHeader) : undefined;
    if (documentIdResult && !documentIdResult.success) {
      throw new AppError("document_id_invalid", "The document identity is invalid", 422);
    }
    const documentId = documentIdResult?.success ? documentIdResult.data.toLowerCase() : undefined;
    if (operationIdHeader) {
      const operationIdResult = z.uuid().safeParse(operationIdHeader);
      if (!operationIdResult.success) {
        throw new AppError("reviewed_intake_operation_invalid", "The reviewed intake operation is invalid", 422);
      }
      const validatedOperationId = operationIdResult.data.toLowerCase();
      reviewedOperationId = validatedOperationId;
      reviewedOperationUserId = session.user.id;
      const existing = await authorizeDirectReviewedUpload(session.user.id, validatedOperationId, householdId, itemId);
      if (existing.documentId) {
        const document = (await listItemDocuments(session.user.id, householdId, itemId)).find(
          (candidate) => candidate.id === existing.documentId,
        );
        if (!document) throw new AppError("reviewed_intake_recoverable", "That reviewed document is not available yet", 503);
        if (document.lifecycle === "rejected") {
          throw new AppError(
            document.failureCode === "malware_detected"
              ? "document_malware_detected"
              : document.failureCode === "scanner_failed"
                ? "document_scanner_failed"
                : "document_upload_failed",
            "That document upload has already been rejected",
            document.failureCode === "scanner_failed" ? 503 : 422,
          );
        }
        return json(
          { document },
          { status: document.recoverable || !document.ready ? 202 : 201, headers: { "cache-control": "no-store" } },
        );
      }
    }
    const encodedFilename = event.request.headers.get("x-orbit-filename");
    if (!encodedFilename) throw new AppError("document_filename_required", "The document filename is required", 422);
    let filename;
    try {
      filename = decodeURIComponent(encodedFilename);
    } catch {
      throw new AppError("document_filename_invalid", "The document filename is invalid", 422);
    }
    const contentLengthHeader = event.request.headers.get("content-length");
    const declaredBytes = contentLengthHeader ? Number(contentLengthHeader) : undefined;
    if (declaredBytes !== undefined && (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0)) {
      throw new AppError("document_size_invalid", "The document size is invalid", 422);
    }
    uploadAttempted = true;
    const document = await uploadItemDocument({
      userId: session.user.id,
      householdId,
      itemId,
      filename,
      body: event.request.body,
      declaredBytes,
      documentId,
    });
    if (reviewedOperationId) {
      try {
        if (document.recoverable) {
          await recordDirectReviewedUploadPending(session.user.id, reviewedOperationId, householdId, itemId, document.id, document.failureCode);
        } else {
          await completeDirectReviewedUpload(session.user.id, reviewedOperationId, householdId, itemId, document.id);
        }
      } catch (error) {
        if (!document.recoverable) await requestDocumentDeletion(session.user.id, document.id).catch(() => undefined);
        throw error;
      }
    }
    return json({ document }, { status: document.recoverable ? 202 : 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (reviewedOperationId && reviewedOperationUserId && uploadAttempted) {
      await markDirectReviewedUploadRecoverable(reviewedOperationUserId, reviewedOperationId, "document_upload_failed").catch(() => undefined);
    }
    throw error;
  }
});
