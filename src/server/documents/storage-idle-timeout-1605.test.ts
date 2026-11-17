import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalDocumentStorage, UPLOAD_IDLE_TIMEOUT_MS } from "./storage";

/* #1605 SEC-D2/1 (from #1209): the upload read loop had no deadline, so a
   client that stops sending holds its connection and file handle. Ruling: an
   idle (per-chunk) timeout of 60 s, as nginx's client_body_timeout, fixed, no
   total cap; a stall is refused 408 `document_upload_stalled`. */

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** One chunk, then a body that never sends another byte and never ends. */
function stallingBody(onStalled: () => void): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new Uint8Array(1_024).fill(0x41));
        return undefined;
      }
      onStalled();
      return new Promise(() => undefined);
    },
  });
}

describe("the upload read loop has an idle deadline (SEC-D2/1)", () => {
  it("exports the idle timeout as 60 seconds", () => {
    expect(UPLOAD_IDLE_TIMEOUT_MS).toBe(60_000);
  });

  it("refuses a stalled upload with 408 document_upload_stalled once 60 s pass with no bytes, and removes the quarantine file", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbit-idle-1605-"));
    roots.push(root);
    const storage = new LocalDocumentStorage(join(root, "objects"), join(root, "quarantine"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let stalled = false;
    let outcome: { error?: unknown; done: boolean } = { done: false };
    const received = storage.receive(stallingBody(() => { stalled = true; }), "30000000-0000-4000-8000-000000000001", 1_048_576)
      .then(() => { outcome = { done: true }; }, (error: unknown) => { outcome = { done: true, error }; });
    // Real I/O has to finish first: wait, off the fake clock, until the loop is waiting for a second chunk.
    for (let turns = 0; !stalled && turns < 2_000; turns += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(stalled).toBe(true);

    await vi.advanceTimersByTimeAsync(UPLOAD_IDLE_TIMEOUT_MS - 1_000);
    expect(outcome.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    for (let turns = 0; !outcome.done && turns < 200; turns += 1) await new Promise((resolve) => setImmediate(resolve));

    expect(outcome.done).toBe(true);
    expect(outcome.error).toMatchObject({ code: "document_upload_stalled", status: 408, message: "The document transfer stalled and was stopped" });
    await received;
    await expect(readdir(join(root, "quarantine"))).resolves.toEqual([]);
  });
});
