/**
 * What the item drawer's foot row does (#1319, FootRow.svelte): the host's
 * handlers, handed down through the desk's ItemView and the phone's
 * ItemDrawer. A module of its own because a type cannot be imported from a
 * `.svelte` file's script.
 *
 * @typedef {{
 *   busy: "snooze" | "complete" | "attach" | "retire" | null,
 *   problem: string | null,
 *   onsnooze: (until: string) => unknown,
 *   oncomplete: () => unknown,
 *   onattach: (file: File) => unknown,
 *   onretire: () => unknown,
 *   oncopy: () => Promise<boolean>,
 * }} DrawerActs
 */

export {};
