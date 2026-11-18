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

/*
 * #1848 W-R1 (notes 59391, 59466). Names the tests fix for the build:
 *  - `readRelay` keeps the GET's `ETag` (module state) and `rotateRelay` sends
 *    it as `If-Match`; with none kept, no If-Match is sent.
 *  - 412 is an unknown outcome: `rotateRelayReconciled` re-reads instead of
 *    throwing. 429 is thrown as a WorkspaceError (status 429, code
 *    `relay_rotation_limited`) with no re-read.
 *  - `ROTATE_NOT_CONFIRMED` and `ROTATE_LIMITED` are exported from workspace.js
 *    beside ROTATE_UNCHANGED.
 */
function errorBody(code) {
  return JSON.stringify({ error: { code, message: "refused" } });
}

/**
 * @param {{ put: () => Response, gets: Array<{ etag?: string, relay: Record<string, unknown> }> }} script
 */
function stubRelayServer({ put, gets }) {
  const calls = { puts: [], gets: 0 };
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) return new Response(JSON.stringify({ user: null, csrfToken: "t" }), { status: 200 });
    if (href.includes("/api/settings/mail-relay")) {
      if (init?.method === "PUT") {
        calls.puts.push(new Headers(init.headers).get("if-match"));
        return put();
      }
      const next = gets[Math.min(calls.gets, gets.length - 1)];
      calls.gets += 1;
      return new Response(JSON.stringify({ relay: next.relay }), { status: 200, headers: next.etag ? { etag: next.etag } : {} });
    }
    return new Response("{}", { status: 404 });
  }));
  return calls;
}

describe("W-R1 (#1848): the conditional rotate on the client", () => {
  it("sends the ETag the last read kept as If-Match, and none when nothing was read", async () => {
    const calls = stubRelayServer({
      put: () => new Response(JSON.stringify({ relay: { address: NEW } }), { status: 200 }),
      gets: [{ etag: '"3"', relay: { address: OLD } }],
    });
    const { readRelay, rotateRelay } = await import("../../web/src/lib/data/workspace.js");
    await rotateRelay("rotate");
    expect(calls.puts).toEqual([null]);
    await readRelay();
    await rotateRelay("rotate");
    expect(calls.puts).toEqual([null, '"3"']);
  });

  it("a 412 re-reads, and an address that changed (another tab rotated) is shown but is not this press's rotation (#1879 W-F1)", async () => {
    const calls = stubRelayServer({
      put: () => new Response(errorBody("relay_changed"), { status: 412 }),
      gets: [{ etag: '"4"', relay: { address: NEW } }],
    });
    const { rotateRelayReconciled } = await import("../../web/src/lib/data/workspace.js");
    const outcome = await rotateRelayReconciled(OLD);
    expect(calls.gets).toBe(1);
    expect(outcome.rotated).toBe(false);
    expect(outcome.relay?.address).toBe(NEW);
  });

  it("a 412 whose re-read still shows the same address is not rotated, and the re-read's ETag is what the next press sends", async () => {
    const calls = stubRelayServer({
      put: () => new Response(errorBody("relay_changed"), { status: 412 }),
      gets: [{ etag: '"5"', relay: { address: OLD } }],
    });
    const { rotateRelayReconciled } = await import("../../web/src/lib/data/workspace.js");
    const outcome = await rotateRelayReconciled(OLD);
    expect(calls.gets).toBe(1);
    expect(outcome.rotated).toBe(false);
    expect(outcome.relay?.address).toBe(OLD);
    await rotateRelayReconciled(OLD);
    expect(calls.puts.at(-1)).toBe('"5"');
  });

  it("a 429 is thrown with its status and code, and is not re-read", async () => {
    const calls = stubRelayServer({
      put: () => new Response(errorBody("relay_rotation_limited"), { status: 429, headers: { "retry-after": "60" } }),
      gets: [{ relay: { address: OLD } }],
    });
    const { rotateRelayReconciled, WorkspaceError } = await import("../../web/src/lib/data/workspace.js");
    const thrown = await rotateRelayReconciled(OLD).then(() => null, (error) => error);
    expect(thrown).toBeInstanceOf(WorkspaceError);
    expect(thrown).toMatchObject({ status: 429, code: "relay_rotation_limited" });
    expect(calls.gets).toBe(0);
  });

  it("the screen messages for a limited rotate and for an unconfirmed one", async () => {
    stubFetch({});
    const workspace = await import("../../web/src/lib/data/workspace.js");
    expect(workspace.ROTATE_LIMITED).toBe("not rotated — rotated too often lately. your address is unchanged; try again later");
    expect(workspace.ROTATE_NOT_CONFIRMED).toBe("rotate not confirmed — your address still reads the same. try again");
  });
});
