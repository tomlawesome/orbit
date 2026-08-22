import { env } from "$env/dynamic/private";

/**
 * Whether the fixture harness is on (#451's ORBIT_FIXTURES, extended to the
 * front door for #410/§15) — and nothing else.
 *
 * The door itself still holds no data: this load reaches no database and no
 * session, so a signed-out reader's surface is as data-free as it was when this
 * page was prerendered. What it does do is let the harness NAME an arrival
 * stage, exactly as home's own load lets it name a beat of the flight, so the
 * create card and the newcomer's landing can be photographed and put in front
 * of the owner instead of described.
 *
 * The prerender that used to stand here goes with it: a flag baked into static
 * HTML at build time is a flag that cannot be turned off at run time, and this
 * one must be off in production whatever the build did. Read per request, it is
 * unreachable in production twice over, exactly as the fixture API routes are:
 * the composite entry (#450) never sets the flag, and without the flag the
 * query string is not read at all.
 */
export function load() {
  return { fixtures: env.ORBIT_FIXTURES === "1" };
}
