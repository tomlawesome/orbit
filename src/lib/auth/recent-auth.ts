/*
 * Recent authentication: one guard for every sensitive action (ADR-0023 §5).
 *
 * The owner's ruling is that no freshness window ships. Setting a password,
 * changing one, linking, unlinking, issuing somebody else a setup link and
 * transferring primary authority all re-challenge the person in front of the
 * screen, every time — a window is a bearer token for anyone at an unlocked
 * laptop, which is exactly what this replaces (#263's fifteen minutes, deleted
 * with this module).
 *
 * There are two challenges and one rule for choosing between them:
 *
 *  - **Has a password?** Then the password is the challenge, verified through
 *    `verifyCredential` — the same backoff, the same gate, the same one-word
 *    refusal as a sign-in. Nothing here re-implements any of that.
 *  - **OIDC only?** Then a step-up: `POST /api/auth/step-up/start` sends the
 *    browser to the provider with `max_age=0`, the callback checks the
 *    returned `auth_time` and mints the proof cookie this module opens.
 *
 * A person with both methods is challenged with the password: it is cheaper,
 * it works offline, and it does not depend on the provider being reachable.
 *
 * Everything fails closed. No password, a wrong password, no proof, an expired
 * proof, a proof sealed for another session or another action: one answer,
 * `recent_authentication_required`, and the action does not happen.
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { externalIdentities, localCredentials, sessions } from "@/db/schema";
import { openProof, sealProof } from "@/lib/auth/crypto";
import { AuthError } from "@/lib/auth/errors";
import type { VerifiedIdentity } from "@/lib/auth/oidc";
import { getAuthConfig, type AuthConfig } from "@/lib/env";
import type { CookieSink } from "@/lib/http";
import { log } from "@/lib/logger";
import { verifyCredential } from "@/server/local-credentials";

/** Keeps a step-up proof from opening as a claim cookie or a transaction. */
export const STEP_UP_PROOF_AUDIENCE = "step-up-proof";

/**
 * Two minutes (ADR-0023 §5): long enough to come back from the provider and
 * finish the action, short enough that a proof left behind on a shared machine
 * is worth nothing by the time anyone finds it.
 */
export const STEP_UP_PROOF_TTL_SECONDS = 120;

/**
 * What a step-up is FOR. A closed list, because the proof is bound to one of
 * these: a step-up taken to change a password cannot be spent transferring the
 * instance. Later M7 slices append their own actions here; nothing reorders or
 * removes, and no route invents an intent of its own.
 */
export const stepUpIntents = [
  "password_set",
  "password_change",
  "link_oidc",
  "unlink_method",
  "local_user_create",
  "setup_link_issue",
  "primary_transfer",
] as const;
export type StepUpIntent = typeof stepUpIntents[number];

export function isStepUpIntent(value: unknown): value is StepUpIntent {
  return typeof value === "string" && (stepUpIntents as readonly string[]).includes(value);
}

/**
 * The receipt `requireRecentAuthentication` hands back: who was challenged,
 * what for, and how. An engine function that performs a sensitive action takes
 * one of these instead of reading session ages, so the challenge cannot be
 * skipped by calling the repository directly — and so the check on "is this
 * the same person, for this action" happens where the action happens.
 */
export interface RecentAuthentication {
  readonly userId: string;
  readonly intent: StepUpIntent;
  readonly method: "password" | "step_up";
}

/** Everything the guard needs from a request: one cookie jar. */
export interface RecentAuthenticationEvent {
  cookies: CookieSink;
}

/**
 * The caller's session, narrowed to what the guard reads. SvelteKit's
 * `AuthenticatedSession` satisfies it as it stands.
 */
export interface RecentAuthenticationSubject {
  id: string;
  user: { id: string; email: string };
}

/** The one answer every unproven action gets. */
function unproven(): AuthError {
  return new AuthError(
    "recent_authentication_required",
    "Confirm it is you before making this change",
    403,
  );
}

/** One bounded record for a step-up the provider or the identity did not carry. */
function stepUpRejected(): void {
  log.warn({
    event: "auth.provider",
    state: "invalid",
    reason: "step_up_rejected",
    action: "check_provider",
    impact: "sign_in_blocked",
  });
}

export function stepUpProofCookieName(config: AuthConfig): string {
  return config.secureCookies ? "__Secure-orbit-step-up" : "orbit-step-up";
}

/**
 * Mints the proof the callback hands back to the browser. It carries no
 * secret: only the session it belongs to, the action it was earned for, and
 * its own two-minute expiry.
 */
export async function sealStepUpProof(
  sessionId: string,
  intent: StepUpIntent,
  config: AuthConfig,
): Promise<string> {
  return sealProof({ sessionId, intent }, STEP_UP_PROOF_AUDIENCE, STEP_UP_PROOF_TTL_SECONDS, config);
}

