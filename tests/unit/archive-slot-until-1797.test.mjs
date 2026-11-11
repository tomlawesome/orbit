import { afterEach, beforeAll, describe, expect, it } from "vitest";

/*
 * #1797 spec section 7 test 7: `awaitArchiveSlot(request, { until })` leaves
 * the queue and resolves null when `until` aborts, wired as the request's own
 * signal is; the waiters behind it keep their order. Fails today (the option
 * is ignored).
 */
/** @type {typeof import("../../web/src/lib/server/archive-slot.js")} */
let slot;
beforeAll(async () => { slot = await import("../../web/src/lib/server/archive-slot.js"); }, 30_000);

const claims = [];
afterEach(async () => {
  // A waiter the code under test failed to drop is handed the slot later: keep releasing until nothing holds it.
  const deadline = Date.now() + 2_000;
  do {
    for (const claim of claims.splice(0)) claim?.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (slot.archiveSlotHeld() && Date.now() < deadline);
});

const PENDING = Symbol("pending");
const within = (promise, ms = 150) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(PENDING), ms))]);
const take = (promise) => promise.then((claim) => { claims.push(claim); return claim; });
const request = () => new Request("http://orbit.invalid/x", { method: "POST" });

describe("#1797 test 7: awaitArchiveSlot takes an until signal", () => {
  it("resolves null and leaves the queue when until aborts; the waiters behind it keep their order", async () => {
    const holder = slot.claimArchiveSlot(request());
    claims.push(holder);
    expect(holder).not.toBeNull();
    const controller = new AbortController();
    const leaver = take(slot.awaitArchiveSlot(request(), { waitMs: 60_000, until: controller.signal }));
    const order = [];
    const second = take(slot.awaitArchiveSlot(request(), { waitMs: 60_000 })).then((claim) => { order.push("second"); return claim; });
    const third = take(slot.awaitArchiveSlot(request(), { waitMs: 60_000 })).then((claim) => { order.push("third"); return claim; });

    expect(await within(leaver)).toBe(PENDING);
    controller.abort();
    expect(await within(leaver), "the aborted waiter resolves null").toBeNull();
    expect(await within(second, 50), "the others still wait").toBe(PENDING);

    holder.release();
    const secondClaim = await within(second);
    expect(secondClaim, "the slot goes to the next waiter, not to the one that left").not.toBe(PENDING);
    expect(secondClaim).not.toBeNull();
    expect(await within(third, 50), "third waits for second").toBe(PENDING);
    secondClaim.release();
    const thirdClaim = await within(third);
    expect(thirdClaim).not.toBeNull();
    expect(order).toEqual(["second", "third"]);
    thirdClaim.release();
  });

  it("an until that is already aborted resolves null when the slot is held", async () => {
    claims.push(slot.claimArchiveSlot(request()));
    const controller = new AbortController();
    controller.abort();
    expect(await within(take(slot.awaitArchiveSlot(request(), { waitMs: 60_000, until: controller.signal })))).toBeNull();
  });

  it("without until, and with the slot free, it is taken at once as before", async () => {
    const claim = await within(take(slot.awaitArchiveSlot(request(), { waitMs: 60_000, until: new AbortController().signal })));
    expect(claim).not.toBeNull();
    expect(claim).not.toBe(PENDING);
  });
});
