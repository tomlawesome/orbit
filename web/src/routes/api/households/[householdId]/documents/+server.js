import { json } from "@sveltejs/kit";
import { z } from "zod";

import { AppError } from "orbit/lib/app-error";
import { uploadItemDocument } from "orbit/server/document-repository";

import { write } from "$lib/server/api.js";

/**
 * Stages a document for an item that is about to be created (#1316): the
 * create form uploads its file here first, then sends `item.upsert` with the
 * document's id, and the engine binds the two in one transaction, so an item
 * is never saved without the document the member attached. The same raw-body
 * shape as the item's own documents route, plus the draft item's id in
 * `x-orbit-item-id`: the file is sealed under it, and only that item can bind
 * it. Idempotent on `x-orbit-document-id`, which is required so a retry never
 * stores the file twice. Unbound, it is retired after about a day.
 */
export const POST = write(async (event, session) => {
  const householdId = /** @type {string} */ (event.params.householdId);
  const documentIdResult = z.uuid().safeParse(event.request.headers.get("x-orbit-document-id") ?? "");
  if (!documentIdResult.success) {
    throw new AppError("document_id_invalid", "The document identity is invalid", 422);
  }
  const itemIdResult = z.uuid().safeParse(event.request.headers.get("x-orbit-item-id") ?? "");
  if (!itemIdResult.success) {
    throw new AppError("item_id_invalid", "The item identity is invalid", 422);
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
  const document = await uploadItemDocument({
    userId: session.user.id,
    householdId,
    itemId: itemIdResult.data.toLowerCase(),
    staged: true,
    filename,
    body: event.request.body,
    declaredBytes,
    documentId: documentIdResult.data.toLowerCase(),
  });
  return json({ document }, { status: document.recoverable ? 202 : 201, headers: { "cache-control": "no-store" } });
});
