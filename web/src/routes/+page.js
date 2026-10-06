/*
 * The front door was prerendered to plain HTML while it was artwork, a name and
 * one button. It is now the ARRIVAL's switchboard (#410, §15: "first-run sits
 * ON TOP of the login screen, not its own page"), so it carries the fixture
 * flag its stages are named with — see +page.server.js for why that flag must
 * be read per request rather than baked in at build time.
 *
 * Its load still reaches no database and no session, so the door's HTML is the
 * same for every reader. What does read the session is the server hook, before
 * this route is ever rendered (#1252, `frontDoor` in web/src/hooks.server.js):
 * a reader who already belongs to a household is answered 303 to /home there
 * and never gets this page. For everyone else, the rest is asked afterwards,
 * in the browser, of GET /api/auth/session.
 *
 * Was a 308 to /home (#429). The redirect could not stay once "/" became the
 * sign-in: a signed-out reader would have been bounced to a screen that bounces
 * them to the identity provider, and the ratified door would never have been
 * seen.
 */
export const prerender = false;
