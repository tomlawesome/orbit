import { writable } from "svelte/store";

/**
 * Whether the first-run film is on screen (#1730). film.js sets it from the
 * start of `start()` until `destroy()`; screens that must stay off the tour
 * (the importance pill) read it. A store, not a rune, so film.js stays plain
 * JS for the unit tests that load it without the Svelte compiler.
 */
export const tourRunning = writable(false);
