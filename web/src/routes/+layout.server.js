import { env } from "$env/dynamic/private";
import { documentReadingEnabled } from "orbit/server/documents/tika";

/**
 * #475: whether this instance is running on fixtures, for EVERY route.
 *
 * The living backdrops roll a fresh seed per load, but the fidelity gate
 * compares first-viewport pixels — so under fixtures the roll must be pinned
 * instead. Only `/` and `/home` could see the flag before, through their own
 * `+page.server.js`, which is why only home has a seeded sky today. A layout
 * load puts it in front of every screen that draws a backdrop: the relay,
 * create, administration and the rest.
 *
 * Read per request, never prerendered, for the same reason `/home` gives: a
 * baked-in value would ship the gate's world to a real instance.
 */
/*
 * #1120: whether the reader is an instance administrator, for the pocket
 * hatch's Administration row. Read off the session the hooks already put on
 * locals, so it costs no query. Showing the row is all this decides; the
 * administration page and its API keep their own server-side gates.
 */
/*
 * #1459: whether this instance reads documents (TIKA_URL set). The Add page
 * promises extraction, and asks for it, only when it is true. Fixtures keep
 * the reading lane drawn; an unreadable configuration means nothing is read.
 */
function documentReading() {
  if (env.ORBIT_FIXTURES === "1") return true;
  try {
    return documentReadingEnabled();
  } catch {
    return false;
  }
}

/** @type {import("./$types").LayoutServerLoad} */
export function load({ locals }) {
  return {
    fixtures: env.ORBIT_FIXTURES === "1",
    documentReading: documentReading(),
    /* #1180: the shell reads the session (theme and text size) only for a
       signed-in reader; the session route answers 401 to anyone else. */
    signedIn: Boolean(locals.session),
    isAdmin: Boolean(locals.session?.user?.isInstanceAdmin),
  };
}
