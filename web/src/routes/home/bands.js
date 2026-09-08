/*
 * Per-band lookups the corridor rows and the dial both need (#624/#782):
 * plain data and a pure formatter, kept in one module so CorridorRow.svelte
 * and +page.svelte's own dial markup share one typed copy instead of two.
 */

/** @type {Record<string, string>} */
export const BAND_VAR = { overdue: "--overdue", "due-soon": "--warm", upcoming: "--upcoming", ok: "--ok" };
/** @type {Record<string, string>} */
export const T_CLASS = { overdue: "over", "due-soon": "soon", upcoming: "up", ok: "ok" };

/** @param {{ days: number }} b */
export const tlabel = (b) => (b.days < 0 ? `T+${-b.days}d` : `T−${b.days}d`);
