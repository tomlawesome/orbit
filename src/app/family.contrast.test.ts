import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { themePacks, type ThemePack } from "@/lib/preferences";

/**
 * Contrast contract for the family screens (sign-in, signed-out, not-found,
 * maintenance, sign-in error).
 *
 * A previous release shipped real WCAG contrast failures, and these screens
 * are the ones a visitor meets before Orbit knows anything about them —
 * including which theme pack they use. Every text colour on them is
 * therefore derived from the pack token contract by a `color-mix()` whose
 * ratio is recomputed here, against every pack, light and dark. Change a
 * mix percentage in family.css and this test recomputes it; drop below AA
 * on any pack and it fails.
 *
 * The measured raw tokens, for the record — this is why the lifts exist:
 *   --ink       on --bg  11.61 (atlas) … 16.72 (star-chart)  passes
 *   --ink-mid   on --bg   4.47 (atlas)                       fails
 *   --ink-faint on --bg   2.16 (atlas) …  2.78 (star-chart)  fails
 *   --accent    on --bg   2.76 (atlas),   4.01 (dawn)        fails
 */

const tokensCss = readFileSync(fileURLToPath(new URL("./theme-tokens.css", import.meta.url)), "utf8");
const familyCss = readFileSync(fileURLToPath(new URL("./family.css", import.meta.url)), "utf8");

const AA_NORMAL = 4.5;
const AA_LARGE = 3;

type Rgb = readonly [number, number, number];

function parseColor(value: string): Rgb {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const digits = hex[1];
    return [0, 2, 4].map((offset) => parseInt(digits.slice(offset, offset + 2), 16)) as unknown as Rgb;
  }
  const short = /^#([0-9a-f]{3})$/i.exec(value.trim());
  if (short) {
    return short[1].split("").map((digit) => parseInt(digit + digit, 16)) as unknown as Rgb;
  }
  throw new Error(`Unsupported colour literal: ${value}`);
}

/** The custom properties a `[data-theme="pack"]` block declares. */
function packTokens(pack: ThemePack): Map<string, string> {
  const block = new RegExp(`\\[data-theme="${pack}"\\]\\s*{([^}]*)}`).exec(tokensCss);
  if (!block) throw new Error(`No [data-theme="${pack}"] block in theme-tokens.css`);
  return new Map([...block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((entry) => [entry[1], entry[2].trim()]));
}

/** The `--family-*` lifts family.css derives from the pack tokens. */
function familyDefinitions(): Map<string, string> {
  const block = /\.family-screen\s*{([\s\S]*?)\n}/.exec(familyCss);
  if (!block) throw new Error("No .family-screen block in family.css");
  return new Map([...block[1].matchAll(/(--family-[\w-]+)\s*:\s*([^;]+);/g)].map((entry) => [entry[1], entry[2].trim()]));
}

const MIX_PATTERN = /^color-mix\(\s*in srgb\s*,\s*(.+?)\s+(\d+(?:\.\d+)?)%\s*,\s*(.+?)\s+(\d+(?:\.\d+)?)%\s*\)$/;

/** Resolves `var(--x)`, a hex literal, or a two-term srgb `color-mix()`
 *  against one pack's tokens plus the family.css derivations. */
function resolve(value: string, pack: ThemePack, definitions: Map<string, string>, tokens: Map<string, string>): Rgb {
  const expression = value.trim();

  const variable = /^var\(\s*(--[\w-]+)\s*\)$/.exec(expression);
  if (variable) {
    const name = variable[1];
    const source = definitions.get(name) ?? tokens.get(name);
    if (!source) throw new Error(`${name} is not defined for ${pack}`);
    return resolve(source, pack, definitions, tokens);
  }

  const mix = MIX_PATTERN.exec(expression);
  if (mix) {
    const first = resolve(mix[1], pack, definitions, tokens);
    const second = resolve(mix[3], pack, definitions, tokens);
    const weight = Number(mix[2]) / (Number(mix[2]) + Number(mix[4]));
    return [0, 1, 2].map((channel) => first[channel] * weight + second[channel] * (1 - weight)) as unknown as Rgb;
  }

  return parseColor(expression);
}

function relativeLuminance(colour: Rgb): number {
  const [red, green, blue] = colour.map((channel) => {
    const scaled = channel / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground: Rgb, background: Rgb): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)]
    .sort((first, second) => second - first);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Every foreground family.css puts on the screen background, with the
 *  threshold that applies to the size it is used at. */
const FOREGROUNDS: ReadonlyArray<{ what: string; value: string; minimum: number }> = [
  { what: "headings and the wordmark (--ink)", value: "var(--ink)", minimum: AA_NORMAL },
  { what: "body copy (--family-quiet)", value: "var(--family-quiet)", minimum: AA_NORMAL },
  { what: "the eyebrow (--family-quiet)", value: "var(--family-quiet)", minimum: AA_NORMAL },
  { what: "the footer ribbon (--family-faint)", value: "var(--family-faint)", minimum: AA_NORMAL },
  { what: "the secondary link (--family-link)", value: "var(--family-link)", minimum: AA_NORMAL },
  { what: "the focus ring (--ink)", value: "var(--ink)", minimum: AA_LARGE },
  { what: "the mark's ring (--ink-mid)", value: "var(--ink-mid)", minimum: AA_LARGE },
  { what: "the mark's body (--family-link)", value: "var(--family-link)", minimum: AA_LARGE },
];

describe("family screen contrast, on every theme pack", () => {
  const definitions = familyDefinitions();

  it.each(themePacks)("%s carries every family foreground at AA", (pack) => {
    const tokens = packTokens(pack);
    const background = resolve("var(--bg)", pack, definitions, tokens);

    for (const { what, value, minimum } of FOREGROUNDS) {
      const ratio = contrast(resolve(value, pack, definitions, tokens), background);
      expect(ratio, `${what} on ${pack} measured ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(minimum);
    }
  });

  it.each(themePacks)("%s carries the primary action's label on its accent fill", (pack) => {
    const tokens = packTokens(pack);
    // globals.css pins --accent-ink to #000 for text on a solid --accent
    // fill; family.css's `.family-action` is one of its users.
    const ratio = contrast(parseColor("#000"), resolve("var(--accent)", pack, definitions, tokens));
    expect(ratio, `--accent-ink on --accent for ${pack}`).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it("derives every family colour from the pack contract, never a literal", () => {
    // The one permitted literal is the black the night-side limb and the
    // --accent-ink fallback mix toward; anything else would be a colour
    // that cannot follow a pack into a light theme.
    const literals = [...familyCss.matchAll(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi)].map((match) => match[0]);
    expect(literals.filter((literal) => literal.toLowerCase() !== "#000")).toEqual([]);
  });

  it("resolves the family lifts from tokens every pack actually defines", () => {
    expect([...definitions.keys()].sort()).toEqual(["--family-faint", "--family-limb", "--family-link", "--family-quiet"]);
    for (const pack of themePacks) {
      const tokens = packTokens(pack);
      for (const value of definitions.values()) {
        expect(() => resolve(value, pack, definitions, tokens)).not.toThrow();
      }
    }
  });
});
