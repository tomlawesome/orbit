import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `GET /api/auth/availability`'s own contract (#788, #860, #869): its own
 * tests live here rather than under web/ because it is a plain ESM module
 * once `orbit/...` is aliased (vitest.config.ts) — web/**'s own suites are
 * Playwright and cannot unit-test a single route handler in isolation. Same
 * pattern as tests/unit/hooks-server-init.test.mjs.
 *
 * `phase` is the one field #869 adds: the boot fact the sign-in door now
 * polls on instead of inferring boot from a content-free `degraded`
 * readiness answer. This file pins that the route reads it straight from
 * `getBootPhase()` and still carries `configured`/`contactAddress`
 * unchanged.
 */
const mocks = vi.hoisted(() => ({
  getAuthConfig: vi.fn(),
  readPublicContactAddress: vi.fn(),
  getBootPhase: vi.fn(),
}));

vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/server/instance-contact", () => ({ readPublicContactAddress: mocks.readPublicContactAddress }));
vi.mock("orbit/server/boot", () => ({ getBootPhase: mocks.getBootPhase }));

describe("GET /api/auth/availability", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.getAuthConfig.mockReset();
    mocks.readPublicContactAddress.mockReset();
    mocks.getBootPhase.mockReset();
    mocks.getAuthConfig.mockReturnValue({ oidc: null });
    mocks.readPublicContactAddress.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("carries phase: starting straight from getBootPhase (#869)", async () => {
    mocks.getBootPhase.mockReturnValue("starting");

    const { GET } = await import("../../web/src/routes/api/auth/availability/+server.js");
    const response = await GET();
    const body = await response.json();

    expect(body.phase).toBe("starting");
  });

  it("carries phase: running once boot has finished (#869)", async () => {
    mocks.getBootPhase.mockReturnValue("running");

    const { GET } = await import("../../web/src/routes/api/auth/availability/+server.js");
    const response = await GET();
    const body = await response.json();

    expect(body.phase).toBe("running");
  });

  it("still carries configured and contactAddress unchanged alongside phase", async () => {
    mocks.getBootPhase.mockReturnValue("running");
    mocks.getAuthConfig.mockImplementation(() => { throw new Error("auth not configured"); });
    mocks.readPublicContactAddress.mockResolvedValue("ops@example.com");

    const { GET } = await import("../../web/src/routes/api/auth/availability/+server.js");
    const response = await GET();
    const body = await response.json();

    expect(body).toEqual({
      configured: false,
      claimed: true,
      methods: { local: true, oidc: false },
      phase: "running",
      contactAddress: "ops@example.com",
    });
  });

  it("reports methods.oidc true only when getAuthConfig returns a non-null oidc block (M7 slice 1)", async () => {
    mocks.getBootPhase.mockReturnValue("running");
    mocks.getAuthConfig.mockReturnValue({ oidc: { issuer: "https://auth.example/" } });

    const { GET } = await import("../../web/src/routes/api/auth/availability/+server.js");
    const response = await GET();
    const body = await response.json();

    expect(body.methods).toEqual({ local: true, oidc: true });
    expect(body.claimed).toBe(true);
  });
});
