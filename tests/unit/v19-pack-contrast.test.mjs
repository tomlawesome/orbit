import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #861: the text-grade tokens (#491) were graded against each pack's --bg
 * ONLY. Every pack also paints text on a panel — a translucent --panel or
 * --panel-raised sitting over that same --bg — and axe caught in CI what the
 * grading pass never measured: ink that clears 4.5:1 on the bare background
 * can fail once composited under a panel.
 *
 * This file parses the real web/src/lib/packs.css (never a copy, never
 * hand-transcribed values) and measures every text-carrying ink token, in
 * every pack the file defines, against all three grounds text actually sits
 * on there: --bg itself, --panel over --bg, and --panel-raised over --bg. A
 * new pack or a changed value is picked up automatically because nothing
 * here is a stored number — only WCAG's own formula and packs.css's own
 * declarations.
 */

const PACKS_CSS = readFileSync(
  resolve(import.meta.dirname, "../../web/src/lib/packs.css"),
  "utf8",
);

// Discover packs from the file itself — never a hard-coded roster — so a
// pack added later is covered without touching this test.
const PACK_NAMES = [...PACKS_CSS.matchAll(/\[data-theme=([\w-]+)\]/g)].map((m) => m[1]);

/*
 * packs.css's own preamble (#491, "THE TEXT-GRADE COMPANIONS") states the
 * contract and names the tokens it covers: "three companions join every
 * pack, and their contract is narrow and literal: they are for INK THAT
 * CARRIES WORDS" — --ink-quiet, --accent-text and --ok-text — "alongside"
 * the base --ink and --ink-mid, which the same preamble treats as already
 * text (it measures --ink-mid's lift in exactly these terms). The preamble
 * is equally explicit about what is deliberately excluded: "--ink-faint is
 * still the hairline, the rule, the tick and the swatch... because a mark is
 * not a letterform" — so --ink-faint is not in this list, on purpose.
 */
const TEXT_TOKENS = ["--ink", "--ink-mid", "--ink-quiet", "--accent-text", "--ok-text"];

const GROUND_TOKENS = ["--bg", "--panel", "--panel-raised"];

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

const BLOCKS = Object.fromEntries(PACK_NAMES.map((pack) => [pack, blockOf(pack)]));

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
 * pack's own block. Anything else is a shape this test does not expect and
 * throws rather than silently mismeasuring.
 */
function resolveColor(pack, rawValue) {
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
function compositeOver({ rgb, alpha }, baseRgb) {
  if (alpha === 1) return rgb;
  return rgb.map((c, i) => c * alpha + baseRgb[i] * (1 - alpha));
}

/** WCAG 2 relative luminance. */
function relativeLuminance([r, g, b]) {
  const linearise = (c) => {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : ((cs + 0.055) / 1.055) ** 2.4;
  };
  const [rl, gl, bl] = [linearise(r), linearise(g), linearise(b)];
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

/** WCAG 2 contrast ratio between two colours, order-independent. */
function contrastRatio(rgbA, rgbB) {
  const la = relativeLuminance(rgbA);
  const lb = relativeLuminance(rgbB);
  const [lighter, darker] = la >= lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}

const AA_TEXT_FLOOR = 4.5;

/** The three grounds a pack actually paints text on: its own --bg, and its
 * two panel tiers composited over that --bg — the way html body{background:
 * var(--bg)} plus a translucent panel on top of it actually paints. */
function groundsFor(pack) {
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

describe("packs.css text-carrying ink clears WCAG 2 AA on every ground it is painted on (#861)", () => {
  it.each(PACK_NAMES)("%s defines every text-carrying ink token", (pack) => {
    for (const token of TEXT_TOKENS) {
      expect(BLOCKS[pack]).toHaveProperty(token);
    }
  });

  it.each(PACK_NAMES)("%s: every text-carrying ink token clears 4.5:1 on --bg, --panel and --panel-raised", (pack) => {
    const grounds = groundsFor(pack);
    const failures = [];
    for (const token of TEXT_TOKENS) {
      const raw = BLOCKS[pack][token];
      const inkColor = resolveColor(pack, raw);
      for (const ground of grounds) {
        const inkRgb = compositeOver(inkColor, ground.rgb);
        const ratio = contrastRatio(inkRgb, ground.rgb);
        if (ratio < AA_TEXT_FLOOR) {
          failures.push(
            `${pack}: ${token} (${raw}) measured ${ratio.toFixed(2)}:1 on ${ground.label} — under the 4.5:1 floor`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
