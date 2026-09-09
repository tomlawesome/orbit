import { json } from "@sveltejs/kit";
import { z } from "zod";

import { listInstanceUsers, setInstanceAdministrator, setInstanceUserDisabled } from "orbit/server/admin-repository";
import { requireInstanceAdministrator } from "orbit/server/authorization";
import { createLocalUser, issueSetupToken } from "orbit/server/local-credentials";
import { requireRecentAuthentication } from "orbit/lib/auth/recent-auth";
import { getAuthConfig } from "orbit/lib/env";

import { ADMIN_USERS_FIXTURE } from "$lib/data/fixtures/admin.js";
import { read, write } from "$lib/server/api.js";

const administratorUpdateSchema = z.object({ userId: z.uuid(), administrator: z.boolean() });
const disabledUpdateSchema = z.object({ userId: z.uuid(), disabled: z.boolean() });
const createLocalUserSchema = z.object({
  email: z.string(),
  displayName: z.string(),
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
 * Creates a local user with no password (ADR-0023 §3): an administrator
 * names the address and the display name, and the response carries the
 * one-time setup URL the new user opens to choose their own password. The
 * URL is returned exactly once — `GET` never carries it, and neither does
 * any other response — because it is, until consumed, everything needed to
 * sign in as that user.
 */
export const POST = write(async (event, session) => {
  await requireInstanceAdministrator(session.user.id);
  const submitted = createLocalUserSchema.parse(await event.request.json());
  await requireRecentAuthentication(event, session, submitted, "local_user_create");

  const user = await createLocalUser(
    { email: submitted.email, displayName: submitted.displayName },
    { createdByUserId: session.user.id },
  );
  const config = getAuthConfig();
  const { token } = await issueSetupToken(user.id, "setup", { createdByUserId: session.user.id });
  const setupUrl = new URL(`/setup/${token}`, config.appUrl).toString();

  return json(
    { user, setupUrl },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
});
