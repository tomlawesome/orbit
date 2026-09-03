import { NextRequest, NextResponse } from "next/server";
import { getAuthConfig } from "@/lib/env";
import { safeReturnPath } from "@/lib/auth/crypto";
import { clearSessionCookie } from "@/lib/auth/cookies";
import { authErrorResponse } from "@/lib/auth/http";
import { createProviderLogoutUrl, discoverProvider } from "@/lib/auth/oidc";
import { assertCsrf, assertSameOrigin, deleteSessionToken, readSession } from "@/lib/auth/session";
import { nextCookies, nextCookieSink } from "@/lib/auth/next-compat";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const config = getAuthConfig();
    const session = await readSession(nextCookies(request), config);
    if (session) assertCsrf(request.headers, session, config);
    else assertSameOrigin(request.headers, config);
    await deleteSessionToken(session?.token);

    // Mirrors the login route's returnTo (#410, §15): this engine's own
    // sign-out button is only ever reached from this engine's own screens
    // (/workspace, /settings), and "/" being v19's own front door now means
    // a bare sign-out would strand that journey there instead of showing it
    // its own signed-out state.
    const postLogoutReturnTo = new URL(safeReturnPath(request.nextUrl.searchParams.get("returnTo")), config.appUrl);

    let redirectTarget: URL = postLogoutReturnTo;
    try {
      const metadata = await discoverProvider(config);
      redirectTarget = createProviderLogoutUrl(config, metadata, postLogoutReturnTo) ?? postLogoutReturnTo;
    } catch {
      // Local logout must succeed even if the provider is unavailable.
    }

    const response = request.headers.get("accept")?.includes("application/json")
      ? NextResponse.json({ redirectTo: redirectTarget.href })
      : NextResponse.redirect(redirectTarget, 303);
    response.headers.set("Cache-Control", "no-store");
    clearSessionCookie(nextCookieSink(request, response), config);
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}
