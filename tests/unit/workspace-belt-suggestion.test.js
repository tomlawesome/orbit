import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1151 W2-Q4: readBelt already holds the workspace (it reads one itself at
 * the top, to find the household an id belongs to). For a mail-in receipt id
 * — no item matches, so it falls back to readItem(id) to build the
 * suggestion view — readItem used to read its OWN workspace from scratch,
 * so one readBelt call for a suggestion cost two /api/workspace round trips
 * instead of one.
 */

const WORKSPACE_BODY = {
  workspace: {
    households: [{ id: "h1", name: "Home", items: [], sections: [] }],
    activeHouseholdId: "h1",
    fixtureToday: "2026-10-03",
  },
};

const RECEIPT = {
  id: "r1",
  canApprove: true,
  householdId: "h1",
  proposal: { title: "Forwarded email" },
};

function stubFetch() {
  const workspaceCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) return new Response("", { status: 503 });
    if (href.includes("/api/workspace")) {
      workspaceCalls.push(href);
      return new Response(JSON.stringify(WORKSPACE_BODY), { status: 200 });
    }
    if (href.includes("/api/imap-inbox")) {
      return new Response(JSON.stringify({ receipts: [RECEIPT] }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${href}`);
  }));
  return workspaceCalls;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readBelt building a mail-in suggestion", () => {
  it("reads the workspace once, not twice", async () => {
    const workspaceCalls = stubFetch();
    const { readBelt } = await import("../../web/src/lib/data/workspace.js");
    const belt = await readBelt("r1");
    expect(belt?.suggestion).toBeTruthy();
    expect(workspaceCalls).toHaveLength(1);
  });
});
