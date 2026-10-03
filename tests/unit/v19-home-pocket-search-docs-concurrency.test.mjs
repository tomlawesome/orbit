import { describe, expect, it } from "vitest";

import { readSearchDocuments, SEARCH_DOC_CONCURRENCY } from "../../web/src/routes/home/pocket-search.js";

/*
 * #1151 W1-R9 (now shared per W1-Q8): loadSearchDocuments() used to map
 * every active item carrying documents straight into Promise.all, with no
 * cap — a household with hundreds or thousands of such items fired that
 * many simultaneous requests the instant the search sheet opened.
 *
 * readSearchDocuments() runs a small fixed pool of workers that each pull
 * the next item off a shared cursor, so at most SEARCH_DOC_CONCURRENCY
 * readItemDocuments() calls are ever in flight at once. Real behaviour is
 * tested here directly, now that the fetch loop is a plain, importable
 * function rather than something only a .svelte file carried.
 */

/** A controllable "fetch": resolves only once release() is called, and
 *  tracks the running/peak count of calls in flight. */
function trackedReader() {
  let inFlight = 0;
  let peak = 0;
  /** @type {(() => void)[]} */
  const releasers = [];
  const read = (/** @type {string} */ householdId, /** @type {string} */ itemId) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    return new Promise((resolve) => {
      releasers.push(() => {
        inFlight--;
        resolve([{ id: `${itemId}-doc`, name: `${itemId} paper`, itemId }]);
      });
    });
  };
  return { read, releasers: () => releasers, peak: () => peak };
}

describe("#1151 W1-R9/W1-Q8: readSearchDocuments caps concurrent reads", () => {
  it("never has more than SEARCH_DOC_CONCURRENCY requests in flight at once", async () => {
    const carrying = Array.from({ length: 20 }, (_, i) => ({ id: `item-${i}`, title: `Item ${i}` }));
    const tracked = trackedReader();
    const resultPromise = readSearchDocuments(carrying, tracked.read, "hh1", () => false);
    // Let every worker start and block on its own request.
    await new Promise((r) => setTimeout(r, 0));
    expect(tracked.peak()).toBeLessThanOrEqual(SEARCH_DOC_CONCURRENCY);
    expect(tracked.peak()).toBe(Math.min(SEARCH_DOC_CONCURRENCY, carrying.length));
    // Release them all; the pool should drain the rest of the 20 items the
    // same way, never exceeding the cap.
    while (tracked.releasers().length) {
      tracked.releasers().shift()?.();
      await new Promise((r) => setTimeout(r, 0));
      expect(tracked.peak()).toBeLessThanOrEqual(SEARCH_DOC_CONCURRENCY);
    }
    const found = await resultPromise;
    expect(found.length).toBe(carrying.length);
  });

  it("drops only the failing item's own papers, not the whole search", async () => {
    const carrying = [{ id: "ok", title: "OK" }, { id: "bad", title: "Bad" }];
    const read = async (/** @type {string} */ hh, /** @type {string} */ id) => {
      if (id === "bad") throw new Error("boom");
      return [{ id: `${id}-doc`, name: "paper", itemId: id }];
    };
    const found = await readSearchDocuments(carrying, read, "hh1", () => false);
    expect(found).toHaveLength(1);
    expect(found[0].itemId).toBe("ok");
  });

  it("stops early once the caller reports its household has moved on", async () => {
    const carrying = Array.from({ length: 10 }, (_, i) => ({ id: `item-${i}`, title: `Item ${i}` }));
    let calls = 0;
    const read = async () => { calls++; return []; };
    let becomeStale = false;
    const found = await readSearchDocuments(carrying, read, "hh1", () => becomeStale);
    void found;
    becomeStale = true;
    // A second call with the flag already set makes no further reads.
    calls = 0;
    await readSearchDocuments(carrying, read, "hh1", () => becomeStale);
    expect(calls).toBe(0);
  });
});
