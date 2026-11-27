import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

/*
 * #1354 part 3: one controller for reading a picked or dropped document on
 * /create, driven by the desk (create.behaviour.js) and the phone
 * (pocket.svelte). Both copies today run the same flow over
 * readPickedDocument ($lib/data/document-read.js): one AbortController per
 * pick, a `current()` check on every outcome, a stale page's object URL
 * revoked, page one and the read handled independently, a refusal (by either
 * half) that stops the read, suggestions carried only into empty fields, the
 * caption from captionOf, and an undrawable page settled once the read is
 * done. Only what each does WITH an outcome (DOM writes vs state) differs.
 *
 * API (web/src/routes/create/read-controller.svelte.js; plain JS, no runes in
 * its own logic, so it imports under plain vitest):
 *
 *   createReadController(handlers, deps?) -> controller
 *     deps.readPicked   defaults to readPickedDocument (a test seam)
 *     handlers (all optional, called only while the pick is current):
 *       onScanned(scanned)         virus check passed; before page one, never after it
 *       onPage({ url, scanned })   page one drawn
 *       onPageUndrawn(why)         page not drawn (not a refusal): at once
 *       onRefused(why)             malware verdict or a refusing read; the
 *                                  controller has already stopped the pick
 *       onRead({ outcome, carry, caption })
 *                                  read ended, not refused. outcome.kind is
 *                                  "read" | "unread" | "attached"; carry is
 *                                  suggestionsToCarry(outcome.suggestions,
 *                                  valueOf) (always [] unless "read"); caption
 *                                  is captionOf(outcome, carry.length)
 *       onSettleUndrawn(why)       the page was undrawn AND the read is done
 *                                  (either order); never after a refusal
 *   controller.start(file, { householdId, documentReading, readAfter, valueOf, wanted })
 *       -> { current(), done }
 *       Supersedes any pick in flight (aborts it). valueOf(field) is the
 *       form's current value, for carrying; wanted() is the driver's extra
 *       "still this file" test (default true). current() is true until stop(),
 *       a newer start(), a refusal, or wanted() going false. done resolves
 *       when both halves have been handled; it never rejects.
 *   controller.stop()   aborts the pick; nothing more is delivered; a page
 *                       that arrives later has its object URL revoked.
 *
 * Desk vs phone differences, kept as callbacks/inputs, not in the controller:
 *   - what an outcome does: DOM nodes (desk) vs `picked` state (phone);
 *   - the cost value's non-digits are stripped by the phone when it writes
 *     the field; the desk writes the raw value (carry is raw for both);
 *   - desk reads the date through its picker's value (valueOf);
 *   - the "already held" stage/alert (askHeld, readAfter gate) and household
 *     change re-ask stay in each driver: readAfter is passed in;
 *   - the desk marks the page "failed" in onPageUndrawn; the phone only
 *     settles in onSettleUndrawn.
 */

const root = resolve(import.meta.dirname, "../..");
const text = (/** @type {string} */ p) => readFileSync(resolve(root, p), "utf8");
const CONTROLLER = "web/src/routes/create/read-controller.svelte.js";
const file = () => new File([new Uint8Array([37, 80, 68, 70])], "policy.pdf", { type: "application/pdf" });

