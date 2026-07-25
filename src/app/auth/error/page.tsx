import Link from "next/link";

const messages: Record<string, string> = {
  invalid_request: "The sign-in response was incomplete.",
  invalid_state: "The sign-in request expired or could not be matched to this browser.",
  provider_error: "Your identity provider could not complete the request.",
  token_exchange_failed: "Orbit could not complete the secure token exchange.",
  invalid_id_token: "The identity response could not be verified.",
  missing_email: "Your identity provider must supply a usable email address.",
};

export default async function AuthErrorPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const parameters = await searchParams;
  const code = typeof parameters.code === "string" ? parameters.code : "provider_error";
  return (
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24 }}>
      <section style={{ maxWidth: 480, padding: 32, borderRadius: 24, background: "var(--paper)", boxShadow: "var(--shadow)" }}>
        <p className="eyebrow">Sign-in interrupted</p>
        <h1 style={{ fontSize: 36 }}>We couldn&apos;t sign you in.</h1>
        <p style={{ color: "var(--muted)", lineHeight: 1.6 }}>{messages[code] ?? messages.provider_error} Please try again or contact your Orbit administrator.</p>
        <Link href="/" className="add-button" style={{ display: "inline-flex", textDecoration: "none", marginTop: 12 }}>Return home</Link>
      </section>
    </main>
  );
}
