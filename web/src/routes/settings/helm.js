
import { wordsOf } from "$lib/data/workspace.js";
import { THEME_TABLE } from "$lib/theme.js";
import { clockOf, dayMonth, dayMonthYear, localZone } from "$lib/format.js";

/*
 * What settings' desk cards and its phone layout (pocket.svelte, #1125) both
 * need and neither should hold alone: the theme roster with its offer, the
 * two date forms, and the sign-in methods' refusal wording.
 *
 * THE v1.3.0 ROSTER, FINAL (§15, owner): star-chart, after dark, CLOUDS,
 * dawn (which now means the terminator) and retrograde — theme.js's own
 * the THEME_TABLE, in the order and membership named there (#865). Atlas,
 * hanami, porcelain, miami and solarium are on the records shelf: their
 * code is gone (#865 removed atlas's own, the last one still present), and
 * what goes here is the OFFER — this card is the only place in the product
 * that makes one in words as well as colour.
 *
 * Two rows changed with the roster, and both of them because the sheet
 * ruled the picture rather than because a preference was tidied:
 *   · CLOUDS joined, carrying the lighter end of the range (owner: "one of
 *     Orbit's MAIN LIGHTER THEMES"). Its strip shows the cool white of a
 *     cloud crest and its own hazy pastel bodies.
 *   · DAWN's ground moved to the temperature story's own #d2d3d4 and its
 *     line stopped saying "first light" — that is the pair's shared light,
 *     and what this pack IS now is the crossing. The words are the sheet's:
 *     design/v19/dawn-terminator.html, "night hands the sky to day".
 * Both strips' bodies are the pastels the refresh gave the light packs, so
 * the swatch is made of the same paint as the screen it promises.
 */
/* What each pack's card adds to the table's title and ground: its line, and
   the [sun, warm, ok, upcoming] colours of its strip. */
/** @type {Record<string, [string, string[]]>} */
const META = {
  starchart: ["the ratified night",
    ["radial-gradient(circle at 35% 30%,#fff6e6,#ffe9c4 45%,transparent 72%)", "#f0b429", "#4ade80", "#8fb8ff"]],
  afterdark: ["lights out, ink up",
    ["radial-gradient(circle at 35% 30%,#ffffff,#dbe9ff 45%,transparent 72%)", "#f0b429", "#4ade80", "#7dd3fc"]],
  clouds: ["first light, from altitude",
    ["radial-gradient(circle at 35% 30%,#9c4a10,#eda253 45%,transparent 72%)", "#f0c076", "#95cfab", "#9dbce6"]],
  dawn: ["night hands the sky to day",
    ["radial-gradient(circle at 35% 30%,#9c4a10,#eda253 45%,transparent 72%)", "#f0c076", "#95cfab", "#9dbce6"]],
  retrograde: ["the eighties, classy",
    ["radial-gradient(circle at 35% 30%,#fff0fb,#ff4fd8 45%,transparent 72%)", "#ffd23f", "#3ef2a0", "#2de2e6"]],
};

/** [id, title, line, ground, [sun, warm, ok, upcoming]] per pack, in roster order. */
/** @type {[string, string, string, string, string[]][]} */
export const PACKS = THEME_TABLE.map(({ id, title, ground }) => {
  const [line, strip] = META[id];
  return [id, title, line, ground, strip];
});

/** The provider as a reader recognises it: its host, never the whole issuer URL. */
/** @param {string} issuer */
export function issuerHost(issuer) {
  try { return new URL(issuer).host; } catch { return issuer; }
}

/** A date a reader can read, in UTC so the gate photographs the same one. */
/** @param {?string} iso */
export const on = (iso) => (iso ? dayMonthYear(iso) : "");

/** The step-up intent each armed action is bound to (ADR-0023 §5). */
/** @param {string} action */
export const intentOf = (action) =>
  action.startsWith("unlink:") ? "unlink_method" : action === "password_remove" ? "unlink_method" : action;

/**
 * Where the provider sends a reader back to after a step-up (ADR-0023 §5):
 * `?stepup=` names the action they left to do, and an unlink names the
 * identity too, so the screen can re-arm it on the way back in.
 * @param {string} action
 */
export const stepUpReturnOf = (action) => {
  const identity = action.startsWith("unlink:") ? `&identity=${encodeURIComponent(action.slice(7))}` : "";
  return `/settings?stepup=${encodeURIComponent(action)}${identity}`;
};

/** What a sign-in method refusal means in the block's own words, from the bounded code. */
/** @param {unknown} error */
export function methodWords(error) {
  const code = /** @type {{ code?: string, message?: string }} */ (error)?.code;
  if (code === "recent_authentication_required") return "that isn't your current password — nothing was changed";
  if (code === "too_many_attempts") return "too many attempts at once; try again shortly";
  if (code === "password_rejected") return wordsOf(error, "that password was refused");
  if (code === "link_last_method") return "keep at least one way to sign in: add another method before removing this one";
  if (code === "link_exists") return "that provider account already belongs to an Orbit account";
  if (code === "step_up_failed") return "your identity provider did not re-authenticate you, so nothing was changed";
  if (code === "provider_handover_unreadable") {
    return "not started — Orbit could not hand you to your identity provider";
  }
  return wordsOf(error, "not changed — Orbit could not reach your sign-in methods");
}

/**
 * When a reminder was sent, as the sent list says it (#1003): the day and
 * the time, in UTC under fixtures so the gate photographs one answer. The
 * desk joins them with ` · `, the phone with a space (`between`).
 * @param {string} iso @param {boolean} fixtures @param {string} between
 */
export function sentWhenOf(iso, fixtures, between) {
  const zone = fixtures ? "UTC" : localZone();
  return `${dayMonth(iso, zone)}${between}${clockOf(iso, zone)}`;
}

/**
 * What a browser-alerts refusal means in words, from the code alerts.js
 * throws (so no layout matches on a message). The desk writes an administrator's
 * with a straight apostrophe, the phone with a curly one (`curly`).
 * @param {unknown} error @param {{ curly?: boolean }} [options]
 */
export function alertsWords(error, { curly = false } = {}) {
  const reason = /** @type {{ code?: string }} */ (error)?.code;
  return reason === "permission_denied"
    ? "your browser is refusing alerts. allow notifications for Orbit, then try again"
    : reason === "unconfigured"
      ? `not switched on — this Orbit has no push keys yet, which is your administrator${curly ? "’" : "'"}s to set`
      : "not switched on — Orbit could not reach your alert settings";
}
