import { json } from "@sveltejs/kit";
import { z } from "zod";

import { setSessionCookie } from "orbit/lib/auth/cookies";
import { AuthError } from "orbit/lib/auth/errors";
import { authErrorResponse } from "orbit/lib/auth/http";
import { checkPasswordBounds, hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "orbit/lib/auth/password";
import { createSession } from "orbit/lib/auth/session";
import { VerificationGateRefusedError } from "orbit/lib/auth/verification-gate";
import { getAuthConfig } from "orbit/lib/env";
import { hasLocalCredential, setPassword, verifyCredential } from "orbit/server/local-credentials";

import { write } from "$lib/server/api.js";

const bodySchema = z.object({
  password: z.string(),
  currentPassword: z.string().optional(),
});

/**
 * Sets or changes the signed-in caller's own password (ADR-0023 §6, §7).
 *
 * "Always challenge" (ADR-0023 §5): a caller who already has a password
 * must supply `currentPassword`, verified exactly as a sign-in is — same
 * backoff, same gate, same generic failure. A caller with no password yet is
 * OIDC-only, adding local sign-in for the first time, and ADR-0023 §5 sends
 * them through a step-up instead.
 *
 * TODO(#910): route the OIDC-only, no-local-credential caller through the
 * step-up guard here once `src/lib/auth/recent-auth.ts` lands (slice 7);
 * until then this branch sets the password with no recent-authentication
 * check at all, because slice 8 does not implement or stub that guard.
 *
 * `setPassword` decides, and enforces, the rest of §7: a first password
 * revokes nothing; a replacement revokes every session — this caller's
 * included — so this re-issues the caller's own session in the same response
 * exactly as the ADR requires.
 */
export const POST = write(async (event, session) => {
  const submitted = bodySchema.parse(await event.request.json());
  const alreadySet = await hasLocalCredential(session.user.id);

  if (alreadySet) {
    if (!submitted.currentPassword) {
      throw new AuthError("recent_authentication_required", "Confirm your current password to continue", 401);
    }
    const verdict = await verifyCredential(session.user.email, submitted.currentPassword);
    if (verdict.outcome === "throttled") {
      throw new AuthError("too_many_attempts", "Too many attempts at once; try again shortly", 429);
    }
    if (verdict.outcome !== "verified" || verdict.userId !== session.user.id) {
      throw new AuthError("recent_authentication_required", "Confirm your current password to continue", 401);
    }
  }

  const rejection = checkPasswordBounds(submitted.password);
  if (rejection) {
    throw new AuthError(
      "password_rejected",
      rejection === "too_short"
        ? `Use a password of at least ${MIN_PASSWORD_LENGTH} characters`
        : `Use a password of at most ${MAX_PASSWORD_LENGTH} characters`,
      400,
    );
  }

  let passwordHash;
  try {
    passwordHash = await hashPassword(submitted.password);
  } catch (error) {
    if (error instanceof VerificationGateRefusedError) {
      throw new AuthError("too_many_attempts", "Too many attempts at once; try again shortly", 429);
    }
    throw error;
  }

  const outcome = await setPassword(session.user.id, passwordHash, session.user.id);

  if (outcome.replaced) {
    /* Every session this account held, this one included, just died inside
       `setPassword`. A fresh one for this browser is the "re-issues the
       caller's own" half of ADR-0023 §7 — not a sign-in, so no CSRF or
       origin check beyond the one `write()` already made for this request. */
    const config = getAuthConfig();
    const reissued = await createSession(session.user.id, config, event.request.headers.get("user-agent"));
    setSessionCookie(event.cookies, reissued.token, config);
  }

  return json(
    { changed: outcome.replaced, sessionsRevoked: outcome.sessionsRevoked },
    { headers: { "cache-control": "no-store" } },
  );
}, { errorResponse: authErrorResponse });