export function setStepUpProofCookie(cookies: CookieSink, value: string, config: AuthConfig): void {
  cookies.set(stepUpProofCookieName(config), value, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: "/",
    maxAge: STEP_UP_PROOF_TTL_SECONDS,
  });
}

export function clearStepUpProofCookie(cookies: CookieSink, config: AuthConfig): void {
  cookies.set(stepUpProofCookieName(config), "", {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/**
 * Turns a verified provider answer into a step-up proof (ADR-0023 §5).
 *
 * `completeAuthorization` has already refused an `auth_time` that is missing or
 * older than a minute, so what is left to check is that the person who just
 * authenticated is the person holding the session being challenged: without
 * that, anyone at an unlocked screen could step up with their OWN provider
 * account and satisfy somebody else's challenge.
 *
 * A step-up never creates, updates or links an account, and never issues a
 * session. An identity Orbit does not know is simply not proof.
 */
export async function completeStepUp(params: {
  identity: VerifiedIdentity;
  sessionId: string;
  intent: StepUpIntent;
  config: AuthConfig;
}): Promise<string> {
  const db = getDb();
  const [session] = await db
    .select({ userId: sessions.userId, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(eq(sessions.id, params.sessionId))
    .limit(1);
  const [identity] = await db
    .select({ userId: externalIdentities.userId })
    .from(externalIdentities)
    .where(and(
      eq(externalIdentities.issuer, params.identity.issuer),
      eq(externalIdentities.subject, params.identity.subject),
    ))
    .limit(1);

  if (!session || session.expiresAt <= new Date() || !identity || identity.userId !== session.userId) {
    stepUpRejected();
    throw new AuthError("step_up_failed", "The re-authentication did not match this session", 403);
  }
  return sealStepUpProof(params.sessionId, params.intent, params.config);
}

/**
 * The guard every sensitive action calls before it changes anything.
 *
 * `body` is the request body the route has already parsed — a local user's
 * `currentPassword` travels in it — and `intent` names the action, which is
 * what a step-up proof is bound to.
 *
 * Returns the receipt to hand to whatever performs the action; throws
 * `recent_authentication_required` otherwise, or `too_many_attempts` when the
 * password backoff or the verification gate is the thing refusing.
 */
export async function requireRecentAuthentication(
  event: RecentAuthenticationEvent,
  session: RecentAuthenticationSubject,
  body: unknown,
  intent: StepUpIntent,
): Promise<RecentAuthentication> {
  const config = getAuthConfig();
  const [credential] = await getDb()
    .select({ userId: localCredentials.userId })
    .from(localCredentials)
    .where(eq(localCredentials.userId, session.user.id))
    .limit(1);

  if (credential) return verifyPasswordChallenge(session, body, intent);
  return verifyStepUpProof(event, session, intent, config);
}

async function verifyPasswordChallenge(
  session: RecentAuthenticationSubject,
  body: unknown,
  intent: StepUpIntent,
): Promise<RecentAuthentication> {
  const supplied = body && typeof body === "object"
    ? (body as Record<string, unknown>).currentPassword
    : undefined;
  if (typeof supplied !== "string" || supplied.length === 0) throw unproven();

  const verdict = await verifyCredential(session.user.email, supplied);
  if (verdict.outcome === "throttled") {
    throw new AuthError("too_many_attempts", "Too many attempts at once; try again shortly", 429);
  }
  /* The verdict names the account the address resolved to, and it must be the
     one holding this session: a second account that somehow shared the address
     would otherwise let its password answer for this one. */
  if (verdict.outcome !== "verified" || verdict.userId !== session.user.id) throw unproven();
  return { userId: session.user.id, intent, method: "password" };
}

async function verifyStepUpProof(
  event: RecentAuthenticationEvent,
  session: RecentAuthenticationSubject,
  intent: StepUpIntent,
  config: AuthConfig,
): Promise<RecentAuthentication> {
  const value = event.cookies.get(stepUpProofCookieName(config));
  /* Consumed on sight, whatever it turns out to be: the browser gets one
     action per step-up, and a refused proof is not left lying around to be
     retried against a different one. The cookie is HTTP-only and expires in
     two minutes, so clearing it is what "consumed" means here — Orbit keeps no
     server-side record of which proofs have been spent. */
  clearStepUpProofCookie(event.cookies, config);
  if (!value) throw unproven();

  let payload: Record<string, unknown>;
  try {
    payload = await openProof(value, STEP_UP_PROOF_AUDIENCE, config);
  } catch {
    // Expired, forged, or sealed for another audience: all the same answer.
    throw unproven();
  }
  if (payload.sessionId !== session.id || payload.intent !== intent) throw unproven();
  return { userId: session.user.id, intent, method: "step_up" };
}
