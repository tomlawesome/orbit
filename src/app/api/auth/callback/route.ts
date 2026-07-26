import { NextRequest, NextResponse } from "next/server";
import { getAuthConfig, type AuthConfig } from "@/lib/env";
import { clearTransactionCookie, sessionCookieName, setSessionCookie, transactionCookieName } from "@/lib/auth/cookies";
import { constantTimeEqual, openLoginTransaction } from "@/lib/auth/crypto";
import { AuthError, asAuthError } from "@/lib/auth/errors";
import { authErrorResponse } from "@/lib/auth/http";
import { completeAuthorization, discoverProvider } from "@/lib/auth/oidc";
import { provisionIdentity } from "@/lib/auth/provision";
import { createSession, deleteSessionToken } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

function logCallbackFailure(error: unknown, authError: AuthError): void {
  const cause = authError.cause instanceof Error ? authError.cause : error instanceof Error ? error : undefined;
  const details = cause as (Error & { code?: unknown; claim?: unknown; reason?: unknown }) | undefined;

  // Deliberately exclude tokens, authorization codes, claims, and request data.
  console.error("Orbit authentication callback failed", {
    code: authError.code,
    status: authError.status,
    cause: details
      ? {
          name: details.name,
          code: typeof details.code === "string" ? details.code : undefined,
          claim: typeof details.claim === "string" ? details.claim : undefined,
          reason: typeof details.reason === "string" ? details.reason : undefined,
          message: details.message.replace(/[\r\n\t]/g, " ").slice(0, 300),
        }
      : undefined,
  });
}

function callbackFailure(error: unknown, config: AuthConfig): NextResponse {
  const authError = asAuthError(error);
  logCallbackFailure(error, authError);
  const target = new URL("/auth/error", config.appUrl);
  target.searchParams.set("code", authError.code);
  const response = NextResponse.redirect(target, 303);
  response.headers.set("Cache-Control", "no-store");
  clearTransactionCookie(response, config);
  return response;
}

export async function GET(request: NextRequest) {
  let config: AuthConfig;
  try {
    config = getAuthConfig();
  } catch (error) {
    return authErrorResponse(error);
  }

  try {
    const providerError = request.nextUrl.searchParams.get("error");
    if (providerError) throw new AuthError("provider_error", "The identity provider declined the sign-in request", 401);

    const code = request.nextUrl.searchParams.get("code");
    const returnedState = request.nextUrl.searchParams.get("state");
    const transactionCookie = request.cookies.get(transactionCookieName(config))?.value;
    if (!code || !returnedState || !transactionCookie) {
      throw new AuthError("invalid_request", "The authorization response is incomplete", 400);
    }

    const transaction = await openLoginTransaction(transactionCookie, config);
    if (!constantTimeEqual(returnedState, transaction.state)) {
      throw new AuthError("invalid_state", "The authorization state does not match", 400);
    }

    const metadata = await discoverProvider(config);
    const identity = await completeAuthorization(config, metadata, code, transaction);
    const user = await provisionIdentity(identity);
    if (user.disabledAt) {
      throw new AuthError("account_disabled", "This Orbit account is disabled", 403);
    }

    // A successful login always replaces the browser's previous session.
    await deleteSessionToken(request.cookies.get(sessionCookieName(config))?.value);
    const session = await createSession(user.id, config);
    const response = NextResponse.redirect(new URL(transaction.returnTo, config.appUrl), 303);
    response.headers.set("Cache-Control", "no-store");
    clearTransactionCookie(response, config);
    setSessionCookie(response, session.token, config);
    return response;
  } catch (error) {
    return callbackFailure(error, config);
  }
}
