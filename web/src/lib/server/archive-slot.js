/* One archive at a time (#1316; owner, 2026-10-15).
 *
 * An archive preview or import parses the whole JSON body, up to
 * ARCHIVE_BODY_LIMIT (body-limit.js), and an export holds the plaintext, the
 * ciphertext and its base64 at once: one request peaks over 1 GB. Orbit is
 * one Node process (Dockerfile), so a few of those in parallel from any
 * signed-in member exhausted its memory.
 *
 * The standard shape: a one-slot bulkhead with fail-fast admission. The
 * three routes share one slot for the whole process; a request that finds it
 * taken is refused at once with a 429, rather than queued behind it, and its
 * body is never buffered: read and thrown away after the answer, so the
 * browser still sending it sees the 429 (body-limit.js's `discardBody`). The
 * caller (hooks.server.js) frees the slot however its request ends.
 *
 * A holder that stops sending would keep the slot for good, so its body is
 * watched as it streams, as nginx's client_body_timeout does: it fails with a
 * 408 when no byte arrives for the stall time, or when it is still arriving
 * at the deadline (Node's own requestTimeout, five minutes). The cut errors
 * only the watched copy, so the route answers its 408; the source is not
 * cancelled (adapter-node would tear the connection down before that answer
 * went out) but read away to its end, like a refused body.
 */
import { env } from "$env/dynamic/private";
import { AppError } from "orbit/lib/app-error";
import { discardBody } from "./body-limit.js";

/** Route ids, not pathnames, as body-limit.js's sets are. POST only: a download stays out. */
export const ARCHIVE_SLOT_ROUTES = new Set([
  "/api/portable-archives/preview",
  "/api/portable-archives/import",
  "/api/households/[householdId]/portable-archives",
]);

export const ARCHIVE_BUSY_CODE = "archive_busy";
export const ARCHIVE_BUSY_RETRY_AFTER_SECONDS = 60;
export const ARCHIVE_BODY_TIMED_OUT_CODE = "request_timeout";
export const ARCHIVE_BODY_STALL_MS = 30_000;
export const ARCHIVE_BODY_DEADLINE_MS = 300_000;

/* The browser shows both verbatim (DeskArchive.svelte, PocketArchive.svelte).
   Both are the owner's words (2026-10-15); the busy one is generic, since
   the other request may be an export as well as an import. */
export const ARCHIVE_BUSY_MESSAGE = "Orbit’s processing another request right now, please try again in a few minutes.";
export const ARCHIVE_BODY_TIMED_OUT_MESSAGE = "The archive failed to upload, please try again.";

/**
 * The one holder's token, or null. One per process: see docs/architecture.md.
 * @type {object | null}
 */
let holder = null;

/** Whether the slot is taken (for tests). */
export function archiveSlotHeld() {
  return holder !== null;
}

/**
 * The refusal. Like body-limit.js's 413 it is sent before the body is read;
 * holdArchiveSlot then reads the body away, so the connection stays usable
 * and no `Connection: close` is needed.
 */
export function archiveBusy() {
  return Response.json(
    { error: { code: ARCHIVE_BUSY_CODE, message: ARCHIVE_BUSY_MESSAGE } },
    {
      status: 429,
      headers: { "Retry-After": String(ARCHIVE_BUSY_RETRY_AFTER_SECONDS), "Cache-Control": "no-store" },
    },
  );
}

/** @param {number | undefined} given @param {string | undefined} configured @param {number} fallback */
function milliseconds(given, configured, fallback) {
  if (given !== undefined) return given;
  const parsed = Number(configured);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Takes the slot for one archive request: null when the request is not one
 * (another route, not a POST, no body), the 429 when the slot is taken, or the
 * request to carry on with, its body under the watchdog, and the release the
 * caller must call however the request ends. Releasing twice is harmless.
 * Throws, leaving the slot free, if the body cannot be watched (already read).
 *
 * @param {string | null} routeId
 * @param {Request} request
 * @param {{ stallMs?: number, deadlineMs?: number }} [options]
 * @returns {null | Response | { request: Request, release(): void }}
 */
export function holdArchiveSlot(routeId, request, { stallMs, deadlineMs } = {}) {
  if (routeId === null || !ARCHIVE_SLOT_ROUTES.has(routeId)) return null;
  if (request.method !== "POST" || request.body === null) return null;
  if (holder !== null) {
    discardBody(request);
    return archiveBusy();
  }

  const stall = milliseconds(stallMs, env.ORBIT_ARCHIVE_BODY_STALL_MS, ARCHIVE_BODY_STALL_MS);
  const deadline = milliseconds(deadlineMs, env.ORBIT_ARCHIVE_BODY_DEADLINE_MS, ARCHIVE_BODY_DEADLINE_MS);

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let stallTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let deadlineTimer;
  const stop = () => {
    clearTimeout(stallTimer);
    clearTimeout(deadlineTimer);
  };
  /* unref: a watchdog must never be what keeps the process alive. */
  /** @param {number} ms @param {() => void} fire */
  const after = (ms, fire) => {
    const timer = setTimeout(fire, ms);
    timer.unref?.();
    return timer;
  };

  /** @type {TransformStreamDefaultController} */
  let body;
  const timedOut = () => {
    stop();
    body.error(new AppError(ARCHIVE_BODY_TIMED_OUT_CODE, ARCHIVE_BODY_TIMED_OUT_MESSAGE, 408));
  };
  /* limitRequestBody's counted stream, but piped by hand: pipeThrough would
     cancel the source when the watchdog errors the copy, and gives no handle
     on when the pipe lets go of the source so it can be read away. The lock
     check is pipeThrough's own; pipeTo would only reject. */
  if (request.body.locked) throw new TypeError("The archive request's body is already being read");
  const transform = new TransformStream({
    start(controller) {
      body = controller;
      stallTimer = after(stall, timedOut);
      deadlineTimer = after(deadline, timedOut);
    },
    transform(chunk, controller) {
      clearTimeout(stallTimer);
      stallTimer = after(stall, timedOut);
      controller.enqueue(chunk);
    },
    flush: stop,
  });
  const watched = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: transform.readable,
    signal: request.signal,
    // @ts-expect-error -- Node's fetch needs `duplex` for a streamed body; the DOM types lag.
    duplex: "half",
  });
  /* The pipe fails when the watchdog cuts the copy, the route stops reading it
     or the client goes away; whichever, what is left of the source is read
     away rather than left paused. */
  request.body.pipeTo(transform.writable, { preventCancel: true }).catch(() => discardBody(request));

  /* Last, so anything above that throws leaves the slot free. */
  const token = {};
  holder = token;
  return {
    request: watched,
    release() {
      stop();
      if (holder === token) holder = null;
    },
  };
}
