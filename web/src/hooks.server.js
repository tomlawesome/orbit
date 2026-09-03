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
 * All but `/` are prerendered, and none of them reads a session.
 */
const OPEN_ROUTES = new Set(["/", "/login", "/logout", "/maintenance"]);

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
 * The authentication gate for every screen (#789).
 *
 * The cut deleted Next's AuthenticationGate along with the rest of `src/app/`
 * and nothing took the job over, so a signed-out stranger could open
 * `/settings`, `/administration` and the rest and read their structure. No
 * records leaked — `web/src/lib/server/api.js` wraps every handler with
 * `requireSession`, so `/api/*` answered 401 throughout — but there was no
 * door either.
 *
 * A `handle` hook rather than a guard on each route because this has to fail
 * CLOSED: a screen added tomorrow is behind the gate the day its folder
 * exists, with its author doing nothing. Per-route guards fail open, and
 * forgetting one is exactly the hole. A browser-side redirect is weaker still
 * — it serves the screen's HTML first, and a `curl` never redirects at all.
 *
 * The order below is load-bearing; each step is a reason the next is safe.
 *
 * @type {import("@sveltejs/kit").Handle}
 */
export async function handle({ event, resolve }) {
  /* Same guard and the same reason as `init`: this also runs while the
     adapter prerenders /login, /logout and /maintenance, where there is no
     session, no database, and no dynamic environment to read. */
  if (building) return resolve(event);

  /* A null id is a path the router did not match, which belongs to the 404
     screen. Letting it through gates nothing new: route names already ship in
     the client bundle. */
  const id = event.route.id;
  if (id === null || OPEN_ROUTES.has(id) || id.startsWith("/api/")) return resolve(event);

  /* The fixture harness drives real screens with no database and no session
     cookie — the fidelity gate photographs 17 of them. Without this every one
     would photograph the door. Safe on the same terms the API seam already
     relies on: nothing production runs sets the variable. */
  if (env.ORBIT_FIXTURES === "1") return resolve(event);

  /* `readSession` rather than `requireSession`: a page wants an answer, not a
     thrown 401. It returns null for an absent cookie without touching the
     database, and for an invalid, expired or disabled-user session after one
     query, which it then cleans up. Every failure below — auth unconfigured,
     database unreachable — converges on the same null, so the gate fails
     closed and tells a stranger nothing about which it was. */
  let session = null;
  try {
    const { readSession } = await import("orbit/lib/auth/session");
    const { getAuthConfig } = await import("orbit/lib/env");
    session = await readSession(event.cookies, getAuthConfig());
  } catch {
    session = null;
  }

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
