import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1810 W-F6: the Settings screen's "waiting for review" count must agree with
 * the inbox: mail held for a sender check is listed as ready and held, and the
 * inbox counts it under review, so Settings counts it too. Mail still being
 * read, or failed, is not waiting for review.
 */
const WORKSPACE_BODY = { workspace: { households: [], activeHouseholdId: null, fixtureToday: "2026-10-03" } };

function stubFetch(receipts) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) return new Response("", { status: 503 });
    if (href.includes("/api/workspace")) return new Response(JSON.stringify(WORKSPACE_BODY), { status: 200 });
    if (href.includes("/api/imap-inbox")) return new Response(JSON.stringify({ receipts }), { status: 200 });
    if (href.includes("/api/settings/mail-relay")) return new Response(JSON.stringify({ relay: {} }), { status: 200 });
    return new Response("{}", { status: 404 });
  }));
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe("W-F6: Settings' waiting count and the inbox's review lane agree", () => {
  it("counts addable mail and mail held for a sender check, not mail still reading", async () => {
    stubFetch([
      { id: "a", classification: "ready", canApprove: true },
      { id: "b", classification: "ready", canApprove: false, needsSenderCheck: true },
      { id: "c", classification: "waiting", canApprove: false },
    ]);
    const { readSettingsScreen, readInboxScreen } = await import("../../web/src/lib/data/workspace.js");
    const inbox = await readInboxScreen();
    const settings = await readSettingsScreen();
    expect(inbox.review).toHaveLength(2);
    expect(settings.waiting).toBe(inbox.review.length);
  });
});
