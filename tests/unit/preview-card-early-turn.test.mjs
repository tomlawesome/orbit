// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPageLoader, settle } from "../support/svelte-page.mjs";
import { documentRowOf } from "../../web/src/lib/data/belt.js";
import { DOCUMENTS_FIXTURE } from "../../web/src/lib/data/fixtures/workspace.js";

/*
 * #1803 L-turn: a failure of a page turned to belongs to that turn, whether
 * or not page one has arrived. Only page one's own load (started when the
 * paper is shown) may mark the whole paper undrawable. Today, turning before
 * page one lands cancels its request; if the turned-to page then fails, or
 * the first-load timer (15 s) fires, the whole paper reads "could not draw a
 * picture of this document".
 *
 * The card is mounted in happy-dom with fetch stubbed per page; the assertions
 * are on what the reader sees.
 */

vi.mock("orbit/lib/env", () => ({ getAuthConfig: vi.fn().mockReturnValue({}) }));
vi.mock("$lib/data/workspace.js", () => ({ wordsOf: (/** @type {unknown} */ _e, /** @type {string} */ fallback) => fallback }));

const page = createPageLoader("preview-card-early-turn");
const LOAD_TIMEOUT_MS = 15_000;
const PAPER = "Orbit could not draw a picture of this document.";
const TURN_LOST = "this page could not be drawn";

beforeEach(() => {
  vi.stubGlobal("matchMedia", (/** @type {string} */ query) => ({
    matches: query.includes("prefers-reduced-motion"), media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }));
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

/** Lets promises settle; timers run only when the test advances a faked clock. */
const quiet = async () => {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await settle();
};

/**
 * Mounts the card on a three-page paper. `plan(n, signal)` answers a page's
 * fetch; a held one rejects with AbortError when the card cancels it.
 * @param {(n: number, signal: AbortSignal | undefined) => Promise<Response>} plan
 */
async function mountCard(plan) {
  vi.stubGlobal("fetch", vi.fn((/** @type {string} */ href, /** @type {RequestInit} */ init) => plan(pageOf(String(href)), init?.signal ?? undefined)));
  const doc = { ...documentRowOf(DOCUMENTS_FIXTURE["i-mot"][0]), pageCount: 3 };
  const mounted = await page.mount("lib/reading/PreviewCard.svelte", {
    doc, itemTitle: "Car MOT",
    onclose: () => {}, onremove: async () => {}, onrestore: async () => {},
  });
  await quiet();
  return mounted;
}

/** A fetch that never answers until the card aborts it. @param {AbortSignal | undefined} signal @returns {Promise<Response>} */
const held = (signal) => new Promise((_, reject) => {
  signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
});

/** @param {HTMLElement} target @param {string} label */
const press = async (/** @type {HTMLElement} */ target, /** @type {string} */ label, /** @type {() => void} */ flushSync) => {
  /** @type {HTMLButtonElement} */ (target.querySelector(`[aria-label="${label}"]`)).click();
  flushSync();
  await quiet();
};

describe("a failed early turn does not blank the paper (#1803 L-turn)", () => {
  it("T1: page one held, page two fails: the turn is lost, the paper is not undrawable, and page one still loads on turning back", async () => {
    let oneAsked = 0;
    const { target, flushSync } = await mountCard((n, signal) => {
      if (n === 1) { oneAsked++; return oneAsked === 1 ? held(signal) : Promise.resolve(ok()); }
      return Promise.resolve(new Response("no", { status: 500 }));
    });
    await press(target, "Next page", flushSync);

    expect(target.textContent, "the whole paper must not read as undrawable").not.toContain(PAPER);
    expect(target.textContent, "the turn's own failure shows").toContain(TURN_LOST);

    await press(target, "Previous page", flushSync);
    const img = target.querySelector(".sheet img");
    expect(img?.getAttribute("src"), "page one loads").toBe("blob:page");
    expect(target.textContent).not.toContain(PAPER);
  });

  it("T2: as T1, then the first-load timer's time passes: still not undrawable", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { target, flushSync } = await mountCard((n, signal) => (n === 1
      ? held(signal)
      : Promise.resolve(new Response("no", { status: 500 }))));
    await press(target, "Next page", flushSync);
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS + 1_000);
    flushSync();
    await quiet();

    expect(target.textContent, "the first-load timer must not blank the paper after a turn").not.toContain(PAPER);
    expect(target.textContent).toContain(TURN_LOST);
  });

  it("T3: page one fails with no turn: the paper is undrawable, as before", async () => {
    const { target, flushSync } = await mountCard(() => Promise.resolve(new Response("no", { status: 500 })));
    flushSync();
    await settle();
    expect(target.textContent).toContain(PAPER);
  });
});
