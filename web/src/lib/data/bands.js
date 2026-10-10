/*
 * The one band-to-token step (#1341): every screen that paints an urgency
 * band takes its colour token from BAND_VAR, and its class from T_CLASS.
 * Per-band lookups the corridor rows and the dial both need (#624/#782):
 * plain data and a pure formatter, kept in one module so CorridorRow.svelte
 * and +page.svelte's own dial markup share one typed copy instead of two.
 */

import { tminusOf } from "$lib/format.js";

/* `ended` is the expiry's own band (#1005): a one-off past its date is not
   overdue, so it wears the quiet ink tone rather than the alarm colour.
   `unscheduled` (#1151 W1-F3) is chart.js's bandOfKind(…, null) answer for
   an active item with no due date — it carries no urgency either, so it
   wears the same quiet tone as `ended` rather than leaving BAND_VAR[band]
   undefined, which rendered as the invalid custom property `var(undefined)`
   and silently dropped the colour. */
/** @type {Record<string, string>} */
export const BAND_VAR = { overdue: "--overdue", "due-soon": "--warm", upcoming: "--upcoming", ok: "--ok", ended: "--ink-mid", unscheduled: "--ink-mid" };
/** @type {Record<string, string>} */
export const T_CLASS = { overdue: "over", "due-soon": "soon", upcoming: "up", ok: "ok", ended: "ended", unscheduled: "ended" };

/* #1151 W1-Q10: null-safe so the pocket's own copy (which this one now
   replaces) can be dropped rather than kept as a second, diverging
   version — an unscheduled row's `days` is null, and `null < 0` is false,
   which would otherwise print the literal "T−nulld". */
/** @param {{ days: number | null }} b */
export const tlabel = (b) => tminusOf(b.days);
