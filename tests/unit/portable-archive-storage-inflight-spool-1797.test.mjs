import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/*
 * #1797 spec section 7 test 1: `PortableArchiveStorage.spool()` starts the
 * write and returns at once with a handle (`whenWritten`, `prefix`, `abort`,
 * `done`), so the first bytes of an upload can be read back from the spool
 * file while the rest is still arriving. Written from the specification
 * alone, before the build; fails today (spool() resolves only when the
 * source ends).
 */
let root;
let storage;
const hold = [];

beforeAll(async () => {
  const { PortableArchiveStorage } = await import("orbit/server/portable-archive-storage");
  root = mkdtempSync(join(tmpdir(), "orbit-1797-spool-"));
  storage = new PortableArchiveStorage(root);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => { for (const end of hold.splice(0)) end(); });

const tmpFiles = () => (existsSync(root) ? readdirSync(root).filter((name) => name.endsWith(".upload.tmp")) : []);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PENDING = Symbol("pending");
/** The promise's value, or PENDING when it has not settled within `ms`. */
const within = (promise, ms = 300) => Promise.race([promise, sleep(ms).then(() => PENDING)]);

/** A source the test feeds by hand; `state` records cancellation. */
function source() {
  const queue = [];
  let wake = null;
  const state = { cancelled: false, cancelReason: undefined };
  const deliver = (item) => { if (wake) { const resolve = wake; wake = null; resolve(item); } else queue.push(item); };
  const stream = new ReadableStream({
    async pull(controller) {
      const item = queue.length ? queue.shift() : await new Promise((resolve) => { wake = resolve; });
      if (item === null) controller.close();
      else controller.enqueue(item);
    },
    cancel(reason) { state.cancelled = true; state.cancelReason = reason; },
  }, { highWaterMark: 0 });
  let ended = false;
  const end = () => { if (!ended) { ended = true; deliver(null); } };
  hold.push(end);
  return { stream, state, send: (bytes) => deliver(new Uint8Array(bytes)), end };
}

async function readAll(stream) {
  const reader = stream.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

const bytes = (length, offset = 0) => Buffer.from(Array.from({ length }, (_, index) => (index + offset) % 251));

describe("#1797 section 7 test 1: the spool in flight", () => {
  it("spool() returns at once, while its source has not ended", async () => {
    const feed = source();
    feed.send(bytes(100));
    const inflight = await within(Promise.resolve(storage.spool(feed.stream)));
    expect(inflight, "spool() did not wait for the source to end").not.toBe(PENDING);
    expect(typeof inflight.whenWritten).toBe("function");
    expect(typeof inflight.prefix).toBe("function");
    expect(typeof inflight.abort).toBe("function");
    expect(inflight.done).toBeInstanceOf(Promise);
    inflight.abort(new Error("test over"));
    await inflight.done.catch(() => undefined);
  });

  it("whenWritten(n) resolves once n bytes are on disk, and not before", async () => {
    const feed = source();
    feed.send(bytes(100));
    const inflight = await storage.spool(feed.stream);
    expect(await within(inflight.whenWritten(100))).toBe(100);
    const waiting = inflight.whenWritten(150);
    expect(await within(waiting, 150), "50 bytes short: still waiting").toBe(PENDING);
    feed.send(bytes(100, 100));
    expect(await within(waiting)).toBeGreaterThanOrEqual(150);
    inflight.abort(new Error("test over"));
    await inflight.done.catch(() => undefined);
  });

  it("whenWritten(n) resolves with what there is when the source ends first", async () => {
    const feed = source();
    feed.send(bytes(200));
    const inflight = await storage.spool(feed.stream);
    const waiting = inflight.whenWritten(1000);
    feed.end();
    expect(await within(waiting)).toBe(200);
    const spooled = await inflight.done;
    expect(spooled.sizeBytes).toBe(200);
    await spooled.dispose();
  });

  it("prefix(n) yields exactly the first n bytes while the spool continues", async () => {
    const feed = source();
    const all = bytes(300);
    feed.send(all.subarray(0, 200));
    const inflight = await storage.spool(feed.stream);
    await within(inflight.whenWritten(200));
    const first = await within(readAll(inflight.prefix(150)));
    expect(first).not.toBe(PENDING);
    expect(first.equals(all.subarray(0, 150))).toBe(true);
    expect(await within(inflight.done, 150), "the spool is still running").toBe(PENDING);
    feed.send(all.subarray(200));
    feed.end();
    const spooled = await inflight.done;
    expect(spooled.sizeBytes).toBe(300);
    expect((await readAll(spooled.stream())).equals(all), "the whole file reads back after it ends").toBe(true);
    await spooled.dispose();
  });

  it("abort(reason) cancels the source, removes the file and rejects done with the reason; a second abort is harmless", async () => {
    const feed = source();
    feed.send(bytes(100));
    const inflight = await storage.spool(feed.stream);
    await within(inflight.whenWritten(100));
    expect(tmpFiles(), "the spool file exists while it runs").toHaveLength(1);
    const reason = new Error("over quota");
    const done = inflight.done.then(() => ({ ok: true }), (error) => ({ error }));
    inflight.abort(reason);
    inflight.abort(new Error("second"));
    const outcome = await within(done);
    expect(outcome.error).toBe(reason);
    expect(feed.state.cancelled, "the source was cancelled").toBe(true);
    for (let tries = 0; tries < 50 && tmpFiles().length > 0; tries += 1) await sleep(20);
    expect(tmpFiles()).toEqual([]);
  });

  it("a source that errors removes the file and rejects done", async () => {
    const failing = new ReadableStream({
      pull(controller) { controller.error(new Error("client went away")); },
    }, { highWaterMark: 0 });
    const inflight = await storage.spool(failing);
    await expect(inflight.done).rejects.toThrow("client went away");
    expect(tmpFiles()).toEqual([]);
  });

  it("an unaborted spool that ends leaves one readable file and dispose() removes it", async () => {
    const feed = source();
    feed.send(bytes(64));
    feed.end();
    const inflight = await storage.spool(feed.stream);
    const spooled = await inflight.done;
    const files = tmpFiles();
    expect(files).toHaveLength(1);
    expect(readFileSync(join(root, files[0])).equals(bytes(64))).toBe(true);
    await spooled.dispose();
    expect(tmpFiles()).toEqual([]);
  });
});
