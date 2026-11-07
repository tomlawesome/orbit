import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `DELETE /api/auth/methods/local` (ADR-0023 §6): removes the caller's
 * password. Session + CSRF (real assertCsrf) + a fresh challenge, which the
 * route asks `requireRecentAuthentication` for under the "unlink_method"
 * intent, and hands the receipt to `unlinkLocal`, which refuses the last
 * method. The body is optional and read leniently: no body or garbage is left
 * to the guard, never a 500. Answers are no-store.
 */
const mocks = vi.hoisted(() => ({
  getAuthConfig: vi.fn(),
  requireSession: vi.fn(),
  assertOutsideMaintenance: vi.fn(),
  requireRecentAuthentication: vi.fn(),
  unlinkLocal: vi.fn(),
  assertKeyUsable: vi.fn(),
}));

vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/session", async (importOriginal) => ({ ...(await importOriginal()), requireSession: mocks.requireSession }));
vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: mocks.assertOutsideMaintenance }));
vi.mock("orbit/lib/auth/recent-auth", () => ({ requireRecentAuthentication: mocks.requireRecentAuthentication }));
vi.mock("orbit/server/local-credentials", () => ({ unlinkLocal: mocks.unlinkLocal }));
vi.mock("orbit/server/key-state", () => ({ assertKeyUsable: mocks.assertKeyUsable, noteRefusedSignIn: vi.fn() }));

const { DELETE } = await import("../../web/src/routes/api/auth/methods/local/+server.js");
const { csrfTokenForSession } = await import("orbit/lib/auth/session");
const { AuthError } = await import("orbit/lib/auth/errors");

const config = { appUrl: new URL("https://orbit.example"), sessionSecret: "s".repeat(48) };
const session = { id: "s-1", token: "tok-1", user: { id: "u-1" } };
const receipt = { userId: "u-1", intent: "unlink_method", method: "password" };

function event(body, { csrf = csrfTokenForSession(session, config), origin = "https://orbit.example" } = {}) {
  const headers = { origin };
  if (csrf) headers["x-csrf-token"] = csrf;
  return {
    cookies: { get: vi.fn() },
    request: new Request("https://orbit.example/api/auth/methods/local", {
      method: "DELETE",
      headers,
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    }),
  };
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getAuthConfig.mockReturnValue(config);
  mocks.requireSession.mockResolvedValue(session);
  mocks.requireRecentAuthentication.mockResolvedValue(receipt);
  mocks.unlinkLocal.mockResolvedValue({ unlinked: true });
});

describe("DELETE /api/auth/methods/local", () => {
  it("unlinks the caller's own password after a fresh challenge, no-store", async () => {
    const e = event({ password: "current-password" });
    const response = await DELETE(e);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ unlinked: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.requireRecentAuthentication).toHaveBeenCalledWith(e, session, { password: "current-password" }, "unlink_method");
    expect(mocks.unlinkLocal).toHaveBeenCalledWith("u-1", receipt);
  });

  it("hands the guard an empty body for no body, malformed JSON or a non-object, rather than failing", async () => {
    await DELETE(event(undefined));
    await DELETE(event("{oops"));
    await DELETE(event("null"));
    expect(mocks.requireRecentAuthentication.mock.calls.map((c) => c[2])).toEqual([{}, {}, {}]);
  });

  it("does not unlink when the challenge fails: 403 recent_authentication_required", async () => {
    mocks.requireRecentAuthentication.mockRejectedValue(new AuthError("recent_authentication_required", "Confirm it is you", 403));
    const response = await DELETE(event({ password: "wrong" }));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("recent_authentication_required");
    expect(mocks.unlinkLocal).not.toHaveBeenCalled();
  });

  it("surfaces the engine's refusal to remove the last sign-in method", async () => {
    mocks.unlinkLocal.mockRejectedValue(new AuthError("link_last_method", "Your last sign-in method cannot be removed", 409));
    const response = await DELETE(event({ password: "right" }));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("link_last_method");
  });

  it("refuses a signed-out caller with 401 before any challenge", async () => {
    mocks.requireSession.mockRejectedValue(new AuthError("session_required", "A valid session is required", 401));
    const response = await DELETE(event({ password: "x" }));
    expect(response.status).toBe(401);
    expect(mocks.requireRecentAuthentication).not.toHaveBeenCalled();
    expect(mocks.unlinkLocal).not.toHaveBeenCalled();
  });

  it("refuses a missing CSRF token and a cross-origin request before any challenge", async () => {
    expect((await DELETE(event({ password: "x" }, { csrf: "" }))).status).toBe(403);
    expect((await DELETE(event({ password: "x" }, { origin: "https://evil.example" }))).status).toBe(403);
    expect(mocks.requireRecentAuthentication).not.toHaveBeenCalled();
    expect(mocks.unlinkLocal).not.toHaveBeenCalled();
  });
});
