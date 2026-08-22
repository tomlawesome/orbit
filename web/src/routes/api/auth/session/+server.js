import { error, json } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";

import { SESSION_FIXTURE } from "$lib/data/fixtures/workspace.js";

/** Fixture stand-in for `GET /api/auth/session` — see api/workspace/+server.js. */
export function GET() {
  if (env.ORBIT_FIXTURES !== "1") error(404, "Not found");
  return json(SESSION_FIXTURE, { headers: { "cache-control": "no-store" } });
}
