import { json } from "@sveltejs/kit";

import { getSystemStatus } from "orbit/server/system-status";

import { SYSTEM_STATUS_FIXTURE } from "$lib/data/fixtures/system-status.js";
import { read } from "$lib/server/api.js";

/**
 * The system-status drawer's own data (#863).
 *
 * Any signed-in reader, not only an administrator: `#869`'s ruling put
 * per-subsystem truth "behind sign-in", not behind the admin gate, because a
 * signed-out visitor learning which dependency is down is reconnaissance and
 * a signed-in household member during an incident is the whole point of the
 * drawer. `getSystemStatus` already carries the security split -- state
 * words, never a reason, a version or a path -- so this route adds nothing
 * beyond the session and the maintenance guard `read()` already gives every
 * other signed-in-only route.
 */
export const GET = read(
  async () => json({ status: await getSystemStatus() }, { headers: { "cache-control": "no-store" } }),
  { fixture: () => json({ status: SYSTEM_STATUS_FIXTURE }, { headers: { "cache-control": "no-store" } }) },
);
