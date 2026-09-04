/**
 * "Did this reader just sign in?" — the one honest signal we have.
 *
 * THE PROBLEM. The ratified launch plays from the press of the button to the
 * arrival on the dial, unbroken. The product cannot: pressing the button
 * leaves Orbit entirely for the identity provider, and the browser comes back
 * on a fresh document. Nothing in the OIDC round trip carries a "you have just
 * signed in" flag — the callback (src/app/api/auth/callback/route.ts) issues
 * the session cookie and 303s to `returnTo`, and that is all it says.
 *
 * THE SIGNAL. The departing page writes a one-shot marker into
 * sessionStorage: per-origin, per-TAB, and it survives a navigation away to
 * the provider and back, because a tab session is not an origin visit. The
 * arriving page reads it and DELETES IT IN THE SAME BREATH, so:
 *
 *   - an ordinary navigation to /home never flies (no marker was written);
 *   - a refresh of the landing never re-flies (the marker is already gone);
 *   - a Back into the landing never re-flies (same);
 *   - a second tab never flies on the first tab's sign-in (session, not local);
 *   - abandoning the sign-in and coming back to the login clears it, so the
 *     marker cannot sit around waiting to fire on some later visit.
 *
 * It is a claim by the departing page, not proof from the server: the landing
 * only flies when the marker AND a live session are both present, and the
 * session is what the API answers for.
 */

export const LAUNCH_KEY = "orbit-launch";

/** @param {Storage | null | undefined} [given] */
function store(given) {
  if (given) return given;
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    /* storage can be denied outright; the flight is dressing, never a gate */
    return null;
  }
}

/**
 * Written the moment the reader presses the gate and Orbit leaves for the IdP.
 * @param {Storage | null} [storage]
 */
export function markLaunch(storage) {
  const s = store(storage);
  if (!s) return false;
  try {
    s.setItem(LAUNCH_KEY, "departed");
    return true;
  } catch {
    return false;
  }
}

/**
 * True exactly once per departure: reads the marker and takes it away.
 * @param {Storage | null} [storage]
 */
export function consumeLaunch(storage) {
  const s = store(storage);
  if (!s) return false;
  try {
    const departed = s.getItem(LAUNCH_KEY) === "departed";
    if (departed) s.removeItem(LAUNCH_KEY);
    return departed;
  } catch {
    return false;
  }
}

/**
 * Landing back on the sign-in means the journey did not happen.
 * @param {Storage | null} [storage]
 */
export function clearLaunch(storage) {
  const s = store(storage);
  if (!s) return;
  try {
    s.removeItem(LAUNCH_KEY);
  } catch {
    /* nothing to do: an unwritable store never held a marker either */
  }
}