/** A readPicked stand-in whose two halves the test settles by hand. */
function fake() {
  /** @type {any} */
  const call = {};
  const readPicked = vi.fn((householdId, f, options) => {
    Object.assign(call, { householdId, file: f, options });
    const page = new Promise((r) => { call.page = r; });
    const read = new Promise((r) => { call.read = r; });
    return { page, read };
  });
  return { readPicked, call };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

async function build(handlers = {}) {
  const { createReadController } = await import("../../web/src/routes/create/read-controller.svelte.js");
  const f = fake();
  const events = /** @type {any[]} */ ([]);
  const log = (/** @type {string} */ name) => (/** @type {any[]} */ ...args) => events.push([name, ...args]);
  const all = {
    onScanned: log("scanned"), onPage: log("page"), onPageUndrawn: log("undrawn"), onRefused: log("refused"),
    onRead: log("read"), onSettleUndrawn: log("settle"), ...handlers,
  };
  const controller = createReadController(all, { readPicked: f.readPicked });
  return { controller, events, ...f };
}

describe("#1354: the shared create read controller", () => {
  it("asks readPicked once, with the household, file, signal, documentReading and readAfter", async () => {
    const { controller, call, readPicked } = await build();
    const f = file();
    const readAfter = Promise.resolve();
    controller.start(f, { householdId: "h1", documentReading: false, readAfter, valueOf: () => "" });
    expect(readPicked).toHaveBeenCalledTimes(1);
    expect(call.householdId).toBe("h1");
    expect(call.file).toBe(f);
    expect(call.options.documentReading).toBe(false);
    expect(call.options.readAfter).toBe(readAfter);
    expect(call.options.signal).toBeInstanceOf(AbortSignal);
    expect(typeof call.options.onScanned).toBe("function");
  });

  it("delivers page one, then the read with the empty fields carried and the caption", async () => {
    const { controller, call, events } = await build();
    const run = controller.start(file(), { householdId: "h1", valueOf: (/** @type {string} */ f) => (f === "reference" ? "MINE" : "") });
    call.options.onScanned(true);
    call.page({ kind: "up", url: "blob:p1", scanned: true });
    call.read({
      kind: "read", extracted: true, message: "",
      suggestions: [{ field: "provider", value: "British Gas" }, { field: "reference", value: "BG-1" }, { field: "cost", value: "£144.00" }],
    });
    await run.done;
    expect(events[0]).toEqual(["scanned", true]);
    expect(events[1]).toEqual(["page", { url: "blob:p1", scanned: true }]);
    const [, read] = events.find((e) => e[0] === "read");
    expect(read.carry).toEqual([{ field: "provider", value: "British Gas" }, { field: "cost", value: "£144.00" }]);
    expect(read.caption).toBe("the fields marked ◆ from document are what orbit read across into the form");
    expect(read.outcome.kind).toBe("read");
    expect(run.current()).toBe(true);
  });

  it("carries nothing for unread and attached, and captions them", async () => {
    for (const [outcome, caption] of [
      [{ kind: "unread", message: "The reader fell over" }, "orbit could not read the pages this time"],
      [{ kind: "attached" }, "the file is attached as it is"],
    ]) {
      const { controller, call, events } = await build();
      const run = controller.start(file(), { householdId: "h1", valueOf: () => "" });
      call.page({ kind: "up", url: "blob:x", scanned: false });
      call.read(outcome);
      await run.done;
      const [, read] = events.find((e) => e[0] === "read");
      expect(read.carry).toEqual([]);
      expect(read.caption).toBe(caption);
      expect(read.outcome).toEqual(outcome);
    }
  });

  it("a refusing read stops the pick: onRefused once, the signal aborted, a late page revoked and not shown", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { controller, call, events } = await build();
    const run = controller.start(file(), { householdId: "h1", valueOf: () => "" });
    call.read({ kind: "refused", why: "not a PDF" });
    await tick();
    expect(events).toEqual([["refused", "not a PDF"]]);
    expect(call.options.signal.aborted).toBe(true);
    expect(run.current()).toBe(false);
    call.page({ kind: "up", url: "blob:late", scanned: true });
    await run.done;
    expect(events).toEqual([["refused", "not a PDF"]]);
    expect(revoke).toHaveBeenCalledWith("blob:late");
    revoke.mockRestore();
  });

  it("a malware verdict on the page refuses once, and the read that follows is not delivered", async () => {
    const { controller, call, events } = await build();
    const run = controller.start(file(), { householdId: "h1", valueOf: () => "" });
    call.page({ kind: "refused", why: "it did not pass what orbit checks before keeping a file<br>choose another document" });
    call.read({ kind: "read", extracted: true, suggestions: [{ field: "provider", value: "X" }], message: "" });
    await run.done;
    expect(events.map((e) => e[0])).toEqual(["refused"]);
    expect(call.options.signal.aborted).toBe(true);
  });

  it("an undrawn page is announced at once and settled when the read is done, in either order", async () => {
    for (const pageFirst of [true, false]) {
      const { controller, call, events } = await build();
      const run = controller.start(file(), { householdId: "h1", valueOf: () => "" });
      const page = () => call.page({ kind: "undrawable", why: "the scanner couldn't be reached, Admin have been notified" });
      const read = () => call.read({ kind: "read", extracted: true, suggestions: [], message: "" });
      if (pageFirst) { page(); await tick(); expect(events.map((e) => e[0])).toEqual(["undrawn"]); read(); }
      else { read(); await tick(); page(); }
      await run.done;
      expect(events.map((e) => e[0]).sort()).toEqual(["read", "settle", "undrawn"]);
      expect(events.at(-1)[0]).toBe("settle");
      expect(events.find((e) => e[0] === "settle")[1]).toBe("the scanner couldn't be reached, Admin have been notified");
    }
  });

  it("onScanned is passed on only before the page outcome is in", async () => {
    const { controller, call, events } = await build();
    const run = controller.start(file(), { householdId: "h1", valueOf: () => "" });
    call.options.onScanned(false);
    call.page({ kind: "up", url: "blob:p", scanned: false });
    await tick();
    call.options.onScanned(true);
    call.read({ kind: "attached" });
    await run.done;
    expect(events.filter((e) => e[0] === "scanned")).toEqual([["scanned", false]]);
  });

  it("stop() aborts, delivers nothing more, and revokes a page that arrives afterwards", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { controller, call, events } = await build();
    const run = controller.start(file(), { householdId: "h1", valueOf: () => "" });
    controller.stop();
    expect(call.options.signal.aborted).toBe(true);
    expect(run.current()).toBe(false);
    call.options.onScanned(true);
    call.page({ kind: "up", url: "blob:gone", scanned: true });
    call.read({ kind: "attached" });
    await run.done;
    expect(events).toEqual([]);
    expect(revoke).toHaveBeenCalledWith("blob:gone");
    revoke.mockRestore();
  });

  it("a newer start() supersedes the older pick: its signal aborts and none of its outcomes are delivered", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { controller, call, events } = await build();
    const first = controller.start(file(), { householdId: "h1", valueOf: () => "" });
    const firstCall = { ...call };
    const second = controller.start(file(), { householdId: "h1", valueOf: () => "" });
    expect(firstCall.options.signal.aborted).toBe(true);
    expect(first.current()).toBe(false);
    expect(second.current()).toBe(true);
    firstCall.page({ kind: "up", url: "blob:first", scanned: true });
    firstCall.read({ kind: "read", extracted: true, suggestions: [{ field: "provider", value: "Old" }], message: "" });
    await first.done;
    expect(events).toEqual([]);
    expect(revoke).toHaveBeenCalledWith("blob:first");
    call.read({ kind: "attached" });
    await tick();
    expect(events.map((e) => e[0])).toEqual(["read"]);
    revoke.mockRestore();
  });

  it("wanted() going false silences the pick like stop() does, without needing it", async () => {
    let on = true;
    const { controller, call, events } = await build();
    const run = controller.start(file(), { householdId: "h1", valueOf: () => "", wanted: () => on });
    on = false;
    expect(run.current()).toBe(false);
    call.page({ kind: "up", url: "blob:x", scanned: true });
    call.read({ kind: "attached" });
    await run.done;
    expect(events).toEqual([]);
  });

  it("done never rejects, even when a handler throws", async () => {
    const { controller, call } = await build({ onPage() { throw new Error("driver bug"); } });
    const run = controller.start(file(), { householdId: "h1", valueOf: () => "" });
    call.page({ kind: "up", url: "blob:x", scanned: true });
    call.read({ kind: "attached" });
    await expect(run.done).resolves.toBeUndefined();
  });
});

