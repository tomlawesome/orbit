"use client";

import Image from "next/image";
import { Icon } from "@/components/icons";

/**
 * The signed-out surface: what an unauthenticated visitor, a session still
 * being confirmed, and a failed bootstrap all see. Extracted from
 * dashboard.tsx so the signed-out family of screens (design/family/login.html,
 * logout.html) can be built without touching the authenticated shell.
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
  const message = loading ? loadingMessage : error;
  return (
    <main className="authentication-gate">
      <section>
        <Image src="/orbit-mark.svg" alt="" width={112} height={112} priority />
        <p className="eyebrow">Everything in your orbit, on track</p>
        <h1>{loading ? loadingMessage ? "Orbit is starting…" : "Checking access…" : error ? "Orbit could not open safely." : "Sign in to Orbit."}</h1>
        <p role={message ? "alert" : undefined}>
          {message ?? (loading
            ? "Orbit is confirming your session."
            : "Your household information is private and is only available after authentication.")}
        </p>
        {!loading && error && onRetry && <button className="wizard-primary" type="button" onClick={onRetry}>Try again <Icon name="chevron" /></button>}
        {!loading && !error && <a className="wizard-primary" href="/api/auth/login">Sign in securely <Icon name="chevron" /></a>}
      </section>
    </main>
  );
}
