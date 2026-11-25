/**
 * The household page's member acts, once, for both shapes (#1354): the desk
 * (+page.svelte) and the pocket (pocket.svelte). What differs between them --
 * which state or wake shows the words, what follows a success -- stays with
 * each shape as a callback.
 */
import { deletionNameMatches } from "$lib/data/household.js";
import { decideJoinRequest, sendInvitation, transferOwnership, wordsOf } from "$lib/data/workspace.js";

/**
 * @param {{
 *   householdId: () => string,
 *   clear: () => void,
 *   fail: (words: string) => void,
 *   refresh: () => Promise<unknown> | unknown,
 * }} ui
 */
export function createActs({ householdId, clear, fail, refresh }) {
  /**
   * Clear the old problem, run, then `done`, then refresh. Any failure is told
   * through `fail`, never thrown.
   * @param {() => Promise<unknown>} run
   * @param {() => unknown} [done]
   */
  async function act(run, done) {
    clear();
    try {
      await run();
      await done?.();
      await refresh();
    } catch (error) {
      fail(wordsOf(error));
    }
  }

  /**
   * @param {{ id: string } | null | undefined} taker
   * @param {() => unknown} [done]
   */
  async function handOver(taker, done) {
    if (!taker) return;
    await act(() => transferOwnership(householdId(), taker.id), done);
  }

  /**
   * @param {{ id: string }} request
   * @param {"approve" | "decline"} action
   * @param {() => unknown} [done]
   */
  const decide = (request, action, done) => act(() => decideJoinRequest(request.id, action), done);

  /**
   * Send to the trimmed address; resolves the invitation the server made, or
   * null (and sends nothing) for an empty address. A failure reaches the caller.
   * @param {string} email
   */
  async function offer(email) {
    const address = email.trim();
    if (!address) return null;
    const { invitation } = await sendInvitation(householdId(), address);
    return invitation;
  }

  return { act, handOver, decide, offer };
}

/**
 * The owner's "leave" press: refuse at once, let go after `ms`; a second press
 * restarts the clock.
 * @param {(refused: boolean) => void} setRefused
 * @param {number} [ms]
 */
export function createOwnerLeave(setRefused, ms = 6000) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  return () => {
    setRefused(true);
    clearTimeout(timer);
    timer = setTimeout(() => setRefused(false), ms);
  };
}

/**
 * The server's own deletion-name check, trimmed on both sides.
 * @param {string | null | undefined} typed
 * @param {string | null | undefined} householdName
 */
export const nameOk = (typed, householdName) => deletionNameMatches(typed, householdName);
