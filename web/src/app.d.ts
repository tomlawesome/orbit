/*
 * SvelteKit's ambient types for this app.
 *
 * It exists for one field. The authentication gate in `hooks.server.js` reads
 * the session once per request (#789) and puts it here, so a server load that
 * needs the reader does not query for them a second time. Without the
 * declaration `event.locals.session` is a type error under `checkJs`.
 *
 * `AuthenticatedSession` is the engine's own type — the shape `readSession`
 * returns — rather than a copy of it, so the two cannot drift apart.
 */
import type { AuthenticatedSession } from "orbit/lib/auth/session";

declare global {
  namespace App {
    interface Locals {
      /** The signed-in reader, set by the gate. Absent on open routes. */
      session?: AuthenticatedSession;
    }
  }
}

export {};
