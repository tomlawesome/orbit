import { error, json } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";

/** Fixture stand-in for `GET /api/join-requests` (#453/#465) — one pending
 * request, in the real route's shape. Caught 2 days before the fixture's
 * noon, so a screen reading it says "2d ago" and holds still.
 *
 * No screen reads it today: §15-2g took join requests off administration and
 * gave them to household management, which is not built yet. The route stays
 * for that screen — and because the real route it stands in for is live. */
export function GET() {
  if (env.ORBIT_FIXTURES !== "1") error(404, "Not found");
  return json({
    requests: [
      {
        id: "jr-rob-seaside",
        householdId: "hh-seaside-4551",
        householdName: "Seaside Cottage",
        userId: "u-rob",
        displayName: "Rob Lawson",
        createdAt: "2026-08-11T12:00:00.000Z",
      },
    ],
  }, { headers: { "cache-control": "no-store" } });
}
