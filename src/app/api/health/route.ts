import { NextResponse } from "next/server";
import { getPublicReadiness } from "@/server/readiness";

export const dynamic = "force-dynamic";

export async function GET() {
  const readiness = await getPublicReadiness();
  return NextResponse.json(
    { status: readiness.status, service: "orbit", timestamp: new Date().toISOString() },
    { status: readiness.status === "ready" ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
