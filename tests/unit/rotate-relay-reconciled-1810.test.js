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
