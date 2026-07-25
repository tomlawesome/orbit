import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AuthError } from "@/lib/auth/errors";

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

/** Converts expected API failures into a consistent, non-cacheable response. */
export function appErrorResponse(error: unknown): NextResponse {
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
  console.error(error);
  return NextResponse.json(
    { error: { code: "internal_error", message: "Orbit could not complete the request" } },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}
