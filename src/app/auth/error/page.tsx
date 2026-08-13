import Link from "next/link";
import { FamilyScreen } from "@/components/family-screen";

/**
 * The sign-in error screen, rebuilt on the family surface
 * (design/family/maintenance.html's "could not open safely" treatment).
 *
 * Every message here is a fixed, content-free sentence chosen by an error
 * *code*: the provider's own error text is never echoed back, so a hostile
 * or over-talkative identity provider cannot use this page to say anything
 * to an unauthenticated visitor. `tests/e2e/authenticated-lifecycle.spec.ts`
 * asserts the account_disabled wording verbatim.
 */
const messages: Record<string, string> = {
  invalid_request: "The sign-in response was incomplete.",
  invalid_state: "The sign-in request expired or could not be matched to this browser.",
  provider_error: "Your identity provider could not complete the request.",
  token_exchange_failed: "Orbit could not complete the secure token exchange.",
  invalid_id_token: "The identity response could not be verified.",
  missing_email: "Your identity provider must supply a usable email address.",
  account_disabled: "This Orbit account has been disabled by an administrator.",
};

export const metadata = { title: "Sign-in interrupted" };

export default async function AuthErrorPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const parameters = await searchParams;
  const code = typeof parameters.code === "string" ? parameters.code : "provider_error";
  return (
    <FamilyScreen phase="eclipse" ribbon="Sign-in interrupted">
      <p className="family-eyebrow">Sign-in interrupted</p>
      <h1>We couldn&apos;t sign you in.</h1>
      <p className="family-message" role="alert">{messages[code] ?? messages.provider_error}</p>
      <p className="family-message family-message-quiet">Please try again, or contact your Orbit administrator.</p>
      <Link className="family-action" href="/">Return home</Link>
    </FamilyScreen>
  );
}
