/*
 * The sign-in holds no data — it is artwork, a name and one button — so it is
 * prerendered to plain HTML. That keeps it servable as static files and means
 * the signed-out surface reaches no database and no session at all.
 */
export const prerender = true;
