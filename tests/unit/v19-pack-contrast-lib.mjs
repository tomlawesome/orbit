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

export const PACK_NAMES = [...PACKS_CSS.matchAll(/\[data-theme=([\w-]+)\]/g)].map((m) => m[1]);

/** Extracts `prop: value;` pairs from a `[data-theme=x]{...}` block, raw (unresolved). */
function blockOf(pack) {
  const pattern = new RegExp(`\\[data-theme=${pack}\\]\\s*{([^}]*)}`);
  const match = pattern.exec(PACKS_CSS);
  if (!match) throw new Error(`No [data-theme=${pack}] block found in packs.css`);
  const body = match[1];
  const props = {};
  // Strip /* ... */ comments first — this file's comments are prose-heavy and
  // sometimes name a token, which must never be read as a declaration.
  const withoutComments = body.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const decl of withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    props[decl[1]] = decl[2].trim();
  }
  return props;
}

export const BLOCKS = Object.fromEntries(PACK_NAMES.map((pack) => [pack, blockOf(pack)]));

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Resolves a raw packs.css value to {rgb:[r,g,b], alpha}. Handles this file's
 * two colour forms — #rrggbb (opaque) and rgba(r,g,b,a) — plus one level of
 * var(--other-token) indirection (e.g. dawn's `--ink-quiet:var(--ink-faint)`),
 * resolved by looking the referenced token straight back up in the same
 * pack's own block. Anything else is a shape this module does not expect and
 * throws rather than silently mismeasuring.
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

  if (/^#[0-9a-fA-F]{3,6}$/.test(value)) {
    return { rgb: hexToRgb(value), alpha: 1 };
  }

  const rgbaMatch = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d*\.?\d+)\s*\)$/.exec(value);
  if (rgbaMatch) {
    const [, r, g, b, a] = rgbaMatch;
    return { rgb: [Number(r), Number(g), Number(b)], alpha: Number(a) };
  }

  throw new Error(`${pack}: cannot resolve colour value "${value}" (expected #rrggbb, rgba(...) or var())`);
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
