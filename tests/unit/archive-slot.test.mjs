import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1316 (DATA3): the instance handles at most ONE archive preview, import or
 * export at a time. A signed-in caller who POSTs to an archive route while
 * another is in progress is refused at once (429) without the server reading
 * their upload. The slot is always freed afterwards (success, error, client
 * abort, stalled upload); the caller releases it, the watchdog only errors the
 * body. Written from the specification alone, before web/src/lib/server/archive-slot.js
 * exists.
 *
 * Same shape as tests/unit/body-limit.test.mjs, whose request builder this copies.
 */
const COLD_IMPORT_TIMEOUT_MS = 30_000;

import { appErrorResponse } from "orbit/lib/app-error";

const PREVIEW = "/api/portable-archives/preview";
const IMPORT = "/api/portable-archives/import";
const EXPORT = "/api/households/[householdId]/portable-archives";
const SLOT_ROUTES = [PREVIEW, IMPORT, EXPORT];

/** @type {typeof import("../../web/src/lib/server/archive-slot.js")} */
let slot;
beforeAll(async () => {
  slot = await import("../../web/src/lib/server/archive-slot.js");
}, COLD_IMPORT_TIMEOUT_MS);

/** Everything a test takes hold of, so a failing test cannot leave the slot taken for the next. */
/** @type {Array<{ release(): void }>} */
let held = [];
/** @type {Array<() => void>} */
let cleanups = [];

/** @param {string} routeId @param {Request} request @param {object} [options] */
function hold(routeId, request, options) {
  const outcome = slot.holdArchiveSlot(routeId, request, options);
  if (outcome && !(outcome instanceof Response)) held.push(outcome);
  return outcome;
}

/** @param {number} size @param {{ declare?: boolean }} [options] */
function post(size, { declare = true } = {}) {
  const bytes = new Uint8Array(size).map((_, at) => at % 251);
  const body = declare ? bytes : new ReadableStream({
    start(controller) {
      for (let at = 0; at < size; at += 64 * 1024) controller.enqueue(bytes.subarray(at, at + 64 * 1024));
      controller.close();
    },
  });
  return new Request("http://127.0.0.1:3000/api/anything", {
    method: "POST",
    headers: declare ? { "content-length": String(size), "content-type": "application/octet-stream" } : { "content-type": "application/octet-stream" },
    body,
    duplex: "half",
  });
}

/** @param {ReadableStream} body @param {Record<string, string>} [headers] */
function streamed(body, headers = {}) {
  return new Request("http://127.0.0.1:3000/api/anything", {
    method: "POST",
    headers: { "content-type": "application/octet-stream", ...headers },
    body,
    duplex: "half",
  });
}

/** A body that sends one chunk and then goes silent for good. */
function silentAfterOneChunk() {
  return new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); } });
}

/** A body that drips one byte every 20 ms until it is cancelled. */
function dripping() {
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let timer;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      timer = setInterval(() => {
        try { controller.enqueue(new Uint8Array([1])); } catch { clearInterval(timer); }
      }, 20);
    },
    cancel() { clearInterval(timer); },
  });
  cleanups.push(() => clearInterval(timer));
  return body;
}

/** @param {Request} request */
const failureOf = (request) => request.arrayBuffer().then(() => null, (error) => error);

beforeEach(() => {
  held = [];
  cleanups = [];
});

afterEach(() => {
  for (const one of held) one.release();
  for (const undo of cleanups) undo();
  vi.useRealTimers();
  delete process.env.ORBIT_ARCHIVE_BODY_STALL_MS;
  delete process.env.ORBIT_ARCHIVE_BODY_DEADLINE_MS;
});

