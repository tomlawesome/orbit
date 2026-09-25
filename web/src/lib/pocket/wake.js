/**
 * THE WAKE (#1120, proposal §1.13): the pocket's one toast. One line rising
 * from the foot, held 4s, with "undo" where the act is reversible. One at a
 * time: a new wake replaces the one showing. Failures are announced
 * assertively, everything else politely (§1.12).
 *
 * A plain store so any screen can raise one without holding a component:
 *   import { wake } from "$lib/pocket/wake.js";
 *   wake("Emma Lawson removed", { undo: () => restore() });
 * Wake.svelte, mounted once in the root layout, draws whatever is current.
 */

export const WAKE_HOLD_MS = 4000;

/**
 * @typedef {{ id: number, message: string, undo: (() => void) | null, failure: boolean }} WakeEntry
 */

/** @type {WakeEntry | null} */
let current = null;
let nextId = 1;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let timer;
/** @type {Set<(entry: WakeEntry | null) => void>} */
const listeners = new Set();

const publish = () => {
  for (const listener of listeners) listener(current);
};

/**
 * @param {string} message
 * @param {{ undo?: () => void, failure?: boolean, hold?: number }} [options]
 * @returns {number} the wake's id, for dismissWake
 */
export function wake(message, { undo, failure = false, hold = WAKE_HOLD_MS } = {}) {
  clearTimeout(timer);
  current = { id: nextId++, message, undo: undo ?? null, failure };
  const id = current.id;
  timer = setTimeout(() => dismissWake(id), hold);
  publish();
  return id;
}

/** @param {number} [id] only dismiss if this wake is still the current one */
export function dismissWake(id) {
  if (!current || (id !== undefined && current.id !== id)) return;
  clearTimeout(timer);
  current = null;
  publish();
}

/** Runs the current wake's undo, once, and puts the wake away. */
export function undoWake() {
  const undo = current?.undo;
  dismissWake();
  undo?.();
}

/**
 * @param {(entry: WakeEntry | null) => void} listener
 * @returns {() => void}
 */
export function subscribeWake(listener) {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}
