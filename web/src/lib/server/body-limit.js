/* Per-route request body limits (#1285): this module is the one gate.
 *
 * adapter-node's `BODY_SIZE_LIMIT` is one number for every route. Its 512 KB
 * default refused every document over 512 KB; since #1390 the image turns it
 * off (`BODY_SIZE_LIMIT=Infinity`, Dockerfile), because the archive routes'
 * limit follows the household quota in the configuration and a fixed image
 * value cannot. This module gives each route its own limit, so no route
 * takes a body larger than it reads, and a 100 MB body never reaches a route
 * that reads JSON:
 *
 *  - the document upload routes take the upload size limit an administrator
 *    sets (src/server/upload-limit.ts), read fresh on every request;
 *  - the portable-archive routes carry a whole household, document bytes
 *    included, as an archive file in a multipart upload read in pieces
 *    (#1566), so they get the largest archive the import accepts,
 *    `maxArchiveFileBytes` of the configuration read on every request
 *    (src/server/portable-archive-limits.ts, #1390), plus room for the
 *    fields that come before it (#1290);
 *  - every other route gets `SMALL_BODY_LIMIT`, twice the 512 KB every route
 *    has run under until now.
 *
 * A declared Content-Length over the limit is refused before a byte is
 * buffered: the 413 goes first, then the body is read and thrown away
 * (`discardBody`); adapter-node already holds a body to the length it
 * declared. A body with no declared length is counted as it streams and
 * fails at the limit. Either way the answer is a 413 in the API's own error
 * envelope, never a 500.
 */
import { AppError } from "orbit/lib/app-error";
import { DOCUMENT_MAX_BYTES_CEILING, documentHouseholdQuotaBytes } from "orbit/server/documents/config";
import { maxArchiveFileBytes } from "orbit/server/portable-archive-limits";

const MIB = 1_048_576;

export const SMALL_BODY_LIMIT = MIB;

/**
 * An archive import or preview: the largest archive file the import accepts
 * under the current configuration (the household quota plus the manifest
 * cap, sealed), and a small limit's room for the rest of the body (the
 * passphrase, the conflict list). Read per request, as the upload limit is.
 * The quota is read without the document key, so a missing key still gives
 * the route a limit; the import itself cannot run without it.
 *
 * @returns {number}
 */
export function archiveBodyLimit() {
  return maxArchiveFileBytes({ householdQuotaBytes: documentHouseholdQuotaBytes() }) + SMALL_BODY_LIMIT;
}

/** Route ids, not pathnames: the router's own truth, as hooks.server.js's gates use. */
export const UPLOAD_ROUTES = new Set([
  "/api/households/[householdId]/documents",
  "/api/households/[householdId]/item-document-preview",
  "/api/households/[householdId]/item-document-inspection",
  "/api/households/[householdId]/items/[itemId]/documents",
]);

/* A body this size is why only one archive runs at a time: archive-slot.js
   (#1316) holds these two routes and the export to one slot, claimed in
   hooks.server.js before this module's limit is applied. */
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
  if (routeId !== null && ARCHIVE_ROUTES.has(routeId)) return { limit: archiveBodyLimit(), code, message };
  return { limit: SMALL_BODY_LIMIT, code, message };
}

/** How long a body being thrown away may go without a byte before it is cut (#1390): the archive slot's stall. */
export const DISCARD_STALL_MS = 30_000;

/**
 * Reads a refused request's body to its end and throws it away, as Node does
 * for a request nobody touched. adapter-node starts reading every body itself
 * and pauses after the first chunk, so Node never does this for us: a body
 * left there stalls the connection, and a browser still sending it never
 * sees the answer (Firefox reports a network error instead). Draining costs
 * bandwidth, not memory. A sender that stops is cut once no byte has arrived
 * for `DISCARD_STALL_MS` (#1390): the body is cancelled, which under
 * adapter-node destroys the socket. Node's whole-request timeout no longer
 * bounds it (scripts/web-server.mjs turns that off). Never rejects; a
 * request with no body is left alone.
 *
 * @param {Request} request
 * @returns {Promise<void>}
 */
export function discardBody(request) {
  if (request.body === null) return Promise.resolve();
  let reader;
  try {
    reader = request.body.getReader();
  } catch {
    return Promise.resolve();
  }
  const source = reader;
  return new Promise((resolve) => {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve();
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        source.cancel().catch(() => undefined);
        finish();
      }, DISCARD_STALL_MS);
      /* A watchdog must never be what keeps the process alive. */
      timer.unref?.();
    };
    const pump = () => {
      arm();
      source.read().then(({ done }) => {
        if (finished) return;
        if (done) finish();
        else pump();
      }, finish);
    };
    pump();
  });
}

/**
 * The refusal. It is sent before the body has been read; the caller then
 * reads the rest away (`discardBody`), so the connection stays usable for the
 * client's next request and no `Connection: close` is needed.
 *
 * @param {{ code: string, message: string }} refusal
 */
export function tooLarge({ code, message }) {
  return Response.json({ error: { code, message } }, { status: 413, headers: { "Cache-Control": "no-store" } });
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
    if (!Number.isFinite(length) || length <= rule.limit) return request;
    discardBody(request);
    return tooLarge(rule);
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
