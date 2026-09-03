import { error, json } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";

/**
 * Fixture stand-in for `GET /api/settings/tour` (#751/#752) — the
 * `settings/reminders` precedent, including its reasoning: the real endpoint
 * lives in the engine and reads the signed-in user's own row, and this only
 * ever hands back a known value so the fidelity gate measures the port.
 *
 * Read only, for the same reason as reminders: `PUT` belongs to the engine.
 * There is no preferences row here to write, and a proxy that pretended to
 * save would make the gate agree with a state nothing is holding.
 *
 * THE VALUE IS "ALREADY TAKEN", deliberately. Under fixtures every screen in
 * the gate is photographed as a returning reader, so the walk must not open
 * itself over seventeen other screenshots. The two tour screens are the ones
 * that want the other answer, and they say so where the rest of their setup
 * is — by answering this route themselves (tests/fidelity/screens.spec.js,
 * `tourDue`), which is how the goodbye already says it is signed out.
 */
const TOUR_FIXTURE = { tour: { tourSeenAt: "2026-08-13T09:00:00.000Z" } };

export function GET() {
  if (env.ORBIT_FIXTURES !== "1") error(404, "Not found");
  return json(TOUR_FIXTURE, { headers: { "cache-control": "no-store" } });
}
