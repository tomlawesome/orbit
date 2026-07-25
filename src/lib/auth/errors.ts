export type AuthErrorCode =
  | "auth_not_configured"
  | "discovery_failed"
  | "invalid_request"
  | "invalid_state"
  | "provider_error"
  | "token_exchange_failed"
  | "invalid_id_token"
  | "missing_email"
  | "session_required"
  | "csrf_failed";

export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
    public readonly status = 400,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AuthError";
  }
}

export function asAuthError(error: unknown): AuthError {
  if (error instanceof AuthError) return error;
  return new AuthError("provider_error", "Authentication could not be completed", 502, { cause: error });
}
