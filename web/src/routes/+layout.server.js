import { env } from "$env/dynamic/private";

/**
 * #475: whether this instance is running on fixtures, for EVERY route.
 *
 * The living backdrops roll a fresh seed per load, but the fidelity gate
 * compares first-viewport pixels — so under fixtures the roll must be pinned
 * instead. Only `/` and `/home` could see the flag before, through their own
 * `+page.server.js`, which is why only home has a seeded sky today. A layout
 * load puts it in front of every screen that draws a backdrop: the relay,
 * create, administration and the rest.
 *
 * Read per request, never prerendered, for the same reason `/home` gives: a
 * baked-in value would ship the gate's world to a real instance.
 */
export function load() {
  return { fixtures: env.ORBIT_FIXTURES === "1" };
}
