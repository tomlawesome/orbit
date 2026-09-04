/* The whole adaptation layer between SvelteKit and the engine (#735).
 *
 * There is deliberately very little here. The engine's seam already speaks
 * Web-standard `Headers` and `Response` and takes SvelteKit's `event.cookies`
 * as-is, so a route handler needs no translation — only the error envelope
 * every route shares, and the CSRF check every write shares.
 *
 * The composite dispatcher this replaces sent `/api/*` to Next before this
 * router ever saw it. Now these ARE the routes: one process, one origin, so
 * the `__Host-` cookie prefix and the same-origin check keep meaning what
 * they meant.
 */
import { env } from "$env/dynamic/private";

import { appErrorResponse } from "orbit/lib/app-error";
import { assertCsrf, requireSession } from "orbit/lib/auth/session";
import { getAuthConfig } from "orbit/lib/env";
import { assertOutsideMaintenance } from "orbit/server/maintenance";

/**
 * True when the harness has asked for fixture data.
 *
 * The fidelity gate and `vite dev` set this so screens render known data with
 * no database behind them. It is READ-ONLY as far as the engine goes: a route
 * either answers from the fixture or answers from the engine, and never
 * half-and-half. Unset — which is every real deployment — it is simply false,
 * and no route changes its status code because of it (#735 criterion 1: a
 * route must never 404 merely because this is unset).
 *
 * A real deployment cannot reach this at all (#773). A production build that
 * finds ORBIT_FIXTURES set refuses to start, with
 * `validateStartupConfiguration` naming the `fixtures` setting as a blocking
 * problem — anything present and non-empty, including "0", because a reader
 * who set it meant something and guessing "off" for them is the guess worth
 * refusing. That check is the replacement for the composite entry (#450),
 * which kept /api on the engine whatever this app believed and went with the
 * cut (#735).
 *
 * Since #789 the same flag also bypasses the authentication gate in
 * `hooks.server.js`, so it is load-bearing in two places rather than one.
 *
 * @returns {boolean}
 */
export function fixturesRequested() {
  return env.ORBIT_FIXTURES === "1";
}

/**
 * Wraps a read handler: engine failures become the shared error envelope.
 *
 * `errorResponse` exists because the auth routes answer in a different
 * envelope — `authErrorResponse` reports provider and configuration failures
 * that mean nothing on a workspace route, and it already delegates the
 * maintenance case back to `appErrorResponse` so the bounded 503 contract
 * (#523) holds either way.
 *
 * @param {(event: import("@sveltejs/kit").RequestEvent) => Promise<Response> | Response} handler
 * @param {{
 *   fixture?: (event: import("@sveltejs/kit").RequestEvent) => Response,
 *   errorResponse?: (error: unknown) => Response,
 * }} [options]
 * @returns {(event: import("@sveltejs/kit").RequestEvent) => Promise<Response>}
 */
export function api(handler, { fixture, errorResponse = appErrorResponse } = {}) {
  return async (event) => {
    try {
      if (fixture && fixturesRequested()) return fixture(event);
      return await handler(event);
    } catch (error) {
      /* The envelope owns the status, the code and the no-store header. */
      return errorResponse(error);
    }
  };
}

/**
 * Wraps a write handler: the maintenance guard, a session, and the CSRF pair.
 *
 * The order matters and is the same order the Next routes used. Maintenance
 * first, so a blocked instance answers 503 rather than leaking whether a
 * session is valid; then the session; then the synchronizer token, which is
 * derived from the session and so cannot be checked before it.
 *
 * The handler receives the session it already had to establish, so no route
 * reads it twice.
 *
 * @param {(event: import("@sveltejs/kit").RequestEvent, session: import("orbit/lib/auth/session").AuthenticatedSession) => Promise<Response> | Response} handler
 * @param {{ errorResponse?: (error: unknown) => Response }} [options]
 * @returns {(event: import("@sveltejs/kit").RequestEvent) => Promise<Response>}
 */
export function write(handler, options) {
  return api(async (event) => {
    await assertOutsideMaintenance(event.cookies);
    const config = getAuthConfig();
    const session = await requireSession(event.cookies, config);
    assertCsrf(event.request.headers, session, config);
    return await handler(event, session);
  }, options);
}

/**
 * Wraps a read handler that needs a session but writes nothing.
 *
 * @param {(event: import("@sveltejs/kit").RequestEvent, session: import("orbit/lib/auth/session").AuthenticatedSession) => Promise<Response> | Response} handler
 * @param {{ fixture?: (event: import("@sveltejs/kit").RequestEvent) => Response }} [options]
 * @returns {(event: import("@sveltejs/kit").RequestEvent) => Promise<Response>}
 */
export function read(handler, options) {
  return api(async (event) => {
    await assertOutsideMaintenance(event.cookies);
    const session = await requireSession(event.cookies, getAuthConfig());
    return await handler(event, session);
  }, options);
}
