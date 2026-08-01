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
  | "csrf_failed";

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
