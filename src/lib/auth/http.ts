import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AuthError, asAuthError } from "@/lib/auth/errors";
import {
  reportAuthConfiguration,
  reportAuthProviderDiscoveryFailure,
  reportAuthTokenExchangeFailure,
} from "@/lib/auth/observability";

export function authErrorResponse(error: unknown): NextResponse {
  const authError = error instanceof ZodError
    ? new AuthError("auth_not_configured", "Authentication runtime configuration is incomplete", 503, { cause: error })
    : asAuthError(error);

  if (authError.code === "auth_not_configured") reportAuthConfiguration("invalid");
  if (authError.code === "discovery_failed") reportAuthProviderDiscoveryFailure();
  if (authError.code === "token_exchange_failed") reportAuthTokenExchangeFailure();

  return NextResponse.json(
    { error: { code: authError.code, message: authError.message } },
    { status: authError.status, headers: { "Cache-Control": "no-store" } },
  );
}
