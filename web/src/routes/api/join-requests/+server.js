import { error, json } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";

/** Fixture stand-in for `GET /api/join-requests` (#453/#465) — the #452
 * mockup's one pending request, in the real route's shape. Caught 2 days
 * before the fixture's noon, so the screen says "2d ago" and holds still. */
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
