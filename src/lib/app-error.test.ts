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

  /*
   * #1405: with no usable encryption key every API answers the same bounded
   * 503, named for what is wrong and with no Retry-After, because nothing says
   * when the key will be back. The maintenance guard's answer is the pattern
   * (a string code, not the { code, message } envelope).
   */
  it("answers a missing encryption key with a bare 503, never stored and with no Retry-After (#1405)", async () => {
    /* imported here, not at the top, so the file's other cases do not depend on the module */
    const { KeyUnavailableError } = await import("@/server/key-state");
    const response = appErrorResponse(new KeyUnavailableError());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBeNull();
    await expect(response.json()).resolves.toEqual({ error: "encryption_key_unavailable" });
    expect(mocks.log.error).not.toHaveBeenCalled();
  });
});
