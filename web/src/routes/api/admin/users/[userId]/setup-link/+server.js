import { json } from "@sveltejs/kit";
import { z } from "zod";

import { AppError } from "orbit/lib/app-error";
import { AuthError } from "orbit/lib/auth/errors";
import { getAuthConfig } from "orbit/lib/env";
import { issueSetupToken, verifyCredential } from "orbit/server/local-credentials";
import { requireInstanceAdministrator } from "orbit/server/authorization";

import { write } from "$lib/server/api.js";

const bodySchema = z.object({
  /** The acting administrator's own current password (ADR-0023 §5). */
  currentPassword: z.string(),
});

/**
 * The local-credential half of "always challenge" (ADR-0023 §5) — see the
 * matching helper and its TODO(#910) in `web/src/routes/api/admin/users/+server.js`.
 */
async function requireRecentLocalAuthentication(session, currentPassword) {
  const verdict = await verifyCredential(session.user.email, currentPassword);
  if (verdict.outcome === "throttled") {
    throw new AuthError("too_many_attempts", "Too many attempts at once; try again shortly", 429);
  }
  if (verdict.outcome !== "verified" || verdict.userId !== session.user.id) {
    throw new AuthError("recent_authentication_required", "Confirm your password to continue", 401);
  }
}

/**
 * Re-issues a setup link (purpose `recovery`) for a local user who has
 * forgotten their password (ADR-0023 §3). Returns the URL once, exactly as
 * the initial creation does; the administration screen never stores it.
 */
export const POST = write(async (event, session) => {
  await requireInstanceAdministrator(session.user.id);
  const userId = /** @type {string} */ (event.params.userId);
  if (!z.uuid().safeParse(userId).success) {
    throw new AppError("invalid_identifier", "User is not a valid identifier", 422);
  }
  const submitted = bodySchema.parse(await event.request.json());
  await requireRecentLocalAuthentication(session, submitted.currentPassword);

  const config = getAuthConfig();
  const { token } = await issueSetupToken(userId, "recovery", { createdByUserId: session.user.id });
  const setupUrl = new URL(`/setup/${token}`, config.appUrl).toString();

  return json({ setupUrl }, { headers: { "cache-control": "no-store" } });
});
