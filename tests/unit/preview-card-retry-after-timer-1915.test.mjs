// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPageLoader } from "../support/svelte-page.mjs";
import { documentRowOf } from "../../web/src/lib/data/belt.js";
import { DOCUMENTS_FIXTURE } from "../../web/src/lib/data/fixtures/workspace.js";

/*
 * #1915 W-F2 (with W-F3): the card's 15 s load timer (LOAD_TIMEOUT_MS) must be
 * cleared when a busy answer starts the quiet-retry wait, or a 30 s Retry-After
 * trips it and the paper reads could-not-draw while it is only waiting. A load
 * that really stalls still hits the timeout.
 */

vi.mock("orbit/lib/env", () => ({ getAuthConfig: vi.fn().mockReturnValue({}) }));
vi.mock("$lib/data/workspace.js", () => ({ wordsOf: (/** @type {unknown} */ _e, /** @type {string} */ fallback) => fallback }));

const page = createPageLoader("preview-card-retry-after-timer-1915");
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
  vi.useRealTimers();
  page.unmount();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
afterAll(() => page.teardown());

const ok = () => new Response(new Blob(["x"]), { status: 200, headers: { "x-orbit-page-count": "3" } });
const busy30 = () => new Response(
  JSON.stringify({ error: { code: "document_preview_busy", message: "Orbit is busy; try again shortly" } }),
  { status: 503, headers: { "Retry-After": "30", "Content-Type": "application/json" } },
);

/** @param {(n: number) => Promise<Response>} answer */
async function mountCard(answer) {
  let asked = 0;
  vi.stubGlobal("fetch", vi.fn(() => answer(++asked)));
  const doc = { ...documentRowOf(DOCUMENTS_FIXTURE["i-mot"][0]), pageCount: 3 };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { flushSync } = await page.mount("lib/reading/PreviewCard.svelte", {
    doc, itemTitle: "Car MOT", onclose: () => {}, onremove: async () => {}, onrestore: async () => {},
  });
  return { flushSync, asked: () => asked };
}

describe("PreviewCard's load timer and the Retry-After wait (#1915 W-F2)", () => {
  it("a 30 s Retry-After wait never trips the 15 s load timeout, and the retry then draws", async () => {
    // Catches loadTimer left running on the busy path: at 15 s failed() shows could-not-draw.
    const { flushSync, asked } = await mountCard((n) => Promise.resolve(n === 1 ? busy30() : ok()));
    await vi.advanceTimersByTimeAsync(0);
    expect(asked(), "page 1 asked for once").toBe(1);

    await vi.advanceTimersByTimeAsync(20_000);
    flushSync();
    expect(document.body.textContent, "15 s passed while waiting").not.toContain(UNDRAWN);

    await vi.advanceTimersByTimeAsync(11_000);
    flushSync();
    expect(asked(), "retried after the 30 s").toBe(2);
    expect(document.body.textContent).not.toContain(UNDRAWN);
  });

  it("a load that really stalls still fails at the timeout", async () => {
    const { flushSync } = await mountCard(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(14_000);
    flushSync();
    expect(document.body.textContent).not.toContain(UNDRAWN);
    await vi.advanceTimersByTimeAsync(2_000);
    flushSync();
    expect(document.body.textContent).toContain(UNDRAWN);
  });
});
