/**
 * A COMPLETION HELD FOR ITS UNDO (§1.13; first the belt's tapComplete and the
 * pocket's completeRow -- the belt retired with #1319):
 * there is no command that takes a completion back, so `complete` builds its
 * command, holds it for the wake's four seconds and only then sends it.
 * `undo` inside the hold is a real undo. Leaving the page sends it at once.
 *
 * #1151 W1-R5/W1-S3: the command is stashed in localStorage before it is
 * first sent, under the key both of those screens use, and leaves the stash
 * only once a send confirms — so a send cut off by the page unloading is
 * picked up on the next load (`retryStashed`), and a version conflict there
 * counts as the original send having landed.
 *
 * Home's desk drawer (#1319) holds its completions through this; the belt
 * and the pocket keep their own copies of the same mechanism, pinned by
 * tests/unit/v19-held-completion-stash.test.mjs.
 */

export const HELD_COMPLETION_KEY = "orbit:pending-completion";

/** @typedef {{ getItem(key: string): string | null, setItem(key: string, value: string): void, removeItem(key: string): void }} StashStorage */

/** @returns {StashStorage | null} */
const defaultStorage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/**
 * The held commands a previous visit stashed: a list, one per completion,
 * in the same shape the belt and the pocket write (an older single-slot
 * `{ command }` is read too).
 * @param {StashStorage | null} [storage]
 * @returns {object[]}
 */
export function readHeldCompletionStash(storage = defaultStorage()) {
  try {
    const raw = storage?.getItem(HELD_COMPLETION_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed.command].filter(Boolean);
  } catch {
    return [];
  }
}

/** @param {object[]} commands @param {StashStorage | null} storage */
function writeStash(commands, storage) {
  try {
    if (commands.length === 0) storage?.removeItem(HELD_COMPLETION_KEY);
    else storage?.setItem(HELD_COMPLETION_KEY, JSON.stringify(commands));
  } catch { /* best effort */ }
}

/** @param {object} command @param {StashStorage | null} [storage] */
export function stashHeldCompletion(command, storage = defaultStorage()) {
  writeStash([...readHeldCompletionStash(storage), command], storage);
}

/** @param {object} command @param {StashStorage | null} [storage] */
export function clearHeldCompletionStash(command, storage = defaultStorage()) {
  const key = JSON.stringify(command);
  writeStash(readHeldCompletionStash(storage).filter((one) => JSON.stringify(one) !== key), storage);
}

/**
 * @typedef {{ command: object, done: boolean, timer: ReturnType<typeof setTimeout> | undefined }} HeldJob
 */

/**
 * @param {{
 *   apply: (command: object) => Promise<unknown>,
 *   onsent?: () => unknown,
 *   onfailed?: (error: unknown) => unknown,
 *   holdMs: number,
 *   storage?: StashStorage | null,
 * }} options
 */
export function createHeldCompletion({ apply, onsent = () => {}, onfailed = () => {}, holdMs, storage = defaultStorage() }) {
  /** @type {HeldJob | null} */
  let held = null;

  /** @param {HeldJob} job */
  async function fire(job) {
    if (job.done) return;
    job.done = true;
    if (held === job) held = null;
    try {
      await apply(job.command);
      clearHeldCompletionStash(job.command, storage);
      await onsent();
    } catch (error) {
      await onfailed(error);
    }
  }

  return {
    /**
     * Holds `command`, sending any completion already held first.
     * @param {object} command
     * @returns {HeldJob}
     */
    hold(command) {
      this.flush();
      stashHeldCompletion(command, storage);
      /** @type {HeldJob} */
      const job = { command, done: false, timer: undefined };
      job.timer = setTimeout(() => fire(job), holdMs);
      held = job;
      return job;
    },
    /** The wake's undo: the held command is never sent. @param {HeldJob} job */
    undo(job) {
      clearTimeout(job.timer);
      job.done = true;
      if (held === job) held = null;
      clearHeldCompletionStash(job.command, storage);
    },
    /** Leaving: the held command goes now, not lost. */
    flush() {
      const job = held;
      if (!job || job.done) return;
      clearTimeout(job.timer);
      job.done = true;
      held = null;
      apply(job.command).then(() => clearHeldCompletionStash(job.command, storage)).catch(() => {});
    },
    /**
     * A previous visit's stash, finished. A version conflict means the
     * original send landed after all.
     * @param {(error: unknown) => boolean} isConflict
     */
    retryStashed(isConflict) {
      for (const command of readHeldCompletionStash(storage)) {
        apply(command).then(async () => {
          clearHeldCompletionStash(command, storage);
          await onsent();
        }).catch(async (error) => {
          if (isConflict(error)) {
            clearHeldCompletionStash(command, storage);
            await onsent();
            return;
          }
          await onfailed(error);
        });
      }
    },
  };
}
