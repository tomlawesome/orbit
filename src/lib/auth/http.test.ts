import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AuthError } from "./errors";
import { authErrorResponse } from "./http";
import { resetAuthObservabilityForTests } from "./observability";

const mocks = vi.hoisted(() => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/lib/logger", () => ({ log: mocks.log }));

describe("authentication HTTP diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAuthObservabilityForTests();
  });

  it("reports a configuration failure once while preserving the fail-closed response", async () => {
    const secret = "http-client-secret-sentinel";
    const error = new z.ZodError([
      { code: "custom", path: ["OIDC_CLIENT_SECRET"], message: secret },
    ]);

    const first = authErrorResponse(error);
    const second = authErrorResponse(error);

    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
    await expect(first.json()).resolves.toEqual({
      error: {
        code: "auth_not_configured",
        message: "Authentication runtime configuration is incomplete",
      },
    });
    expect(mocks.log.error).toHaveBeenCalledWith({
      event: "auth.configuration",
      state: "invalid",
      reason: "configuration_invalid",
      action: "check_configuration",
      impact: "sign_in_blocked",
    });
    expect(mocks.log.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain(secret);
  });

  it("reports provider discovery failure once without exposing provider or exception details", () => {
    const providerUrl = "https://provider.example.invalid/tenant/discovery-sensitive";
    const error = new AuthError(
      "discovery_failed",
      "The OpenID provider configuration could not be validated",
      502,
      { cause: new Error(`provider response contained ${providerUrl}`) },
    );

    const first = authErrorResponse(error);
    const second = authErrorResponse(error);

    expect(first.status).toBe(502);
    expect(second.status).toBe(502);
    expect(mocks.log.error).toHaveBeenCalledWith({
      event: "auth.provider",
      state: "invalid",
      reason: "discovery_failed",
      action: "check_provider",
      impact: "sign_in_blocked",
    });
    expect(mocks.log.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain(providerUrl);
  });

  it("reports token exchange failure using its closed internal reason without exposing exchange details", () => {
    const sensitiveDetails = [
      "https://provider.example.invalid/token",
      "client-id-sentinel",
      "client-secret-sentinel",
      "authorization-code-sentinel",
      "code-verifier-sentinel",
      "https://orbit.example.invalid/api/auth/callback",
      "provider response contained access_token=token-sentinel",
    ];
    const error = new AuthError(
      "token_exchange_failed",
      "The authorization code could not be exchanged",
      502,
      { cause: new Error(sensitiveDetails.join(" ")), tokenExchangeReason: "invalid_grant" },
    );

    const first = authErrorResponse(error);
    const second = authErrorResponse(error);

    expect(first.status).toBe(502);
    expect(second.status).toBe(502);
    expect(mocks.log.error).toHaveBeenCalledWith({
      event: "auth.provider",
      state: "invalid",
      reason: "invalid_grant",
      action: "check_provider",
      impact: "sign_in_blocked",
    });
    expect(mocks.log.error).toHaveBeenCalledTimes(1);
    const records = JSON.stringify(mocks.log.error.mock.calls);
    for (const value of sensitiveDetails) expect(records).not.toContain(value);
  });

  it("falls back to provider_rejected when a token exchange failure lacks a typed reason", () => {
    const error = new AuthError(
      "token_exchange_failed",
      "The authorization code could not be exchanged",
      502,
    );

    authErrorResponse(error);

    expect(mocks.log.error).toHaveBeenCalledWith({
      event: "auth.provider",
      state: "invalid",
      reason: "provider_rejected",
      action: "check_provider",
      impact: "sign_in_blocked",
    });
    expect(mocks.log.error).toHaveBeenCalledTimes(1);
  });

  it("does not report an ordinary signed-out 401", () => {
    const response = authErrorResponse(new AuthError("session_required", "Authentication is required", 401));

    expect(response.status).toBe(401);
    expect(mocks.log.error).not.toHaveBeenCalled();
    expect(mocks.log.info).not.toHaveBeenCalled();
  });
});
