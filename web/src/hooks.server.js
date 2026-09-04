import { building } from "$app/environment";
import { env } from "$env/dynamic/private";
import { redirect } from "@sveltejs/kit";

/**
 * The screens a reader may open without a session (#789).
 *
 * Route ids, not pathnames: the router's own truth, so a trailing slash or a
 * percent-encoded path cannot dress a gated screen up as an open one.
 *
 * `/` is the arrival and decides signed-in from signed-out in the browser;
 * `/login` and `/logout` are the ratified dawn and dusk (§15); `/maintenance`
 * has to be reachable precisely when the instance cannot serve anything else.
 * None of them reads a session.
 */
const OPEN_ROUTES = new Set(["/", "/login", "/logout", "/maintenance"]);

/**
 * The screens maintenance never closes (#526; ADR-0013 decision 3): the door
 * and the way out, because an administrator has to be able to sign in to end
 * a window and anyone may leave cleanly. Neither reads any state at all.
 *
 * `/` is deliberately not here: a signed-out visitor is not an administrator,
 * and the arrival would only send them to a home that is closed. The API is
 * a separate boundary with its own guard (`web/src/lib/server/api.js`); this
 * set is for screens.
 */
const DOORS = new Set(["/login", "/logout"]);

/**
 * Orbit's boot sequence, moved off Next's instrumentation hook (#735).
 *
 * `registerNode` validates startup configuration, reports authentication and
 * scanner readiness, runs migrate-on-boot and starts the five workers — in
 * that strict order, because each step's failure has to fail closed before the
 * next one is reachable. `src/server/boot.test.ts` holds that ordering.
 *
 * SvelteKit calls `init` once per server process before the first request, so
 * the engine and the HTTP surface now come up in one process at one instant.
 * Nothing about the sequence changed; only what calls it.
 *
 * The `building` guard matters because `init` also runs while the adapter
 * prerenders: a build machine has no database and no reason to start a worker,
 * so booting there would either fail the build or, worse, migrate whatever
 * database happened to be configured at build time.
 *
 * @type {import("@sveltejs/kit").ServerInit}
 */
export async function init() {
  if (building) return;

  const { registerNode } = await import("orbit/server/boot");
  await registerNode();
}

/**
 * Whether the instance is closed for maintenance, read once per request.
 *
 * A failed read answers "open". Maintenance is a state an operator declared,
 * and an unreachable database is not that state — it is an outage, which
 * ADR-0013 decision 6 keeps distinct — so a request that cannot find out is
 * handled as every request was before this gate existed: the session gate
 * fails closed on the same unreachable database a moment later. Logged,
 * because a screen that cannot tell whether it is closed is worth knowing
 * about even when the answer turns out to be "open".
 *
 * @returns {Promise<{ effectivelyActive: boolean, expectedEndAt: Date | null }>}
 */
async function readMaintenance() {
  try {
    const { readEffectiveMaintenance } = await import("orbit/server/maintenance");
    return await readEffectiveMaintenance();
  } catch {
    const { log } = await import("orbit/lib/logger");
    log.warn({
      event: "application.error",
      state: "degraded",
      reason: "unexpected_failure",
      action: "check_database",
      impact: "application_degraded",
    });
    return { effectivelyActive: false, expectedEndAt: null };
  }
}

/**
 * `readSession` rather than `requireSession`: a page wants an answer, not a
 * thrown 401. It returns null for an absent cookie without touching the
 * database, and for an invalid, expired or disabled-user session after one
 * query, which it then cleans up. Every failure — auth unconfigured, database
 * unreachable — converges on the same null, so the gate fails closed and
 * tells a stranger nothing about which it was.
 *
 * @param {import("@sveltejs/kit").Cookies} cookies
 * @returns {Promise<import("orbit/lib/auth/session").AuthenticatedSession | null>}
 */
async function readSessionQuietly(cookies) {
  try {
    const { readSession } = await import("orbit/lib/auth/session");
    const { getAuthConfig } = await import("orbit/lib/env");
    return await readSession(cookies, getAuthConfig());
  } catch {
    return null;
  }
}

