import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `GET /api/health`'s response shape is a contract this issue (#869) must
 * not move: the installer, the container HEALTHCHECK and
 * scripts/ci/verify-health-endpoint.sh all read it as it is today, byte for
 * byte (acceptance criterion 4). This file pins the shape directly rather
 * than trusting "nothing touched the route" by inspection alone — #869
 * deliberately put its own new field on `/api/auth/availability` instead.
 */
const mocks = vi.hoisted(() => ({
  getPublicReadiness: vi.fn(),
}));

vi.mock("orbit/server/readiness", () => ({ getPublicReadiness: mocks.getPublicReadiness }));

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.getPublicReadiness.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers exactly status, service and timestamp for a ready instance, at 200", async () => {
    mocks.getPublicReadiness.mockResolvedValue({ status: "ready" });

    const { GET } = await import("../../web/src/routes/api/health/+server.js");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["service", "status", "timestamp"]);
    expect(body.status).toBe("ready");
    expect(body.service).toBe("orbit");
    expect(() => new Date(body.timestamp).toISOString()).not.toThrow();
    expect(body.phase).toBeUndefined();
  });

  it("answers maintenance at 200, not 503 (ADR-0013: closed on purpose is healthy)", async () => {
    mocks.getPublicReadiness.mockResolvedValue({ status: "maintenance" });

    const { GET } = await import("../../web/src/routes/api/health/+server.js");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("maintenance");
  });

  it("answers degraded at 503, with the same three fields and no phase (criterion 4)", async () => {
    mocks.getPublicReadiness.mockResolvedValue({ status: "degraded" });

    const { GET } = await import("../../web/src/routes/api/health/+server.js");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(Object.keys(body).sort()).toEqual(["service", "status", "timestamp"]);
    expect(body.status).toBe("degraded");
  });

  it("never caches", async () => {
    mocks.getPublicReadiness.mockResolvedValue({ status: "ready" });

    const { GET } = await import("../../web/src/routes/api/health/+server.js");
    const response = await GET();

    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
