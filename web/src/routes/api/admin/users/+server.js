import { json } from "@sveltejs/kit";
import { z } from "zod";

import { listInstanceUsers, setInstanceAdministrator, setInstanceUserDisabled } from "orbit/server/admin-repository";
import { requireInstanceAdministrator } from "orbit/server/authorization";
import { createLocalUserAndSendSetupLink } from "orbit/server/local-credentials/setup-mail";
import { requireRecentAuthentication } from "orbit/lib/auth/recent-auth";

import { ADMIN_USERS_FIXTURE } from "$lib/data/fixtures/admin.js";
import { read, write } from "$lib/server/api.js";

const administratorUpdateSchema = z.object({ userId: z.uuid(), administrator: z.boolean() });
const disabledUpdateSchema = z.object({ userId: z.uuid(), disabled: z.boolean() });
const createLocalUserSchema = z.object({
  email: z.string(),
  displayName: z.string(),
  /**
   * How many whole days the setup link lives, 1 to 14, default 7 (ADR-0023
   * §3). The bounds are the engine's, so the refusal is Orbit's own bounded
   * `invalid_request` wherever the call comes from.
   */
  expiresInDays: z.number().optional(),
  /**
   * The acting administrator's own current password (ADR-0023 §5), when they
   * have a local credential; absent for an OIDC-only administrator, who is
   * challenged with a step-up proof cookie instead.
   */
  currentPassword: z.string().optional(),
});

export const GET = read(
  async (_event, session) => {
    const result = await listInstanceUsers(session.user.id);
    return json(
      { users: result.users, totalUsers: result.totalCount, truncated: result.truncated },
      { headers: { "cache-control": "no-store" } },
    );
  },
  { fixture: () => json(ADMIN_USERS_FIXTURE, { headers: { "cache-control": "no-store" } }) },
);

export const PUT = write(async (event, session) => {
  const update = administratorUpdateSchema.parse(await event.request.json());
  const result = await setInstanceAdministrator(session.user.id, update.userId, update.administrator);
  return json(
    { users: result.users, totalUsers: result.totalCount, truncated: result.truncated },
    { headers: { "cache-control": "no-store" } },
  );
});

export const PATCH = write(async (event, session) => {
  const update = disabledUpdateSchema.parse(await event.request.json());
  const result = await setInstanceUserDisabled(session.user.id, update.userId, update.disabled);
  return json(
    { users: result.users, totalUsers: result.totalCount, truncated: result.truncated },
    { headers: { "cache-control": "no-store" } },
  );
});

/**
 * Creates a local user with no password (ADR-0023 §3): an administrator names
 * the address, the display name and how long the setup link should live, and
 * Orbit EMAILS the link to that address.
 *
 * No response on any route carries the URL or the token (owner ruling,
 * 2026-09-09): the administrator learns where it went and when it lapses, so
 * a link cannot be handed on to anybody but the person it is for. A mail that
 * did not go is reported as one bounded word in `sendError` — the account
 * exists either way, and the administrator sends again from its row.
 */
export const POST = write(async (event, session) => {
  await requireInstanceAdministrator(session.user.id);
  const submitted = createLocalUserSchema.parse(await event.request.json());
  await requireRecentAuthentication(event, session, submitted, "local_user_create");

  const { user, sentTo, expiresAt, sendError } = await createLocalUserAndSendSetupLink(
    session.user.id,
    { email: submitted.email, displayName: submitted.displayName },
    { expiresInDays: submitted.expiresInDays },
  );

  return json(
    { user, sentTo, expiresAt: expiresAt.toISOString(), sendError },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
});
