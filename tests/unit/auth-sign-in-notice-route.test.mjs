import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `GET /api/auth/sign-in-notice` (#1033, ADR-0027): a signed-in reader is told,
 * once, that a sign-in to their account was refused. A read that writes (the
 * notice is taken). Scoped to the caller's own id, takes nothing from the
 * request, `null` is the ordinary answer, no-store, and fixtures never show a
 * refusal.
 */
const mocks = vi.hoisted(() => ({
  getAuthConfig: vi.fn(),
  requireSession: vi.fn(),
  assertOutsideMaintenance: vi.fn(),
  takeDeniedSignInNotice: vi.fn(),
  assertKeyUsable: vi.fn(),
}));

vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/session", async (importOriginal) => ({ ...(await importOriginal()), requireSession: mocks.requireSession }));
vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: mocks.assertOutsideMaintenance }));
vi.mock("orbit/server/sign-in-approvals", () => ({ takeDeniedSignInNotice: mocks.takeDeniedSignInNotice }));
vi.mock("orbit/server/key-state", () => ({ assertKeyUsable: mocks.assertKeyUsable, noteRefusedSignIn: vi.fn() }));

const { GET } = await import("../../web/src/routes/api/auth/sign-in-notice/+server.js");
const { AuthError } = await import("orbit/lib/auth/errors");
const { MaintenanceActiveError } = await import("orbit/lib/errors");

const event = (search = "") => ({
  cookies: { get: vi.fn() },
  url: new URL(`https://orbit.example/api/auth/sign-in-notice${search}`),
  request: new Request(`https://orbit.example/api/auth/sign-in-notice${search}`),
});

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getAuthConfig.mockReturnValue({});
  mocks.requireSession.mockResolvedValue({ user: { id: "u-1" } });
  mocks.takeDeniedSignInNotice.mockResolvedValue(null);
});

describe("GET /api/auth/sign-in-notice", () => {
  it("answers null, no-store, when nothing was refused", async () => {
    const response = await GET(event());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ notice: null });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers the refusal's time as ISO 8601 and takes it for the caller's own id only", async () => {
    mocks.takeDeniedSignInNotice.mockResolvedValue({ deniedAt: new Date("2026-10-01T10:20:30.000Z") });
    const response = await GET(event("?userId=someone-else"));
    expect(await response.json()).toEqual({ notice: { deniedAt: "2026-10-01T10:20:30.000Z" } });
    expect(mocks.takeDeniedSignInNotice).toHaveBeenCalledTimes(1);
    expect(mocks.takeDeniedSignInNotice).toHaveBeenCalledWith("u-1");
  });

  it("refuses a signed-out reader with 401 and takes nothing", async () => {
    mocks.requireSession.mockRejectedValue(new AuthError("session_required", "A valid session is required", 401));
    const response = await GET(event());
    expect(response.status).toBe(401);
    expect(mocks.takeDeniedSignInNotice).not.toHaveBeenCalled();
  });

  it("answers 503 during maintenance without taking the notice", async () => {
    mocks.assertOutsideMaintenance.mockRejectedValue(new MaintenanceActiveError(null));
    const response = await GET(event());
    expect(response.status).toBe(503);
    expect(mocks.takeDeniedSignInNotice).not.toHaveBeenCalled();
  });

  it("answers null under fixtures without reaching the engine", async () => {
    vi.stubEnv("ORBIT_FIXTURES", "1");
    const response = await GET(event());
    expect(await response.json()).toEqual({ notice: null });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.takeDeniedSignInNotice).not.toHaveBeenCalled();
  });
});
