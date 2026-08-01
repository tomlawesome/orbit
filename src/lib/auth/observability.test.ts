import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/lib/logger", () => ({ log: mocks.log }));

import {
  reportAuthConfiguration,
  reportAuthProviderDiscoveryFailure,
  reportAuthTokenExchangeFailure,
  resetAuthObservabilityForTests,
} from "./observability";

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

    expect(mocks.log.info).toHaveBeenCalledWith("auth.configuration", { state: "ready" });
    expect(mocks.log.info).toHaveBeenCalledTimes(1);
    expect(mocks.log.error).not.toHaveBeenCalled();
  });

  it("emits one fixed invalid configuration record and no sensitive values", () => {
    reportAuthConfiguration("invalid");
    reportAuthConfiguration("invalid");

    expect(mocks.log.error).toHaveBeenCalledWith("auth.configuration", {
      state: "invalid",
      impact: "sign_in_blocked",
    });
    expect(mocks.log.error).toHaveBeenCalledTimes(1);
    const records = JSON.stringify([...mocks.log.info.mock.calls, ...mocks.log.error.mock.calls]);
    for (const value of hostileValues) expect(records).not.toContain(value);
  });

  it("emits one fixed provider discovery failure record per process", () => {
    reportAuthProviderDiscoveryFailure();
    reportAuthProviderDiscoveryFailure();

    expect(mocks.log.error).toHaveBeenCalledWith("auth.provider", {
      state: "invalid",
      reason: "discovery_failed",
      impact: "sign_in_blocked",
    });
    expect(mocks.log.error).toHaveBeenCalledTimes(1);
    const records = JSON.stringify(mocks.log.error.mock.calls);
    for (const value of hostileValues) expect(records).not.toContain(value);
  });

  it("emits one coarse token exchange failure record per process", () => {
    reportAuthTokenExchangeFailure();
    reportAuthTokenExchangeFailure();

    expect(mocks.log.error).toHaveBeenCalledWith("auth.provider", {
      state: "invalid",
      reason: "token_exchange_failed",
      impact: "sign_in_blocked",
    });
    expect(mocks.log.error).toHaveBeenCalledTimes(1);
    const records = JSON.stringify(mocks.log.error.mock.calls);
    for (const value of hostileValues) expect(records).not.toContain(value);
  });
});
