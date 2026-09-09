import { json } from "@sveltejs/kit";
import { z } from "zod";

import { AppError } from "orbit/lib/app-error";
import { getAuthConfig } from "orbit/lib/env";
import { requireRecentAuthentication } from "orbit/lib/auth/recent-auth";
import { issueSetupToken } from "orbit/server/local-credentials";
import { requireInstanceAdministrator } from "orbit/server/authorization";

import { write } from "$lib/server/api.js";

const bodySchema = z.object({
  /**
   * The acting administrator's own current password (ADR-0023 §5), when they
   * have a local credential; absent for an OIDC-only administrator, who is
   * challenged with a step-up proof cookie instead.
   */
  currentPassword: z.string().optional(),
});

/**
 * Re-issues a setup link (purpose `recovery`) for a local user who has
 * forgotten their password (ADR-0023 §3). Returns the URL once, exactly as
 * the initial creation does; the administration screen never stores it.
 *
 * The acting administrator is re-challenged first, same as creation (ADR-0023
 * §5, `requireRecentAuthentication`, intent `setup_link_issue`).
 */
export const POST = write(async (event, session) => {
  await requireInstanceAdministrator(session.user.id);
  const userId = /** @type {string} */ (event.params.userId);
  if (!z.uuid().safeParse(userId).success) {
    throw new AppError("invalid_identifier", "User is not a valid identifier", 422);
  }
  const submitted = bodySchema.parse(await event.request.json());
  await requireRecentAuthentication(event, session, submitted, "setup_link_issue");

  const config = getAuthConfig();
  const { token } = await issueSetupToken(userId, "recovery", { createdByUserId: session.user.id });
  const setupUrl = new URL(`/setup/${token}`, config.appUrl).toString();

  return json({ setupUrl }, { headers: { "cache-control": "no-store" } });
});
