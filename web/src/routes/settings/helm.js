import { THEME_TABLE } from "$lib/theme.js";
import { dayMonthYear } from "$lib/format.js";

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

/** What a sign-in method refusal means in the block's own words, from the bounded code. */
/** @param {unknown} error */
export function methodWords(error) {
  const code = /** @type {{ code?: string, message?: string }} */ (error)?.code;
  if (code === "recent_authentication_required") return "that isn't your current password — nothing was changed";
  if (code === "too_many_attempts") return "too many attempts at once; try again shortly";
  if (code === "password_rejected") return /** @type {{ message?: string }} */ (error)?.message ?? "that password was refused";
  if (code === "link_last_method") return "keep at least one way to sign in: add another method before removing this one";
  if (code === "link_exists") return "that provider account already belongs to an Orbit account";
  if (code === "step_up_failed") return "your identity provider did not re-authenticate you, so nothing was changed";
  if (code === "provider_handover_unreadable") {
    return "not started — Orbit could not hand you to your identity provider";
  }
  return /** @type {{ message?: string }} */ (error)?.message ?? "not changed — Orbit could not reach your sign-in methods";
}
