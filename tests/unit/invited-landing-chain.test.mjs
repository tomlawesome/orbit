import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * THE INVITED LANDING'S SERVER CHAIN (#871, audit finding T-F1).
 *
 * Redeeming an invitation at `/invite/[token]` sets the one-shot invited-
 * landing cookie and redirects 303 to "/"; the next `GET /api/auth/session`
 * reads and clears that cookie and answers `justJoined`. No test covered
 * either step (the rig spec starts from a fixture that sets `justJoined` by
 * hand). Both route files and the real cookie module run here, sharing one
 * in-memory cookie jar; only the session, the invitation store and the
 * household list are mocked at their own module boundaries.
 */
const mocks = vi.hoisted(() => ({
  readSession: vi.fn(),
  redeemInvitation: vi.fn(),
  inspectInvitation: vi.fn(),
  listVisibleHouseholds: vi.fn(),
}));

vi.mock("orbit/lib/env", () => ({ getAuthConfig: () => ({ secureCookies: false }) }));
vi.mock("orbit/lib/auth/session", () => ({
  readSession: mocks.readSession,
  requireSession: vi.fn(),
  assertCsrf: vi.fn(),
  csrfTokenForSession: () => "csrf-token",
}));
vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: vi.fn().mockResolvedValue(undefined) }));
vi.mock("orbit/server/key-state", () => ({ assertKeyUsable: vi.fn(), noteRefusedSignIn: vi.fn() }));
vi.mock("orbit/server/invitations", () => ({
  redeemInvitation: mocks.redeemInvitation,
  inspectInvitation: mocks.inspectInvitation,
}));
vi.mock("orbit/server/join-requests", () => ({ listVisibleHouseholds: mocks.listVisibleHouseholds }));

const COOKIE = "orbit-invited";
const session = {
  id: "s-1",
  user: { id: "u-1", email: "new@example.invalid" },
  activeHouseholdId: "h-1",
  expiresAt: new Date("2030-01-01T00:00:00.000Z"),
};

/** A SvelteKit-shaped cookie jar: set with maxAge 0 / empty value deletes. */
function jar() {
  const store = new Map();
  const sets = [];
  return {
    store,
    sets,
    get: (name) => store.get(name),
    set: (name, value, options) => {
      sets.push({ name, value, options });
      if (value === "" || options?.maxAge === 0) store.delete(name);
      else store.set(name, value);
    },
  };
}

async function redirectOf(promise) {
  try {
    await promise;
  } catch (thrown) {
    return thrown;
  }
  throw new Error("expected a redirect");
}

describe("invited-landing server chain (#871)", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.readSession.mockReset().mockResolvedValue(session);
    mocks.redeemInvitation.mockReset();
    mocks.inspectInvitation.mockReset();
    mocks.listVisibleHouseholds.mockReset().mockResolvedValue([{ id: "h-1" }]);
  });

  it.each(["joined", "already_member"])("redeeming (%s) sets the invited-landing cookie and redirects 303 to /", async (state) => {
    mocks.redeemInvitation.mockResolvedValue({ state });
    const cookies = jar();
    const { load } = await import("../../web/src/routes/invite/[token]/+page.server.js");

    const redirected = await redirectOf(load({ params: { token: "tok" }, cookies }));

    expect(redirected.status).toBe(303);
    expect(redirected.location).toBe("/");
    expect(cookies.get(COOKIE)).toBe("1");
    expect(cookies.sets.find((set) => set.name === COOKIE).options).toMatchObject({ httpOnly: true, path: "/" });
  });

  it("sets no invited-landing cookie when the invitation is refused", async () => {
    mocks.redeemInvitation.mockResolvedValue({ state: "expired", inviterName: "Sam" });
    const cookies = jar();
    const { load } = await import("../../web/src/routes/invite/[token]/+page.server.js");

    const data = await load({ params: { token: "tok" }, cookies });

    expect(data.state).toBe("expired");
    expect(cookies.get(COOKIE)).toBeUndefined();
  });

  it("the session route answers justJoined once after a redemption, then clears the cookie", async () => {
    mocks.redeemInvitation.mockResolvedValue({ state: "joined" });
    const cookies = jar();
    const { load } = await import("../../web/src/routes/invite/[token]/+page.server.js");
    await redirectOf(load({ params: { token: "tok" }, cookies }));
    const { GET } = await import("../../web/src/routes/api/auth/session/+server.js");
    const event = { cookies, request: new Request("http://localhost/api/auth/session") };

    const first = await (await GET(event)).json();
    expect(first.justJoined).toBe(true);
    expect(first.visibleHouseholds).toEqual([{ id: "h-1" }]);
    expect(cookies.get(COOKIE)).toBeUndefined();

    const second = await (await GET(event)).json();
    expect(second.authenticated).toBe(true);
    expect(second).not.toHaveProperty("justJoined");
    expect(second).not.toHaveProperty("visibleHouseholds");
    expect(mocks.listVisibleHouseholds).toHaveBeenCalledTimes(1);
  });
});
