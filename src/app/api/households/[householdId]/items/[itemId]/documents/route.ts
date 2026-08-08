import { NextRequest, NextResponse } from "next/server";
import { appErrorResponse, AppError } from "@/lib/app-error";
import { getAuthConfig } from "@/lib/env";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { listItemDocuments, requestDocumentDeletion, uploadItemDocument } from "@/server/document-repository";
import { authorizeDirectReviewedUpload, completeDirectReviewedUpload, markDirectReviewedUploadRecoverable, recordDirectReviewedUploadPending } from "@/server/reviewed-intake";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ householdId: string; itemId: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const session = await requireSession(request, getAuthConfig());
    const { householdId, itemId } = await context.params;
    const itemDocuments = await listItemDocuments(session.user.id, householdId, itemId);
    return NextResponse.json({ documents: itemDocuments }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return appErrorResponse(error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  let reviewedOperationId: string | undefined;
  let reviewedOperationUserId: string | undefined;
  let uploadAttempted = false;
  try {
    const config = getAuthConfig();
    const session = await requireSession(request, config);
    assertCsrf(request, session, config);
    const { householdId, itemId } = await context.params;
    const operationIdHeader = request.headers.get("x-orbit-review-operation");
    const documentIdHeader = request.headers.get("x-orbit-document-id");
    const documentIdResult = documentIdHeader ? z.uuid().safeParse(documentIdHeader) : undefined;
    if (documentIdResult && !documentIdResult.success) throw new AppError("document_id_invalid", "The document identity is invalid", 422);
    const documentId = documentIdResult?.success ? documentIdResult.data.toLowerCase() : undefined;
    if (operationIdHeader) {
      const operationIdResult = z.uuid().safeParse(operationIdHeader);
      if (!operationIdResult.success) throw new AppError("reviewed_intake_operation_invalid", "The reviewed intake operation is invalid", 422);
      const validatedOperationId = operationIdResult.data.toLowerCase();
      reviewedOperationId = validatedOperationId;
      reviewedOperationUserId = session.user.id;
      const existing = await authorizeDirectReviewedUpload(session.user.id, validatedOperationId, householdId, itemId);
      if (existing.documentId) {
        const document = (await listItemDocuments(session.user.id, householdId, itemId)).find((candidate) => candidate.id === existing.documentId);
        if (!document) throw new AppError("reviewed_intake_recoverable", "That reviewed document is not available yet", 503);
        if (document.lifecycle === "rejected") {
          throw new AppError(
            document.failureCode === "malware_detected" ? "document_malware_detected" : document.failureCode === "scanner_failed" ? "document_scanner_failed" : "document_upload_failed",
            "That document upload has already been rejected",
            document.failureCode === "scanner_failed" ? 503 : 422,
          );
        }
        return NextResponse.json({ document }, { status: document.recoverable || !document.ready ? 202 : 201, headers: { "Cache-Control": "no-store" } });
      }
    }
    const encodedFilename = request.headers.get("x-orbit-filename");
    if (!encodedFilename) throw new AppError("document_filename_required", "The document filename is required", 422);
    let filename: string;
    try {
      filename = decodeURIComponent(encodedFilename);
    } catch {
      throw new AppError("document_filename_invalid", "The document filename is invalid", 422);
    }
    const contentLengthHeader = request.headers.get("content-length");
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
      body: request.body,
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
    return NextResponse.json({ document }, {
      status: document.recoverable ? 202 : 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (reviewedOperationId && reviewedOperationUserId && uploadAttempted) {
      await markDirectReviewedUploadRecoverable(reviewedOperationUserId, reviewedOperationId, "document_upload_failed").catch(() => undefined);
    }
    return appErrorResponse(error);
  }
}
