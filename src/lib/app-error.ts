import { ZodError } from "zod";
import { AppError, MaintenanceActiveError } from "@/lib/errors";
import { AuthError } from "@/lib/auth/errors";
import { log } from "@/lib/logger";

/* The classes live in the framework-free `@/lib/errors` (ADR-0015 decision
   1) so operator artifacts can bundle domain code without linking Next.
   They are re-exported here because this is where the rest of the codebase
   already imports them from, and that should keep working. */
export { AppError, MaintenanceActiveError };

/** Converts expected API failures into a consistent, non-cacheable response. */
export function appErrorResponse(error: unknown): Response {
  if (error instanceof MaintenanceActiveError) {
    const headers: Record<string, string> = { "Cache-Control": "no-store" };
    const secondsRemaining = error.expectedEndAt
      ? Math.ceil((error.expectedEndAt.getTime() - Date.now()) / 1000)
      : 0;
    if (secondsRemaining > 0) headers["Retry-After"] = String(secondsRemaining);
    return Response.json({ error: "maintenance_active" }, { status: 503, headers });
  }
  if (error instanceof AuthError || error instanceof AppError) {
    return Response.json(
      { error: { code: error instanceof AuthError ? error.code : error.code, message: error.message } },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (error instanceof ZodError) {
    return Response.json(
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
  return Response.json(
    { error: { code: "internal_error", message: "Orbit could not complete the request" } },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}
