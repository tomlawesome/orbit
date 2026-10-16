import { revokeSession, signOutEverywhere } from "$lib/data/workspace.js";

/*
 * Settings' own sign-outs (#1439), shared by the desk and the pocket as
 * helm.js is. The order is the ordinary sign-out's (Chrome.svelte):
 *   1. end the server session, and wait for it;
 *   2. hand the answer's redirectTo to Chrome's descent, which plays the
 *      goodbye and owns every navigation after it (to the provider's own
 *      sign-out, or "Sign back in" at /logout).
 * Nothing here navigates on success, and nothing goes to /login: through the
 * provider's still-live single sign-on that signs the reader straight back
 * in. Nothing calls the API again either, for the same reason: a 401 would.
 *
 * A failed revoke is re-thrown untouched, so each layout keeps its own
 * problem text and arming.
 */

/**
 * Plays the goodbye, or, when it cannot be had, leaves as Chrome's own
 * no-flight fallback does. The session is already ended, so this never
 * throws: a failed goodbye must never read as "still signed in".
 *
 * @param {string | null} redirectTo the provider's own logout URL, if any
 * @param {((redirectTo: string | null) => unknown) | undefined} descendFrom Chrome's descent
 */
async function leave(redirectTo, descendFrom) {
  try {
    if (typeof descendFrom !== "function") throw new Error("no descent");
    await descendFrom(redirectTo);
  } catch {
    location.href = redirectTo ?? "/logout";
  }
}

/**
 * Signs one device out. This device leaves with the goodbye; another
 * device's session just ends, and the caller drops its row.
 *
 * @param {{ id: string, current: boolean }} row
 * @param {((redirectTo: string | null) => unknown) | undefined} descendFrom Chrome's descent
 * @returns {Promise<boolean>} true when this device left, false when another device's session ended
 */
export async function signOutOfDevice(row, descendFrom) {
  const redirectTo = await revokeSession(row.id);
  if (!row.current) return false;
  await leave(redirectTo, descendFrom);
  return true;
}

/**
 * Signs out of every device, this one included, and leaves with the goodbye.
 *
 * @param {((redirectTo: string | null) => unknown) | undefined} descendFrom Chrome's descent
 * @returns {Promise<void>}
 */
export async function signOutOfEveryDevice(descendFrom) {
  const redirectTo = await signOutEverywhere();
  await leave(redirectTo, descendFrom);
}
