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
 * picked up on the next load (`retryStashed`). The engine replays a completion
 * it already recorded as success, so a refusal there — a version conflict
 * included — means it was NOT recorded: it is reported once and dropped.
 *
 * Home's desk drawer (#1319) holds its completions through this; the belt
 * and the pocket keep their own copies of the same mechanism, pinned by
 * tests/unit/v19-held-completion-stash.test.mjs.
 */

import { WorkspaceError } from "./workspace.js";

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
    return (Array.isArray(parsed) ? parsed : [parsed.command].filter(Boolean)).map(todaysShape);
  } catch {
    return [];
  }
}

/**
 * A stash written before ADR-0034 carried a next due date and the activity's
 * kind, which the engine now refuses; the completion is still the member's,
 * so it is sent in today's shape.
 * @param {any} command
 */
function todaysShape(command) {
  if (command?.type !== "item.complete") return command;
  const { nextDate: _nextDate, ...rest } = command;
  if (rest.activity && typeof rest.activity === "object") {
    const { kind: _kind, nextDate: _activityNext, ...activity } = rest.activity;
    rest.activity = activity;
  }
  return rest;
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
 *   onfailed?: (error: unknown, command: object) => unknown,
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
      await onfailed(error, job.command);
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
     * A previous visit's stash, finished. A conflict or other 4xx refusal will
     * come back on every load, so it is said once and the entry dropped; a
     * network or server failure keeps it for the next load.
     * @param {(error: unknown) => boolean} isConflict
     */
    retryStashed(isConflict) {
      for (const command of readHeldCompletionStash(storage)) {
        apply(command).then(async () => {
          clearHeldCompletionStash(command, storage);
          await onsent();
        }).catch(async (error) => {
          if (isConflict(error) || isRefused(error)) clearHeldCompletionStash(command, storage);
          /* The command too, so the screen can name the item whose tick was lost. */
          await onfailed(error, command);
        });
      }
    },
  };
}

/** A 4xx: the engine will give the same answer however often it is asked. @param {unknown} error */
export function isRefused(error) {
  return error instanceof WorkspaceError && typeof error.status === "number" && error.status >= 400 && error.status < 500;
}

/**
 * What the wake says when a completion was refused: it was NOT recorded and
 * is already gone from the stash, so "refresh and try again" (the engine's
 * words for a conflict) cannot bring it back; the member has to mark it again.
 * @param {string} title
 */
export function droppedCompletionWords(title) {
  return `${title}: that tick was not recorded — mark it as done again`;
}
