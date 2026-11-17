// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPageLoader, settle } from "../support/svelte-page.mjs";

/*
 * #1446 decision 3: a busy answer (503 document_preview_busy, Retry-After)
 * for a page the reader turned to keeps the page on show, says once "busy —
 * trying this page again", and asks for the same page exactly once more after
 * Retry-After. A second busy is the lost state ("this page could not be
 * drawn" plus try again). Turning away aborts the pending retry. A busy answer
 * alone never shows "could not be drawn".
 *
 * Reader.svelte is mounted in happy-dom with fetch stubbed per page; the
 * assertions are on what the reader shows. Only setTimeout/clearTimeout are
 * faked, so the retry wait is advanced by the test.
 */

vi.mock("orbit/lib/env", () => ({ getAuthConfig: vi.fn().mockReturnValue({}) }));
vi.mock("$lib/data/workspace.js", () => ({ wordsOf: (/** @type {unknown} */ _e, /** @type {string} */ fallback) => fallback }));

const page = createPageLoader("reader-busy-retry");
const BUSY = "busy — trying this page again";
const LOST = "this page could not be drawn";
const HREF = "/api/documents/d/preview";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  URL.createObjectURL = () => "blob:page";
  URL.revokeObjectURL = () => {};
});
afterEach(() => {
  page.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
afterAll(() => page.teardown());

const pageOf = (/** @type {string} */ href) => Number(new URL(href, "http://x").searchParams.get("page") ?? "1");
const ok = () => new Response(new Blob(["x"]), { status: 200, headers: { "x-orbit-page-count": "3" } });
const busy = (/** @type {string} */ seconds = "2") => new Response(
  JSON.stringify({ error: { code: "document_preview_busy", message: "Orbit is busy; try again shortly" } }),
  { status: 503, headers: { "Retry-After": seconds, "Content-Type": "application/json" } },
);

const quiet = () => vi.advanceTimersByTimeAsync(0).then(() => settle());

/** @param {(n: number, call: number, signal: AbortSignal | undefined) => Promise<Response>} plan */
async function mountReader(plan) {
  /** @type {number[]} */
  const asked = [];
  vi.stubGlobal("fetch", vi.fn((/** @type {string} */ href, /** @type {RequestInit} */ init) => {
    const n = pageOf(String(href));
    asked.push(n);
    return plan(n, asked.filter((p) => p === n).length, init?.signal ?? undefined);
  }));
  const mounted = await page.mount("lib/reading/Reader.svelte", {
    open: true,
    doc: { name: "Car MOT.pdf", href: "/api/documents/d/download", previewHref: HREF, pageCount: 3 },
    itemTitle: "Car MOT",
    onremove: async () => {},
  });
  await quiet();
  return { ...mounted, asked };
}

/** @param {HTMLElement} target @param {() => void} flushSync @param {string} label */
async function press(target, flushSync, label) {
  /** @type {HTMLButtonElement} */ (target.querySelector(`[aria-label="${label}"]`)).click();
  flushSync();
  await quiet();
}

const count = (/** @type {string} */ text, /** @type {string} */ needle) => text.split(needle).length - 1;

describe("a busy page turn is retried once, quietly (#1446 decision 3)", () => {
  it("keeps the page on show, says busy once, and draws the page when the one retry succeeds", async () => {
    const { target, flushSync, asked } = await mountReader((n, call) => Promise.resolve(n === 2 && call === 1 ? busy("2") : ok()));
    await press(target, flushSync, "Next page");

    expect(asked.filter((n) => n === 2)).toHaveLength(1);
    expect(target.querySelector(".sheet img, .rd-stage img"), "the page stays up").not.toBeNull();
    expect(target.textContent).not.toContain(LOST);
    expect(count(target.textContent ?? "", BUSY), "the busy line shows once").toBe(1);
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(BUSY);

    await vi.advanceTimersByTimeAsync(1_900);
    await quiet();
    expect(asked.filter((n) => n === 2), "not before Retry-After").toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    flushSync();
    await quiet();

    expect(asked.filter((n) => n === 2), "exactly one retry").toHaveLength(2);
    expect(target.textContent).not.toContain(BUSY);
    expect(target.textContent).not.toContain(LOST);
  });

  it("a second busy is the lost state, with try again, and no third request", async () => {
    const { target, flushSync, asked } = await mountReader((n) => Promise.resolve(n === 2 ? busy("1") : ok()));
    await press(target, flushSync, "Next page");
    await vi.advanceTimersByTimeAsync(1_000);
    flushSync();
    await quiet();

    expect(target.textContent).toContain(LOST);
    expect(target.textContent?.toLowerCase()).toContain("try again");
    expect(target.textContent).not.toContain(BUSY);

    await vi.advanceTimersByTimeAsync(60_000);
    flushSync();
    await quiet();
    expect(asked.filter((n) => n === 2), "one request and one retry, no more").toHaveLength(2);
  });

  it("clamps a long Retry-After to 10 s for the wait", async () => {
    const { target, flushSync, asked } = await mountReader((n, call) => Promise.resolve(n === 2 && call === 1 ? busy("300") : ok()));
    await press(target, flushSync, "Next page");
    await vi.advanceTimersByTimeAsync(9_900);
    await quiet();
    expect(asked.filter((n) => n === 2)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    await quiet();
    expect(asked.filter((n) => n === 2)).toHaveLength(2);
  });

  it("turning away aborts the pending retry: the busy page is never asked for again", async () => {
    const { target, flushSync, asked } = await mountReader((n, call) => Promise.resolve(n === 2 && call === 1 ? busy("5") : ok()));
    await press(target, flushSync, "Next page");
    expect(target.textContent).toContain(BUSY);

    await press(target, flushSync, "Previous page");
    await vi.advanceTimersByTimeAsync(60_000);
    flushSync();
    await quiet();

    expect(asked.filter((n) => n === 2), "the retry was aborted").toHaveLength(1);
    expect(target.textContent).not.toContain(BUSY);
    expect(target.textContent).not.toContain(LOST);
  });

  it("closing the reader aborts the pending retry too", async () => {
    const { target, flushSync, asked } = await mountReader((n, call) => Promise.resolve(n === 2 && call === 1 ? busy("5") : ok()));
    await press(target, flushSync, "Next page");
    /** @type {HTMLButtonElement} */ (target.querySelector('[aria-label="Close"], .rd-close')).click();
    flushSync();
    await vi.advanceTimersByTimeAsync(60_000);
    await quiet();
    expect(asked.filter((n) => n === 2)).toHaveLength(1);
  });

  it("a failure that is not busy is lost at once, with no retry", async () => {
    const { target, flushSync, asked } = await mountReader((n) => Promise.resolve(n === 2 ? new Response("no", { status: 500 }) : ok()));
    await press(target, flushSync, "Next page");
    await vi.advanceTimersByTimeAsync(60_000);
    flushSync();
    await quiet();
    expect(target.textContent).toContain(LOST);
    expect(asked.filter((n) => n === 2)).toHaveLength(1);
  });
});
