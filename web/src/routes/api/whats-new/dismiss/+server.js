import { json } from "@sveltejs/kit";

import { AppError } from "orbit/lib/errors";
import { dismissWhatsNew } from "orbit/server/whats-new";

import { write } from "$lib/server/api.js";

/**
 * Dismisses the what's-new notice (#1618): body `{ version }`, the version the
 * card showed. The engine stores max(seen, min(version, running)), so the
 * record never goes backwards. A CSRF-checked write for the session's own user.
 */
export const POST = write(async (event, session) => {
  const body = await event.request.json();
  if (typeof body?.version !== "string") {
    throw new AppError("validation_failed", "version must be a string", 422);
  }
  await dismissWhatsNew(session.user.id, body.version, { runningVersion: process.env.ORBIT_VERSION ?? null });
  return json({ ok: true }, { headers: { "cache-control": "no-store" } });
});