describe("the constants other code and the client rely on", () => {
  it("names the three archive routes and the codes and timings of the refusals", () => {
    expect(slot.ARCHIVE_SLOT_ROUTES).toBeInstanceOf(Set);
    expect([...slot.ARCHIVE_SLOT_ROUTES].sort()).toEqual([...SLOT_ROUTES].sort());
    expect(slot.ARCHIVE_BUSY_CODE).toBe("archive_busy");
    expect(slot.ARCHIVE_BUSY_RETRY_AFTER_SECONDS).toBe(60);
    expect(slot.ARCHIVE_BODY_TIMED_OUT_CODE).toBe("request_timeout");
    expect(slot.ARCHIVE_BODY_STALL_MS).toBe(30_000);
    expect(slot.ARCHIVE_BODY_DEADLINE_MS).toBe(300_000);
    expect(slot.ARCHIVE_BUSY_MESSAGE).toEqual(expect.stringMatching(/\S/));
    expect(slot.ARCHIVE_BODY_TIMED_OUT_MESSAGE).toEqual(expect.stringMatching(/\S/));
  });
});

describe("which requests take the slot", () => {
  it("leaves a route that is not an archive route alone", () => {
    expect(hold("/api/admin/contact", post(100))).toBeNull();
    expect(hold(null, post(100))).toBeNull();
    expect(slot.archiveSlotHeld()).toBe(false);
  });

  it("leaves a GET to an archive route alone", () => {
    const request = new Request("http://127.0.0.1:3000/api/anything", { method: "GET" });
    for (const route of SLOT_ROUTES) expect(hold(route, request)).toBeNull();
    expect(slot.archiveSlotHeld()).toBe(false);
  });

  it("leaves a request with no body alone", () => {
    const request = new Request("http://127.0.0.1:3000/api/anything", { method: "POST" });
    expect(request.body).toBeNull();
    for (const route of SLOT_ROUTES) expect(hold(route, request)).toBeNull();
    expect(slot.archiveSlotHeld()).toBe(false);
  });
});

describe("taking the slot", () => {
  it.each(SLOT_ROUTES)("hands the first POST to %s its slot and the same body", async (route) => {
    const sent = post(5000);
    const outcome = hold(route, sent);
    expect(outcome).not.toBeInstanceOf(Response);
    expect(outcome).not.toBeNull();
    expect(typeof outcome.release).toBe("function");
    expect(outcome.request).toBeInstanceOf(Request);
    expect(slot.archiveSlotHeld()).toBe(true);

    const bytes = new Uint8Array(await outcome.request.arrayBuffer());
    expect(bytes).toEqual(new Uint8Array(5000).map((_, at) => at % 251));
    // Holding is not reading: the slot is taken until the caller says so.
    expect(slot.archiveSlotHeld()).toBe(true);
    outcome.release();
    expect(slot.archiveSlotHeld()).toBe(false);
  });

  it("delivers an undeclared (streamed) body in full too", async () => {
    const outcome = hold(PREVIEW, post(300 * 1024, { declare: false }));
    expect((await outcome.request.arrayBuffer()).byteLength).toBe(300 * 1024);
  });
});

