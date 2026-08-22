import { error, json } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import { ADMIN_USERS_FIXTURE } from "$lib/data/fixtures/admin.js";

/** Fixture stand-in for `GET /api/admin/users` (#465) — see api/workspace/
 * +server.js for the env-gating rationale. */
export function GET() {
  if (env.ORBIT_FIXTURES !== "1") error(404, "Not found");
  return json(ADMIN_USERS_FIXTURE, { headers: { "cache-control": "no-store" } });
}
