import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1901 (ruling 1, W-F1 / A-S2 / W-R1): the new-password route saves, THEN
 * mints the session, and only after the mint clears the hold cookie and sets
 * the session cookie. A refusal that lands between the save and the mint
 * answers with a fresh hold; any other throw after the save is reported as a
 * saved password the reader signs in with. Every collaborator is mocked at
 * its module boundary (the pattern of auth-pending-login-session-callback),
 * so this pins the route's own ordering and answers.
 */

const calls = [];
const mocks = vi.hoisted(() => ({
  getAuthConfig: vi.fn(),
  assertSameOrigin: vi.fn(),
  openPasswordChangeHold: vi.fn(),
  issuePasswordChangeHold: vi.fn(),
  clearPasswordChangeCookie: vi.fn(),
  completePasswordRenewal: vi.fn(),
  assertNotRefusedPassword: vi.fn(),
  hashPassword: vi.fn(),
  createSession: vi.fn(),
  deleteSessionToken: vi.fn(),
  setSessionCookie: vi.fn(),
}));

vi.mock("orbit/lib/auth/cookies", () => ({
  sessionCookieName: () => "orbit_session",
  setSessionCookie: mocks.setSessionCookie,
}));
vi.mock("orbit/lib/auth/password", async (importOriginal) => ({
  ...(await importOriginal()),
  hashPassword: mocks.hashPassword,
}));
vi.mock("orbit/lib/auth/password-change-hold", () => ({
  openPasswordChangeHold: mocks.openPasswordChangeHold,
  issuePasswordChangeHold: mocks.issuePasswordChangeHold,
  clearPasswordChangeCookie: mocks.clearPasswordChangeCookie,
}));
vi.mock("orbit/lib/auth/session", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  createSession: mocks.createSession,
  deleteSessionToken: mocks.deleteSessionToken,
}));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/server/local-credentials", () => ({
  assertNotRefusedPassword: mocks.assertNotRefusedPassword,
  completePasswordRenewal: mocks.completePasswordRenewal,
}));

/* Loaded after each resetModules, from the specifier the route uses, so instanceof holds. */
async function refusal(userId, at) {
  const { PasswordChangeRequiredError } = await import("orbit/lib/auth/errors");
  return new PasswordChangeRequiredError(userId, at);
}

const config = { appUrl: "https://orbit.example" };
const REQUIRED_AT = new Date("2026-11-19T09:00:00.000Z");
const REMARKED_AT = new Date("2026-11-19T09:05:00.000Z");
const PASSWORD = "a-brand-new-password-1901";

function event() {
  return {
    cookies: { get: vi.fn(() => "old-session") },
    request: new Request("https://orbit.example/api/auth/local/login/new-password", {
      method: "POST",
      headers: { "content-type": "application/json", origin: config.appUrl, "user-agent": "test" },
      body: JSON.stringify({ password: PASSWORD, passwordAgain: PASSWORD }),
    }),
  };
}

async function post() {
  const { POST } = await import("../../web/src/routes/api/auth/local/login/new-password/+server.js");
  return POST(event());
}

beforeEach(() => {
  vi.resetModules();
  calls.length = 0;
  for (const mock of Object.values(mocks)) mock.mockReset?.();
  mocks.getAuthConfig.mockReturnValue(config);
  mocks.openPasswordChangeHold.mockResolvedValue({ userId: "u1", requiredAt: REQUIRED_AT });
  mocks.assertNotRefusedPassword.mockResolvedValue(undefined);
  mocks.hashPassword.mockResolvedValue("hash");
  mocks.completePasswordRenewal.mockImplementation(async () => { calls.push("save"); return { replaced: true }; });
  mocks.createSession.mockImplementation(async () => { calls.push("mint"); return { token: "new-token" }; });
  mocks.deleteSessionToken.mockImplementation(async () => { calls.push("delete-old"); });
  mocks.clearPasswordChangeCookie.mockImplementation(() => { calls.push("clear-hold"); });
  mocks.setSessionCookie.mockImplementation(() => { calls.push("set-session"); });
  mocks.issuePasswordChangeHold.mockImplementation(async (_cookies, refusal) => {
    calls.push("issue-hold");
    return { refusedAt: refusal.requiredAt.toISOString(), expiresAt: "2026-11-19T09:15:00.000Z" };
  });
});

describe("POST /api/auth/local/login/new-password order (#1901 W-F1)", () => {
  it("saves, mints the session, and only then clears the hold and sets the session cookie", async () => {
    const response = await post();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: true });
    expect(calls.indexOf("save")).toBe(0);
    expect(calls.indexOf("mint")).toBeGreaterThan(calls.indexOf("save"));
    expect(calls.indexOf("clear-hold")).toBeGreaterThan(calls.indexOf("mint"));
    expect(calls.indexOf("set-session")).toBeGreaterThan(calls.indexOf("mint"));
  });

  it("does not clear the hold before the session exists", async () => {
    mocks.createSession.mockImplementation(async () => {
      expect(mocks.clearPasswordChangeCookie, "hold cleared before the session was minted").not.toHaveBeenCalled();
      expect(mocks.setSessionCookie).not.toHaveBeenCalled();
      return { token: "new-token" };
    });
    expect((await post()).status).toBe(200);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
  });

  it("leaves the hold alone when the save itself is refused", async () => {
    const { AuthError } = await import("orbit/lib/auth/errors");
    mocks.completePasswordRenewal.mockRejectedValue(new AuthError("password_change_lapsed", "lapsed", 400));
    const response = await post();

    expect(response.status).toBe(400);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.clearPasswordChangeCookie).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/local/login/new-password when the mint fails after the save (#1901 A-S2)", () => {
  it("answers a fresh hold when the account was marked again, and clears nothing", async () => {
    mocks.createSession.mockImplementation(async () => { throw await refusal("u1", REMARKED_AT); });
    const response = await post();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      saved: true,
      state: "password_change_required",
      refusedAt: REMARKED_AT.toISOString(),
    });
    expect(mocks.issuePasswordChangeHold).toHaveBeenCalledTimes(1);
    expect(mocks.issuePasswordChangeHold.mock.calls[0][1]).toMatchObject({ userId: "u1", requiredAt: REMARKED_AT });
    expect(mocks.clearPasswordChangeCookie).not.toHaveBeenCalled();
    expect(mocks.setSessionCookie).not.toHaveBeenCalled();
  });

  it("answers sign_in_again and clears the hold on any other throw", async () => {
    mocks.createSession.mockRejectedValue(new Error("database unavailable"));
    const response = await post();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saved: true, state: "sign_in_again" });
    expect(mocks.clearPasswordChangeCookie).toHaveBeenCalledTimes(1);
    expect(mocks.issuePasswordChangeHold).not.toHaveBeenCalled();
    expect(mocks.setSessionCookie).not.toHaveBeenCalled();
  });
});
