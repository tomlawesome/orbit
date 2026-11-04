import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `GET /api/admin/health` (#1000): the real service rows and build stamp for
 * the administration screen. `read()` covers maintenance and session; the
 * administrator check runs first inside the handler, so a non-administrator
 * learns nothing and `getAdministratorHealth` is never called for them.
 * no-store.
 */
const mocks = vi.hoisted(() => ({
  getAuthConfig: vi.fn(),
  requireSession: vi.fn(),
  assertOutsideMaintenance: vi.fn(),
  requireInstanceAdministrator: vi.fn(),
  getAdministratorHealth: vi.fn(),
  assertKeyUsable: vi.fn(),
}));

vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/session", async (importOriginal) => ({ ...(await importOriginal()), requireSession: mocks.requireSession }));
vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: mocks.assertOutsideMaintenance }));
vi.mock("orbit/server/authorization", () => ({ requireInstanceAdministrator: mocks.requireInstanceAdministrator }));
vi.mock("orbit/server/admin-health", () => ({ getAdministratorHealth: mocks.getAdministratorHealth }));
vi.mock("orbit/server/key-state", () => ({ assertKeyUsable: mocks.assertKeyUsable, noteRefusedSignIn: vi.fn() }));

const { GET } = await import("../../web/src/routes/api/admin/health/+server.js");
const { AuthError } = await import("orbit/lib/auth/errors");
const { AppError } = await import("orbit/lib/app-error");
const { MaintenanceActiveError } = await import("orbit/lib/errors");

const event = { cookies: {}, request: new Request("https://orbit.example/api/admin/health") };
const health = { build: { version: "0.3.7" }, services: [{ service: "orbit-app", state: "healthy" }] };

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getAuthConfig.mockReturnValue({});
  mocks.requireSession.mockResolvedValue({ user: { id: "admin-1" } });
  mocks.requireInstanceAdministrator.mockResolvedValue(undefined);
  mocks.getAdministratorHealth.mockResolvedValue(health);
});

describe("GET /api/admin/health", () => {
  it("answers the health snapshot to an administrator, no-store", async () => {
    const response = await GET(event);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ health });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.requireInstanceAdministrator).toHaveBeenCalledWith("admin-1");
  });

  it("refuses a non-administrator with 403 and never gathers the health data", async () => {
    mocks.requireInstanceAdministrator.mockRejectedValue(new AppError("administrator_required", "Orbit administrator access is required", 403));
    const response = await GET(event);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("administrator_required");
    expect(mocks.getAdministratorHealth).not.toHaveBeenCalled();
  });

  it("refuses a signed-out caller with 401 before the administrator check", async () => {
    mocks.requireSession.mockRejectedValue(new AuthError("session_required", "A valid session is required", 401));
    const response = await GET(event);
    expect(response.status).toBe(401);
    expect(mocks.requireInstanceAdministrator).not.toHaveBeenCalled();
    expect(mocks.getAdministratorHealth).not.toHaveBeenCalled();
  });

  it("answers the bounded 503 during maintenance before reading the session", async () => {
    mocks.assertOutsideMaintenance.mockRejectedValue(new MaintenanceActiveError(null));
    const response = await GET(event);
    expect(response.status).toBe(503);
    expect(mocks.requireSession).not.toHaveBeenCalled();
  });
});
