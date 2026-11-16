/* One archive at a time (#1316; owner, 2026-10-15), and an upload never
 * holds that one (#1792).
 *
 * An archive preview or import once parsed the whole JSON body, and an
 * export held the plaintext, the ciphertext and its base64 at once: one
 * request peaked over 1 GB. Orbit is one Node process (Dockerfile), so a few
 * of those in parallel from any signed-in member exhausted its memory.
 * Preview and import now read the upload in pieces (#1566) and a v2 archive
 * is verified a segment at a time (#1390), but a v1 archive still decrypts
 * into a scratch tmpfs sized for one archive (docker-compose.yml), and every
 * import restores its documents through the document path, which is
 * one-at-a-time; so one at a time it stays.
 *
 * The slot bounds processing, not the upload (#1792). A preview or import
 * first takes its archive file in whole, to a spool file on the document
 * volume (`spoolPortableArchiveUpload`), and only then claims the slot, for
 * the decrypting, checking and restoring: server time, bounded by the file's
 * size, never by the client's link speed. Before, the slot was held while the
 * file arrived, so one signed-in owner sending slowly made every other
 * household's export, preview and import a 429 for as long as they liked.
 *
 * The lane bounds uploads per account: while an account has a preview or
 * import spooling or processing, its next one is refused at once with the
 * same 429 as a busy slot (`claimUploadLane`). Different accounts spool side
 * by side; each spool is bounded by the body limit and the disk preflight.
 *
 * The wait: a spooled request that finds the slot held does not fail at
 * once, since a 429 then would cost the person the whole upload again. It
 * queues, first come first served, for up to the slot wait (10 minutes,
 * `ORBIT_ARCHIVE_SLOT_WAIT_MS`), and a release hands the slot straight to the
 * request that has waited longest (`awaitArchiveSlot`). A wait that runs out
 * is the 429 and its spool file is removed. The export's body is small JSON,
 * so it still claims the slot directly and is refused at once when it is
 * held (`claimArchiveSlot`): waiting is for bodies already on disk.
 *
 * The slot is the standard one-slot bulkhead; a request refused with a 429
 * never has its body buffered: it is read and thrown away after the answer,
 * so the browser still sending it sees the 429 (body-limit.js's
 * `discardBody`). The route that claimed the slot or the lane frees it
 * however its request ends.
 *
 * Since the #1390 review (ruling 4) the slot is claimed by the route, only
 * once the household role check has passed, and the lane likewise (after the
 * import's step-up too): a signed-in person with no right to the household
 * never holds either, so their unfinished request cannot make the owner's a
 * 429. The hook (hooks.server.js) only watches the body.
 *
 * A sender that stops would hold its spool for good, so the body is watched
 * as it streams, as nginx's client_body_timeout does: it fails with a 408
 * when the route has asked for bytes and none arrives for the stall time;
 * the spool then removes its file. The stall clock runs only while the route
 * is waiting for the client (ruling 2): while the route is not pulling --
 * writing a piece to the spool, as before #1792 it was scanning, checking or
 * decrypting a document -- nothing can arrive through the watched
 * stream however fast the client sends (the bytes wait in the socket), so
 * that time is the server's, not the client's, and is not counted. The clock
 * starts when a read is outstanding and stops when it is answered. There is
 * no whole-request deadline (#1390): an archive is a household, gigabytes on
 * a slow link, and a body that keeps moving is never cut
 * (scripts/web-server.mjs turns Node's own requestTimeout off for the same
 * reason, and its rate floor skips the windows in which the server paused
 * the socket). The cut errors only the watched copy, so the route answers
 * its 408; the source is not cancelled (adapter-node would tear the
 * connection down before that answer went out) but read away to its end,
 * like a refused body.
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
/** How long a spooled upload waits for the slot before its 429 (#1792). */
export const ARCHIVE_SLOT_WAIT_MS = 600_000;

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
/**
 * Requests whose slot holdArchiveSlot took, mapped to that claim's token.
 * @type {WeakMap<Request, object>}
 */
const heldRequests = new WeakMap();
/**
 * Spooled uploads waiting for the slot, longest first (#1792).
 * @type {Array<{ hand(token: object): void }>}
 */