describe("#1354: both drivers use the controller and no longer hold the reading flow", () => {
  const drivers = ["web/src/routes/create/create.behaviour.js", "web/src/routes/create/pocket.svelte"];

  it("the controller lives in create/ over document-read.js, free of runes' needs", () => {
    const src = text(CONTROLLER);
    expect(src).toMatch(/from "\$lib\/data\/document-read\.js"/);
    for (const name of ["readPickedDocument", "suggestionsToCarry", "captionOf"]) expect(src).toContain(name);
    expect(src).toMatch(/export function createReadController/);
  });

  /* Code only: a comment may still name what moved. */
  const code = (/** @type {string} */ p) => text(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  for (const driver of drivers) {
    it(`${driver} imports ./read-controller.svelte.js`, () => {
      expect(text(driver)).toMatch(/from "\.\/read-controller\.svelte\.js"/);
    });

    it(`${driver} has no reading flow of its own`, () => {
      const src = code(driver);
      expect(src).not.toMatch(/\breadPickedDocument\b/);
      expect(src).not.toMatch(/\bsuggestionsToCarry\b/);
      expect(src).not.toMatch(/\bcaptionOf\b/);
      expect(src).not.toMatch(/\bfocusAfterScan\b/);
      /* its own abort controller for the read is gone: the controller owns it */
      expect(src).not.toMatch(/new AbortController\(\)/);
    });
  }

  it("the words still come from document-read.js, not copies", () => {
    for (const driver of drivers) expect(text(driver)).toMatch(/from "\$lib\/data\/document-read\.js"/);
  });
});
