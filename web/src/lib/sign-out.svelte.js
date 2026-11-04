import { signOut, wordsOf } from "$lib/data/workspace.js";

/*
 * The one sign-out press (#410, §15, #1253; #1355, survey finding web-17),
 * shared by the desk menu (Chrome.svelte), the pocket hatch
 * (pocket/Hatch.svelte) and home's own desk card. Each used to carry this
 * sequence itself; they differed only in what happens once the session is
 * gone, which is the `after` each one hands in.
 *
 * One press (owner, 2026-10-06): the plain sign-out does not arm first. It
 * REVOKES before anything is shown: POST /api/auth/logout deletes the
 * session row and clears the cookie, and only when the server has said so
 * does `after` run, so a crash, a closed lid or a killed tab during the
 * goodbye can never leave a live session behind.
 *
 * `signingOut` is set for the span of the request and after it, so a
 * second press never fires a second, concurrent signOut() (#1151 W1-R7). It
 * is cleared only on a refusal, which keeps the menu open with `problem`
 * under the button so its line is read.
 */

/**
 * @param {(redirectTo: string | null) => unknown} after what follows an
 *   ended session: given the provider's own logout URL, if any
 */
export function createSignOut(after) {
  let signingOut = $state(false);
  /** @type {string | null} */
  let problem = $state(null);

  async function press() {
    if (signingOut) return;
    signingOut = true;
    problem = null;
    /** @type {string | null} */
    let redirectTo = null;
    try {
      redirectTo = await signOut();
    } catch (error) {
      signingOut = false;
      problem = wordsOf(error, "still signed in — try again");
      return;
    }
    await after(redirectTo);
  }

  return {
    get signingOut() { return signingOut; },
    get problem() { return problem; },
    press,
  };
}
