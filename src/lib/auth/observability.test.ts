import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/lib/logger", () => ({ log: mocks.log }));

import type { TokenExchangeReason } from "./errors";
import {
  reportAuthConfiguration,
  reportAuthProviderDiscoveryFailure,
  reportAuthTokenExchangeFailure,
  resetAuthObservabilityForTests,
} from "./observability";

const tokenExchangeReasons: TokenExchangeReason[] = [
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
  "provider_rejected",
  "unreachable",
  "invalid_response",
];

const hostileValues = [
  "https://issuer.example.invalid/tenant/secret?callback=https://app.example.invalid/callback",
  "client-id-sentinel",
  "client-secret-sentinel",
  "/run/secrets/oidc-client-secret",
  "OIDC_CLIENT_SECRET: secret-file-value",
  "ZodError: provider configuration contains a secret",
  "provider response exposed private details",
  "Cookie: orbit-session=session-token-sentinel",
  "Bearer access-token-sentinel",
  "user@example.invalid",
  "https://orbit.example.invalid/api/auth/login",
];

describe("authentication operational diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAuthObservabilityForTests();
  });

  afterEach(() => {
    resetAuthObservabilityForTests();
  });

  it("emits one fixed ready configuration record per process", () => {
    reportAuthConfiguration("ready");
    reportAuthConfiguration("ready");
    reportAuthConfiguration("invalid");

    expect(mocks.log.info).toHaveBeenCalledWith({ event: "auth.configuration", state: "ready" });
    expect(mocks.log.info).toHaveBeenCalledTimes(1);
    expect(mocks.log.error).not.toHaveBeenCalled();
  });

  it("emits one fixed invalid configuration record and no sensitive values", () => {
    reportAuthConfiguration("invalid");
    reportAuthConfiguration("invalid");

    expect(mocks.log.error).toHaveBeenCalledWith({
      event: "auth.configuration",
      state: "invalid",
      reason: "configuration_invalid",
      action: "check_configuration",
      impact: "sign_in_blocked",
    });
    expect(mocks.log.error).toHaveBeenCalledTimes(1);
    const records = JSON.stringify([...mocks.log.info.mock.calls, ...mocks.log.error.mock.calls]);
    for (const value of hostileValues) expect(records).not.toContain(value);
  });

  it("emits repeated provider discovery failures for shared logger deduplication", () => {
    reportAuthProviderDiscoveryFailure();
    reportAuthProviderDiscoveryFailure();

    expect(mocks.log.error).toHaveBeenCalledWith({
      event: "auth.provider",
      state: "invalid",
      reason: "discovery_failed",
      action: "check_provider",
      impact: "sign_in_blocked",
    });
    expect(mocks.log.error).toHaveBeenCalledTimes(2);
    const records = JSON.stringify(mocks.log.error.mock.calls);
    for (const value of hostileValues) expect(records).not.toContain(value);
  });

  it.each(tokenExchangeReasons)("emits a fixed token exchange failure record for the closed reason %s", (reason) => {
    reportAuthTokenExchangeFailure(reason);

    expect(mocks.log.error).toHaveBeenCalledWith({
      event: "auth.provider",
      state: "invalid",
      reason,
      action: "check_provider",
      impact: "sign_in_blocked",
    });
    expect(mocks.log.error).toHaveBeenCalledTimes(1);
    const records = JSON.stringify(mocks.log.error.mock.calls);
    for (const value of hostileValues) expect(records).not.toContain(value);
  });

  it("emits repeated token exchange failures for shared logger deduplication", () => {
    reportAuthTokenExchangeFailure("invalid_grant");
    reportAuthTokenExchangeFailure("invalid_grant");
    reportAuthTokenExchangeFailure("unreachable");
    reportAuthTokenExchangeFailure("unreachable");

    expect(mocks.log.error).toHaveBeenCalledWith({
      event: "auth.provider",
      state: "invalid",
      reason: "invalid_grant",
      action: "check_provider",
      impact: "sign_in_blocked",
    });
    expect(mocks.log.error).toHaveBeenCalledWith({
      event: "auth.provider",
      state: "invalid",
      reason: "unreachable",
      action: "check_provider",
      impact: "sign_in_blocked",
    });
    expect(mocks.log.error).toHaveBeenCalledTimes(4);
  });
});
