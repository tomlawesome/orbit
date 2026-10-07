/* Per-route request body limits (#1285): one generous server-wide ceiling,
 * and a tighter limit for each route chosen in the request pipeline.
 *
 * adapter-node's `BODY_SIZE_LIMIT` is one number for every route. Its 512 KB
 * default refused every document over 512 KB, so the image sets it to the
 * largest body any route may take (`SERVER_BODY_LIMIT`, Dockerfile). This
 * module then gives each route its own, smaller limit, so raising the
 * server-wide one does not let a 100 MB body reach a route that reads JSON:
 *
 *  - the document upload routes take the upload size limit an administrator
 *    sets (src/server/upload-limit.ts), read fresh on every request;
 *  - the portable-archive routes carry a whole household as JSON, document
 *    bytes included, so they get the server-wide ceiling;
 *  - every other route gets `SMALL_BODY_LIMIT`, twice the 512 KB every route
 *    has run under until now.
 *
 * A declared Content-Length over the limit is refused before a byte is read;
 * adapter-node already holds a body to the length it declared. A body with no
 * declared length is counted as it streams and fails at the limit. Either way
 * the answer is a 413 in the API's own error envelope, never a 500.
 */
import { AppError } from "orbit/lib/app-error";
import { DOCUMENT_MAX_BYTES_CEILING } from "orbit/server/documents/config";

export const SMALL_BODY_LIMIT = 1_048_576;

/** Must match the image's `BODY_SIZE_LIMIT=101M` (Dockerfile): 100 MiB + 1 MiB. */
export const SERVER_BODY_LIMIT = DOCUMENT_MAX_BYTES_CEILING + SMALL_BODY_LIMIT;

/** Route ids, not pathnames: the router's own truth, as hooks.server.js's gates use. */
export const UPLOAD_ROUTES = new Set([
  "/api/households/[householdId]/item-document-preview",
  "/api/households/[householdId]/item-document-inspection",
  "/api/households/[householdId]/items/[itemId]/documents",
]);

export const ARCHIVE_ROUTES = new Set([
  "/api/portable-archives/preview",
  "/api/portable-archives/import",
]);

const DOCUMENT_TOO_LARGE = ["document_too_large", "That document exceeds the configured size limit"];
const REQUEST_TOO_LARGE = ["request_too_large", "That request is too large"];

/**
 * The limit for one route, and the code an over-limit body is refused with.
 *
 * @param {string | null} routeId
 * @param {() => Promise<number>} readUploadLimit
 * @returns {Promise<{ limit: number, code: string, message: string }>}
 */
export async function bodyLimitFor(routeId, readUploadLimit) {
  if (routeId !== null && UPLOAD_ROUTES.has(routeId)) {
    const [code, message] = DOCUMENT_TOO_LARGE;
    try {
      return { limit: await readUploadLimit(), code, message };
    } catch {
      /* The upload path reads the limit again itself and refuses on it, so
         an early answer that cannot be had here only means the refusal
         comes from the route rather than from this check. */
      return { limit: DOCUMENT_MAX_BYTES_CEILING, code, message };
    }
  }
  const [code, message] = REQUEST_TOO_LARGE;
  if (routeId !== null && ARCHIVE_ROUTES.has(routeId)) return { limit: SERVER_BODY_LIMIT, code, message };
  return { limit: SMALL_BODY_LIMIT, code, message };
}

/**
 * The refusal. It is sent before the body has been read, so the rest of that
 * body is still on its way: `Connection: close` tells the client not to send
 * its next request down the same connection behind it, which it would
 * otherwise find hung up.
 *
 * @param {{ code: string, message: string }} refusal
 */
export function tooLarge({ code, message }) {
  return Response.json({ error: { code, message } }, { status: 413, headers: { "Cache-Control": "no-store", Connection: "close" } });
}

/**
 * Holds one request's body to its limit: a Response refusing it, or the
 * request to carry on with — the same one, or one whose body is counted as it
 * streams when no length was declared.
 *
 * @param {Request} request
 * @param {{ limit: number, code: string, message: string }} rule
 * @returns {Response | Request}
 */
export function limitRequestBody(request, rule) {
  if (request.body === null) return request;
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    return Number.isFinite(length) && length > rule.limit ? tooLarge(rule) : request;
  }
  let seen = 0;
  const counted = request.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > rule.limit) controller.error(new AppError(rule.code, rule.message, 413));
      else controller.enqueue(chunk);
    },
  }));
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: counted,
    signal: request.signal,
    // @ts-expect-error -- Node's fetch needs `duplex` for a streamed body; the DOM types lag.
    duplex: "half",
  });
}
