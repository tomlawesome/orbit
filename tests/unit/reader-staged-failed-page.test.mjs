// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPageLoader, settle } from "../support/svelte-page.mjs";

/*
 * #1605 b1 W-F8: the reader's lost-page line is the same generic words for a
 * waiting (staged) attachment as for a kept document. A waiting attachment is
 * not yet in Orbit; its page fails for reasons a kept one's does not (the mail
 * may have been decided or burned up meanwhile), and the foot already speaks of
 * it as "not yet in orbit". The staged reader's failure line must say it is
 * about the waiting attachment, not use the kept document's line word for word.
 * The wording is the fixer's to choose; this pins only that the two differ and
 * that the staged one still says the page could not be drawn.
 */

vi.mock("orbit/lib/env", () => ({ getAuthConfig: vi.fn().mockReturnValue({}) }));
vi.mock("$lib/data/workspace.js", () => ({ wordsOf: (/** @type {unknown} */ _e, /** @type {string} */ fallback) => fallback }));

const page = createPageLoader("reader-staged-failed-page");
const GENERIC = "this page could not be drawn";

beforeEach(() => {
  vi.stubGlobal("matchMedia", (/** @type {string} */ query) => ({
    matches: false, media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }));
  URL.createObjectURL = () => "blob:page";
  URL.revokeObjectURL = () => {};
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("no", { status: 500 }))));
});
afterEach(() => {
  page.unmount();
  vi.unstubAllGlobals();
});
afterAll(() => page.teardown());

/** The alert text the open reader shows for a page that failed to load. @param {boolean} staged */
async function lostLine(staged) {
  const { target, flushSync } = await page.mount("lib/reading/Reader.svelte", {
    open: true,
    doc: { id: "d1", name: "Service history.pdf", href: "/api/documents/d1/download", previewHref: "/api/documents/d1/preview", pageCount: 2 },
    itemTitle: "Car MOT",
    onremove: async () => {},
    staged,
    pageHref: "/api/staged/d1/preview",
  });
  flushSync();
  await settle();
  flushSync();
  const alert = target.ownerDocument.querySelector(".rd-lost");
  return alert?.textContent?.trim() ?? "";
}

describe("the reader's failure line for a staged page (#1605 W-F8)", () => {
  it("a kept document's failed page says the generic line (the baseline this test measures against)", async () => {
    expect(await lostLine(false)).toBe(GENERIC);
  });

  it("a staged attachment's failed page says something of its own, and still that the page could not be drawn", async () => {
    const line = await lostLine(true);
    expect(line).not.toBe("");
    expect(line).not.toBe(GENERIC);
    expect(line).toMatch(/could not be drawn/i);
  });
});
