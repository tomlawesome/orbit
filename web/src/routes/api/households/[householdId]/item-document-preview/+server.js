import { AppError, appErrorResponse } from "orbit/lib/app-error";
import { previewItemDocument } from "orbit/server/item-document-preview";

import { placeholderPageSvg } from "$lib/server/document-content-fixture.js";
import { write } from "$lib/server/api.js";

/**
 * Page one of a file the create form has just been given, before it belongs
 * to any item (#1245; the render is #476's).
 *
 * The body streams straight through to `previewItemDocument`, exactly as
 * the sibling inspection route streams to `inspectItemDocument` — filename
 * and declared size travel as headers because the body is the raw file.
 * Nothing is kept: the form uploads the file again onto the item it saves.
 *
 * ADR-0033 step 5: the virus check comes first and the reader is told when
 * it is done, then that Orbit has moved on to the preview. So the answer is
 * NDJSON, one JSON object per line, written as each stage ends:
 *
 *   {"stage":"scanned","scanned":true}   the scan passed ("false" where the
 *                                        instance has scanning off, so the
 *                                        lane says "scanned clean" only
 *                                        when something scanned it)
 *   {"stage":"preview","mediaType":"image/png","bytes":"<base64>"}
 *   or {"error":{"code":"...","message":"..."}}   if drawing failed
 *
 * Anything refused before the scan has finished — the session, the name,
 * the size, the type, malware, a scanner that is down — is still the
 * ordinary JSON error with its own status, because no line has been written
 * yet. The stream is private, never cached and never sniffed, since the
 * bytes on its last line are derived from private document content.
 */
const STREAM_HEADERS = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

const encoder = new TextEncoder();

/** @param {unknown} value */
const line = (value) => encoder.encode(`${JSON.stringify(value)}\n`);

/**
 * A failure after the stream has started, as its last line: an AppError's
 * own code and words, anything else the shared envelope's generic ones
 * (which also logs it), never internal error text.
 * @param {unknown} error
 */
async function errorLine(error) {
  if (error instanceof AppError) return { error: { code: error.code, message: error.message } };
  const body = await appErrorResponse(error).json().catch(() => null);
  const envelope = body?.error;
  if (envelope && typeof envelope.code === "string" && typeof envelope.message === "string") {
    return { error: { code: envelope.code, message: envelope.message } };
  }
  return { error: { code: "internal_error", message: "Orbit could not complete the request" } };
}

/** @param {Uint8Array} bytes */
const base64 = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

export const POST = write(
  async (event, session) => {
    const householdId = /** @type {string} */ (event.params.householdId);
    const encodedFilename = event.request.headers.get("x-orbit-filename");
    if (!encodedFilename) throw new AppError("document_filename_required", "The document filename is required", 422);
    try {
      decodeURIComponent(encodedFilename);
    } catch {
      throw new AppError("document_filename_invalid", "The document filename is invalid", 422);
    }
    const declaredHeader = event.request.headers.get("x-orbit-declared-bytes");
    const declaredBytes = declaredHeader ? Number(declaredHeader) : undefined;
    if (declaredBytes !== undefined && (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0)) {
      throw new AppError("document_size_invalid", "The document size is invalid", 422);
    }

    /** @type {(scanned: boolean) => void} */
    let markScanned = () => {};
    /** @type {Promise<boolean>} */
    const scannedOnce = new Promise((resolve) => {
      markScanned = resolve;
    });
    const preview = previewItemDocument({
      userId: session.user.id,
      householdId,
      body: event.request.body,
      declaredBytes,
      onScanned: (scanned) => markScanned(scanned),
    });
    /* Whichever comes first. A refusal before the scan has passed rejects
       here, and `write` answers it as the ordinary JSON error. onScanned
       always fires before the preview can resolve, so the second branch is
       only a guard. */
    const scanned = await Promise.race([scannedOnce, preview.then((page) => page.scanned)]);

    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        const send = (/** @type {unknown} */ value) => {
          if (!cancelled) controller.enqueue(line(value));
        };
        send({ stage: "scanned", scanned });
        preview
          .then(
            (page) => {
              try {
                send({ stage: "preview", mediaType: page.mediaType, bytes: base64(page.bytes) });
              } finally {
                page.bytes.fill(0);
              }
            },
            async (error) => send(await errorLine(error)),
          )
          .catch(() => undefined)
          .finally(() => {
            if (!cancelled) controller.close();
          });
      },
      cancel() {
        /* The reader went away (a new pick, "not this one"); the preview
           still settles, and its bytes are still zeroed above. */
        cancelled = true;
      },
    });
    return new Response(body, { status: 200, headers: STREAM_HEADERS });
  },
  {
    /* No engine behind ORBIT_FIXTURES=1 (#1141's rule for the sibling
       preview routes): a placeholder page in the same NDJSON shape, so the
       fixture harness's lane lands a sheet rather than a 500. Nothing was
       scanned, so the first line says so. */
    fixture: (event) => {
      let name = "document";
      try {
        name = decodeURIComponent(event.request.headers.get("x-orbit-filename") ?? "document");
      } catch {
        /* an undecodable name is still a page */
      }
      const svg = Buffer.from(placeholderPageSvg(name), "utf8").toString("base64");
      const text = `${JSON.stringify({ stage: "scanned", scanned: false })}\n`
        + `${JSON.stringify({ stage: "preview", mediaType: "image/svg+xml", bytes: svg })}\n`;
      return new Response(text, { status: 200, headers: STREAM_HEADERS });
    },
  },
);
