import { NextRequest, NextResponse } from "next/server";
import { appErrorResponse } from "@/lib/app-error";
import { getAuthConfig } from "@/lib/env";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { tourPreferenceSchema } from "@/lib/preferences";
import { assertOutsideMaintenance } from "@/server/maintenance";
import { readTourSettings, writeTourSettings } from "@/server/tour-settings";

export const dynamic = "force-dynamic";

/**
 * The signed-in user's own first-run tour record (#751, slice 1 of #477):
 * whether the walk has been taken, set when they skip or finish it, cleared
 * by "Take the walk again".
 *
 * The session is the only input on both verbs — no user id is accepted, so
 * there is nothing to substitute and no way to read or rewrite another
 * reader's record. `no-store` because a preference the user just changed
 * must never be served from a cache, and the write carries a CSRF token
 * because it changes state (the `/api/preferences` precedent).
 */
export async function GET(request: NextRequest) {
  try {
    await assertOutsideMaintenance(request);
    const session = await requireSession(request, getAuthConfig());
    const tour = await readTourSettings(session.user.id);
    return NextResponse.json({ tour }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return appErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    await assertOutsideMaintenance(request);
    const config = getAuthConfig();
    const session = await requireSession(request, config);
    assertCsrf(request, session, config);
    const preference = tourPreferenceSchema.parse(await request.json());
    const tour = await writeTourSettings(session.user.id, preference);
    return NextResponse.json({ tour }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return appErrorResponse(error);
  }
}
