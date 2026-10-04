import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1151 W2-F2: readInboxScreen's `lastCaught` came from
 * `receipts.map(r => r.receivedAt).sort().pop()`. `Array.prototype.sort()`
 * compares its elements as strings, and a receipt with no `receivedAt` (the
 * field is optional) sorts as the string "null" or "undefined" — which, by
 * plain character comparison, sorts AFTER every real ISO timestamp (the
 * letters "n"/"u" come after the digit "2"). So one caught-but-undated
 * receipt in the list hid the real last-caught time behind a blank one.
 */

const WORKSPACE_BODY = {
  workspace: { households: [], activeHouseholdId: null, fixtureToday: "2026-10-03" },
};

/** @param {Array<{classification: string, receivedAt?: string}>} receipts */
function stubFetch(receipts) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) return new Response("", { status: 503 });
    if (href.includes("/api/workspace")) {
      return new Response(JSON.stringify(WORKSPACE_BODY), { status: 200 });
    }
    if (href.includes("/api/imap-inbox")) {
      return new Response(JSON.stringify({ receipts }), { status: 200 });
    }
    if (href.includes("/api/settings/mail-relay")) {
      return new Response(JSON.stringify({ relay: {} }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${href}`);
  }));
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readInboxScreen lastCaught", () => {
  it("ignores a caught receipt with no receivedAt instead of letting it win the sort", async () => {
    stubFetch([
      { classification: "approved", receivedAt: "2026-09-30T10:00:00.000Z" },
      { classification: "approved" },
    ]);
    const { readInboxScreen } = await import("../../web/src/lib/data/workspace.js");
    await expect(readInboxScreen()).resolves.toMatchObject({
      lastCaught: "2026-09-30T10:00:00.000Z",
    });
  });

  it("still reports null when nothing has been caught", async () => {
    stubFetch([{ classification: "waiting" }]);
    const { readInboxScreen } = await import("../../web/src/lib/data/workspace.js");
    await expect(readInboxScreen()).resolves.toMatchObject({ lastCaught: null });
  });
});
