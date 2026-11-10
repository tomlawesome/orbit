/* The archive upload the preview and import routes take (#1566).
 *
 * A streaming file upload: `multipart/form-data` with the small fields
 * first and the archive file last, as the part named `archive`. The route
 * reads the fields, validates them and runs its access checks while the body
 * is paused at the file part, and only then lets the file flow, in pieces,
 * into the repository; nothing of it is held whole. Anything but the
 * client's own shape is refused as `request_malformed`
 * (orbit/server/multipart-reader).
 *
 * Whatever the outcome, what is left of the body is read away after the
 * answer, so a refusal goes out before the file is read and the connection
 * can still answer the client's next request (the body is locked, so
 * hooks.server.js's drainUnread leaves it to this).
 *
 * Since #1792 the file is taken in whole to a spool file before anything
 * processes it (`spoolThenProcess`), so the one archive slot is held only
 * while the server works, never while the client sends (archive-slot.js).
 */
import { MultipartReader, multipartBoundary, requestMalformed } from "orbit/server/multipart-reader";
import { spoolPortableArchiveUpload } from "orbit/server/portable-archive-repository";

import { archiveBusy, awaitArchiveSlot, claimUploadLane } from "./archive-slot.js";
import { archiveBodyLimit, SMALL_BODY_LIMIT } from "./body-limit.js";

/** The file part's name. */
const ARCHIVE_PART = "archive";

/**
 * Reads the upload's fields and hands them to `handle`, with a way to take
 * the archive file as a stream once the route's checks have passed. A field
 * the body leaves out is simply absent from `fields`, so the route's schema
 * refuses it as it refuses any bad value (422 `validation_failed`); the
 * body's structure (no file part, a file part named otherwise, a field after
 * the file) is refused as malformed.
 *
 * @template T
 * @param {Request} request
 * @param {(fields: Record<string, string>, archiveFile: () => Promise<ReadableStream<Uint8Array>>) => Promise<T>} handle
 * @returns {Promise<T>}
 */
export async function readArchiveUpload(request, handle) {
  const boundary = multipartBoundary(request.headers.get("content-type")) ?? "";
  const upload = new MultipartReader(request.body, boundary, { maxFieldBytes: SMALL_BODY_LIMIT });
  try {
    const fields = await upload.fields();
    /* The part's name is in its headers, read with the fields: a wrong one is
       refused here, before the route's checks (the import's step-up spends the
       person's proof) run. */
    if ((await upload.fileName()) !== ARCHIVE_PART) throw requestMalformed();
    return await handle(fields, async () => (await upload.file()).stream);
  } finally {
    /* On the next turn, so the answer is on its way before any more of the
       body is pulled; on success there is nothing left to read. */
    setTimeout(() => void upload.dispose(), 0);
  }
}

/**
 * A field that carries JSON (the import's `conflictItemIds`), parsed; text
 * that is not JSON is left as it is, so the route's schema refuses it as it
 * refuses any other value of the wrong type.
 *
 * @param {string | undefined} text
 * @returns {unknown}
 */
export function jsonField(text) {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * How much the client says it is sending: its Content-Length when that is a
 * non-negative whole number, the archive body limit when it says nothing (or
 * nonsense), so the spool's disk check never assumes a small file.
 *
 * @param {Request} request
 * @returns {number}
 */
export function declaredBytes(request) {
  const header = request.headers.get("content-length");
  const length = header === null || header.trim() === "" ? Number.NaN : Number(header);
  return Number.isSafeInteger(length) && length >= 0 ? length : archiveBodyLimit();
}

/**
 * The upload's steps after the route's own checks (#1792): take the
 * account's upload lane (a 429 when it already has one in flight), spool the
 * file whole, wait for the archive slot (a 429 when the wait runs out), hand
 * `process` the spooled file as a stream, then release the slot, remove the
 * spool file and release the lane, in that order, however it ends.
 *
 * @param {Request} request
 * @param {string} userId
 * @param {() => Promise<ReadableStream<Uint8Array>>} archiveFile
 * @param {(archive: ReadableStream<Uint8Array>) => Promise<Response>} process
 * @returns {Promise<Response>}
 */
export async function spoolThenProcess(request, userId, archiveFile, process) {
  const lane = claimUploadLane(userId);
  if (lane === null) return archiveBusy();
  try {
    const spooled = await spoolPortableArchiveUpload(await archiveFile(), declaredBytes(request));
    try {
      const slot = await awaitArchiveSlot(request);
      if (slot === null) return archiveBusy();
      try {
        return await process(spooled.stream());
      } finally {
        slot.release();
      }
    } finally {
      await spooled.dispose().catch(() => undefined);
    }
  } finally {
    lane.release();
  }
}
