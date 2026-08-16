import { error, json } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import { RELAY_FIXTURE } from "$lib/data/fixtures/relay.js";

/**
 * Fixture stand-in for `GET /api/settings/mail-relay` (#432) — see
 * api/workspace/+server.js for the env-gating rationale. The real endpoint
 * lives in the engine and derives the address per request; this only ever
 * hands back the mockup's own values so the gate measures the port.
 */
export function GET() {
  if (env.ORBIT_FIXTURES !== "1") error(404, "Not found");
  return json(RELAY_FIXTURE, { headers: { "cache-control": "no-store" } });
}
