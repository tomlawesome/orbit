// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPageLoader, settle } from "../support/svelte-page.mjs";

/*
 * #1605 W-R10: where the Reader fetches pages itself (no `picture` prop, as
 * StagedPage.svelte mounts it), a page whose fetch failed can be asked for
 * again without leaving it: #1870's "try again" on the lost page fetches the
 * same page once more. It must not just clear the failure line and show the
 * old page (the comment at the stage: "the old page never stays up under the
 * new number"). Mounted in happy-dom with fetch stubbed per page.
 */
vi.mock("orbit/lib/env", () => ({ getAuthConfig: vi.fn().mockReturnValue({}) }));
vi.mock("$lib/data/workspace.js", () => ({ wordsOf: (/** @type {unknown} */ _e, /** @type {string} */ fallback) => fallback }));

const page = createPageLoader("reader-own-fetch-repeat-press");
const UNDRAWN = "this page could not be drawn";

beforeEach(() => {
  vi.stubGlobal("matchMedia", (/** @type {string} */ query) => ({
    matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
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
const ok = () => new Response(new Blob(["x"]), { status: 200, headers: { "x-orbit-page-count": "2" } });
const quiet = async () => {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await settle();
};

/** @param {(n: number) => Response | Promise<Response>} plan */
async function mountReader(plan) {
  const asked = /** @type {number[]} */ ([]);
  vi.stubGlobal("fetch", vi.fn(async (/** @type {string} */ href) => { const n = pageOf(String(href)); asked.push(n); return plan(n); }));
  const mounted = await page.mount("lib/reading/Reader.svelte", {
    open: true, doc: { name: "mot.pdf", previewHref: "/api/preview/x?page=1", pageCount: 2 }, itemTitle: "Car MOT",
    onremove: async () => {}, pageNo: 1,
  });
  await quiet();
  return { ...mounted, asked };
}

/** The lost page's own control (#1870): "try again", labelled for the page. @param {number} n */
const tryAgain = async (/** @type {number} */ n, /** @type {() => void} */ flushSync) => {
  const button = /** @type {HTMLButtonElement | null} */ (document.querySelector(`[aria-label="Try page ${n} again"]`));
  expect(button, `a "try again" for page ${n}`).not.toBeNull();
  /** @type {HTMLButtonElement} */ (button).click();
  flushSync();
  await quiet();
};

describe("a page whose own fetch failed is fetched again from the page itself (#1605 W-R10)", () => {
  it("page one fails: its try again fetches page one a second time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { flushSync, asked } = await mountReader(() => new Response("no", { status: 500 }));
    expect(document.body.textContent).toContain(UNDRAWN);
    expect(asked).toEqual([1]);

    await tryAgain(1, flushSync);
    expect(asked, "the press fetched page one again").toEqual([1, 1]);
  });

  it("page two (the last) fails: its try again fetches page two again, and never leaves the old page under the failed number", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Page two fails once; its try again is left unanswered, so the check below sees the stage while the retry
    // is still in flight, when only the old page (page one's image) could be standing in for page two.
    let twos = 0;
    const { target, flushSync, asked } = await mountReader((n) => (n === 1 ? ok() : (twos += 1) === 1 ? new Response("no", { status: 500 }) : new Promise(() => {})));
    /** @type {HTMLButtonElement} */ (target.ownerDocument.querySelector('[aria-label="Next page"]')).click();
    flushSync();
    await quiet();
    expect(asked).toEqual([1, 2]);
    expect(document.body.textContent).toContain(UNDRAWN);

    await tryAgain(2, flushSync);
    expect(asked, "the press fetched page two again").toEqual([1, 2, 2]);
    expect(document.querySelector(".rd-stage img"), "the old page is not shown as page two while it is asked for again").toBeNull();
  });
});
