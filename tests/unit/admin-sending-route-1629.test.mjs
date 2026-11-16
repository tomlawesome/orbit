import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `/api/admin/sending` (#1629, design note 54742): the Sending half of the
 * Mail card, beside `/api/admin/mailbox`. The route name, the `{ sending }`
 * answer and the `{ action: "set", expectedVersion, ...input }` body are the
 * tests' choice, mirroring the mailbox route; the input is
 * `{ via: "mailbox", senderName, senderAddress }` or
 * `{ via: "account", host, port, security, user, password, senderName, senderAddress }`.
 *
 * GET carries the sending half: sends as, via (and host, port, security),
 * the password's state (the mailbox's, or set by whom and when) and last
 * sent, never the password. POST hands the password straight to the engine,
 * which verifies before storing, and answers with no password in it.
 */
const mocks = vi.hoisted(() => ({
  getAuthConfig: vi.fn(),
  requireSession: vi.fn(),
  assertOutsideMaintenance: vi.fn(),
  readSendingSettings: vi.fn(),
  setSendingSettings: vi.fn(),
  assertKeyUsable: vi.fn(),
}));

vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/session", async (importOriginal) => ({ ...(await importOriginal()), requireSession: mocks.requireSession }));
vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: mocks.assertOutsideMaintenance }));
vi.mock("orbit/server/mail-in/sending-settings", async (importOriginal) => ({
  ...(await importOriginal()),
  readSendingSettings: mocks.readSendingSettings,
  setSendingSettings: mocks.setSendingSettings,
}));
vi.mock("orbit/server/key-state", () => ({ assertKeyUsable: mocks.assertKeyUsable, noteRefusedSignIn: vi.fn() }));

const route = () => import("../../web/src/routes/api/admin/sending/+server.js");
const { csrfTokenForSession } = await import("orbit/lib/auth/session");
const { AuthError } = await import("orbit/lib/auth/errors");
const { AppError } = await import("orbit/lib/app-error");

const PASSWORD = "fake-relay-pass-1629";
const config = { appUrl: new URL("https://orbit.example"), sessionSecret: "s".repeat(48) };
const session = { id: "s-1", token: "tok-1", user: { id: "admin-1" } };
const sendingView = {
  configured: true,
  via: "account",
  host: "smtp.relay.example",
  port: 465,
  security: "implicit_tls",
  user: "relay-user",
  sendsAs: "Orbit <orbit@orbit-test.example>",
  password: "set",
  credentialSetBy: "Ned Example",
  credentialSetAt: "2026-11-07T10:00:00.000Z",
  source: "ui",
  setBy: "Ned Example",
  setAt: "2026-11-07T10:00:00.000Z",
  lastSent: { what: "a reminder", at: "2026-11-07T11:00:00.000Z" },
  version: 2,
};
const anotherAccount = {
  via: "account",
  host: "smtp.relay.example",
  port: 465,
  security: "implicit_tls",
  user: "relay-user",
  password: PASSWORD,
  senderName: "Orbit",
  senderAddress: "orbit@orbit-test.example",
};

const getEvent = () => ({ cookies: {}, request: new Request("https://orbit.example/api/admin/sending") });
function postEvent(body, { csrf = csrfTokenForSession(session, config), origin = "https://orbit.example" } = {}) {
  const headers = { origin, "content-type": "application/json" };
  if (csrf) headers["x-csrf-token"] = csrf;
  return {
    cookies: {},
    request: new Request("https://orbit.example/api/admin/sending", { method: "POST", headers, body: JSON.stringify(body) }),
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getAuthConfig.mockReturnValue(config);
  mocks.requireSession.mockResolvedValue(session);
  mocks.readSendingSettings.mockResolvedValue(sendingView);
  mocks.setSendingSettings.mockResolvedValue({ outcome: "verified", settings: sendingView });
});

describe("GET /api/admin/sending", () => {
  it("answers the sending half as sending, no-store, read for the caller's own id", async () => {
    const { GET } = await route();
    const response = await GET(getEvent());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sending: sendingView });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.readSendingSettings).toHaveBeenCalledWith("admin-1");
  });

  it("passes a non-administrator's refusal through as 403, and refuses a signed-out caller with 401", async () => {
    const { GET } = await route();
    mocks.readSendingSettings.mockRejectedValueOnce(new AppError("administrator_required", "no", 403));
    expect((await GET(getEvent())).status).toBe(403);
    mocks.requireSession.mockRejectedValueOnce(new AuthError("session_required", "x", 401));
    expect((await GET(getEvent())).status).toBe(401);
  });
});

describe("POST /api/admin/sending", () => {
  it("hands another account, password and all, to the engine with the version the caller read, and answers without the password", async () => {
    const { POST } = await route();
    const response = await POST(postEvent({ action: "set", expectedVersion: 2, ...anotherAccount }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ sending: sendingView, outcome: "verified" });
    expect(JSON.stringify(body)).not.toContain(PASSWORD);
    expect(mocks.setSendingSettings).toHaveBeenCalledWith("admin-1", 2, expect.objectContaining(anotherAccount));
  });

  it("takes the mailbox account with only a sender, and a first save with a null version", async () => {
    const { POST } = await route();
    const response = await POST(postEvent({
      action: "set", expectedVersion: null, via: "mailbox", senderName: "Orbit", senderAddress: "orbit@orbit-test.example",
    }));
    expect(response.status).toBe(200);
    expect(mocks.setSendingSettings).toHaveBeenCalledWith("admin-1", null, expect.objectContaining({ via: "mailbox" }));
  });

  it("passes a failed sign-in's reason back as the outcome", async () => {
    const { POST } = await route();
    mocks.setSendingSettings.mockResolvedValueOnce({ outcome: "smtp_rejected", settings: { ...sendingView, configured: false } });
    const response = await POST(postEvent({ action: "set", expectedVersion: null, ...anotherAccount }));
    expect((await response.json()).outcome).toBe("smtp_rejected");
  });

  it("passes the engine's 409 through with its code", async () => {
    const { POST } = await route();
    mocks.setSendingSettings.mockRejectedValueOnce(new AppError("sending_version_conflict", "stale", 409));
    const response = await POST(postEvent({ action: "set", expectedVersion: 1, ...anotherAccount }));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("sending_version_conflict");
  });

  it("refuses a missing CSRF token and a cross-origin post, writing nothing", async () => {
    const { POST } = await route();
    expect((await POST(postEvent({ action: "set", expectedVersion: 1, ...anotherAccount }, { csrf: "" }))).status).toBe(403);
    expect((await POST(postEvent({ action: "set", expectedVersion: 1, ...anotherAccount }, { origin: "https://evil.example" }))).status).toBe(403);
    expect(mocks.setSendingSettings).not.toHaveBeenCalled();
  });
});
