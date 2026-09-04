import { json } from "@sveltejs/kit";
import { z } from "zod";

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
 */
export const POST = write(async (event, session) => {
  const { targetUserId } = transferSchema.parse(await event.request.json());
  const result = await transferPrimaryAdministrator(session.user.id, session.id, targetUserId);
  return json(
    { users: result.users, totalUsers: result.totalCount, truncated: result.truncated },
    { headers: { "cache-control": "no-store" } },
  );
});
