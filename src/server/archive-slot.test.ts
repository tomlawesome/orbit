import { afterEach, describe, expect, it } from "vitest";
import * as slot from "@/server/archive-slot";

/*
 * #1774 test 14: the archive slot core lives in the engine (`orbit/server/archive-slot`,
 * src/server/archive-slot.ts) so the document worker can hold it; behaviour
 * moved, not changed. Written from the specification before the module exists.
 *
 * Contract this file asks of the builder (the core carries no Request; the
 * web module keeps the request-bound parts and calls the core):
 *   claimArchiveSlot(): { release(): void } | null     take it now, or null
 *   awaitArchiveSlot(options?: { waitMs?: number; until?: AbortSignal; signal?: AbortSignal }):
 *       Promise<{ release(): void } | null>             longest waiter first;
 *       null when the wait runs out (default ORBIT_ARCHIVE_SLOT_WAIT_MS read
 *       from process.env at call time, else 600000) or `until`/`signal` aborts;
 *       already aborted: null at once, even if the slot is free
 *   archiveSlotHeld(): boolean
 * Releasing twice is harmless; a release hands the slot straight to the
 * longest waiter.
 */

type Claim = { release(): void } | null;
const claims: Claim[] = [];
const take = (claim: Claim) => { claims.push(claim); return claim; };
const takeLater = (promise: Promise<Claim>) => promise.then(take);
const PENDING = Symbol("pending");
const within = <T>(promise: Promise<T>, ms = 80) => Promise.race([promise, new Promise<typeof PENDING>((resolve) => setTimeout(() => resolve(PENDING), ms))]);

afterEach(async () => {
  delete process.env.ORBIT_ARCHIVE_SLOT_WAIT_MS;
  const deadline = Date.now() + 2_000;
  do {
    for (const claim of claims.splice(0)) claim?.release();
    await new Promise((resolve) => setTimeout(resolve, 5));
  } while (slot.archiveSlotHeld() && Date.now() < deadline);
});

describe("the slot core", () => {
  it("is taken by one and refused to the next until released, and a double release frees nothing twice", () => {
    expect(slot.archiveSlotHeld()).toBe(false);
    const first = take(slot.claimArchiveSlot());
    expect(first).not.toBeNull();
    expect(slot.archiveSlotHeld()).toBe(true);
    expect(slot.claimArchiveSlot()).toBeNull();
    first!.release();
    expect(slot.archiveSlotHeld()).toBe(false);
    const second = take(slot.claimArchiveSlot());
    expect(second).not.toBeNull();
    first!.release(); // the old claim cannot free the new holder's slot
    expect(slot.archiveSlotHeld()).toBe(true);
    expect(slot.claimArchiveSlot()).toBeNull();
  });

  it("answers an await at once when the slot is free", async () => {
    const claim = await within(takeLater(slot.awaitArchiveSlot({ waitMs: 5_000 })));
    expect(claim).not.toBe(PENDING);
    expect(claim).not.toBeNull();
    expect(slot.archiveSlotHeld()).toBe(true);
  });

  it("hands the slot to waiters in the order they came, straight from the release", async () => {
    const holder = take(slot.claimArchiveSlot())!;
    const order: string[] = [];
    const a = takeLater(slot.awaitArchiveSlot({ waitMs: 60_000 })).then((claim) => { order.push("a"); return claim; });
    const b = takeLater(slot.awaitArchiveSlot({ waitMs: 60_000 })).then((claim) => { order.push("b"); return claim; });
    expect(await within(a)).toBe(PENDING);
    holder.release();
    const first = await a;
    expect(first).not.toBeNull();
    expect(slot.archiveSlotHeld(), "handed on, never free in between").toBe(true);
    expect(slot.claimArchiveSlot(), "a newcomer cannot jump the queue").toBeNull();
    expect(await within(b)).toBe(PENDING);
    first!.release();
    expect(await b).not.toBeNull();
    expect(order).toEqual(["a", "b"]);
  });

  it("gives up with null when the wait runs out, and leaves the queue so the next waiter is not blocked by it", async () => {
    const holder = take(slot.claimArchiveSlot())!;
    const gone = slot.awaitArchiveSlot({ waitMs: 30 });
    const next = takeLater(slot.awaitArchiveSlot({ waitMs: 60_000 }));
    expect(await gone).toBeNull();
    holder.release();
    expect(await next).not.toBeNull();
  });

  it("reads the default wait from ORBIT_ARCHIVE_SLOT_WAIT_MS when none is given", async () => {
    process.env.ORBIT_ARCHIVE_SLOT_WAIT_MS = "40";
    take(slot.claimArchiveSlot());
    const began = Date.now();
    expect(await slot.awaitArchiveSlot()).toBeNull();
    expect(Date.now() - began).toBeLessThan(2_000);
  });

  it("leaves the queue and resolves null when `until` or `signal` aborts, and at once when already aborted", async () => {
    const holder = take(slot.claimArchiveSlot())!;
    const until = new AbortController();
    const signal = new AbortController();
    const byUntil = slot.awaitArchiveSlot({ waitMs: 60_000, until: until.signal });
    const bySignal = slot.awaitArchiveSlot({ waitMs: 60_000, signal: signal.signal });
    const survivor = takeLater(slot.awaitArchiveSlot({ waitMs: 60_000 }));
    expect(await within(byUntil)).toBe(PENDING);
    until.abort();
    signal.abort();
    expect(await byUntil).toBeNull();
    expect(await bySignal).toBeNull();
    const aborted = new AbortController();
    aborted.abort();
    holder.release();
    expect(await survivor).not.toBeNull();
    take(null);
    // Free again after the survivor lets go: an aborted await is still null.
    claims.splice(0).forEach((claim) => claim?.release());
    expect(await slot.awaitArchiveSlot({ until: aborted.signal })).toBeNull();
    expect(slot.archiveSlotHeld()).toBe(false);
  });
});