/**
 * The maintenance screen as the answer to a blocked request (ADR-0013
 * decision 2): the same body, status 503, never cached, with `Retry-After`
 * when the operator has said when to come back. Same derivation as the API's
 * envelope in `appErrorResponse`, so a page and an API answer agree on when.
 *
 * @param {Response} page
 * @param {{ expectedEndAt: Date | null }} maintenance
 */
function closedForMaintenance(page, maintenance) {
  const headers = new Headers(page.headers);
  headers.set("cache-control", "no-store");
  headers.delete("etag");
  const secondsRemaining = maintenance.expectedEndAt
    ? Math.ceil((maintenance.expectedEndAt.getTime() - Date.now()) / 1000)
    : 0;
  if (secondsRemaining > 0) headers.set("retry-after", String(secondsRemaining));
  return new Response(page.body, { status: 503, headers });
}

/**
 * The gates for every screen: maintenance (#526), then authentication (#789).
 *
 * The cut deleted Next's AuthenticationGate along with the rest of `src/app/`
 * and nothing took the job over, so a signed-out stranger could open
 * `/settings`, `/administration` and the rest and read their structure. No
 * records leaked — `web/src/lib/server/api.js` wraps every handler with
 * `requireSession`, so `/api/*` answered 401 throughout — but there was no
 * door either.
 *
 * A `handle` hook rather than a guard on each route because this has to fail
 * CLOSED: a screen added tomorrow is behind both gates the day its folder
 * exists, with its author doing nothing. Per-route guards fail open, and
 * forgetting one is exactly the hole. A browser-side redirect is weaker still
 * — it serves the screen's HTML first, and a `curl` never redirects at all.
 *
 * Maintenance is decided first, as `write()` decides it for the API, so a
 * closed instance answers 503 before it has said anything about whether a
 * cookie was valid. The blocked reader gets the maintenance screen AT THE
 * URL THEY ASKED FOR — rendered through `event.fetch`, which SvelteKit
 * dispatches inside this process without touching the network — so that a
 * reload once the window has closed lands them where they were, rather than
 * on a screen that has nothing left to say.
 *
 * The order below is load-bearing; each step is a reason the next is safe.
 *
 * @type {import("@sveltejs/kit").Handle}
 */
export async function handle({ event, resolve }) {
  /* Same guard and the same reason as `init`: this also runs while the
     adapter prerenders /login and /logout, where there is no session, no
     database, and no dynamic environment to read. */
  if (building) return resolve(event);

  /* A null id is a path the router did not match, which belongs to the 404
     screen. Letting it through gates nothing new: route names already ship in
     the client bundle. The API has its own guards for both gates and answers
     in its own envelope, so it is not this hook's to intercept. */
  const id = event.route.id;
  if (id === null || id.startsWith("/api/")) return resolve(event);

  /* The fixture harness drives real screens with no database and no session
     cookie — the fidelity gate photographs 17 of them. Without this every one
     would photograph the door, or the eclipse. Safe on the same terms the API
     seam already relies on: nothing production runs sets the variable. */
  if (env.ORBIT_FIXTURES === "1") return resolve(event);

  if (DOORS.has(id)) return resolve(event);

  /* The session is read at most once, and only when a gate needs it: the open
     routes never read one unless the instance is closed. */
  let session;

  const maintenance = await readMaintenance();
  if (maintenance.effectivelyActive) {
    session = await readSessionQuietly(event.cookies);
    /* readSession answers null for a disabled user, so a surviving session
       with the flag is exactly "an active instance administrator" — the one
       reader who passes everywhere (ADR-0013 decision 4). The maintenance
       screen is its own answer; every other screen is answered with it. */
    if (!session?.user.isInstanceAdmin) {
      const screen = id === "/maintenance" ? await resolve(event) : await event.fetch("/maintenance");
      return closedForMaintenance(screen, maintenance);
    }
  }

  if (OPEN_ROUTES.has(id)) return resolve(event);

  session ??= await readSessionQuietly(event.cookies);

  /* 303 so a signed-out POST to a form action arrives at the door as a GET.
     returnTo is carried for the door to send the reader back afterwards; the
     server sanitises it with safeReturnPath, so it cannot become an open
     redirect. */
  if (!session) {
    redirect(303, `/login?returnTo=${encodeURIComponent(event.url.pathname + event.url.search)}`);
  }

  /* Carried on locals so a server load never has to ask a second time. */
  event.locals.session = session;
  return resolve(event);
}
