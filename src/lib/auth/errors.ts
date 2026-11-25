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
  | "password_rejected"
  /* Setup tokens (ADR-0022 §5, ADR-0023 §3). An unknown, already-consumed or
     expired setup/recovery token is the one generic `setup_token_invalid`. */
  | "setup_token_invalid"
  /* Recent authentication (ADR-0023 §5, §8). `recent_authentication_required`
     is every way a sensitive action can arrive unproven — no password, a wrong
     one, no step-up proof, or a proof sealed for another session or another
     action. `step_up_failed` is narrower and is the provider's fault: it
     answered without a fresh `auth_time`, so nobody was re-authenticated and
     the action stays blocked until the operator fixes the provider. */
  | "recent_authentication_required"
  | "step_up_failed"
  /* Linking and unlinking (ADR-0023 §6, §8). `link_exists` is the unique
     index on `(issuer, subject)` speaking: that provider account already
     belongs to an Orbit account, and an identity is never moved between them.
     `link_last_method` is the rule that keeps somebody from locking
     themselves out — at least one USABLE method has to survive, and an
     identity is not usable while `ORBIT_AUTH_OIDC` is false. */
  | "link_exists"
  | "link_last_method"
  /* The sign-in could not be decided because the instance could not read the
     setting the second factor turns on (S-data3-1). A 503 that names no
     subsystem: a signed-out visitor learning which one failed is
     reconnaissance, the availability route's own rule. */
  | "sign_in_unavailable"
  /* A refused sign-in forces a new password (#1881, ADR-0027 amendment of
     2026-11-17). `password_change_required` is session creation refusing an
     account whose password is marked; the sign-in routes turn it into the
     change-password hold rather than answering it. `password_unchanged` is a
     new password that is the refused one; `password_mismatch` is the two
     entries disagreeing (or the second missing). `password_change_lapsed` is
     a hold that has run out, been spent, or never existed, or whose mark was
     cleared by any path: one word for all, as a setup link has.
     `password_change_saved` is no longer sent (#1943 SEC-H3 reversed #1901's
     retry answer, which checked a password outside the sign-in door); it is
     kept so a browser still showing it reads it. `password_recovery_required` is a marked
     password typed on an instance with no mail relay: with no verified
     channel to renew it through, it signs nobody in and the way back is a
     setup link from an administrator (OWASP/NIST: a known-compromised
     password is reset only through a verified channel). */
  | "password_change_required"
  | "password_unchanged"
  | "password_mismatch"
  | "password_change_lapsed"
  | "password_change_saved"
  | "password_recovery_required";

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

/**
 * Session creation's refusal for an account whose password a refused sign-in
 * has marked (#1881). Carries the mark's own moment, because that is both
 * what the change-password hold is bound to and what the card tells the
 * reader. Never shown to a browser as an error: every sign-in route catches
 * it and answers with the hold instead.
 */
export class PasswordChangeRequiredError extends AuthError {
  constructor(
    public readonly userId: string,
    public readonly requiredAt: Date,
  ) {
    super("password_change_required", "A new password is needed before this account can sign in", 403);
    this.name = "PasswordChangeRequiredError";
  }
}

export function asAuthError(error: unknown): AuthError {
  if (error instanceof AuthError) return error;
  return new AuthError("provider_error", "Authentication could not be completed", 502, { cause: error });
}
