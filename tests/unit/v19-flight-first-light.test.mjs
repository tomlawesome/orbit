import { describe, expect, it } from "vitest";

import { SEEN_FRESH_MS, SEEN_KEY, isFirstVisit } from "../../web/src/lib/flight/door-seen.js";

/* #1253: first light is orbit-site's (main.js showDoor): `lit` waits for the
   pieces and, on a first visit, a lap of the runner, and never for ever. Since
   #1371 the waiting is the shared door's own `dawn.light()` (the folder,
   unchanged); what stays Orbit's is whether this browser has seen the door
   lately, which is what Orbit tells it (`firstVisit`). */

/** @param {Record<string, string>} [kept] */
const storage = (kept = {}) => ({
  getItem: (/** @type {string} */ k) => kept[k] ?? null,
  setItem: (/** @type {string} */ k, /** @type {string} */ v) => { kept[k] = v; },
});

describe("a first visit", () => {
  it("is a browser that has not seen the door, and records the visit", () => {
    const s = storage();
    expect(isFirstVisit(s, 1000)).toBe(true);
    expect(isFirstVisit(s, 2000)).toBe(false);
  });

  it("comes again after 36 hours", () => {
    const s = storage({ [SEEN_KEY]: "0" });
    expect(isFirstVisit(s, SEEN_FRESH_MS)).toBe(false);
    expect(isFirstVisit(s, SEEN_FRESH_MS * 2 + 1)).toBe(true);
  });

  it("is what a browser that will not say gets", () => {
    expect(isFirstVisit(undefined)).toBe(true);
    expect(isFirstVisit({ getItem() { throw new Error("no"); }, setItem() {} })).toBe(true);
  });
});
