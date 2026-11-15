import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1810 W-R2 (review): a rotate whose answer is lost is re-read. A re-read
 * that names no address confirms nothing, so it must not count as a new
 * address (the phone would say "new address"). Only a different, real
 * address is a rotation.
 */
const OLD = "orbit+k7q2@harlow.example";
const NEW = "orbit+n3w9@harlow.example";

/** @param {Record<string, unknown>} reread the relay the GET answers after the PUT is lost */
function stubFetch(reread) {
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) return new Response(JSON.stringify({ user: null, csrfToken: "t" }), { status: 200 });
    if (href.includes("/api/settings/mail-relay")) {
      if (init?.method === "PUT") throw new TypeError("network connection was lost");
      return new Response(JSON.stringify({ relay: reread }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }));
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe("W-R2: the re-read after a lost rotate", () => {
  it("a re-read with no address is not confirmed, not a new address", async () => {
    stubFetch({});
    const { rotateRelayReconciled } = await import("../../web/src/lib/data/workspace.js");
    expect(await rotateRelayReconciled(OLD)).toEqual({ relay: null, rotated: null });
  });

  it("a re-read with a different address is a rotation, and shows it", async () => {
    stubFetch({ address: NEW });
    const { rotateRelayReconciled } = await import("../../web/src/lib/data/workspace.js");
    const outcome = await rotateRelayReconciled(OLD);
    expect(outcome.rotated).toBe(true);
    expect(outcome.relay?.address).toBe(NEW);
  });

  it("a re-read with the old address is unchanged", async () => {
    stubFetch({ address: OLD });
    const { rotateRelayReconciled } = await import("../../web/src/lib/data/workspace.js");
    expect((await rotateRelayReconciled(OLD)).rotated).toBe(false);
  });
});

/*
 * #1823 W-R2: the rotate request and its reconcile read are bounded by
 * AbortSignal.timeout(STAGED_PAGE_TIMEOUT_MS), as adminFetch is; a stall ends
 * in the existing failure state ({ relay: null, rotated: null }), not a hang.
 * Fake timers drive the clock, and AbortSignal.timeout is replaced by one on
 * the faked setTimeout so the abort happens in test time.
 */
describe("W-R2 (#1823): a stalled rotate or re-read is bounded by the timeout", () => {
  afterEach(() => vi.useRealTimers());

  it("a rotate whose request and re-read both stall ends in the unknown state once the timeout passes", async () => {
    vi.useFakeTimers();
    const timeouts = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      timeouts.push(ms);
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    const unsignalled = [];
    vi.stubGlobal("fetch", vi.fn((url, init) => {
      const href = String(url);
      if (href.includes("/api/auth/session")) return Promise.resolve(new Response(JSON.stringify({ user: null, csrfToken: "t" }), { status: 200 }));
      return new Promise((_resolve, reject) => {
        if (!init?.signal) { unsignalled.push(`${init?.method ?? "GET"} ${href}`); return; } // stalls forever
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      });
    }));
    const { rotateRelayReconciled } = await import("../../web/src/lib/data/workspace.js");
    const { STAGED_PAGE_TIMEOUT_MS } = await import("../../web/src/lib/data/staged-page.js");

    let outcome;
    const done = rotateRelayReconciled(OLD).then((value) => { outcome = value; });
    for (let step = 0; step < 4 && outcome === undefined; step += 1) await vi.advanceTimersByTimeAsync(STAGED_PAGE_TIMEOUT_MS);

    expect(unsignalled, "every relay request carries the timeout signal").toEqual([]);
    expect(timeouts).toContain(STAGED_PAGE_TIMEOUT_MS);
    expect(outcome, "the stall ended").toEqual({ relay: null, rotated: null });
    await done;
  });
});
