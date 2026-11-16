import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1390 review round, ruling 2: server-side work is not client idleness.
 *
 * In v2 a document is scanned (and structure-checked, and decrypted) while
 * the rest of the upload is still arriving. During that work the route is not
 * pulling from the body, so nothing can arrive through the watched stream,
 * however fast the client is sending: the bytes wait in the socket. The slow
 * client limit must measure the client only while the server is waiting for
 * its bytes. It is paused while the route is not pulling and restarted when
 * pulling resumes (the same idea as nginx's client_body_timeout, which counts
 * only the time a read is outstanding).
 *
 * Fake timers stand in for the 40 s scan. Same shape as archive-v2-stall.test.mjs.
 */
const COLD_IMPORT_TIMEOUT_MS = 30_000;
const IMPORT = "/api/portable-archives/import";
const CHUNK = 64 * 1024;

vi.mock("orbit/server/upload-limit", () => ({ readEffectiveUploadLimit: async () => 50 * 1_048_576 }));

/** @type {typeof import("../../web/src/lib/server/archive-slot.js")} */
let slot;
beforeAll(async () => {
  slot = await import("../../web/src/lib/server/archive-slot.js");
}, COLD_IMPORT_TIMEOUT_MS);

/** @type {Array<{ release(): void }>} */
let held = [];
beforeEach(() => { held = []; });
afterEach(() => {
  for (const one of held) one.release();
  vi.useRealTimers();
  delete process.env.ORBIT_ARCHIVE_BODY_STALL_MS;
});

/**
 * A client that sends at a good rate: a chunk is there whenever the server
 * asks for one, until `chunks` have gone. After that `then` decides: end the
 * body, or stay silent (the client has stopped).
 * @param {number} chunks
 * @param {"end" | "silent"} then
 */
function fastClient(chunks, then = "end") {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent < chunks) {
        sent += 1;
        controller.enqueue(new Uint8Array(CHUNK));
        return undefined;
      }
      if (then === "end") { controller.close(); return undefined; }
      return new Promise(() => {});
    },
  }, { highWaterMark: 0 });
}

/** @param {ReadableStream} body */
function streamed(body) {
  return new Request("http://127.0.0.1:3000/api/portable-archives/import", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body,
    duplex: "half",
  });
}

async function advance(totalMs, stepMs = 1_000) {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) await vi.advanceTimersByTimeAsync(stepMs);
}

/** Settles a promise into an object so a pending one can be told from a settled one. */
function track(promise) {
  const state = { settled: false, value: undefined, error: undefined };
  promise.then((value) => { state.settled = true; state.value = value; }, (error) => { state.settled = true; state.error = error; });
  return state;
}

describe("ruling 2: the stall timer counts the time the route waits for the client, not the time the route is busy", () => {
  it("does not cut a body (no 408) while the route scans for 40 s without pulling, then carries on reading a fast upload to its end", async () => {
    // Catches today's timer, which runs from the last chunk whether or not anyone is reading: it fires at 30 s into the scan and kills the import.
    vi.useFakeTimers();
    const outcome = slot.holdArchiveSlot(IMPORT, streamed(fastClient(20)));
    expect(outcome).not.toBeInstanceOf(Response);
    held.push(outcome);
    const reader = outcome.request.body.getReader();

    const first = await reader.read();
    expect(first.done).toBe(false);

    // The route is scanning that document: no read is outstanding for 40 s.
    await advance(40_000);

    let received = first.value.length;
    let failure = null;
    for (;;) {
      const next = await reader.read().catch((error) => { failure = error; return { done: true, value: undefined }; });
      if (next.done) break;
      received += next.value.length;
    }
    expect(failure, "the slow-client cut must not fire while the route is the one not pulling").toBeNull();
    expect(received).toBe(20 * CHUNK);
  });

  it("pauses again for each piece of server work: three 35 s scans between reads are never a 408", async () => {
    // Catches a fix that pauses only once, or only before the first byte.
    vi.useFakeTimers();
    const outcome = slot.holdArchiveSlot(IMPORT, streamed(fastClient(8)));
    held.push(outcome);
    const reader = outcome.request.body.getReader();
    let failure = null;
    let received = 0;
    for (let round = 0; round < 3; round += 1) {
      const next = await reader.read().catch((error) => { failure = error; return { done: true, value: undefined }; });
      if (failure) break;
      received += next.value.length;
      await advance(35_000);
    }
    for (;;) {
      const next = await reader.read().catch((error) => { failure = error; return { done: true, value: undefined }; });
      if (next.done) break;
      received += next.value.length;
    }
    expect(failure).toBeNull();
    expect(received).toBe(8 * CHUNK);
  });

  it("still cuts a real client stall with 408 request_timeout: 30 s with a read outstanding and no byte, after the route has been busy for 40 s", async () => {
    // Pins that the pause is not an off switch: once the route is pulling again the client has 30 s to send.
    vi.useFakeTimers();
    const outcome = slot.holdArchiveSlot(IMPORT, streamed(fastClient(1, "silent")));
    held.push(outcome);
    const reader = outcome.request.body.getReader();
    expect((await reader.read()).done).toBe(false);

    await advance(40_000); // server work

    const waiting = track(reader.read()); // the route is pulling again; the client has gone quiet
    await advance(29_000);
    expect(waiting.settled, "29 s of waiting for the client is not yet a stall").toBe(false);
    await advance(2_000);
    expect(waiting.settled, "31 s of waiting for the client is a stall").toBe(true);
    expect(waiting.error).toMatchObject({ code: "request_timeout", status: 408 });
  });

  it("still cuts a client that is silent from the start, with a read outstanding, at 30 s", async () => {
    // Pins existing behaviour for the plain case, with the consumer pulling throughout.
    vi.useFakeTimers();
    const outcome = slot.holdArchiveSlot(IMPORT, streamed(fastClient(0, "silent")));
    held.push(outcome);
    const waiting = track(outcome.request.body.getReader().read());
    await advance(31_000);
    expect(waiting.error).toMatchObject({ code: "request_timeout", status: 408 });
  });
});

describe("ruling 2: archive-slot.js says why", () => {
  it("its comment says the stall timer is paused while the route is not pulling (scan, structure check, encryption)", () => {
    // The ruling asks for the comment in archive-slot.js; read as text, the comment lines only.
    const source = readFileSync(new URL("../../web/src/lib/server/archive-slot.js", import.meta.url), "utf8");
    const comments = [...source.matchAll(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gmu)].map((match) => match[0]).join("\n");
    expect(comments).toMatch(/scan/iu);
    expect(comments).toMatch(/not pulling|not reading|isn't pulling|isn't reading|waiting for (the )?(client|bytes)/iu);
  });
});