const waiting = [];
/**
 * Each account's upload in flight, by user id, to its lane token (#1792).
 * @type {Map<string, object>}
 */
const lanes = new Map();

/** Whether the slot is taken (for tests). */
export function archiveSlotHeld() {
  return holder !== null;
}

/** Whether this account has a preview or import upload in flight (for tests). */
export function uploadLaneHeld(/** @type {string} */ userId) {
  return lanes.has(userId);
}

/**
 * The account's one upload lane, or null when it already has a preview or
 * import spooling or processing (#1792). The route takes it after its access
 * checks and before it reads a byte of the file, and must call `release`
 * however it ends; releasing twice is harmless.
 *
 * @param {string} userId
 * @returns {null | { release(): void }}
 */
export function claimUploadLane(userId) {
  if (lanes.has(userId)) return null;
  const token = {};
  lanes.set(userId, token);
  return {
    release() {
      if (lanes.get(userId) === token) lanes.delete(userId);
    },
  };
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
 * Whether this is an archive request the slot governs: one of the three
 * routes, a POST, with a body.
 *
 * @param {string | null} routeId
 * @param {Request} request
 */
export function isArchiveSlotRequest(routeId, request) {
  return routeId !== null && ARCHIVE_SLOT_ROUTES.has(routeId) && request.method === "POST" && request.body !== null;
}

/**
 * Takes the one slot, or answers null when another archive request holds it.
 * The route calls this after its household role check (ruling 4) and must
 * call `release` however it ends; releasing twice is harmless. A request
 * whose slot `holdArchiveSlot` already took (a caller that claims before the
 * route, as the tests do) keeps that claim: its release stays with the
 * holder, so the route's own release does nothing.
 *
 * @param {Request} [request]
 * @returns {null | { release(): void }}
 */
export function claimArchiveSlot(request) {
  if (request !== undefined && heldRequests.has(request) && holder === heldRequests.get(request)) {
    return { release() {} };
  }
  const token = takeSlot();
  return token === null ? null : claimOf(token);
}

/**
 * The slot for a request whose upload is already spooled (#1792): at once
 * when it is free, otherwise once every request queued before it has had it,
 * or null when the slot wait runs out first (or the client goes away). The
 * caller must call `release` however it ends; releasing twice is harmless.
 * A request whose slot `holdArchiveSlot` already took keeps that claim, as
 * with `claimArchiveSlot`.
 *
 * `until` is a second way out, wired as the request's own signal is: when it
 * aborts the waiter leaves the queue and resolves null (#1797); already
 * aborted, the answer is null at once, even if the slot is free.
 *
 * @param {Request} [request]
 * @param {{ waitMs?: number, until?: AbortSignal }} [options]
 * @returns {Promise<null | { release(): void }>}
 */
export function awaitArchiveSlot(request, { waitMs, until } = {}) {
  if (request !== undefined && heldRequests.has(request) && holder === heldRequests.get(request)) {
    return Promise.resolve({ release() {} });
  }
  if (until?.aborted) return Promise.resolve(null);
  const token = waiting.length === 0 ? takeSlot() : null;
  if (token !== null) return Promise.resolve(claimOf(token));
  const wait = milliseconds(waitMs, env.ORBIT_ARCHIVE_SLOT_WAIT_MS, ARCHIVE_SLOT_WAIT_MS);
  return new Promise((resolve) => {
    const signal = request?.signal;
    const leave = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", leave);
      until?.removeEventListener("abort", leave);
      const at = waiting.indexOf(waiter);
      if (at !== -1) waiting.splice(at, 1);
      resolve(null);
    };
    const waiter = {
      hand(/** @type {object} */ given) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", leave);
        until?.removeEventListener("abort", leave);
        resolve(claimOf(given));
      },
    };
    const timer = setTimeout(leave, wait);
    /* unref: a waiting request must never be what keeps the process alive. */
    timer.unref?.();
    signal?.addEventListener("abort", leave, { once: true });
    until?.addEventListener("abort", leave, { once: true });
    waiting.push(waiter);
  });
}

