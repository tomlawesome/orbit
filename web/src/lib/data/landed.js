/*
 * THE RE-READ AFTER A LANDED COMMAND (#1316 A1-R1). A command that landed
 * is never read back as not done when only the re-read after it failed:
 * the write's own failure keeps the act's own words, and the read runs on
 * its own, its failure said in these words where the screen says the
 * act's problems. Here, not in workspace.js: the unit tests stand
 * workspace.js in wholesale, and the words must stay real under a stub.
 */
export const DONE_UNREAD = "done — Orbit could not refresh this screen, so reload to see the new version";

/**
 * Reads again after a command landed. Never throws: a failed read says
 * DONE_UNREAD through `say` and answers false.
 * @param {() => Promise<unknown>} reread
 * @param {(words: string) => unknown} say
 * @returns {Promise<boolean>} whether the read landed
 */
export async function rereadAfterLanded(reread, say) {
  try {
    await reread();
    return true;
  } catch {
    say(DONE_UNREAD);
    return false;
  }
}
