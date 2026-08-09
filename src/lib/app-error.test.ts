import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ log: { error: vi.fn() } }));
vi.mock("@/lib/logger", () => ({ log: mocks.log }));

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
    });
    expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain(secret);
  });
});
