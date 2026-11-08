import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `POST /api/admin/mailbox` with `{ action: "fetch_now" }` (#1651), beside
 * probe, enable/disable and rotate. The action name, the engine function
 * `fetchMailboxNow(actorId)` and the answer
 * `{ mailbox, outcome, messagesRead, receiptsRecorded, reasons }` are the
 * tests' choice, mirroring the probe. Refusals are outcomes, not errors:
 * "already_running" | "paused" | "not_configured" | "credential_locked" |
 * "not_checked" (with `reason`) | "provider_unavailable".
 */
const mocks = vi.hoisted(() => ({
  getAuthConfig: vi.fn(),
  requireSession: vi.fn(),
  assertOutsideMaintenance: vi.fn(),
  fetchMailboxNow: vi.fn(),
  assertKeyUsable: vi.fn(),
}));

vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/session", async (importOriginal) => ({ ...(await importOriginal()), requireSession: mocks.requireSession }));
vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: mocks.assertOutsideMaintenance }));
vi.mock("orbit/server/mail-in/mailbox-settings", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchMailboxNow: mocks.fetchMailboxNow,
}));
vi.mock("orbit/server/key-state", () => ({ assertKeyUsable: mocks.assertKeyUsable, noteRefusedSignIn: vi.fn() }));

const route = () => import("../../web/src/routes/api/admin/mailbox/+server.js");
const { csrfTokenForSession } = await import("orbit/lib/auth/session");
const { AuthError } = await import("orbit/lib/auth/errors");
const { AppError } = await import("orbit/lib/app-error");

const config = { appUrl: new URL("https://orbit.example"), sessionSecret: "s".repeat(48) };
const session = { id: "s-1", token: "tok-1", user: { id: "admin-1" } };
const view = { configured: true, enabled: true, version: 3 };
const reasons = { sender_unverified: 1, unattributed: 0, held: 2, provider_unavailable: 0 };

function postEvent(body, { csrf = csrfTokenForSession(session, config), origin = "https://orbit.example" } = {}) {
  const headers = { origin, "content-type": "application/json" };
  if (csrf) headers["x-csrf-token"] = csrf;
  return {
    cookies: {},
    request: new Request("https://orbit.example/api/admin/mailbox", { method: "POST", headers, body: JSON.stringify(body) }),
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getAuthConfig.mockReturnValue(config);
  mocks.requireSession.mockResolvedValue(session);
  mocks.fetchMailboxNow.mockResolvedValue({
    outcome: "fetched", reason: null, messagesRead: 4, receiptsRecorded: 3, reasons, settings: view,
  });
});

describe("POST /api/admin/mailbox fetch_now", () => {
  it("runs the engine for the caller's own id and answers the outcome, counts and reasons, no-store", async () => {
    const { POST } = await route();
    const response = await POST(postEvent({ action: "fetch_now" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      mailbox: view, outcome: "fetched", reason: null, messagesRead: 4, receiptsRecorded: 3, reasons,
    });
    expect(mocks.fetchMailboxNow).toHaveBeenCalledTimes(1);
    expect(mocks.fetchMailboxNow.mock.calls[0][0]).toBe("admin-1");
  });

  it.each(["already_running", "paused", "not_configured", "credential_locked", "not_checked", "provider_unavailable"])("passes the refusal %s back as the outcome", async (outcome) => {
    mocks.fetchMailboxNow.mockResolvedValueOnce({
      outcome, reason: outcome === "not_checked" ? "key_unavailable" : null, messagesRead: 0, receiptsRecorded: 0,
      reasons: { sender_unverified: 0, unattributed: 0, held: 0, provider_unavailable: 0 }, settings: view,
    });
    const { POST } = await route();
    const body = await (await POST(postEvent({ action: "fetch_now" }))).json();
    expect(body.outcome).toBe(outcome);
    expect(body.reason).toBe(outcome === "not_checked" ? "key_unavailable" : null);
    expect(body.messagesRead).toBe(0);
  });

  it("refuses a non-administrator with 403 and a signed-out caller with 401", async () => {
    const { POST } = await route();
    mocks.fetchMailboxNow.mockRejectedValueOnce(new AppError("administrator_required", "no", 403));
    const refused = await POST(postEvent({ action: "fetch_now" }));
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe("administrator_required");

    mocks.requireSession.mockRejectedValueOnce(new AuthError("session_required", "x", 401));
    expect((await POST(postEvent({ action: "fetch_now" }))).status).toBe(401);
  });

  it("refuses a missing CSRF token and a cross-origin post, running nothing", async () => {
    const { POST } = await route();
    expect((await POST(postEvent({ action: "fetch_now" }, { csrf: "" }))).status).toBe(403);
    expect((await POST(postEvent({ action: "fetch_now" }, { origin: "https://evil.example" }))).status).toBe(403);
    expect(mocks.fetchMailboxNow).not.toHaveBeenCalled();
  });
});
