import { NextRequest, NextResponse } from "next/server";
import { appErrorResponse } from "@/lib/app-error";
import { getAuthConfig } from "@/lib/env";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { reminderPreferenceSchema } from "@/lib/preferences";
import { readReminderSettings, writeReminderSettings } from "@/server/reminder-settings";

export const dynamic = "force-dynamic";

/**
 * The signed-in user's own reminder timing (#468): email reminders on or off,
 * the first and final warning offsets, and the instance's outbound-mail state
 * in bounded words.
 *
 * The session is the only input on both verbs — no user id is accepted, so
 * there is nothing to substitute and no way to read or rewrite another
 * reader's timing. `no-store` because a preference the user just changed must
 * never be served from a cache, and the write carries a CSRF token because it
 * changes state (the `/api/preferences` precedent).
 */
export async function GET(request: NextRequest) {
  try {
    const session = await requireSession(request, getAuthConfig());
    const reminders = await readReminderSettings(session.user.id);
    return NextResponse.json({ reminders }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return appErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const config = getAuthConfig();
    const session = await requireSession(request, config);
    assertCsrf(request, session, config);
    const preference = reminderPreferenceSchema.parse(await request.json());
    const reminders = await writeReminderSettings(session.user.id, preference);
    return NextResponse.json({ reminders }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return appErrorResponse(error);
  }
}
