import { writable } from "svelte/store";

/**
 * Whether the What's new sheet is on screen (#1757). WhatsNew.svelte sets it
 * from its `open` value and clears it when it is destroyed; the home importance
 * pill reads it, so the pill is not drawn behind the sheet. A store, like
 * tour/running.js, so plain JS can read it without the Svelte compiler.
 */
export const whatsNewOpen = writable(false);
