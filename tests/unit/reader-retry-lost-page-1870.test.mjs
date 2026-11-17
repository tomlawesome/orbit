// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPageLoader, settle } from "../support/svelte-page.mjs";
import { documentRowOf } from "../../web/src/lib/data/belt.js";
import { DOCUMENTS_FIXTURE } from "../../web/src/lib/data/fixtures/workspace.js";

/*
 * #1870: a page that failed to load can be asked for again. The lost page
 * (card and reader) carries a "try again" button; one press is one request
 * for the same page; the button is disabled until that request settles; a
 * success draws the page, removes line and button and puts focus on the card
 * (card) or the stage (reader); a failure shows line and an enabled button
 * again and announces again. Written from the design note alone.
 */

vi.mock("orbit/lib/env", () => ({ getAuthConfig: vi.fn().mockReturnValue({}) }));
vi.mock("$lib/data/workspace.js", () => ({ wordsOf: (/** @type {unknown} */ _e, /** @type {string} */ fallback) => fallback }));

const page = createPageLoader("reader-retry-1870");
const LINE = "this page could not be drawn";
const RETRY2 = '[aria-label="Try page 2 again"]';

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

const pageOf = (/** @type {string} */ href) => Number(new URL(href, "http://x").searchParams.get("page") ?? "1");
const ok = () => new Response(new Blob(["x"]), { status: 200, headers: { "x-orbit-page-count": "3" } });
const bad = () => new Response("no", { status: 500 });
const quiet = () => settle();

/** A fetch that answers only when released; rejects if the card aborts it. */
function gate() {
  /** @type {(r: Response) => void} */ let release = () => {};
  const promise = (/** @type {AbortSignal | undefined} */ signal) => new Promise((resolve, reject) => {
    release = resolve;
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
  return { promise, release: (/** @type {Response} */ r) => release(r) };
}

/**
 * Mounts the card on a three-page paper; `plan(n, attempt, signal)` answers
 * each page request (attempt counts per page, from 1). Returns the request log.
 * @param {(n: number, attempt: number, signal: AbortSignal | undefined) => Promise<Response>} plan
 */
async function mountCard(plan) {
  /** @type {number[]} */ const asked = [];
  /** @type {Record<number, number>} */ const attempts = {};
  vi.stubGlobal("fetch", vi.fn((/** @type {string} */ href, /** @type {RequestInit} */ init) => {
    const n = pageOf(String(href));
    attempts[n] = (attempts[n] ?? 0) + 1;
    asked.push(n);
    return plan(n, attempts[n], init?.signal ?? undefined);
  }));
  const doc = { ...documentRowOf(DOCUMENTS_FIXTURE["i-mot"][0]), pageCount: 3 };
  const mounted = await page.mount("lib/reading/PreviewCard.svelte", {
    doc, itemTitle: "Car MOT", onclose: () => {}, onremove: async () => {}, onrestore: async () => {},
  });
  await quiet();
  return { ...mounted, asked };
}

/** @param {ParentNode} root @param {string} label */
const click = async (root, label, /** @type {() => void} */ flushSync) => {
  /** @type {HTMLButtonElement} */ (root.querySelector(`[aria-label="${label}"]`)).click();
  flushSync();
  await quiet();
};

/** Counts role=alert elements added or re-texted under root from now on. @param {Node} root */
function watchAlerts(root) {
  let count = 0;
  const hit = (/** @type {Node} */ n) => {
    const el = n.nodeType === 1 ? /** @type {Element} */ (n) : n.parentElement;
    return Boolean(el && (el.matches("[role=alert]") || el.querySelector("[role=alert]") || el.closest("[role=alert]")));
  };
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "characterData" && hit(r.target)) count++;
      for (const n of r.addedNodes) if (hit(n)) count++;
    }
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  return { count: () => count, stop: () => observer.disconnect() };
}

/** Card with page 2 lost on its first ask. */
const cardWithLostTwo = (/** @type {(attempt: number, signal: AbortSignal | undefined) => Promise<Response>} */ onTwo) =>
  mountCard((n, attempt, signal) => (n === 2 ? onTwo(attempt, signal) : Promise.resolve(ok())));

