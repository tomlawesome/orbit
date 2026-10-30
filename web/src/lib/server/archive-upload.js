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
 */
import { MultipartReader, multipartBoundary, requestMalformed } from "orbit/server/multipart-reader";

import { SMALL_BODY_LIMIT } from "./body-limit.js";

/** The file part's name. */
const ARCHIVE_PART = "archive";

/**
 * Reads the upload's fields and hands them to `handle`, with a way to take
 * the archive file as a stream once the route's checks have passed. Each
 * name in `required` is a field the client always sends: a body without one
 * is not the client's shape (a field sent after the file arrives too late to
 * be read first), so it is refused as malformed, not as invalid.
 *
 * @template T
 * @param {Request} request
 * @param {string[]} required
 * @param {(fields: Record<string, string>, archiveFile: () => Promise<ReadableStream<Uint8Array>>) => Promise<T>} handle
 * @returns {Promise<T>}
 */
export async function readArchiveUpload(request, required, handle) {
  const boundary = multipartBoundary(request.headers.get("content-type")) ?? "";
  const upload = new MultipartReader(request.body, boundary, { maxFieldBytes: SMALL_BODY_LIMIT });
  try {
    const fields = await upload.fields();
    if (required.some((name) => !Object.hasOwn(fields, name))) throw requestMalformed();
    return await handle(fields, async () => {
      const part = await upload.file();
      if (part.name !== ARCHIVE_PART) throw requestMalformed();
      return part.stream;
    });
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
