import { log } from "@/lib/logger";

type AuthConfigurationState = "ready" | "invalid";
type AuthProviderFailureReason = "discovery_failed" | "token_exchange_failed";

let authConfigurationReported = false;
const reportedAuthProviderFailures = new Set<AuthProviderFailureReason>();

/** Emits one fixed authentication configuration record for this process. */
export function reportAuthConfiguration(state: AuthConfigurationState): void {
  if (authConfigurationReported) return;
  authConfigurationReported = true;

  if (state === "ready") {
    log.info("auth.configuration", { state: "ready" });
    return;
  }

  log.error("auth.configuration", {
    state: "invalid",
    impact: "sign_in_blocked",
  });
}

/** Emits one fixed provider-discovery failure record for this process. */
export function reportAuthProviderDiscoveryFailure(): void {
  reportAuthProviderFailure("discovery_failed");
}

/** Emits one fixed token-exchange failure record for this process. */
export function reportAuthTokenExchangeFailure(): void {
  reportAuthProviderFailure("token_exchange_failed");
}

function reportAuthProviderFailure(reason: AuthProviderFailureReason): void {
  if (reportedAuthProviderFailures.has(reason)) return;
  reportedAuthProviderFailures.add(reason);
  log.error("auth.provider", {
    state: "invalid",
    reason,
    impact: "sign_in_blocked",
  });
}

/** Resets process-local diagnostic state between isolated tests. */
export function resetAuthObservabilityForTests(): void {
  authConfigurationReported = false;
  reportedAuthProviderFailures.clear();
}
