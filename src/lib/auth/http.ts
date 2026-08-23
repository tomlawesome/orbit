import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { appErrorResponse, MaintenanceActiveError } from "@/lib/app-error";
import { AuthError, asAuthError } from "@/lib/auth/errors";
import {
  reportAuthConfiguration,
  reportAuthProviderDiscoveryFailure,
  reportAuthTokenExchangeFailure,
} from "@/lib/auth/observability";

export function authErrorResponse(error: unknown): NextResponse {
  // The guard's block is not an authentication failure: it must keep its
  // bounded 503 contract (#523) rather than collapse into provider_error.
  if (error instanceof MaintenanceActiveError) return appErrorResponse(error);
  const authError = error instanceof ZodError
    ? new AuthError("auth_not_configured", "Authentication runtime configuration is incomplete", 503, { cause: error })
    : asAuthError(error);

  if (authError.code === "auth_not_configured") reportAuthConfiguration("invalid");
  if (authError.code === "discovery_failed") reportAuthProviderDiscoveryFailure();
  if (authError.code === "token_exchange_failed") reportAuthTokenExchangeFailure(authError.tokenExchangeReason ?? "provider_rejected");

  return NextResponse.json(
    { error: { code: authError.code, message: authError.message } },
    { status: authError.status, headers: { "Cache-Control": "no-store" } },
  );
}
