import { NextRequest, NextResponse } from "next/server";
import { getAuthConfig } from "@/lib/env";
import { clearSessionCookie } from "@/lib/auth/cookies";
import { authErrorResponse } from "@/lib/auth/http";
import { createProviderLogoutUrl, discoverProvider } from "@/lib/auth/oidc";
import { assertCsrf, assertSameOrigin, deleteSessionToken, readSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const config = getAuthConfig();
    const session = await readSession(request, config);
    if (session) assertCsrf(request, session, config);
    else assertSameOrigin(request, config);
    await deleteSessionToken(session?.token);

    let redirectTarget = config.appUrl;
    try {
      const metadata = await discoverProvider(config);
      redirectTarget = createProviderLogoutUrl(config, metadata) ?? config.appUrl;
    } catch {
      // Local logout must succeed even if the provider is unavailable.
    }

    const response = NextResponse.redirect(redirectTarget, 303);
    response.headers.set("Cache-Control", "no-store");
    clearSessionCookie(response, config);
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}
