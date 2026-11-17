/*
 * THE CHANGE-PASSWORD HOLD (#1881, ADR-0027 amendment of 2026-11-17).
 *
 * A refused sign-in marks the password (`local_credentials.
 * password_change_required_at`), and session creation refuses a marked
 * account by every way in (`createSession`). What the sign-in that got that
 * far receives instead is this: a short-lived proof, sealed with
 * `sealProof` under its own audience, that says "this browser has passed
 * every check a sign-in asks, and may now save a new password for this
 * account" -- and nothing more. It is not a session: `readSession` never
 * reads it, and the only route that opens it is the new-password route.
 *
 * Bound to the mark it was issued against, not just to the account: the save
 * re-reads the mark under the credential's row lock and refuses a hold whose
 * mark has since been cleared or replaced. That makes the hold spend once
 * without a table of its own -- once the password is saved, the mark is gone
 * and every copy of the cookie with it -- and a later refusal invalidates
 * every hold issued before it.
 */

import type { CookieReader, CookieSink } from "@/lib/http";
import type { AuthConfig } from "@/lib/env";
import { clearPasswordChangeCookie, passwordChangeCookieName, setPasswordChangeCookie } from "@/lib/auth/cookies";
import { openProof, sealProof } from "@/lib/auth/crypto";
import { AuthError, type PasswordChangeRequiredError } from "@/lib/auth/errors";

const HOLD_AUDIENCE = "orbit-password-change";

/** The approval's own ten minutes (ADR-0027 §6), for a hold no approval preceded. */
export const PASSWORD_CHANGE_HOLD_TTL_MS = 10 * 60 * 1000;

export interface PasswordChangeHold {
  userId: string;
  /** The mark this hold was issued against: the newest refusal's moment. */
  requiredAt: Date;
}

/**
 * Seals a hold for a marked account and puts it in this browser's cookie.
 *
 * Every hold runs ten minutes from being issued, whichever way in led here:
 * an approval pressed late must still leave time to type (#1881 review). A
 * refused entry never extends it, and it ends at once, whatever its clock
 * says, when the mark it names is cleared or replaced: the save compares the
 * two under the credential's row lock (`completePasswordRenewal`).
 */
export async function issuePasswordChangeHold(
  cookies: CookieSink,
  refusal: PasswordChangeRequiredError,
  config: AuthConfig,
): Promise<{ refusedAt: string; expiresAt: string }> {
  const expiresAt = new Date(Date.now() + PASSWORD_CHANGE_HOLD_TTL_MS);
  const ttlSeconds = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  const sealed = await sealProof(
    /* The lapse is carried to the millisecond and checked strictly on open:
       the proof's own expiry is whole seconds with a few seconds' clock
       tolerance, which would keep a lapsed hold open a little too long. */
    { userId: refusal.userId, requiredAt: refusal.requiredAt.toISOString(), lapsesAt: expiresAt.getTime() },
    HOLD_AUDIENCE,
    ttlSeconds,
    config,
  );
  setPasswordChangeCookie(cookies, sealed, config, ttlSeconds);
  return { refusedAt: refusal.requiredAt.toISOString(), expiresAt: expiresAt.toISOString() };
}

/**
 * Opens this browser's hold, or refuses with `password_change_lapsed` for a
 * missing, forged, expired or malformed one -- one word for all four. Whether
 * the mark it names still stands is the save's own check, under its lock.
 */
export async function openPasswordChangeHold(cookies: CookieReader, config: AuthConfig): Promise<PasswordChangeHold> {
  const lapsed = () => new AuthError("password_change_lapsed", "This sign-in has lapsed; sign in again", 400);
  const value = cookies.get(passwordChangeCookieName(config));
  if (!value) throw lapsed();
  let payload: Record<string, unknown>;
  try {
    payload = await openProof(value, HOLD_AUDIENCE, config);
  } catch (error) {
    throw new AuthError("password_change_lapsed", "This sign-in has lapsed; sign in again", 400, { cause: error });
  }
  const requiredAt = typeof payload.requiredAt === "string" ? new Date(payload.requiredAt) : null;
  if (typeof payload.userId !== "string" || payload.userId.length === 0 || !requiredAt || Number.isNaN(requiredAt.getTime())) {
    throw lapsed();
  }
  if (typeof payload.lapsesAt !== "number" || !Number.isFinite(payload.lapsesAt) || Date.now() >= payload.lapsesAt) {
    throw lapsed();
  }
  return { userId: payload.userId, requiredAt };
}

export { clearPasswordChangeCookie };