/** The claim on `token`: its release frees the slot, or hands it to the longest waiter. @param {object} token */
function claimOf(token) {
  return {
    release() {
      releaseSlot(token);
    },
  };
}

/** @param {object} token */
function releaseSlot(token) {
  if (holder !== token) return;
  holder = null;
  const next = waiting.shift();
  if (next === undefined) return;
  const handed = /** @type {object} */ (takeSlot());
  next.hand(handed);
}

/** The new holder's token, or null when the slot is taken. */
function takeSlot() {
  if (holder !== null) return null;
  const token = {};
  holder = token;
  return token;
}

/**
 * The request with its body under the stall watchdog: a copy whose body
 * fails with a 408 once the route has waited the stall time for a byte that
 * does not come. Only time spent waiting is counted (see the top of this
 * file). The watched body is pulled on demand (high-water mark 0), so nothing
 * is read ahead of the route and a read is outstanding only while the route
 * itself is waiting. Throws if the body is already being read.
 *
 * @param {Request} request
 * @param {{ stallMs?: number }} [options]
 * @returns {Request}
 */
export function watchArchiveBody(request, { stallMs } = {}) {
  if (request.body === null) return request;
  if (request.body.locked) throw new TypeError("The archive request's body is already being read");
  const stall = milliseconds(stallMs, env.ORBIT_ARCHIVE_BODY_STALL_MS, ARCHIVE_BODY_STALL_MS);
  const source = request.body.getReader();

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let stallTimer;
  /* Set once the watched copy has ended, failed or been let go. */
  let finished = false;
  /* The route is done with the copy (a 408, a cancel): what is left of the
     source is read away rather than left paused. A read still outstanding
     is let go with the lock. */
  const letGo = () => {
    clearTimeout(stallTimer);
    if (finished) return;
    finished = true;
    try {
      source.releaseLock();
    } catch {
      return;
    }
    discardBody(request);
  };

  const watched = new ReadableStream({
    async pull(controller) {
      /* The route is waiting for the client: only now does the clock run. */
      stallTimer = setTimeout(() => {
        if (finished) return;
        controller.error(new AppError(ARCHIVE_BODY_TIMED_OUT_CODE, ARCHIVE_BODY_TIMED_OUT_MESSAGE, 408));
        letGo();
      }, stall);
      /* unref: a watchdog must never be what keeps the process alive. */
      stallTimer.unref?.();
      /** @type {ReadableStreamReadResult<Uint8Array>} */
      let next;
      try {
        next = await source.read();
      } catch (error) {
        clearTimeout(stallTimer);
        if (!finished) {
          finished = true;
          controller.error(error);
        }
        return;
      } finally {
        clearTimeout(stallTimer);
      }
      if (finished) return;
      if (next.done) {
        finished = true;
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    cancel() {
      letGo();
    },
  }, { highWaterMark: 0 });

  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: watched,
    signal: request.signal,
    // @ts-expect-error -- Node's fetch needs `duplex` for a streamed body; the DOM types lag.
    duplex: "half",
  });
}

/**
 * The slot and the watchdog together, for a caller that has already decided
 * the request may hold the slot. It models the export's path and the
 * processing phase (a test or hook helper), not an upload: since #1792 a
 * preview or import spools its file before it claims the slot. It answers
 * null when the request is not an archive request (another route, not a
 * POST, no body), the 429 when the slot is taken (the body is then read
 * away unbuffered), or the watched request and the release the caller must
 * call however the request ends. Releasing twice is harmless. Throws, leaving the slot free, if the body cannot be watched
 * (already read).
 *
 * @param {string | null} routeId
 * @param {Request} request
 * @param {{ stallMs?: number }} [options]
 * @returns {null | Response | { request: Request, release(): void }}
 */
export function holdArchiveSlot(routeId, request, options = {}) {
  if (!isArchiveSlotRequest(routeId, request)) return null;
  if (holder !== null) {
    discardBody(request);
    return archiveBusy();
  }
  const watched = watchArchiveBody(request, options);
  /* Last, so anything above that throws leaves the slot free. */
  const token = /** @type {object} */ (takeSlot());
  heldRequests.set(watched, token);
  return {
    request: watched,
    release() {
      releaseSlot(token);
    },
  };
}
