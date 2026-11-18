// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPageLoader, settle } from "../support/svelte-page.mjs";
import { documentRowOf } from "../../web/src/lib/data/belt.js";
import { DOCUMENTS_FIXTURE } from "../../web/src/lib/data/fixtures/workspace.js";

/*
 * #1870: asking the card again for the page it is on, when that page has
 * drawn, is not a retry and sends no request. The card's only entry for the
 * reader's "try again" is picture.again(n, undrawn); the reader is stood in
 * for by a stub that keeps its props, so the test can make that call itself.
 */

vi.mock("orbit/lib/env", () => ({ getAuthConfig: vi.fn().mockReturnValue({}) }));
vi.mock("$lib/data/workspace.js", () => ({ wordsOf: (/** @type {unknown} */ _e, /** @type {string} */ fallback) => fallback }));

const page = createPageLoader("turn-drawn-1870", {
  stubs: { "lib/reading/Reader.svelte": "export default function Reader(anchor, props) { globalThis.__readerProps = props; }" },
});

beforeEach(() => {
  vi.stubGlobal("matchMedia", (/** @type {string} */ query) => ({
    matches: query.includes("prefers-reduced-motion"), media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }));
  URL.createObjectURL = () => "blob:page";
  URL.revokeObjectURL = () => {};
});
afterEach(() => { page.unmount(); vi.unstubAllGlobals(); });
afterAll(() => page.teardown());

describe("card: asking again for a page that has drawn (#1870)", () => {
  it("picture.again(pageNo, false) on a drawn page sends no request; (pageNo, true) does", async () => {
    /** @type {number[]} */ const asked = [];
    vi.stubGlobal("fetch", vi.fn((/** @type {string} */ href) => {
      asked.push(Number(new URL(String(href), "http://x").searchParams.get("page") ?? "1"));
      return Promise.resolve(new Response(new Blob(["x"]), { status: 200, headers: { "x-orbit-page-count": "3" } }));
    }));
    const doc = { ...documentRowOf(DOCUMENTS_FIXTURE["i-mot"][0]), pageCount: 3 };
    const { target, flushSync } = await page.mount("lib/reading/PreviewCard.svelte", {
      doc, itemTitle: "Car MOT", onclose: () => {}, onremove: async () => {}, onrestore: async () => {},
    });
    await settle();
    target.querySelector(".sheet img")?.dispatchEvent(new Event("load"));
    flushSync();
    await settle();
    const props = /** @type {any} */ (globalThis).__readerProps;
    expect(props, "the stub reader was mounted").toBeTruthy();
    expect(props.picture.failed, "page 1 has drawn").toBe(false);
    const before = asked.length;
    props.picture.again(1, false);
    flushSync();
    await settle();
    expect(asked.length - before, "no request for a drawn page").toBe(0);
    expect(props.picture.retrying).toBe(false);
    props.picture.again(1, true);
    flushSync();
    await settle();
    expect(asked.slice(before), "an undrawn page is asked for again").toEqual([1]);
  });
});