describe("card: try again on a lost page (#1870)", () => {
  it("C1: a lost turn shows the line and a 'try again' button labelled for the page (fails now: no button exists)", async () => {
    const { target, flushSync } = await cardWithLostTwo(() => Promise.resolve(bad()));
    await click(target, "Next page", flushSync);
    expect(target.querySelector(".focusline[role=alert]")?.textContent, "the '— try again' suffix moves onto the button").toBe(LINE);
    const button = target.querySelector(RETRY2);
    expect(button?.textContent?.trim(), "visible name").toBe("try again");
    expect(/** @type {HTMLButtonElement} */ (button).disabled).toBe(false);
  });

  it("C2: one press is one new request for the same page, and the button is disabled until it settles (fails now: no button)", async () => {
    const hold = gate();
    const { target, flushSync, asked } = await cardWithLostTwo((attempt, signal) => (attempt === 1 ? Promise.resolve(bad()) : hold.promise(signal)));
    await click(target, "Next page", flushSync);
    const before = asked.length;
    const button = /** @type {HTMLButtonElement} */ (target.querySelector(RETRY2));
    button.click();
    flushSync();
    await quiet();
    expect(asked.slice(before), "exactly one request, for page 2").toEqual([2]);
    expect(target.textContent, "line stays while retrying").toContain(LINE);
    const retrying = /** @type {HTMLButtonElement} */ (target.querySelector(RETRY2));
    expect(retrying.disabled, "disabled while retrying").toBe(true);
    retrying.click();
    retrying.click();
    flushSync();
    await quiet();
    expect(asked.length - before, "presses while retrying send nothing").toBe(1);
  });

  it("C3: a retry that returns the page draws it, removes line and button, and focus lands on the card (fails now: no button)", async () => {
    const hold = gate();
    const { target, flushSync } = await cardWithLostTwo((attempt, signal) => (attempt === 1 ? Promise.resolve(bad()) : hold.promise(signal)));
    await click(target, "Next page", flushSync);
    const button = /** @type {HTMLButtonElement} */ (target.querySelector(RETRY2));
    button.focus();
    button.click();
    flushSync();
    await quiet();
    hold.release(ok());
    flushSync();
    await quiet();
    expect(target.querySelector(".sheet img")?.getAttribute("src"), "the picture is drawn").toBe("blob:page");
    expect(target.textContent).not.toContain(LINE);
    expect(target.querySelector(RETRY2), "button gone").toBeNull();
    expect(document.activeElement, "focus on the card, never the body").toBe(target.querySelector("[data-preview-card]"));
  });

  it("C4: a retry that fails shows the line and an enabled button again, and announces again (fails now: no button)", async () => {
    const hold = gate();
    const { target, flushSync } = await cardWithLostTwo((attempt, signal) => (attempt === 1 ? Promise.resolve(bad()) : hold.promise(signal)));
    await click(target, "Next page", flushSync);
    /** @type {HTMLButtonElement} */ (target.querySelector(RETRY2)).click();
    flushSync();
    await quiet();
    const watch = watchAlerts(target);
    hold.release(bad());
    flushSync();
    await quiet();
    watch.stop();
    expect(target.textContent).toContain(LINE);
    expect(/** @type {HTMLButtonElement} */ (target.querySelector(RETRY2)).disabled).toBe(false);
    expect(watch.count(), "a fresh role=alert announcement").toBeGreaterThanOrEqual(1);
  });

  it("C5: a drawn page offers no button and a good page is never refetched (presence proven first by a retry that drew it)", async () => {
    const { target, flushSync, asked } = await cardWithLostTwo((attempt) => Promise.resolve(attempt === 1 ? bad() : ok()));
    await click(target, "Next page", flushSync);
    expect(target.querySelector(RETRY2), "present while lost").not.toBeNull();
    await click(target, "Try page 2 again", flushSync);
    expect(target.querySelector(".sheet img")?.getAttribute("src")).toBe("blob:page");
    expect(target.querySelector(RETRY2)).toBeNull();
    expect(asked.filter((n) => n === 2), "page 2: the first ask and the one retry only").toHaveLength(2);
  });

  it("C6: turning away and back to a lost page asks for it again (existing behaviour, kept)", async () => {
    const { target, flushSync, asked } = await cardWithLostTwo((attempt) => Promise.resolve(attempt === 1 ? bad() : ok()));
    await click(target, "Next page", flushSync);
    await click(target, "Previous page", flushSync);
    await click(target, "Next page", flushSync);
    expect(asked.filter((n) => n === 2)).toHaveLength(2);
    expect(target.querySelector(RETRY2)).toBeNull();
  });
});

