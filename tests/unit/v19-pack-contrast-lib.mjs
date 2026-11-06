/*
 * Shared measuring stick for every "does this pack clear WCAG AA" test
 * (#861's v19-pack-contrast.test.mjs, and #866's veil test alongside it).
 *
 * Extracted rather than left inline: v19-pack-contrast.test.mjs and
 * v19-pack-text-contrast.test.mjs already carried two near-identical copies
 * of this math before this file existed, and #866 needed a third for the
 * veil. A colour law has exactly one implementation here, imported by every
 * test that grades one — not retyped per file, where a fix to one copy
 * silently leaves the others wrong.
 *
 * Everything below reads from the real web/src/lib/packs.css (never a copy,
 * never hand-transcribed values); PACK_NAMES is discovered from the file's
 * own `[data-theme=x]` blocks, so a pack added later is covered without
 * touching this module or any test built on it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const PACKS_CSS = readFileSync(
  resolve(import.meta.dirname, "../../web/src/lib/packs.css"),
  "utf8",
);

export const PACK_NAMES = [...new Set([...PACKS_CSS.matchAll(/\[data-theme=([\w-]+)\]/g)].map((m) => m[1]))];

/**
 * The custom properties a pack ends up with: every rule whose selector list
 * names `[data-theme=x]` (its own block and any grouped rule shared with
 * other packs, #1356), merged in file order as the cascade does, raw
 * (unresolved). Reading only the pack's own block would silently skip the
 * shared colours.
 */
function blockOf(pack) {
  const props = {};
  let found = false;
  // Strip /* ... */ comments first — this file's comments are prose-heavy and
  // sometimes name a token, which must never be read as a declaration.
  const css = PACKS_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of css.matchAll(/([^{}]+){([^}]*)}/g)) {
    const selectors = rule[1].split(",").map((selector) => selector.trim());
    if (!selectors.includes(`[data-theme=${pack}]`)) continue;
    found = true;
    for (const decl of rule[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      props[decl[1]] = decl[2].trim();
    }
  }
  if (!found) throw new Error(`No [data-theme=${pack}] block found in packs.css`);
  return props;
}

export const BLOCKS = Object.fromEntries(PACK_NAMES.map((pack) => [pack, blockOf(pack)]));

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const NAMED = { black: [0, 0, 0], white: [255, 255, 255] };

/** Splits "a, b(c, d), e" on its top-level commas. */
function splitArgs(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") depth -= 1;
    else if (text[i] === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim());
}

/**
 * color-mix(in srgb, A p%, B q%): CSS Color 4 interpolates in gamma-encoded
 * sRGB, premultiplied by alpha, so for opaque operands it is a plain weighted
 * average of the R/G/B components. A missing percentage is 100 minus the
 * other (50/50 if both are missing); percentages that do not add to 100 are
 * scaled to it. Each operand is anything resolveColor reads, or a named
 * black/white/transparent.
 */
function resolveColorMix(pack, args) {
  if (args[0] !== "in srgb") {
    throw new Error(`${pack}: color-mix() only in srgb is supported, got "${args[0]}"`);
  }
  const operands = args.slice(1).map((arg) => {
    const m = /^(.*?)(?:\s+(\d+(?:\.\d+)?)%)?$/s.exec(arg);
    const text = m[1].trim();
    const lower = text.toLowerCase();
    let colour;
    if (lower === "transparent") colour = { rgb: [0, 0, 0], alpha: 0 };
    else if (NAMED[lower]) colour = { rgb: NAMED[lower], alpha: 1 };
    else colour = resolveColor(pack, text);
    return { colour, pct: m[2] === undefined ? null : Number(m[2]) };
  });
  if (operands.length !== 2) throw new Error(`${pack}: color-mix() needs two colours`);
  const [first, second] = operands;
  if (first.pct === null && second.pct === null) { first.pct = 50; second.pct = 50; }
  else if (first.pct === null) first.pct = 100 - second.pct;
  else if (second.pct === null) second.pct = 100 - first.pct;
  const total = first.pct + second.pct;
  const wa = first.pct / total;
  const wb = second.pct / total;
  const alpha = first.colour.alpha * wa + second.colour.alpha * wb;
  if (alpha === 0) return { rgb: [0, 0, 0], alpha: 0 };
  const rgb = [0, 1, 2].map((i) => (
    (first.colour.rgb[i] * first.colour.alpha * wa + second.colour.rgb[i] * second.colour.alpha * wb) / alpha
  ));
  return { rgb, alpha };
}

