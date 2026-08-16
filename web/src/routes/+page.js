/*
 * The front door holds no data — it is artwork, a name and one button — so it
 * is prerendered to plain HTML, the same way /login is. That keeps it
 * servable as static files and means the signed-out surface reaches no
 * database and no session at all: whether the reader is signed in is asked
 * afterwards, in the browser, of GET /api/auth/session.
 *
 * Was a 308 to /home (#429). The redirect could not stay once "/" became the
 * sign-in: a signed-out reader would have been bounced to a screen that
 * bounces them to the identity provider, and the ratified door would never
 * have been seen.
 */
export const prerender = true;
