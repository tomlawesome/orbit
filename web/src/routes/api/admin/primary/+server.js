import { json } from "@sveltejs/kit";
import { z } from "zod";

import { requireRecentAuthentication } from "orbit/lib/auth/recent-auth";
import { transferPrimaryAdministrator } from "orbit/server/admin-repository";

import { write } from "$lib/server/api.js";

const transferSchema = z.object({
  targetUserId: z.uuid(),
});

/**
 * Transfers primary administrator authority (#263, #735 port).
 *
 * No separate `requireInstanceAdministrator` call: `transferPrimaryAdministrator`
 * checks the actor itself, under the same advisory lock that moves the
 * authority, exactly as the Next route left it.
 *
 * Since M7 the caller is re-challenged first (ADR-0023 §5): a password in the
 * body for someone who has one, a step-up proof cookie for someone who does
 * not. #263's fifteen-minute "fresh session" window is gone — handing over the
 * instance always asks.
 */
export const POST = write(async (event, session) => {
  const body = await event.request.json();
  const { targetUserId } = transferSchema.parse(body);
  const recentAuthentication = await requireRecentAuthentication(event, session, body, "primary_transfer");
  const result = await transferPrimaryAdministrator(session.user.id, recentAuthentication, targetUserId);
  return json(
    { users: result.users, totalUsers: result.totalCount, truncated: result.truncated },
    { headers: { "cache-control": "no-store" } },
  );
});
