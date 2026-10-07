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

  it("answers a body over a request size limit with 413, never 500 (#1285)", async () => {
    // SvelteKit's own error when a body runs past BODY_SIZE_LIMIT: not an
    // AppError, but a status of 413.
    const response = appErrorResponse(Object.assign(new Error("request body size exceeded BODY_SIZE_LIMIT"), { status: 413 }));
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: { code: "request_too_large", message: "That request is too large" },
    });
    expect(mocks.log.error).not.toHaveBeenCalled();
  });
});
