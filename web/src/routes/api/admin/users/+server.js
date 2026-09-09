import { json } from "@sveltejs/kit";
import { z } from "zod";

import { listInstanceUsers, setInstanceAdministrator, setInstanceUserDisabled } from "orbit/server/admin-repository";
import { requireInstanceAdministrator } from "orbit/server/authorization";
import { createLocalUser, issueSetupToken, verifyCredential } from "orbit/server/local-credentials";
import { AuthError } from "orbit/lib/auth/errors";
import { getAuthConfig } from "orbit/lib/env";

import { ADMIN_USERS_FIXTURE } from "$lib/data/fixtures/admin.js";
import { read, write } from "$lib/server/api.js";

const administratorUpdateSchema = z.object({ userId: z.uuid(), administrator: z.boolean() });
const disabledUpdateSchema = z.object({ userId: z.uuid(), disabled: z.boolean() });
const createLocalUserSchema = z.object({
  email: z.string(),
  displayName: z.string(),
  /** The acting administrator's own current password (ADR-0023 §5). */
  currentPassword: z.string(),
});

/**
 * The local-credential half of "always challenge" (ADR-0023 §5) for the two
 * admin routes below. An OIDC-only administrator's step-up is
 * `src/lib/auth/recent-auth.ts` (#910), which no slice has landed yet — this
 * checks only the branch that already exists, and fails closed rather than
 * skip the challenge for an administrator who has no local credential.
 *
 * TODO(#910): route an OIDC-only administrator through the step-up guard
 * here once it lands, instead of falling through to `recent_authentication_required`.
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
  await requireRecentLocalAuthentication(session, submitted.currentPassword);

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
