import { log } from "@/lib/logger";
import type { AuthErrorCode, TokenExchangeReason } from "@/lib/auth/errors";

type AuthConfigurationState = "ready" | "invalid";
type AuthProviderFailureReason = "discovery_failed" | TokenExchangeReason;

let authConfigurationReported = false;
const reportedAuthProviderFailures = new Set<AuthProviderFailureReason>();
const reportedAuthCallbackFailures = new Set<string>();

/** Emits one fixed authentication configuration record for this process. */
export function reportAuthConfiguration(state: AuthConfigurationState): void {
  if (authConfigurationReported) return;
  authConfigurationReported = true;

  if (state === "ready") {
    log.info({ event: "auth.configuration", state: "ready" });
    return;
  }

  log.error({
    event: "auth.configuration",
    state: "invalid",
    reason: "configuration_invalid",
    action: "check_configuration",
    impact: "sign_in_blocked",
  });
}

/** Emits one fixed provider-discovery failure record for this process. */
export function reportAuthProviderDiscoveryFailure(): void {
  reportAuthProviderFailure("discovery_failed");
}

/** Emits one fixed token-exchange failure record per closed reason for this process. */
export function reportAuthTokenExchangeFailure(reason: TokenExchangeReason): void {
  reportAuthProviderFailure(reason);
}

function reportAuthProviderFailure(reason: AuthProviderFailureReason): void {
  if (reportedAuthProviderFailures.has(reason)) return;
  reportedAuthProviderFailures.add(reason);
  log.error({
    event: "auth.provider",
    state: "invalid",
    reason,
    action: "check_provider",
    impact: "sign_in_blocked",
  });
}

/** Emits the single bounded record for a failed authorization callback. */
export function reportAuthCallbackFailure(code: AuthErrorCode, tokenReason?: TokenExchangeReason): void {
  if (code === "discovery_failed") {
    reportAuthProviderDiscoveryFailure();
    return;
  }
  if (code === "token_exchange_failed") {
    reportAuthTokenExchangeFailure(tokenReason ?? "provider_rejected");
    return;
  }

  const reason = code === "invalid_request" || code === "invalid_state" || code === "account_disabled"
    ? code
    : code === "provider_error"
      ? "provider_error"
      : "unexpected_failure";
  if (reportedAuthCallbackFailures.has(reason)) return;
  reportedAuthCallbackFailures.add(reason);
  log.error({
    event: "auth.provider",
    state: "degraded",
    reason,
    action: "check_provider",
    impact: "sign_in_blocked",
  });
}

/** Resets process-local diagnostic state between isolated tests. */
export function resetAuthObservabilityForTests(): void {
  authConfigurationReported = false;
  reportedAuthProviderFailures.clear();
  reportedAuthCallbackFailures.clear();
}
