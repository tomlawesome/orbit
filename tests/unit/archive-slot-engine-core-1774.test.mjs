import { afterEach, beforeAll, describe, expect, it } from "vitest";

/*
 * #1774 test 14, the other half: the web module's slot and the engine's core
 * are ONE slot. The worker's export job (engine) and an import or preview
 * request (web) take turns, never both. The web module keeps its signatures
 * (claimArchiveSlot(request), awaitArchiveSlot(request, options),
 * archiveSlotHeld(), holdArchiveSlot ...) and re-exports/uses the core; its
 * own unit tests (archive-slot*.test.mjs) pass unchanged.
 */
/** @type {typeof import("../../web/src/lib/server/archive-slot.js")} */
let web;
/** @type {typeof import("../../src/server/archive-slot.ts")} */
let core;
beforeAll(async () => {
  web = await import("../../web/src/lib/server/archive-slot.js");
  core = await import("orbit/server/archive-slot");
}, 30_000);

const claims = [];
afterEach(() => { for (const claim of claims.splice(0)) claim?.release(); });
const request = () => new Request("http://orbit.invalid/x", { method: "POST" });

describe("one slot for the engine and the web module", () => {
  it("is held against the engine when a request holds it, and the other way round", () => {
    const fromWeb = web.claimArchiveSlot(request());
    claims.push(fromWeb);
    expect(fromWeb).not.toBeNull();
    expect(core.archiveSlotHeld()).toBe(true);
    expect(core.claimArchiveSlot()).toBeNull();
    fromWeb.release();
    expect(core.archiveSlotHeld()).toBe(false);

    const fromCore = core.claimArchiveSlot();
    claims.push(fromCore);
    expect(fromCore).not.toBeNull();
    expect(web.archiveSlotHeld()).toBe(true);
    expect(web.claimArchiveSlot(request())).toBeNull();
  });

  it("hands a release in the engine to a spooled request waiting in the web module, longest first", async () => {
    const held = core.claimArchiveSlot();
    claims.push(held);
    const waiter = web.awaitArchiveSlot(request(), { waitMs: 5_000 });
    const engineWaiter = core.awaitArchiveSlot({ waitMs: 5_000 });
    held.release();
    const claim = await waiter;
    claims.push(claim);
    expect(claim).not.toBeNull();
    let engineSettled = false;
    void engineWaiter.then(() => { engineSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(engineSettled, "the engine's waiter is behind the web request that came first").toBe(false);
    claim.release();
    const second = await engineWaiter;
    claims.push(second);
    expect(second).not.toBeNull();
  });

  it("keeps the request-bound parts in the web module", () => {
    for (const name of ["holdArchiveSlot", "watchArchiveBody", "claimUploadLane", "uploadLaneHeld", "isArchiveSlotRequest", "archiveBusy"]) {
      expect(typeof web[name], `${name} stays on the web module`).toBe("function");
    }
  });
});
