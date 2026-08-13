"use client";

import { useSyncExternalStore } from "react";
import { FamilyScreen, type FamilyPhase } from "@/components/family-screen";
import { Icon } from "@/components/icons";
import { noSignedOutNotice, signedOutNoticeSnapshot, subscribeToSignedOutNotice } from "@/lib/signed-out-notice";

/**
 * The signed-out surface: what an unauthenticated visitor, a session still
 * being confirmed, a failed bootstrap and a completed sign-out all see.
 * Built on the family surface (design/family/login.html, logout.html and
 * maintenance.html — issue #307's ratified v19 family), which is why none
 * of the authenticated shell's styles reach it.
 *
 * This component is a security boundary, not just a screen. It renders
 * only literals declared here plus the `loadingMessage`/`error` strings the
 * caller hands in — never workspace, household or identity data — so an
 * unauthenticated visitor cannot learn anything from it. The four states
 * and their exact headings are asserted by tests/e2e/signed-out.spec.ts,
 * online-workspace-policy.spec.ts and authenticated-lifecycle.spec.ts:
 *
 *  - signed out       "Sign in to Orbit."          → /api/auth/login
 *  - just signed out  "Sign in to Orbit."          → /api/auth/login, sunset
 *  - starting/waiting "Orbit is starting…" / "Checking access…"
 *  - cannot open      "Orbit could not open safely." → retry
 *
 * The goodbye state deliberately keeps the sign-in heading. Sign-out is a
 * security event with e2e coverage that asserts the visitor lands back on
 * the authentication boundary by that heading, and the screen's job is
 * still to offer a way back in; the confirmation is carried by the status
 * line, the ribbon and the setting sun instead.
 */
export function AuthenticationGate({
  loading,
  loadingMessage,
  error,
  onRetry,
}: {
  loading: boolean;
  loadingMessage?: string;
  error?: string;
  onRetry?: () => void;
}) {
  // True only when the *previous* document in this tab deliberately ended
  // its session, so "not signed in" and "just signed out" stay distinct.
  const justSignedOut = useSyncExternalStore(subscribeToSignedOutNotice, signedOutNoticeSnapshot, noSignedOutNotice);
  const message = loading ? loadingMessage : error;

  const heading = loading
    ? loadingMessage ? "Orbit is starting…" : "Checking access…"
    : error ? "Orbit could not open safely." : "Sign in to Orbit.";

  const eyebrow = loading
    ? "Confirming your session"
    : error ? "Service unavailable"
    : justSignedOut ? "Signed out" : "Everything in your orbit, on track";

  const ribbon = error
    ? "Service unavailable"
    : justSignedOut ? "Signed out · Session ended" : "Private · Self-hosted · Yours";

  const phase: FamilyPhase = error ? "eclipse" : justSignedOut ? "set" : "rise";

  const body = message ?? (loading
    ? "Orbit is confirming your session."
    : justSignedOut
      ? "You are signed out on this device. Your household information stays private until you sign in again."
      : "Your household information is private and is only available after authentication.");

  return (
    <FamilyScreen phase={phase} ribbon={ribbon}>
      <p className="family-eyebrow">{eyebrow}</p>
      <h1>{heading}</h1>
      <p className="family-message" role={error ? "alert" : loading ? "status" : undefined}>{body}</p>
      {!loading && error && onRetry && (
        <button className="family-action" type="button" onClick={onRetry}>
          Try again <Icon name="chevron" />
        </button>
      )}
      {!loading && !error && (
        <a className="family-action" href="/api/auth/login">
          {justSignedOut ? "Sign back in" : "Sign in securely"} <Icon name="chevron" />
        </a>
      )}
    </FamilyScreen>
  );
}
