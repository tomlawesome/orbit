import { NextResponse } from "next/server";
import { getPublicReadiness } from "@/server/readiness";

export const dynamic = "force-dynamic";

export async function GET() {
  const readiness = await getPublicReadiness();
  return NextResponse.json(
    { status: readiness.status, service: "orbit", timestamp: new Date().toISOString() },
    // 503 only for genuine dependency failure: a maintained instance is
    // healthy, must not be restarted, and keeps receiving traffic (ADR-0013).
    { status: readiness.status === "degraded" ? 503 : 200, headers: { "Cache-Control": "no-store" } },
  );
}
