import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1390 (design note §4 line 29; §2.4 "Time"): the archive routes' time bound
 * becomes stall-based only. A body that keeps moving is never cut, however
 * long it takes (the 300 s ARCHIVE_BODY_DEADLINE_MS goes); a body that stops
 * for the stall time (30 s) is still cut with 408; and `discardBody` gets the
 * same 30-second stall cut, so a refused body that stops sending is bounded
 * in time.
 *
 * The note puts this line with the integration tests; it needs no database,
 * so it runs here on the same modules the request pipeline uses, with fake
 * timers standing in for the 400 s (same shape as tests/unit/archive-slot.test.mjs).
 */
const COLD_IMPORT_TIMEOUT_MS = 30_000;

vi.mock("orbit/server/upload-limit", () => ({ readEffectiveUploadLimit: async () => 50 * 1_048_576 }));

const IMPORT = "/api/portable-archives/import";

/** @type {typeof import("../../web/src/lib/server/archive-slot.js")} */
let slot;
/** @type {typeof import("../../web/src/lib/server/body-limit.js")} */
let bodyLimit;
beforeAll(async () => {
  slot = await import("../../web/src/lib/server/archive-slot.js");
  bodyLimit = await import("../../web/src/lib/server/body-limit.js");
}, COLD_IMPORT_TIMEOUT_MS);

/** @type {Array<{ release(): void }>} */
let held = [];
beforeEach(() => { held = []; });
afterEach(() => {
  for (const one of held) one.release();
  vi.useRealTimers();
  delete process.env.ORBIT_ARCHIVE_BODY_STALL_MS;
  delete process.env.ORBIT_ARCHIVE_BODY_DEADLINE_MS;
});

/** @param {ReadableStream} body */
function streamed(body) {
  return new Request("http://127.0.0.1:3000/api/portable-archives/import", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body,
    duplex: "half",
  });
}

/** A body that sends one byte every `everyMs` until it has sent `count`, then ends. */
function trickle(everyMs, count) {
  let sent = 0;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let timer;
  return new ReadableStream({
    start(controller) {
      timer = setInterval(() => {
        if (sent >= count) { clearInterval(timer); controller.close(); return; }
        sent += 1;
        try { controller.enqueue(new Uint8Array([sent % 256])); } catch { clearInterval(timer); }
      }, everyMs);
    },
    cancel() { clearInterval(timer); },
  });
}

/** @param {Request} request */
const failureOf = (request) => request.arrayBuffer().then(() => null, (error) => error);

/** Advances fake time by `totalMs` in `stepMs` steps, letting streams run between steps. */
async function advance(totalMs, stepMs = 1_000) {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) await vi.advanceTimersByTimeAsync(stepMs);
}

describe("§4 line 29: the archive routes' time bound is a stall, not a whole-request deadline", () => {
  it("accepts a body that sends one byte every 10 s for 400 s: no 408", async () => {
    // Catches ARCHIVE_BODY_DEADLINE_MS (300 s) left in place: the 408 would fire at 300 s.
    vi.useFakeTimers();
    const outcome = slot.holdArchiveSlot(IMPORT, streamed(trickle(10_000, 40)));
    expect(outcome).not.toBeInstanceOf(Response);
    held.push(outcome);
    let settled = false;
    const result = outcome.request.arrayBuffer().then((buffer) => { settled = true; return buffer.byteLength; }, (error) => { settled = true; return error; });

    await advance(420_000, 5_000);

    expect(settled, "the body finished within the fake 420 s").toBe(true);
    await expect(result).resolves.toBe(40);
  });

  it("still cuts a body that stops for 31 s with 408 request_timeout", async () => {
    // Pins existing behaviour (the stall cut stays): a client that stops sending is not waited on for ever.
    vi.useFakeTimers();
    const silent = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); } });
    const outcome = slot.holdArchiveSlot(IMPORT, streamed(silent));
    held.push(outcome);
    let failure;
    const pending = failureOf(outcome.request).then((value) => { failure = value; });

    await advance(31_000);
    await pending;

    expect(failure).toMatchObject({ code: "request_timeout", status: 408 });
  });
});

describe("§4 line 29: discardBody cuts a refused body that stalls for 30 s", () => {
  it("stops reading, and cancels the body (closing the connection), once no byte has arrived for 31 s after the answer", async () => {
    // Catches discardBody without a stall cut: today it waits on a silent body for ever.
    vi.useFakeTimers();
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(1024)); },
      cancel() { cancelled = true; },
    });
    const request = new Request("http://127.0.0.1:3000/api/portable-archives/import", { method: "POST", body, duplex: "half" });
    let done = false;
    const discarding = Promise.resolve(bodyLimit.discardBody(request)).then(() => { done = true; });

    await advance(20_000);
    expect(done, "not cut while still inside the stall time").toBe(false);

    await advance(11_000);
    expect(done, "discardBody settled by 31 s").toBe(true);
    await discarding;
    expect(cancelled, "the stalled body is cancelled, which destroys the socket under adapter-node").toBe(true);
  });

  it("keeps reading a refused body that keeps moving, to its end (the cut is a stall, not a deadline)", async () => {
    // The neighbouring case: a slow but live sender is drained, so its connection can answer the next request.
    vi.useFakeTimers();
    const request = new Request("http://127.0.0.1:3000/api/portable-archives/import", { method: "POST", body: trickle(10_000, 12), duplex: "half" });
    let done = false;
    const discarding = Promise.resolve(bodyLimit.discardBody(request)).then(() => { done = true; });

    await advance(140_000, 5_000);
    await discarding;
    expect(done).toBe(true);
  });
});
