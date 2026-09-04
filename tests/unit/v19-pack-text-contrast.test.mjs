import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #491 item 3: every "-text" companion (and --ink-quiet) is a promise that a
 * letterform drawn in that colour clears WCAG 2's 4.5:1 body-text floor on
 * the worst ground the pack actually paints it on. The promise is only as
 * good as this file's ability to break when a value regresses — so it parses
 * the real web/src/lib/packs.css (not a copy of it) and measures every pack,
 * rather than asserting a handful of hand-picked spots.
 *
 * Grounds, per the 2026-09-02 ruling: atlas against --bg; dawn and clouds
 * against --sky-1 (the coolest, darkest stop of the gradient, which is what
 * the top of the dial screen actually paints); the remaining packs against
 * their own --bg.
 */

const PACKS_CSS = readFileSync(
  resolve(import.meta.dirname, "../../web/src/lib/packs.css"),
  "utf8",
);

const PACK_NAMES = ["starchart", "afterdark", "atlas", "dawn", "clouds", "retrograde"];

const GROUND_TOKEN = {
  starchart: "--bg",
  afterdark: "--bg",
  atlas: "--bg",
  dawn: "--sky-1",
  clouds: "--sky-1",
  retrograde: "--bg",
};

const TEXT_TOKENS = ["--overdue-text", "--degraded-text", "--accent-text", "--ok-text", "--ink-quiet"];

/** Extracts `prop: value;` pairs from a `[data-theme=x]{...}` block, raw (unresolved). */
function blockOf(pack) {
  const pattern = new RegExp(`\\[data-theme=${pack}\\]\\s*{([^}]*)}`);
  const match = pattern.exec(PACKS_CSS);
  if (!match) throw new Error(`No [data-theme=${pack}] block found in packs.css`);
  const body = match[1];
  const props = {};
  // Declarations only — strips /* ... */ comments first so a token name
  // mentioned in prose (there is plenty of it in this file) is never read
  // as a declaration.
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

const NAMED = { black: [0, 0, 0], white: [255, 255, 255] };

/** Resolves a packs.css value (hex literal, var(), or color-mix(in srgb, ...)) to an [r,g,b]. */
function resolveColor(pack, rawValue) {
  const value = rawValue.trim();

  const varMatch = /^var\((--[\w-]+)\)$/.exec(value);
  if (varMatch) {
    const referenced = BLOCKS[pack][varMatch[1]];
    if (!referenced) throw new Error(`${pack}: ${varMatch[1]} referenced but not defined`);
    return resolveColor(pack, referenced);
  }

  // color-mix(in srgb, var(--token) P1%, COLOR P2%) — CSS Color 4's "in srgb"
  // interpolates in gamma-encoded sRGB directly: a plain weighted average of
  // the two colours' R/G/B components, no linear-light conversion.
  const mixMatch = /^color-mix\(in srgb,\s*var\((--[\w-]+)\)\s*(\d+(?:\.\d+)?)%,\s*(\w+)\s*(\d+(?:\.\d+)?)%\)$/.exec(
    value,
  );
  if (mixMatch) {
    const [, tokenName, pctA, colorB, pctB] = mixMatch;
    const a = resolveColor(pack, `var(${tokenName})`);
    const b = NAMED[colorB.toLowerCase()] ?? hexToRgb(colorB);
    const wa = parseFloat(pctA);
    const wb = parseFloat(pctB);
    const total = wa + wb;
    return a.map((component, i) => (component * wa + b[i] * wb) / total);
  }

  if (/^#[0-9a-fA-F]{3,6}$/.test(value)) return hexToRgb(value);

  throw new Error(`${pack}: cannot resolve colour value "${value}"`);
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

describe("packs.css text-grade companions clear WCAG 2 AA on their pack's ground (#491)", () => {
  it.each(PACK_NAMES)("%s defines every -text companion and --ink-quiet", (pack) => {
    for (const token of TEXT_TOKENS) {
      expect(BLOCKS[pack]).toHaveProperty(token);
    }
  });

  it.each(PACK_NAMES)("%s: every -text companion and --ink-quiet clears 4.5:1 on its ground", (pack) => {
    const groundRgb = resolveColor(pack, `var(${GROUND_TOKEN[pack]})`);
    const failures = [];
    for (const token of TEXT_TOKENS) {
      const raw = BLOCKS[pack][token];
      const rgb = resolveColor(pack, raw);
      const ratio = contrastRatio(rgb, groundRgb);
      if (ratio < AA_TEXT_FLOOR) {
        failures.push(`${token} (${raw}) = ${ratio.toFixed(2)}:1 on ${GROUND_TOKEN[pack]}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("dark packs and retrograde alias the originals for overdue/degraded (no pixel moves)", () => {
    for (const pack of ["starchart", "afterdark", "retrograde"]) {
      expect(BLOCKS[pack]["--overdue-text"]).toBe("var(--overdue)");
      expect(BLOCKS[pack]["--degraded-text"]).toBe("var(--degraded)");
    }
  });
});