describe("a second archive request while one is in progress", () => {
  it.each(SLOT_ROUTES)("is refused at once with a 429 busy answer when it goes to %s", async (route) => {
    hold(PREVIEW, post(100));

    const answer = hold(route, post(100));

    expect(answer).toBeInstanceOf(Response);
    expect(answer.status).toBe(429);
    expect(answer.headers.get("retry-after")).toBe("60");
    expect(answer.headers.get("cache-control")).toBe("no-store");
    // The refused upload is read and thrown away, not abandoned: no "close" demand on the connection.
    expect(answer.headers.get("connection")).toBeNull();
    const { error } = await answer.json();
    expect(error.code).toBe("archive_busy");
    expect(error.message).toEqual(expect.stringMatching(/\S/));
    // The first one is still the holder.
    expect(slot.archiveSlotHeld()).toBe(true);
  });

  it("is refused whichever route held it first", async () => {
    for (const first of SLOT_ROUTES) {
      const holder = hold(first, post(100));
      expect(holder).not.toBeInstanceOf(Response);
      for (const second of SLOT_ROUTES) expect(hold(second, post(100)).status).toBe(429);
      holder.release();
    }
  });

  it("returns the refusal at once and reads the refused upload to its end, throwing it away", async () => {
    hold(PREVIEW, post(100));
    const chunks = 5;
    let pulled = 0;
    let closed = false;
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        if (pulled < chunks) {
          pulled += 1;
          controller.enqueue(new Uint8Array(1024));
        } else {
          closed = true;
          controller.close();
        }
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });

    const answer = hold(IMPORT, streamed(body));

    // Synchronous: a Response, not a promise of one, and nothing read yet.
    expect(answer).toBeInstanceOf(Response);
    expect(answer.status).toBe(429);
    expect(pulled).toBeLessThanOrEqual(1);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pulled).toBe(chunks);
    expect(closed).toBe(true);
    expect(cancelled).toBe(false);
  });

  it("causes no unhandled rejection when the refused upload errors while it is being read away", async () => {
    hold(PREVIEW, post(100));
    /** @type {unknown[]} */
    const unhandled = [];
    const listener = (reason) => { unhandled.push(reason); };
    process.on("unhandledRejection", listener);
    try {
      let pulls = 0;
      const body = new ReadableStream({
        pull(controller) {
          pulls += 1;
          if (pulls === 1) controller.enqueue(new Uint8Array(1024));
          else controller.error(new Error("the client went away"));
        },
      }, { highWaterMark: 0 });

      const answer = hold(IMPORT, streamed(body));
      expect(answer.status).toBe(429);

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(pulls).toBeGreaterThanOrEqual(2);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("builds the same answer as archiveBusy()", async () => {
    const answer = slot.archiveBusy();
    expect(answer.status).toBe(429);
    expect(answer.headers.get("retry-after")).toBe("60");
    await expect(answer.json()).resolves.toMatchObject({ error: { code: "archive_busy" } });
  });
});

describe("giving the slot back", () => {
  it("frees it on release, so the next caller gets in", () => {
    const first = hold(PREVIEW, post(100));
    expect(slot.archiveSlotHeld()).toBe(true);
    first.release();
    expect(slot.archiveSlotHeld()).toBe(false);

    const third = hold(IMPORT, post(100));
    expect(third).not.toBeInstanceOf(Response);
    expect(third).not.toBeNull();
    expect(slot.archiveSlotHeld()).toBe(true);
  });

  it("is harmless to release twice: the slot is simply free, and still takes one holder at a time", () => {
    const first = hold(PREVIEW, post(100));
    first.release();

    expect(() => first.release()).not.toThrow();

    expect(slot.archiveSlotHeld()).toBe(false);
    const next = hold(IMPORT, post(100));
    expect(next).not.toBeInstanceOf(Response);
    expect(hold(EXPORT, post(100)).status).toBe(429);
  });

  it("lets hold, release, hold, release succeed in a row", () => {
    for (const route of [PREVIEW, IMPORT, EXPORT, PREVIEW]) {
      const outcome = hold(route, post(100));
      expect(outcome).not.toBeInstanceOf(Response);
      expect(outcome).not.toBeNull();
      outcome.release();
      expect(slot.archiveSlotHeld()).toBe(false);
    }
  });
});

describe("an upload that stalls", () => {
  it("is cut off with a 408 request_timeout once no byte arrives for the stall time", async () => {
    const outcome = hold(PREVIEW, streamed(silentAfterOneChunk()), { stallMs: 50, deadlineMs: 10_000 });
    expect(outcome).not.toBeInstanceOf(Response);

    const started = Date.now();
    const failure = await failureOf(outcome.request);

    expect(Date.now() - started).toBeLessThan(1000);
    expect(failure).toMatchObject({ code: "request_timeout", status: 408 });
    const answer = appErrorResponse(failure);
    expect(answer.status).toBe(408);
    await expect(answer.json()).resolves.toMatchObject({ error: { code: "request_timeout" } });
  });

  it("reads the stall time from ORBIT_ARCHIVE_BODY_STALL_MS when no option is given", async () => {
    process.env.ORBIT_ARCHIVE_BODY_STALL_MS = "50";
    const outcome = hold(IMPORT, streamed(silentAfterOneChunk()));
    expect(outcome).not.toBeInstanceOf(Response);

    const started = Date.now();
    const failure = await failureOf(outcome.request);

    expect(Date.now() - started).toBeLessThan(1000);
    expect(failure).toMatchObject({ code: "request_timeout", status: 408 });
  });

  it("does not cut off an upload that keeps moving inside the stall time", async () => {
    const outcome = hold(PREVIEW, streamed(dripping()), { stallMs: 500, deadlineMs: 10_000 });
    const reader = outcome.request.body.getReader();
    for (let chunks = 0; chunks < 5; chunks += 1) {
      const next = await reader.read();
      expect(next.done).toBe(false);
    }
    await reader.cancel();
  });

  it("still delivers the 408 to the caller, never cancels the original source, and reads it on to its end", async () => {
    let cancelled = false;
    let pulls = 0;
    let lateChunksPulled = 0;
    let ended = false;
    let open = () => {};
    const gate = new Promise((resolve) => { open = resolve; });
    // Drips two chunks, then stops until the gate opens; then three more chunks and the end.
    const source = new ReadableStream({
      async pull(controller) {
        pulls += 1;
        if (pulls <= 2) {
          controller.enqueue(new Uint8Array([pulls]));
          return;
        }
        await gate;
        if (lateChunksPulled < 3) {
          lateChunksPulled += 1;
          controller.enqueue(new Uint8Array([9]));
        } else {
          ended = true;
          controller.close();
        }
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });

    const outcome = hold(PREVIEW, streamed(source), { stallMs: 50, deadlineMs: 10_000 });
    expect(outcome).not.toBeInstanceOf(Response);

    const failure = await failureOf(outcome.request);

    expect(failure).toMatchObject({ code: "request_timeout", status: 408 });
    expect(appErrorResponse(failure).status).toBe(408);
    expect(cancelled).toBe(false);

    // The sender carries on after the cut: everything it still sends is read away to the end.
    open();
    for (let waited = 0; !ended && waited < 1000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lateChunksPulled).toBe(3);
    expect(ended).toBe(true);
    expect(cancelled).toBe(false);
  });
});

describe("an upload that drips for too long", () => {
  it("is cut off at the deadline with the same 408, and the slot stays held until the caller releases it", async () => {
    const outcome = hold(PREVIEW, streamed(dripping()), { stallMs: 10_000, deadlineMs: 100 });
    expect(outcome).not.toBeInstanceOf(Response);

    const started = Date.now();
    const failure = await failureOf(outcome.request);
    const took = Date.now() - started;

    expect(failure).toMatchObject({ code: "request_timeout", status: 408 });
    expect(took).toBeGreaterThanOrEqual(80);
    expect(took).toBeLessThan(1500);
    // The watchdog errors the body; only the caller frees the slot.
    expect(slot.archiveSlotHeld()).toBe(true);
    expect(hold(IMPORT, post(100)).status).toBe(429);
    outcome.release();
    expect(slot.archiveSlotHeld()).toBe(false);
  });
});

describe("a client that goes away", () => {
  it("surfaces the body's own error, frees the slot on release and leaves no timer behind", async () => {
    vi.useFakeTimers();
    const failing = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.error(new Error("aborted"));
      },
    });
    const outcome = hold(IMPORT, streamed(failing));
    expect(outcome).not.toBeInstanceOf(Response);

    const failure = await failureOf(outcome.request);

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe("aborted");
    outcome.release();
    expect(slot.archiveSlotHeld()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timer behind after an ordinary completed upload either", async () => {
    vi.useFakeTimers();
    const outcome = hold(PREVIEW, post(2048));
    await outcome.request.arrayBuffer();
    outcome.release();
    expect(vi.getTimerCount()).toBe(0);
    expect(slot.archiveSlotHeld()).toBe(false);
  });
});

/* Last in the file: until the slot is fixed, a failure here leaves it held with no handle to release. */
describe("a request that cannot be prepared", () => {
  it("throws, and does not leave the slot held, when the body is already locked", () => {
    const request = streamed(silentAfterOneChunk());
    request.body.getReader();

    expect(() => slot.holdArchiveSlot(PREVIEW, request)).toThrow();

    expect(slot.archiveSlotHeld()).toBe(false);
    // The next caller gets in.
    const next = hold(IMPORT, post(100));
    expect(next).not.toBeInstanceOf(Response);
    expect(next).not.toBeNull();
  });
});
