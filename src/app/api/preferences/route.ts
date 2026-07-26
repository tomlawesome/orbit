import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db";
import { userPreferences } from "@/db/schema";
import { getAuthConfig } from "@/lib/env";
import { appErrorResponse } from "@/lib/app-error";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { themePreferenceSchema } from "@/lib/preferences";

export const dynamic = "force-dynamic";

export async function PUT(request: NextRequest) {
  try {
    const config = getAuthConfig();
    const session = await requireSession(request, config);
    assertCsrf(request, session, config);
    const preference = themePreferenceSchema.parse(await request.json());
    await getDb().insert(userPreferences).values({
      userId: session.user.id,
      themeMode: preference.mode,
      themeId: preference.colourway,
      textSize: preference.textSize,
      urgencyPalette: preference.urgencyPalette,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: userPreferences.userId,
      set: {
        themeMode: preference.mode,
        themeId: preference.colourway,
        textSize: preference.textSize,
        urgencyPalette: preference.urgencyPalette,
        updatedAt: new Date(),
      },
    });
    const [saved] = await getDb().select().from(userPreferences)
      .where(eq(userPreferences.userId, session.user.id)).limit(1);
    return NextResponse.json(
      {
        preference: {
          mode: saved.themeMode,
          colourway: saved.themeId,
          textSize: saved.textSize,
          urgencyPalette: saved.urgencyPalette,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return appErrorResponse(error);
  }
}
