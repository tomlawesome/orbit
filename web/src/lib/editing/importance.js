/**
 * The three importance levels as the app offers them (#1463, round 6 P): the
 * word and the planet it would draw, small to large (the diameters are P's
 * 10, 16 and 24 px). One list for the Add form's tiles and chips, the
 * drawer's chooser and the one-time pass.
 */

/** @type {readonly { value: "low" | "normal" | "high", words: string, colour: null, disc: number }[]} */
export const IMPORTANCE_CHOICES = [
  { value: "low", words: "low", colour: null, disc: 10 },
  { value: "normal", words: "normal", colour: null, disc: 16 },
  { value: "high", words: "high", colour: null, disc: 24 },
];

/** A level in words; "not set" for none. @param {?string} [level] */
export const importanceWords = (level) => (level === "low" || level === "normal" || level === "high" ? level : "not set");
