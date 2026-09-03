import { env } from "$env/dynamic/private";

/**
 * Whether the fixture harness is on (#451's ORBIT_FIXTURES, extended to a page
 * for #410/§15).
 *
 * The ratified flight is a moving thing, and a moving thing cannot be judged
 * from a description. With this flag home accepts `?flight=up|down&at=<ms>`
 * and holds ONE millisecond of the journey still — every beat up to it
 * applied, the canvas simulated at a fixed 60fps to exactly that moment, no
 * clock and no randomness anywhere in it — so a beat can be screenshotted, put
 * in front of the owner, and compared against the mockup frame for frame.
 *
 * Unreachable in production twice over (#773): nothing production runs sets the
 * variable, and a production build that finds it set refuses to start, with
 * `validateStartupConfiguration` naming the `fixtures` setting as a blocking
 * problem. Without the flag the query string is ignored either way. The second
 * layer replaces the composite entry (#450), which served this app only for the
 * paths in its table and went with the cut (#735).
 */
export function load() {
  return { fixtures: env.ORBIT_FIXTURES === "1" };
}
