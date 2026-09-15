import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `GET /api/system-status`'s own contract (#863): the drawer's data, gated by
 * `read()` -- a session, but not the administrator check
 * `/api/admin/documents/health` uses, per #869's ruling that per-subsystem
 * truth belongs "behind sign-in", not behind the admin gate. Same pattern as
 * tests/unit/availability-route.test.mjs and tests/unit/health-route.test.mjs:
 * every collaborator is mocked at its own module boundary, and the route file
 * itself runs for real, so this proves the wiring rather than the collaborators
 * (system-status.test.ts already covers those).
 */
const mocks = vi.hoisted(() => ({
  assertOutsideMaintenance: vi.fn(),
  getAuthConfig: vi.fn(),
  requireSession: vi.fn(),
  getSystemStatus: vi.fn(),
}));

vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: mocks.assertOutsideMaintenance }));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/session", () => ({
  requireSession: mocks.requireSession,
  assertCsrf: vi.fn(),
}));
vi.mock("orbit/server/system-status", () => ({ getSystemStatus: mocks.getSystemStatus }));

const event = { cookies: {}, request: new Request("http://localhost/api/system-status") };

describe("GET /api/system-status (#863)", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.assertOutsideMaintenance.mockReset().mockResolvedValue(undefined);
    mocks.getAuthConfig.mockReset().mockReturnValue({});
    mocks.requireSession.mockReset();
    mocks.getSystemStatus.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers the real per-service state for a signed-in reader (positive case)", async () => {
    mocks.requireSession.mockResolvedValue({ user: { id: "u-1" } });
    mocks.getSystemStatus.mockResolvedValue({
      handle: "ready",
      services: [{ service: "orbit-app", state: "healthy", observedAt: "2026-09-12T09:59:20.000Z" }],
      lastCheck: { scan: "ready", application: "ready" },
    });

    const { GET } = await import("../../web/src/routes/api/system-status/+server.js");
    const response = await GET(event);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: {
        handle: "ready",
        services: [{ service: "orbit-app", state: "healthy", observedAt: "2026-09-12T09:59:20.000Z" }],
        lastCheck: { scan: "ready", application: "ready" },
      },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 401 and touches getSystemStatus not at all with no session -- a signed-out reader learns nothing (unauthenticated case, #869)", async () => {
    const { AuthError } = await import("orbit/lib/auth/errors");
    mocks.requireSession.mockRejectedValue(new AuthError("session_required", "A valid session is required", 401));

    const { GET } = await import("../../web/src/routes/api/system-status/+server.js");
    const response = await GET(event);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(mocks.getSystemStatus).not.toHaveBeenCalled();
    // Nothing service-shaped leaks into the failure envelope.
    expect(JSON.stringify(body)).not.toMatch(/orbit-|clamav|scanner|degraded/i);
  });

  it("answers 503 during maintenance before ever reading the session (negative case)", async () => {
    const { MaintenanceActiveError } = await import("orbit/lib/errors");
    mocks.assertOutsideMaintenance.mockRejectedValue(new MaintenanceActiveError(null));

    const { GET } = await import("../../web/src/routes/api/system-status/+server.js");
    const response = await GET(event);

    expect(response.status).toBe(503);
    expect(mocks.requireSession).not.toHaveBeenCalled();
    expect(mocks.getSystemStatus).not.toHaveBeenCalled();
  });

  it("answers the fixture, not the engine, under ORBIT_FIXTURES (the fidelity gate's own path)", async () => {
    vi.stubEnv("ORBIT_FIXTURES", "1");
    mocks.requireSession.mockResolvedValue({ user: { id: "u-1" } });

    const { GET } = await import("../../web/src/routes/api/system-status/+server.js");
    const response = await GET(event);
    const body = await response.json();

    expect(body.status.handle).toBe("degraded");
    expect(mocks.getSystemStatus).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
