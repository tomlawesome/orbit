import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ log: { error: vi.fn() } }));
vi.mock("@/lib/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logger")>()),
  log: mocks.log,
}));

import { appErrorResponse } from "./app-error";

describe("application error diagnostics", () => {
  beforeEach(() => vi.clearAllMocks());

  it("classifies unexpected failures without logging the exception", async () => {
    const secret = "private stack path and provider response";
    const response = appErrorResponse(new Error(secret));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: { code: "internal_error", message: "Orbit could not complete the request" },
    });
    expect(mocks.log.error).toHaveBeenCalledWith({
      event: "application.error",
      state: "degraded",
      reason: "unexpected_failure",
      action: "inspect_admin_diagnostics",
      impact: "application_degraded",
      detail: "error_class=Error",
    });
    expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain(secret);
  });

  it("carries the class, status and code of an unexpected failure (#1288)", () => {
    class UpstreamError extends Error {
      status = 502;
      code = "UPSTREAM_BAD_GATEWAY";
    }
    appErrorResponse(new UpstreamError("upstream said no"));

    expect(mocks.log.error).toHaveBeenCalledWith(expect.objectContaining({
      event: "application.error",
      detail: "error_class=UpstreamError status=502 code=UPSTREAM_BAD_GATEWAY",
    }));
  });

  it("does not log a message that carries a connection string (#1288)", () => {
    const url = "postgres://orbit:hunter2@db.internal:5432/orbit";
    appErrorResponse(Object.assign(new Error(`connect failed for ${url}`), { code: url }));

    const logged = JSON.stringify(mocks.log.error.mock.calls);
    expect(logged).not.toContain("hunter2");
    expect(logged).not.toContain("postgres://");
    expect(logged).toContain("error_class=Error");
  });
});
