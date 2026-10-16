/**
 * What the item drawer's foot row and rows do (#1319, FootRow.svelte,
 * EditRows.svelte): the host's handlers and state, handed down through the
 * desk's CorridorRow and ItemView and the phone's ItemDrawer. A module of
 * its own because a type cannot be imported from a `.svelte` file's script.
 *
 * `modes` is the screen's DrawerModes (drawer-modes.svelte.js): what the
 * drawer is doing besides reading, for whichever item it is. `sections` are
 * the item's household's, for the section's name and colour.
 *
 * @typedef {"snooze" | "complete" | "attach" | "retire" | "restore" | "save" | null} DrawerBusy
 * @typedef {{
 *   busy: DrawerBusy,
 *   problem: string | null,
 *   modes: import('./drawer-modes.svelte.js').DrawerModes,
 *   sections: import('./drawer-modes.svelte.js').SectionChoice[],
 *   onsnooze: (from: HTMLElement) => unknown,
 *   oncomplete: (from: HTMLElement) => unknown,
 *   onattach: (file: File) => unknown,
 *   onretire: () => unknown,
 *   oncopy: () => Promise<boolean>,
 *   onedit: () => unknown,
 *   onsave: () => unknown,
 *   onrecord: () => unknown,
 *   oncancel: () => unknown,
 *   onamend?: () => unknown,
 *   onaccept?: () => unknown,
 *   onrestore?: () => unknown,
 * }} DrawerActs
 *
 * `onrestore` brings a retired, cancelled or expired item back (#1319:
 * the drawer opens any item, and offers what fits its state).
 *
 * `onamend` and `onaccept` are a suggestion's (SuggestionView.svelte, #1319):
 * `review & amend →` puts its rows into editing, and `add to orbit` approves
 * what they hold.
 */

export {};
