import { env } from "$env/dynamic/private";

import { readHome } from "$lib/data/workspace.js";

/**
 * What home needs before it can be painted: the view itself, and whether the
 * fixture harness is on.
 *
 * ---- THE VIEW (#842) ----
 *
 * Home used to fill `view` only in `onMount`, so the server rendered no
 * manifest at all and a reader without JavaScript got an empty screen —
 * against epic #411's fifth criterion, which asks for the manifest as a plain
 * list. The read is the same one the browser does; `event.fetch` resolves the
 * relative URLs against this app, dispatches them inside this process, and
 * carries the reader's own cookies, so the API answers for the right person.
 *
 * A failed read gives `view: null` rather than an error page. Signing in is
 * not this load's job — `hooks.server.js` sends a reader with no session to
 * `/login` before any load runs, so a null here means something else went
 * wrong (the inbox is already tolerated inside `readHome`). Home's own
 * `onMount` reads again as it always has, so the client recovers and shows the
 * reader the real failure; failing the page would replace a screen that can
 * still fix itself with one that cannot.
 *
 * ---- THE FIXTURE HARNESS (#451's ORBIT_FIXTURES, extended to a page for
 * #410/§15) ----
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
 *
 * ---- THE SYSTEM-STATUS DRAWER (#863) ----
 *
 * Read here rather than fetched client-side, for the same reason as the view
 * above: a server-rendered value is present at first paint, with no flash
 * between a neutral placeholder and the real content, and the fidelity gate's
 * screens never wait on a client fetch to settle. A failed read gives
 * `systemStatus: null`, and the drawer renders no service rows rather than
 * inventing any -- the same "drop it, don't guess" rule the endpoint itself
 * already follows.
 *
 * @type {import("./$types").PageServerLoad}
 */
export async function load({ fetch }) {
  const [view, systemStatus] = await Promise.all([homeView(fetch), systemStatusView(fetch)]);
  return { fixtures: env.ORBIT_FIXTURES === "1", view, systemStatus };
}

/**
 * @param {typeof globalThis.fetch} fetch
 * @returns {Promise<import("$lib/data/workspace.js").HomeView | null>}
 */
async function homeView(fetch) {
  try {
    return await readHome(fetch);
  } catch {
    return null;
  }
}

/**
 * @param {typeof globalThis.fetch} fetch
 * @returns {Promise<import("orbit/server/system-status").SystemStatus | null>}
 */
async function systemStatusView(fetch) {
  try {
    const response = await fetch("/api/system-status");
    if (!response.ok) return null;
    return (await response.json()).status;
  } catch {
    return null;
  }
}
