import { NextRequest, NextResponse } from "next/server";
import { appErrorResponse } from "@/lib/app-error";
import { getAuthConfig } from "@/lib/env";
import { requireSession } from "@/lib/auth/session";
import { nextCookies } from "@/lib/auth/next-compat";
import { readRelaySettings } from "@/server/mail-in/relay-settings";
import { assertOutsideMaintenance } from "@/server/maintenance";

export const dynamic = "force-dynamic";

/**
 * The signed-in user's own relay (#432): their mail-in address, whether Orbit
 * is listening, when something last arrived, and the instance's ingest flag.
 *
 * A GET, so no CSRF token; the session is the only input, which is what makes
 * it impossible to ask for another user's relay. `no-store` is not decoration:
 * the address is a capability-bearing value that must never sit in a cache.
 * Nothing here logs, and no failure path can carry the address, because
 * `appErrorResponse` only ever emits its own bounded codes.
 */
export async function GET(request: NextRequest) {
  try {
    await assertOutsideMaintenance(nextCookies(request));
    const session = await requireSession(nextCookies(request), getAuthConfig());
    const relay = await readRelaySettings(session.user);
    return NextResponse.json({ relay }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return appErrorResponse(error);
  }
}
