import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readiness: vi.fn() }));
vi.mock("@/server/readiness", () => ({ getPublicReadiness: mocks.readiness }));

import { GET } from "./route";

describe("public health route", () => {
  it("returns content-free success when required readiness is available", async () => {
    mocks.readiness.mockResolvedValueOnce({ status: "ready" });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ status: "ready", service: "orbit" });
  });

  it("returns content-free non-success when required readiness is unavailable", async () => {
    mocks.readiness.mockResolvedValueOnce({ status: "degraded" });
    const response = await GET();
    expect(response.status).toBe(503);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ status: "degraded", service: "orbit" });
    expect(JSON.stringify(body)).not.toContain("postgres");
    expect(JSON.stringify(body)).not.toContain("synthetic");
  });
});
