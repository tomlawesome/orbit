import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AuthError } from "@/lib/auth/errors";
import { log } from "@/lib/logger";

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/**
 * The bounded blocked-request contract of ADR-0013 decision 2 (#523).
 * Deliberately outside the `{ error: { code, message } }` envelope: the body
 * is the fixed `{"error":"maintenance_active"}` and never carries the
 * message, schedule or configuration.
 */
export class MaintenanceActiveError extends Error {
  constructor(public readonly expectedEndAt: Date | null) {
    super("Orbit is in maintenance");
    this.name = "MaintenanceActiveError";
  }
}

/** Converts expected API failures into a consistent, non-cacheable response. */
export function appErrorResponse(error: unknown): NextResponse {
  if (error instanceof MaintenanceActiveError) {
    const headers: Record<string, string> = { "Cache-Control": "no-store" };
    const secondsRemaining = error.expectedEndAt
      ? Math.ceil((error.expectedEndAt.getTime() - Date.now()) / 1000)
      : 0;
    if (secondsRemaining > 0) headers["Retry-After"] = String(secondsRemaining);
    return NextResponse.json({ error: "maintenance_active" }, { status: 503, headers });
  }
  if (error instanceof AuthError || error instanceof AppError) {
    return NextResponse.json(
      { error: { code: error instanceof AuthError ? error.code : error.code, message: error.message } },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: { code: "validation_failed", message: "The submitted data is invalid", issues: error.issues } },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }
  log.error({
    event: "application.error",
    state: "degraded",
    reason: "unexpected_failure",
    action: "inspect_admin_diagnostics",
    impact: "application_degraded",
  });
  return NextResponse.json(
    { error: { code: "internal_error", message: "Orbit could not complete the request" } },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}
