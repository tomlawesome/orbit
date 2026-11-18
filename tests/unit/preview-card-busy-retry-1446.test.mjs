// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPageLoader, settle } from "../support/svelte-page.mjs";
import { documentRowOf } from "../../web/src/lib/data/belt.js";
import { DOCUMENTS_FIXTURE } from "../../web/src/lib/data/fixtures/workspace.js";

/*
 * #1446 decision 3, review finding: "a busy answer alone never shows could-not-draw".
 * Every stored-document host opens the Reader through PreviewCard, which hands it
 * `picture`; the card then owns the page fetch. reader-busy-retry.test.mjs mounts the
 * Reader without `picture`, so it never saw the card send a busy 503 to missed(). Here
 * the real card and the real Reader are mounted together, as a host does.
 */

vi.mock("orbit/lib/env", () => ({ getAuthConfig: vi.fn().mockReturnValue({}) }));
vi.mock("$lib/data/workspace.js", () => ({ wordsOf: (/** @type {unknown} */ _e, /** @type {string} */ fallback) => fallback }));

const page = createPageLoader("preview-card-busy-retry-1446");
const LOST = "could not be drawn";
const UNDRAWN = "could not draw a picture of this document";

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
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
afterAll(() => page.teardown());

const ok = () => new Response(new Blob(["x"]), { status: 200, headers: { "x-orbit-page-count": "3" } });
const busy = () => new Response(
  JSON.stringify({ error: { code: "document_preview_busy", message: "Orbit is busy; try again shortly" } }),
  { status: 503, headers: { "Retry-After": "1", "Content-Type": "application/json" } },
);

describe("a stored document's page turn through PreviewCard and the Reader (#1446 decision 3)", () => {
  it("a busy 503 for the page turned to is retried quietly and the page draws; could-not-draw never shows", async () => {
    // Catches PreviewCard.loadPage sending a busy answer to missed(): the reader shows
    // "this page could not be drawn" (and a try-again button) at once, with no retry.
    /** @type {number[]} */ const asked = [];
    vi.stubGlobal("fetch", vi.fn((/** @type {string} */ href) => {
      const n = Number(new URL(String(href), "http://x").searchParams.get("page") ?? "1");
      asked.push(n);
      return Promise.resolve(n === 2 && asked.filter((p) => p === 2).length === 1 ? busy() : ok());
    }));
    const doc = { ...documentRowOf(DOCUMENTS_FIXTURE["i-mot"][0]), pageCount: 3 };
    const { target, flushSync } = await page.mount("lib/reading/PreviewCard.svelte", {
      doc, itemTitle: "Car MOT", onclose: () => {}, onremove: async () => {}, onrestore: async () => {},
    });
    await settle();
    target.querySelector(".sheet img")?.dispatchEvent(new Event("load"));
    flushSync();
    await settle();

    /** @type {HTMLButtonElement} */ (document.body.querySelector(`[aria-label^="Read "]`)).click();
    flushSync();
    await settle();
    /** @type {HTMLButtonElement} */ (document.body.querySelector('[aria-label="Next page"]')).click();
    flushSync();
    await settle();

    expect(asked.filter((n) => n === 2), "page 2 was asked for").toHaveLength(1);
    expect(document.body.textContent, "busy alone is not could-not-draw").not.toContain(LOST);

    await new Promise((r) => setTimeout(r, 1_300));
    flushSync();
    await settle();

    expect(asked.filter((n) => n === 2), "one quiet retry after Retry-After").toHaveLength(2);
    expect(document.body.textContent).not.toContain(LOST);
  }, 20_000);

  /** @param {number} busyAnswers how many times page 1 answers busy before it succeeds */
  async function mountFirstPage(busyAnswers) {
    /** @type {number} */ let asked = 0;
    vi.stubGlobal("fetch", vi.fn(() => (++asked <= busyAnswers ? Promise.resolve(busy()) : Promise.resolve(ok()))));
    const doc = { ...documentRowOf(DOCUMENTS_FIXTURE["i-mot"][0]), pageCount: 3 };
    const { target, flushSync } = await page.mount("lib/reading/PreviewCard.svelte", {
      doc, itemTitle: "Car MOT", onclose: () => {}, onremove: async () => {}, onrestore: async () => {},
    });
    await settle();
    return { target, flushSync, asked: () => asked };
  }

  it("a busy 503 for the first page is retried quietly and the page draws; could-not-draw never shows", async () => {
    // Catches PreviewCard.loadPage treating a busy first page as the paper's own failure.
    const { target, flushSync, asked } = await mountFirstPage(1);
    expect(asked(), "page 1 was asked for").toBe(1);
    expect(document.body.textContent, "busy alone is not could-not-draw").not.toContain(UNDRAWN);
    expect(document.body.textContent).not.toContain(LOST);

    await new Promise((r) => setTimeout(r, 1_300));
    flushSync();
    await settle();

    expect(asked(), "one quiet retry after Retry-After").toBe(2);
    expect(target.querySelector(".sheet img")?.getAttribute("src"), "the page is shown").toBe("blob:page");
    expect(document.body.textContent).not.toContain(UNDRAWN);
    expect(document.body.textContent).not.toContain(LOST);
  }, 20_000);

  it("a first page that answers busy twice lands on the could-not-draw face, after one retry only", async () => {
    const { flushSync, asked } = await mountFirstPage(2);
    await new Promise((r) => setTimeout(r, 1_300));
    flushSync();
    await settle();

    expect(asked(), "asked once more, and no further").toBe(2);
    expect(document.body.textContent, "the second busy is a real failure").toContain(UNDRAWN);
  }, 20_000);
});
