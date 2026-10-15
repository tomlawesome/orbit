import type { AuthConfig } from "@/lib/env";
import { createProviderLogoutUrl, discoverProvider } from "@/lib/auth/oidc";
import { openSessionIdToken } from "@/lib/auth/session";

/**
 * The provider's end-session address for a session that has just ended, or
 * null (#1316 9a, #1439). One place for the ordinary sign-out and the two
 * settings sign-outs, so they hand the browser to the provider the same way.
 *
 * `taken` is the ended row's id and sealed ID token, captured by the same
 * statement that deleted it (decision 26a). It must be this browser's own
 * session: another device's token is never a hint for this browser.
 *
 * Never throws. The session here is already ended, and that must stand even
 * when the provider cannot be asked.
 */
export async function providerLogoutFor(
  config: AuthConfig,
  taken: { id: string | null; encrypted: string | null },
  returnTo: URL,
): Promise<URL | null> {
  if (!config.oidc || !taken.encrypted) return null;
  try {
    /* No token (a password sign-in, an over-size one), a damaged or moved
       value, or a locked instance: no hint, so no hand-off. */
    const idTokenHint = await openSessionIdToken(taken);
    if (!idTokenHint) return null;
    /* A failed refresh falls back on the last good document rather than
       skip the provider sign-out. That needs an earlier good lookup in
       this process: after a restart with the provider down there is no
       document to fall back on, and the provider sign-out is skipped. */
    const metadata = await discoverProvider(config.oidc, { staleIfError: true });
    return createProviderLogoutUrl(config.oidc, metadata, returnTo, idTokenHint);
  } catch {
    // Local sign-out must succeed even if the provider is unavailable.
    return null;
  }
}
