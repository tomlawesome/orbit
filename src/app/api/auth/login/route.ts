import { NextRequest, NextResponse } from "next/server";
import { getAuthConfig } from "@/lib/env";
import { randomUrlSafe, safeReturnPath, sealLoginTransaction, type LoginTransaction } from "@/lib/auth/crypto";
import { setTransactionCookie } from "@/lib/auth/cookies";
import { authErrorResponse } from "@/lib/auth/http";
import { createAuthorizationUrl, discoverProvider } from "@/lib/auth/oidc";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const config = getAuthConfig();
    const metadata = await discoverProvider(config);
    const transaction: LoginTransaction = {
      state: randomUrlSafe(),
      nonce: randomUrlSafe(),
      codeVerifier: randomUrlSafe(),
      returnTo: safeReturnPath(request.nextUrl.searchParams.get("returnTo")),
    };
    const sealedTransaction = await sealLoginTransaction(transaction, config);
    const response = NextResponse.redirect(createAuthorizationUrl(config, metadata, transaction), 302);
    response.headers.set("Cache-Control", "no-store");
    setTransactionCookie(response, sealedTransaction, config);
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}
