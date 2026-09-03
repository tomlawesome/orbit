import { NextRequest, NextResponse } from "next/server";
import { getAuthConfig } from "@/lib/env";
import { appErrorResponse } from "@/lib/app-error";
import { requireSession } from "@/lib/auth/session";
import { nextCookies } from "@/lib/auth/next-compat";
import { assertOutsideMaintenance } from "@/server/maintenance";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await assertOutsideMaintenance(nextCookies(request));
    await requireSession(nextCookies(request), getAuthConfig());
    return NextResponse.json(
      { publicKey: process.env.VAPID_PUBLIC_KEY ?? "" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return appErrorResponse(error);
  }
}
