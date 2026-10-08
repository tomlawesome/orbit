import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `GET /api/about`'s own contract (#1256): any signed-in member, no admin
 * gate, through `read()`. Same pattern as tests/unit/system-status-route.
 * test.mjs: every collaborator is mocked at its own module boundary and the
 * route file runs for real, so this proves the wiring; src/server/about.
 * test.ts covers the read itself.
 */
const mocks = vi.hoisted(() => ({
  assertOutsideMaintenance: vi.fn(),
  getAuthConfig: vi.fn(),
  requireSession: vi.fn(),
  getAboutFacts: vi.fn(),
}));

vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: mocks.assertOutsideMaintenance }));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/session", () => ({
  requireSession: mocks.requireSession,
  assertCsrf: vi.fn(),
}));
vi.mock("orbit/server/about", () => ({ getAboutFacts: mocks.getAboutFacts }));

const event = { cookies: {}, request: new Request("http://localhost/api/about") };

const FACTS = {
  build: { version: "0.3.0", channel: "preview", revision: "fd6a7e6", image: null },
  node: "v24.11.0",
  sidecars: [{ id: "postgres", state: "running", version: "18.0" }],
};

describe("GET /api/about (#1256)", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.assertOutsideMaintenance.mockReset().mockResolvedValue(undefined);
    mocks.getAuthConfig.mockReset().mockReturnValue({});
    mocks.requireSession.mockReset();
    mocks.getAboutFacts.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("answers what this Orbit runs on to any signed-in member, not only an administrator", async () => {
    mocks.requireSession.mockResolvedValue({ user: { id: "u-1", isInstanceAdmin: false } });
    mocks.getAboutFacts.mockResolvedValue(FACTS);

    const { GET } = await import("../../web/src/routes/api/about/+server.js");
    const response = await GET(event);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ about: FACTS });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 401 and reads nothing for a signed-out visitor", async () => {
    const { AuthError } = await import("orbit/lib/auth/errors");
    mocks.requireSession.mockRejectedValue(new AuthError("session_required", "A valid session is required", 401));

    const { GET } = await import("../../web/src/routes/api/about/+server.js");
    const response = await GET(event);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(mocks.getAboutFacts).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toMatch(/postgres|tika|clamav|ollama|sha256/i);
  });

  it("answers the gate's fixture under ORBIT_FIXTURES, without a session or the engine", async () => {
    vi.stubEnv("ORBIT_FIXTURES", "1");
    const { ABOUT_FIXTURE } = await import("../../web/src/lib/data/fixtures/about.js");

    const { GET } = await import("../../web/src/routes/api/about/+server.js");
    const response = await GET(event);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ about: ABOUT_FIXTURE });
    expect(mocks.requireSession).not.toHaveBeenCalled();
    expect(mocks.getAboutFacts).not.toHaveBeenCalled();
  });
});
