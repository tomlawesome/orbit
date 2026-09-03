import { json } from "@sveltejs/kit";

import { listJoinRequests } from "orbit/server/join-requests";

import { read } from "$lib/server/api.js";

/* One pending request, in the real route's shape. Caught 2 days before the
   fixture's noon, so a screen reading it says "2d ago" and holds still. */
const FIXTURE_REQUESTS = [
  {
    id: "jr-rob-seaside",
    householdId: "hh-seaside-4551",
    householdName: "Seaside Cottage",
    userId: "u-rob",
    displayName: "Rob Lawson",
    createdAt: "2026-08-11T12:00:00.000Z",
  },
];

/** Pending join requests the caller may decide: their owned households, or
 * everything for an instance admin (§11, #453; #735 port). */
export const GET = read(
  async (_event, session) => {
    const requests = await listJoinRequests(session.user.id);
    return json({ requests }, { headers: { "cache-control": "no-store" } });
  },
  { fixture: () => json({ requests: FIXTURE_REQUESTS }, { headers: { "cache-control": "no-store" } }) },
);
