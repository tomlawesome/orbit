export type AuthErrorCode =
  | "auth_not_configured"
  | "discovery_failed"
  | "invalid_request"
  | "invalid_state"
  | "provider_error"
  | "token_exchange_failed"
  | "invalid_id_token"
  | "missing_email"
  | "account_disabled"
  | "session_required"
  | "session_not_found"
  | "csrf_failed"
  /* The claim and registration vocabulary (ADR-0023 §8). Added, never
     reordered: later M7 slices append their own members to this list. */
  | "bootstrap_required"
  | "bootstrap_unavailable"
  | "bootstrap_invalid"
  | "bootstrap_claimed"
  | "link_required"
  /* Local sign-in (ADR-0023 §4, §8). `credentials_invalid` is the ONE answer
     for an unknown address, a wrong password, a disabled account and an
     account with no password; `too_many_attempts` covers both the persisted
     backoff and a saturated verification gate; `password_rejected` is a new
     password outside the bounds of ADR-0021 §6. */
  | "credentials_invalid"
  | "too_many_attempts"
  | "password_rejected";

/**
 * Closed internal diagnostic reasons for a token-exchange failure.
 * These are never exposed to the browser.
 */
export type TokenExchangeReason =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "server_error"
  | "temporarily_unavailable"
  | "provider_rejected"
  | "unreachable"
  | "invalid_response";

export class AuthError extends Error {
  public readonly tokenExchangeReason?: TokenExchangeReason;

  constructor(
    public readonly code: AuthErrorCode,
    message: string,
    public readonly status = 400,
    options?: ErrorOptions & { tokenExchangeReason?: TokenExchangeReason },
  ) {
    super(message, options);
    this.name = "AuthError";
    this.tokenExchangeReason = options?.tokenExchangeReason;
  }
}

export function asAuthError(error: unknown): AuthError {
  if (error instanceof AuthError) return error;
  return new AuthError("provider_error", "Authentication could not be completed", 502, { cause: error });
}
