import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1444: GET /api/auth/sessions says, per row, whether the session began at
 * the sign-in provider (`viaProvider`), so settings can tell a reader the
 * provider signs them out only when it will. The route passes the flag from
 * `listSessions` through unchanged and reads nothing else of the token.
 */
const mocks = vi.hoisted(() => ({ listSessions: vi.fn() }));

vi.mock("orbit/lib/auth/session", () => ({ listSessions: mocks.listSessions }));
vi.mock("$lib/server/api.js", () => ({
  read: (/** @type {Function} */ handler) => (/** @type {unknown} */ event) =>
    handler(event, { id: "s-current", user: { id: "u1" } }),
}));

const row = (/** @type {string} */ id, /** @type {boolean} */ viaProvider) => ({
  id,
  createdAt: new Date("2026-10-01T09:00:00Z"),
  lastSeenAt: new Date("2026-10-02T09:00:00Z"),
  userAgent: null,
  viaProvider,
});

describe("GET /api/auth/sessions viaProvider (#1444)", () => {
  beforeEach(() => {
    mocks.listSessions.mockReset();
  });

  it("is true for a provider session and false for a password one, per row", async () => {
    mocks.listSessions.mockResolvedValue([row("s-current", false), row("s-other", true)]);
    const { GET } = await import("../../web/src/routes/api/auth/sessions/+server.js");
    const body = await (await GET(/** @type {any} */ ({}))).json();
    const byId = Object.fromEntries(body.sessions.map((/** @type {any} */ one) => [one.id, one]));
    expect(byId["s-current"].viaProvider).toBe(false);
    expect(byId["s-current"].current).toBe(true);
    expect(byId["s-other"].viaProvider).toBe(true);
  });

  it("is true for the current row when the current session is a provider one", async () => {
    mocks.listSessions.mockResolvedValue([row("s-current", true)]);
    const { GET } = await import("../../web/src/routes/api/auth/sessions/+server.js");
    const body = await (await GET(/** @type {any} */ ({}))).json();
    expect(body.sessions[0]).toMatchObject({ id: "s-current", current: true, viaProvider: true });
  });
});
