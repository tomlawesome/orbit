import { error, json } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import { REMINDERS_FIXTURE } from "$lib/data/fixtures/settings.js";

/**
 * Fixture stand-in for `GET /api/settings/reminders` (#468) — see
 * api/workspace/+server.js for the env-gating rationale. The real endpoint
 * lives in the engine and reads the signed-in user's stored preference; this
 * only ever hands back the mockup's own values so the gate measures the port.
 *
 * Read only, like the relay's stand-in. `PUT` belongs to the engine: there is
 * no preferences row here to write, and a proxy that pretended to save would
 * make the gate agree with a state nothing is holding.
 */
export function GET() {
  if (env.ORBIT_FIXTURES !== "1") error(404, "Not found");
  return json(REMINDERS_FIXTURE, { headers: { "cache-control": "no-store" } });
}
