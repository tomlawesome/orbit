import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { themePacks } from "@/lib/preferences";

/**
 * WCAG guard for the v19 application shell (issue #307 / #325).
 *
 * A previous release shipped real contrast defects that were only caught
 * after the fact, and the ratified mockup itself contains one: it paints
 * drawer headings and the sign-out link in `--ink-faint`, which is about
 * 2.5:1 on the atlas and dawn packs. shell.css therefore restricts itself
 * to `--ink` and `--ink-mid` for text, and this test holds that line for
 * every pack — not just the dark one the mockup was drawn in.
 *
 * The pairs below are the ones the shell actually paints (see shell.css):
 * chrome surfaces are `--panel` and `--panel-raised`, never the raw page
 * background, precisely because `--ink-mid` on `--bg` is 4.47:1 on atlas.
 */

const cssPath = fileURLToPath(new URL("./theme-tokens.css", import.meta.url));
const css = readFileSync(cssPath, "utf8");
const shellCss = readFileSync(fileURLToPath(new URL("./shell.css", import.meta.url)), "utf8");

interface Rgba { r: number; g: number; b: number; a: number }

function tokensFor(pack: string): Record<string, string> {
  const block = new RegExp(`\\[data-theme="${pack}"\\]\\s*{([^}]*)}`).exec(css);
  if (!block) throw new Error(`No [data-theme="${pack}"] block found in theme-tokens.css`);
  return Object.fromEntries(
    [...block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((entry) => [entry[1], entry[2].trim()]),
  );
}

function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit).join("") : hex[1];
    return {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16),
      a: 1,
    };
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(value.trim());
  if (!rgba) throw new Error(`Unsupported colour value: ${value}`);
  return {
    r: Number(rgba[1]),
    g: Number(rgba[2]),
    b: Number(rgba[3]),
    a: rgba[4] === undefined ? 1 : Number(rgba[4]),
  };
}

/** Flattens a translucent surface onto the opaque page background beneath it. */
function over(top: Rgba, base: Rgba): Rgba {
  return {
    r: top.r * top.a + base.r * (1 - top.a),
    g: top.g * top.a + base.g * (1 - top.a),
    b: top.b * top.a + base.b * (1 - top.a),
    a: 1,
  };
}

function relativeLuminance({ r, g, b }: Rgba): number {
  const channel = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(foreground: Rgba, background: Rgba): number {
  const [light, dark] = [relativeLuminance(foreground), relativeLuminance(background)]
    .sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

/** Resolves a token to an opaque colour, flattening it over `--bg` if needed. */
function surface(pack: string, token: string): Rgba {
  const tokens = tokensFor(pack);
  const value = tokens[token];
  if (!value) throw new Error(`${pack} does not define ${token}`);
  return over(parseColor(value), parseColor(tokens["--bg"]));
}

const textPairs = [
  { ink: "--ink", surface: "--panel", usage: "handle words, drawer body copy" },
  { ink: "--ink", surface: "--panel-raised", usage: "account panel and drawer text" },
  { ink: "--ink-mid", surface: "--panel", usage: "handle secondary text" },
  { ink: "--ink-mid", surface: "--panel-raised", usage: "block titles, counts, hints" },
] as const;

/**
 * Non-text indicators and the surface each one is actually drawn on.
 * `--accent` is listed against `--panel-raised` only: on atlas it is
 * 2.97:1 against `--panel`, so shell.css keeps every accent ring, border
 * and swatch outline on a raised surface. Moving one onto `--panel` would
 * be a regression this list is meant to catch.
 */
const indicatorPairs = [
  ...(["--ok", "--warm", "--overdue", "--upcoming", "--degraded"] as const)
    .flatMap((token) => (["--panel", "--panel-raised"] as const).map((backdrop) => ({ token, backdrop }))),
  { token: "--accent", backdrop: "--panel-raised" } as const,
];

describe("v19 shell contrast (issue #307)", () => {
  it.each(themePacks)("%s: every shell text pair clears WCAG AA (4.5:1)", (pack) => {
    for (const pair of textPairs) {
      const ratio = contrast(surface(pack, pair.ink), surface(pack, pair.surface));
      expect(
        ratio,
        `${pack}: ${pair.ink} on ${pair.surface} (${pair.usage}) is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(themePacks)("%s: every status indicator clears the 3:1 non-text bar", (pack) => {
    for (const { token, backdrop } of indicatorPairs) {
      const ratio = contrast(surface(pack, token), surface(pack, backdrop));
      expect(
        ratio,
        `${pack}: ${token} on ${backdrop} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("records why --ink-faint may not carry shell text", () => {
    // Not a wish: on the light packs this token is the mockup's real defect.
    for (const pack of ["atlas", "dawn"] as const) {
      expect(contrast(surface(pack, "--ink-faint"), surface(pack, "--panel-raised"))).toBeLessThan(4.5);
    }
  });

  it("shell.css never paints text in --ink-faint", () => {
    const offenders = [...shellCss.matchAll(/color:\s*var\(--ink-faint\)/g)];
    expect(offenders).toHaveLength(0);
  });

  it("shell.css never paints small text in --accent (3.15:1 on atlas)", () => {
    expect(contrast(surface("atlas", "--accent"), surface("atlas", "--panel-raised"))).toBeLessThan(4.5);
    const offenders = [...shellCss.matchAll(/(?<!border-)color:\s*var\(--accent\)/g)]
      // The sign-out hover state swaps to --overdue, not --accent; any other
      // accent-coloured text would be a regression.
      .map((match) => match[0]);
    expect(offenders).toHaveLength(0);
  });
});
