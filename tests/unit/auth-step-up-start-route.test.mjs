import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `POST /api/auth/step-up/start` (ADR-0023 §5): starts the OIDC step-up for a
 * signed-in member who has no password. Session + CSRF (real assertCsrf), no
 * recent-authentication guard (this IS the challenge). The intent must be one
 * of the closed list and is sealed with the session id and `maxAge: 0`, so the
 * proof is good for that action and that session only. A JSON caller gets
 * `{ location }`, a form post a 302; both no-store.
 */
const mocks = vi.hoisted(() => ({
  getAuthConfig: vi.fn(),
  requireSession: vi.fn(),
  assertOutsideMaintenance: vi.fn(),
  discoverProvider: vi.fn(),
  createAuthorizationUrl: vi.fn(),
  sealLoginTransaction: vi.fn(),
  setTransactionCookie: vi.fn(),
  assertKeyUsable: vi.fn(),
}));

vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal()),
  requireSession: mocks.requireSession,
}));
vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: mocks.assertOutsideMaintenance }));
vi.mock("orbit/lib/auth/oidc", () => ({
  discoverProvider: mocks.discoverProvider,
  createAuthorizationUrl: mocks.createAuthorizationUrl,
}));
vi.mock("orbit/lib/auth/crypto", async (importOriginal) => ({
  ...(await importOriginal()),
  sealLoginTransaction: mocks.sealLoginTransaction,
}));
vi.mock("orbit/lib/auth/cookies", () => ({ setTransactionCookie: mocks.setTransactionCookie }));
vi.mock("orbit/server/key-state", () => ({ assertKeyUsable: mocks.assertKeyUsable, noteRefusedSignIn: vi.fn() }));

const { POST } = await import("../../web/src/routes/api/auth/step-up/start/+server.js");
const { csrfTokenForSession } = await import("orbit/lib/auth/session");
const { AuthError } = await import("orbit/lib/auth/errors");
const { stepUpIntents } = await import("orbit/lib/auth/recent-auth");

const config = { appUrl: new URL("https://orbit.example"), sessionSecret: "s".repeat(48), oidc: { issuer: "https://idp.example" } };
const session = { id: "s-1", token: "tok-1", user: { id: "u-1" } };

function event(body, { headers = {}, csrf = csrfTokenForSession(session, config) } = {}) {
  const h = { origin: "https://orbit.example", ...headers };
  if (csrf) h["x-csrf-token"] = csrf;
  return {
    cookies: { get: vi.fn(), set: vi.fn() },
    request: new Request("https://orbit.example/api/auth/step-up/start", {
      method: "POST",
      headers: h,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  };
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getAuthConfig.mockReturnValue(config);
  mocks.requireSession.mockResolvedValue(session);
  mocks.discoverProvider.mockResolvedValue({});
  mocks.sealLoginTransaction.mockResolvedValue("sealed");
  mocks.createAuthorizationUrl.mockReturnValue(new URL("https://idp.example/auth?max_age=0"));
});

describe("POST /api/auth/step-up/start", () => {
  it("302s a form post to the provider and seals session id, intent and max_age 0", async () => {
    const e = event({ intent: "unlink_method", returnTo: "/settings" });
    const response = await POST(e);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://idp.example/auth?max_age=0");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.sealLoginTransaction.mock.calls[0][0]).toMatchObject({
      stepUpSessionId: "s-1",
      intent: "unlink_method",
      maxAge: 0,
      returnTo: "/settings",
    });
    expect(mocks.setTransactionCookie).toHaveBeenCalledWith(e.cookies, "sealed", config);
  });

  it("answers a JSON caller with the location instead of a redirect it could not read", async () => {
    const response = await POST(event({ intent: "link_oidc" }, { headers: { accept: "application/json" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ location: "https://idp.example/auth?max_age=0" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("accepts every intent on the closed list", async () => {
    for (const intent of stepUpIntents) {
      expect((await POST(event({ intent }))).status).toBe(302);
    }
  });

  it.each([{}, { intent: "delete_everything" }, { intent: 7 }, { intent: null }])("rejects the intent %j with 400 invalid_request", async (body) => {
    const response = await POST(event(body));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
    expect(mocks.setTransactionCookie).not.toHaveBeenCalled();
  });

  it("treats a malformed or non-object body as no intent (400, not 500)", async () => {
    expect((await POST(event("{not json"))).status).toBe(400);
    expect((await POST(event("null"))).status).toBe(400);
  });

  it("never lets an off-site returnTo into the sealed transaction", async () => {
    await POST(event({ intent: "link_oidc", returnTo: "https://evil.example/" }));
    expect(mocks.sealLoginTransaction.mock.calls[0][0].returnTo).toBe("/");
  });

  it("answers 503 auth_not_configured with no provider", async () => {
    mocks.getAuthConfig.mockReturnValue({ ...config, oidc: undefined });
    const response = await POST(event({ intent: "link_oidc" }));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("auth_not_configured");
  });

  it("refuses a signed-out caller with 401", async () => {
    mocks.requireSession.mockRejectedValue(new AuthError("session_required", "A valid session is required", 401));
    const response = await POST(event({ intent: "link_oidc" }));
    expect(response.status).toBe(401);
    expect(mocks.setTransactionCookie).not.toHaveBeenCalled();
  });

  it("refuses a missing CSRF token with 403 csrf_failed before any provider call", async () => {
    const response = await POST(event({ intent: "link_oidc" }, { csrf: "" }));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("csrf_failed");
    expect(mocks.discoverProvider).not.toHaveBeenCalled();
  });
});
