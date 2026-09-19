import { json } from "@sveltejs/kit";
import { z } from "zod";

import { createHouseholdForOwner, HOUSEHOLD_NAME_LIMIT } from "orbit/server/admin-repository";
import { requireInstanceAdministrator } from "orbit/server/authorization";
import { requireRecentAuthentication } from "orbit/lib/auth/recent-auth";

import { write } from "$lib/server/api.js";

/**
 * A system an administrator made for somebody else (#1052).
 *
 * Two fields and nothing else, because that is what the decision of
 * 2026-09-19 says a system created from the administration screen IS: a
 * household with a named owner, starting empty. Time zone and currency are
 * left to the household's own defaults — the owner changes them on their
 * household screen, as anyone would — and the administrator is NOT made a
 * member of it.
 *
 * The bounds are stated here as well as in the engine so a bad name is
 * refused before any database work happens; `createHouseholdForOwner` keeps
 * its own copy of them, so the refusal is the same however the engine is
 * reached.
 */
const createSystemSchema = z.object({
  name: z.string().trim().min(1).max(HOUSEHOLD_NAME_LIMIT),
  ownerId: z.uuid(),
  /**
   * The acting administrator's own current password (ADR-0023 §5), when they
   * have a local credential; absent for an OIDC-only administrator, who is
   * challenged with a step-up proof cookie instead. Exactly as
   * `/api/admin/users` asks for it.
   */
  currentPassword: z.string().optional(),
});

/**
 * Creates a household and hands it to the named owner.
 *
 * The gate is the one every `users/` route uses and in the same order: a
 * session and the CSRF pair from `write()`, then the administrator check,
 * then the body, then the re-challenge — so an unauthenticated or non-admin
 * caller is refused before anything is parsed, and no action happens without
 * the person in front of the screen proving it is them.
 */
export const POST = write(async (event, session) => {
  await requireInstanceAdministrator(session.user.id);
  const submitted = createSystemSchema.parse(await event.request.json());
  await requireRecentAuthentication(event, session, submitted, "system_create");

  const household = await createHouseholdForOwner(session.user.id, {
    name: submitted.name,
    ownerId: submitted.ownerId,
  });

  return json({ household }, { status: 201, headers: { "cache-control": "no-store" } });
});