/**
 * Resolves a raw packs.css value to {rgb:[r,g,b], alpha}. Handles this file's
 * colour forms — #rrggbb (opaque), rgba(r,g,b,a) and color-mix(in srgb, ...)
 * (the -text companions) — plus var(--other-token) indirection (e.g. dawn's
 * `--ink-quiet:var(--ink-faint)`), resolved by looking the referenced token
 * straight back up in the same pack's own block. Anything else is a shape
 * this module does not expect and throws rather than silently mismeasuring.
 */
export function resolveColor(pack, rawValue) {
  const value = rawValue.trim();

  const varMatch = /^var\((--[\w-]+)\)$/.exec(value);
  if (varMatch) {
    const referenced = BLOCKS[pack][varMatch[1]];
    if (!referenced) {
      throw new Error(`${pack}: ${varMatch[1]} referenced via var() but not defined in this pack`);
    }
    return resolveColor(pack, referenced);
  }

  const mixMatch = /^color-mix\((.*)\)$/s.exec(value);
  if (mixMatch) return resolveColorMix(pack, splitArgs(mixMatch[1]));

  if (/^#[0-9a-fA-F]{3,6}$/.test(value)) {
    return { rgb: hexToRgb(value), alpha: 1 };
  }

  const rgbaMatch = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d*\.?\d+)\s*\)$/.exec(value);
  if (rgbaMatch) {
    const [, r, g, b, a] = rgbaMatch;
    return { rgb: [Number(r), Number(g), Number(b)], alpha: Number(a) };
  }

  throw new Error(`${pack}: cannot resolve colour value "${value}" (expected #rrggbb, rgba(...), color-mix(...) or var())`);
}

/** The token a pack's text is measured against (2026-09-02 ruling): the sky
 * packs paint their gradient's coolest, darkest stop (--sky-1) behind the
 * dial screen; every other pack paints --bg. Read from the pack's own block,
 * so a new pack is graded with no list to edit. */
export function textGroundToken(pack) {
  return "--sky-1" in BLOCKS[pack] ? "--sky-1" : "--bg";
}

/** Composites a possibly-translucent colour over an opaque base RGB — plain
 * "over" blending (out = fg*a + bg*(1-a)), matching how a browser paints a
 * CSS layer over a solid background beneath it. An opaque colour (alpha 1)
 * is simply itself, so this also covers a panel defined as a flat #rrggbb. */
export function compositeOver({ rgb, alpha }, baseRgb) {
  if (alpha === 1) return rgb;
  return rgb.map((c, i) => c * alpha + baseRgb[i] * (1 - alpha));
}

/** WCAG 2 relative luminance. */
export function relativeLuminance([r, g, b]) {
  const linearise = (c) => {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : ((cs + 0.055) / 1.055) ** 2.4;
  };
  const [rl, gl, bl] = [linearise(r), linearise(g), linearise(b)];
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

/** WCAG 2 contrast ratio between two colours, order-independent. */
export function contrastRatio(rgbA, rgbB) {
  const la = relativeLuminance(rgbA);
  const lb = relativeLuminance(rgbB);
  const [lighter, darker] = la >= lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}

export const AA_TEXT_FLOOR = 4.5;
export const AA_UI_FLOOR = 3;

export const GROUND_TOKENS = ["--bg", "--panel", "--panel-raised"];

/** The three grounds a pack actually paints text on: its own --bg, and its
 * two panel tiers composited over that --bg — the way html body{background:
 * var(--bg)} plus a translucent panel on top of it actually paints. */
export function groundsFor(pack) {
  const bg = resolveColor(pack, BLOCKS[pack]["--bg"]);
  if (bg.alpha !== 1) throw new Error(`${pack}: --bg is not opaque (${BLOCKS[pack]["--bg"]})`);
  return GROUND_TOKENS.map((token) => {
    const raw = BLOCKS[pack][token];
    if (!raw) throw new Error(`${pack}: ${token} is not defined`);
    const rgb = token === "--bg" ? bg.rgb : compositeOver(resolveColor(pack, raw), bg.rgb);
    const label = token === "--bg" ? "--bg" : `${token} over --bg`;
    return { token, label, rgb };
  });
}
