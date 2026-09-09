import { json } from "@sveltejs/kit";
import { z } from "zod";

import { AppError } from "orbit/lib/app-error";
import { requireRecentAuthentication } from "orbit/lib/auth/recent-auth";
import { sendSetupLink } from "orbit/server/local-credentials/setup-mail";
import { requireInstanceAdministrator } from "orbit/server/authorization";

import { write } from "$lib/server/api.js";

const bodySchema = z.object({
  /**
   * How many whole days the link lives, 1 to 14, default 7 (ADR-0023 §3).
   * It applies to a user who has never set a password; one who is recovering
   * a forgotten password gets ADR-0022 §5's ratified five minutes instead.
   */
  expiresInDays: z.number().optional(),
  /**
   * The acting administrator's own current password (ADR-0023 §5), when they
   * have a local credential; absent for an OIDC-only administrator, who is
   * challenged with a step-up proof cookie instead.
   */
  currentPassword: z.string().optional(),
});

/**
 * Sends a fresh link to a user's registered address (ADR-0023 §3): a first
 * password for an account that never set one, or a new one for somebody who
 * has forgotten theirs. Issuing it kills the earlier link.
 *
 * The URL is emailed and never returned, exactly as creation does it (owner
 * ruling, 2026-09-09); the answer is where it went, when it lapses, and — if
 * the mail did not go — one bounded word for why.
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

  const { sentTo, expiresAt, sendError } = await sendSetupLink(session.user.id, userId, {
    expiresInDays: submitted.expiresInDays,
  });

  return json(
    { sentTo, expiresAt: expiresAt.toISOString(), sendError },
    { headers: { "cache-control": "no-store" } },
  );
});
