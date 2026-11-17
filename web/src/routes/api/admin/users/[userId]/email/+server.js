import { json } from "@sveltejs/kit";
import { z } from "zod";

import { AppError } from "orbit/lib/app-error";
import { requireRecentAuthentication } from "orbit/lib/auth/recent-auth";
import { readInstanceUser } from "orbit/server/admin-repository";
import { setUserAddress } from "orbit/server/local-credentials/address";
import { requireInstanceAdministrator } from "orbit/server/authorization";

import { write } from "$lib/server/api.js";

const bodySchema = z.object({
  /** The new address; trimmed and checked by the engine, as creation does. */
  email: z.string(),
  /**
   * The acting administrator's own current password (ADR-0023 §5), when they
   * have a local credential; absent for an OIDC-only administrator, who is
   * challenged with a step-up proof cookie instead.
   */
  currentPassword: z.string().optional(),
});

/**
 * Sets the address a member is registered with (#1869): the way back for an
 * account whose stored address cannot be read, or was typed wrongly. It
 * retires the account's live setup links and pending sign-in approvals,
 * tells the OLD address when it could be read, and sends no setup link; the
 * administrator sends one afterwards from the row.
 *
 * Re-challenged first, under its own intent `email_address_set`, so a proof
 * taken for a setup link cannot pay for it.
 */
export const PUT = write(async (event, session) => {
  await requireInstanceAdministrator(session.user.id);
  const userId = /** @type {string} */ (event.params.userId);
  if (!z.uuid().safeParse(userId).success) {
    throw new AppError("invalid_identifier", "User is not a valid identifier", 422);
  }
  const submitted = bodySchema.parse(await event.request.json());
  await requireRecentAuthentication(event, session, submitted, "email_address_set");

  const { noticeError } = await setUserAddress(session.user.id, userId, submitted.email);
  const user = await readInstanceUser(userId);
  if (!user) throw new AppError("user_not_found", "That registered Orbit user is no longer available", 404);

  return json({ user, noticeError }, { headers: { "cache-control": "no-store" } });
});