describe("reader over the card: try again (#1870)", () => {
  /** Opens the reader on page 1 and turns to the lost page 2 inside it. */
  async function readerOnLostTwo(/** @type {(attempt: number, signal: AbortSignal | undefined) => Promise<Response>} */ onTwo) {
    const mounted = await cardWithLostTwo(onTwo);
    const { target, flushSync } = mounted;
    /* the picture has to have loaded before the sheet can be pressed */
    target.querySelector(".sheet img")?.dispatchEvent(new Event("load"));
    flushSync();
    await quiet();
    /** @type {HTMLButtonElement} */ (target.querySelector(".sheet")).click();
    flushSync();
    await quiet();
    const layer = /** @type {HTMLElement} */ (document.querySelector(".rd-layer"));
    await click(layer, "Next page", flushSync);
    return { ...mounted, layer };
  }

  it("R1: the reader's lost page shows the line and its own 'try again' button (fails now: no button)", async () => {
    const { layer } = await readerOnLostTwo(() => Promise.resolve(bad()));
    expect(layer.querySelector(".rd-lost")?.textContent).toBe(LINE);
    expect(layer.querySelector(RETRY2)?.textContent?.trim()).toBe("try again");
  });

  it("R2: pressing it sends one request, is disabled meanwhile, and on success the stage takes focus (fails now: no button)", async () => {
    const hold = gate();
    const { layer, flushSync, asked } = await readerOnLostTwo((attempt, signal) => (attempt === 1 ? Promise.resolve(bad()) : hold.promise(signal)));
    const before = asked.length;
    const button = /** @type {HTMLButtonElement} */ (layer.querySelector(RETRY2));
    button.focus();
    button.click();
    flushSync();
    await quiet();
    expect(asked.slice(before)).toEqual([2]);
    expect(/** @type {HTMLButtonElement} */ (layer.querySelector(RETRY2)).disabled).toBe(true);
    hold.release(ok());
    flushSync();
    await quiet();
    expect(layer.querySelector(".rd-lost")).toBeNull();
    expect(layer.querySelector(RETRY2)).toBeNull();
    expect(layer.querySelector(".rd-stage img")?.getAttribute("src")).toBe("blob:page");
    expect(document.activeElement, "focus on the stage, never the body").toBe(layer.querySelector(".rd-stage"));
  });

  it("R3: a failed retry in the reader leaves the line and an enabled button, announced again (fails now: no button)", async () => {
    const hold = gate();
    const { layer, flushSync } = await readerOnLostTwo((attempt, signal) => (attempt === 1 ? Promise.resolve(bad()) : hold.promise(signal)));
    /** @type {HTMLButtonElement} */ (layer.querySelector(RETRY2)).click();
    flushSync();
    await quiet();
    const watch = watchAlerts(layer);
    hold.release(bad());
    flushSync();
    await quiet();
    watch.stop();
    expect(layer.querySelector(".rd-lost")?.textContent).toBe(LINE);
    expect(/** @type {HTMLButtonElement} */ (layer.querySelector(RETRY2)).disabled).toBe(false);
    expect(watch.count()).toBeGreaterThanOrEqual(1);
  });
});

describe("reader on its own fetch: try again (#1870)", () => {
  it("R4: a lost page in a reader that fetches for itself is re-requested by its button (fails now: no button)", async () => {
    /** @type {number[]} */ const asked = [];
    vi.stubGlobal("fetch", vi.fn((/** @type {string} */ href) => {
      const n = pageOf(String(href));
      asked.push(n);
      return Promise.resolve(n === 2 && asked.filter((x) => x === 2).length === 1 ? bad() : ok());
    }));
    const doc = { ...documentRowOf(DOCUMENTS_FIXTURE["i-mot"][0]), pageCount: 3 };
    const { flushSync } = await page.mount("lib/reading/Reader.svelte", {
      open: true, doc, itemTitle: "Car MOT", onremove: async () => {}, pageHref: doc.previewHref,
    });
    await quiet();
    const layer = /** @type {HTMLElement} */ (document.querySelector(".rd-layer"));
    await click(layer, "Next page", flushSync);
    expect(layer.querySelector(".rd-lost")?.textContent, "lost first").toBe(LINE);
    await click(layer, "Try page 2 again", flushSync);
    expect(asked.filter((n) => n === 2), "one retry").toHaveLength(2);
    expect(layer.querySelector(".rd-lost")).toBeNull();
    expect(layer.querySelector(RETRY2)).toBeNull();
  });
});
