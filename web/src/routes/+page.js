/*
 * The front door was prerendered to plain HTML while it was artwork, a name and
 * one button. It is now the ARRIVAL's switchboard (#410, §15: "first-run sits
 * ON TOP of the login screen, not its own page"), so it carries the fixture
 * flag its stages are named with — see +page.server.js for why that flag must
 * be read per request rather than baked in at build time.
 *
 * The signed-out surface is unchanged in substance: this route still reaches no
 * database and no session on the server, and whether the reader is signed in is
 * asked afterwards, in the browser, of GET /api/auth/session.
 *
 * Was a 308 to /home (#429). The redirect could not stay once "/" became the
 * sign-in: a signed-out reader would have been bounced to a screen that bounces
 * them to the identity provider, and the ratified door would never have been
 * seen.
 */
export const prerender = false;
