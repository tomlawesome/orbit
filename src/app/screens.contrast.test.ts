import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { themePacks, type ThemePack } from "@/lib/preferences";

/**
 * WCAG guard for the settings and administration screens (issue #399).
 *
 * These screens were the last ones still wearing the pre-v19 chrome, and the
 * ratified mockups they are built from (design/family/settings-mail.html,
 * design/family/admin.html) contain the same two defects the shell's guard
 * already records: they paint words in `--ink-faint` and in `--accent`, both
 * of which fail AA on the light packs. screens.css therefore lifts each of
 * those toward the pack's own ink with a fixed `color-mix()`, and this test
 * recomputes every lift against every pack, light and dark. Change a mix
 * percentage in screens.css and this test remeasures it.
 *
 * The measured raw tokens, for the record — this is why the lifts exist:
 *   --ink       on --bg            11.61 (atlas) … 16.72 (star-chart)  passes
 *   --ink-mid   on --bg             4.47 (atlas)                       fails
 *   --ink-faint on --panel-raised   2.5-ish on atlas and dawn          fails
 *   --accent    on --panel-raised   3.15 (atlas), 4.54 (dawn)          fails
 */

const tokensCss = readFileSync(fileURLToPath(new URL("./theme-tokens.css", import.meta.url)), "utf8");
const globalsCss = readFileSync(fileURLToPath(new URL("./globals.css", import.meta.url)), "utf8");
const screensCss = readFileSync(fileURLToPath(new URL("./screens.css", import.meta.url)), "utf8");

const AA_NORMAL = 4.5;
const NON_TEXT = 3;

interface Rgba { r: number; g: number; b: number; a: number }

function parseColor(value: string): Rgba {
  const expression = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(expression);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit).join("") : hex[1];
    return {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16),
      a: 1,
    };
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(expression);
  if (!rgba) throw new Error(`Unsupported colour literal: ${value}`);
  return {
    r: Number(rgba[1]),
    g: Number(rgba[2]),
    b: Number(rgba[3]),
    a: rgba[4] === undefined ? 1 : Number(rgba[4]),
  };
}

/** The custom properties a `[data-theme="pack"]` block declares. */
function packTokens(pack: ThemePack): Map<string, string> {
  const block = new RegExp(`\\[data-theme="${pack}"\\]\\s*{([^}]*)}`).exec(tokensCss);
  if (!block) throw new Error(`No [data-theme="${pack}"] block in theme-tokens.css`);
  return new Map([...block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((entry) => [entry[1], entry[2].trim()]));
}

/** The `--screen-*` lifts screens.css derives from the pack tokens. */
function screenDefinitions(): Map<string, string> {
  const block = /\.settings-page,\n\.admin-page\s*{([\s\S]*?)\n}/.exec(screensCss);
  if (!block) throw new Error("No shared .settings-page/.admin-page block in screens.css");
  return new Map([...block[1].matchAll(/(--screen-[\w-]+)\s*:\s*([^;]+);/g)].map((entry) => [entry[1], entry[2].trim()]));
}

/**
 * The derived aliases globals.css declares for every pack. `--overdue-text`
 * splits by pack — dark packs lighten, light packs darken — so both branches
 * are read rather than assumed.
 */
function globalDefinitions(pack: ThemePack): Map<string, string> {
  const definitions = new Map<string, string>();
  const shared = /\[data-theme\]\s*{([\s\S]*?)\n}/.exec(globalsCss);
  if (!shared) throw new Error("No shared [data-theme] block in globals.css");
  for (const entry of shared[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    definitions.set(entry[1], entry[2].trim());
  }
  const selector = pack === "starchart" || pack === "afterdark"
    ? '\\[data-theme="starchart"\\], \\[data-theme="afterdark"\\]'
    : '\\[data-theme="atlas"\\], \\[data-theme="dawn"\\]';
  const split = new RegExp(`${selector}\\s*{([\\s\\S]*?)\\n}`).exec(globalsCss);
  if (!split) throw new Error(`No --overdue-text block in globals.css for ${pack}`);
  for (const entry of split[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    definitions.set(entry[1], entry[2].trim());
  }
  return definitions;
}

const MIX_PATTERN = /^color-mix\(\s*in srgb\s*,\s*(.+?)\s+(\d+(?:\.\d+)?)%\s*,\s*(.+?)(?:\s+(\d+(?:\.\d+)?)%)?\s*\)$/;

/** Resolves `var(--x)`, a colour literal, `black`/`white`, or a two-term
 *  srgb `color-mix()` against one pack's tokens plus the derived aliases. */
function resolve(value: string, pack: ThemePack, definitions: Map<string, string>, tokens: Map<string, string>): Rgba {
  const expression = value.trim();

  if (expression === "black") return { r: 0, g: 0, b: 0, a: 1 };
  if (expression === "white") return { r: 255, g: 255, b: 255, a: 1 };
  if (expression === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  const variable = /^var\(\s*(--[\w-]+)\s*\)$/.exec(expression);
  if (variable) {
    const source = definitions.get(variable[1]) ?? tokens.get(variable[1]);
    if (!source) throw new Error(`${variable[1]} is not defined for ${pack}`);
    return resolve(source, pack, definitions, tokens);
  }

  const mix = MIX_PATTERN.exec(expression);
  if (mix) {
    const first = resolve(mix[1], pack, definitions, tokens);
    const second = resolve(mix[3], pack, definitions, tokens);
    const secondShare = mix[4] === undefined ? 100 - Number(mix[2]) : Number(mix[4]);
    const weight = Number(mix[2]) / (Number(mix[2]) + secondShare);
    return {
      r: first.r * weight + second.r * (1 - weight),
      g: first.g * weight + second.g * (1 - weight),
      b: first.b * weight + second.b * (1 - weight),
      a: first.a * weight + second.a * (1 - weight),
    };
  }

  return parseColor(expression);
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
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(foreground: Rgba, background: Rgba): number {
  const [light, dark] = [relativeLuminance(foreground), relativeLuminance(background)]
    .sort((first, second) => second - first);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * The surfaces these screens paint on. The page itself, the rails' `--panel`
 * and the panes' `--panel-raised`, plus the two tinted chips globals.css
 * paints inside a pane — the text-size preview swatch and the accent pills
 * on the administrator list and the archive message. Both tints are
 * translucent, so they are flattened over the pane, which is flattened over
 * the page.
 */
const SURFACES = {
  "--bg": "var(--bg)",
  "--panel": "var(--panel)",
  "--panel-raised": "var(--panel-raised)",
  "--ok-soft swatch": "var(--ok-soft)",
  "accent pill": "color-mix(in srgb, var(--accent) 10%, transparent)",
} as const;

type SurfaceName = keyof typeof SURFACES;
const PAGE_SURFACES: ReadonlyArray<SurfaceName> = ["--bg", "--panel", "--panel-raised"];
const PANE_SURFACES: ReadonlyArray<SurfaceName> = ["--panel", "--panel-raised", "--ok-soft swatch", "accent pill"];

/** Every text colour the screens use, and where it is allowed to appear. */
const TEXT: ReadonlyArray<{ what: string; value: string; on: ReadonlyArray<SurfaceName> }> = [
  { what: "headings and pane copy (--ink)", value: "var(--ink)", on: PAGE_SURFACES },
  { what: "page-level muted copy (--screen-quiet)", value: "var(--screen-quiet)", on: PAGE_SURFACES },
  {
    what: "accent words (--screen-accent-text)",
    value: "var(--screen-accent-text)",
    on: ["--bg", ...PANE_SURFACES],
  },
  { what: "danger words (--overdue-text)", value: "var(--overdue-text)", on: PAGE_SURFACES },
  // Inherited globals.css rules paint secondary copy inside the panes.
  { what: "in-pane secondary copy (--ink-mid)", value: "var(--ink-mid)", on: ["--panel", "--panel-raised"] },
];

describe("settings and administration contrast, on every theme pack", () => {
  const screenLifts = screenDefinitions();

  it.each(themePacks)("%s carries every screen foreground at AA", (pack) => {
    const tokens = packTokens(pack);
    const definitions = new Map([...globalDefinitions(pack), ...screenLifts]);
    const page = resolve("var(--bg)", pack, definitions, tokens);
    const pane = over(resolve("var(--panel-raised)", pack, definitions, tokens), page);

    for (const { what, value, on } of TEXT) {
      const foreground = resolve(value, pack, definitions, tokens);
      for (const name of on) {
        // A tint is painted inside a pane; a pack surface sits on the page.
        const beneath = name === "--bg" || name === "--panel" || name === "--panel-raised" ? page : pane;
        const surface = over(resolve(SURFACES[name], pack, definitions, tokens), beneath);
        const ratio = contrast(foreground, surface);
        expect(
          ratio,
          `${what} on ${name} for ${pack} measured ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(AA_NORMAL);
      }
    }
  });

  it.each(themePacks)("%s clears the 3:1 non-text bar for accent borders and rings", (pack) => {
    const tokens = packTokens(pack);
    const definitions = new Map([...globalDefinitions(pack), ...screenLifts]);
    const page = resolve("var(--bg)", pack, definitions, tokens);
    // Chips and panes are `--panel-raised` precisely because of this: the same
    // border on `--panel` is 2.97:1 on atlas.
    const raised = over(resolve("var(--panel-raised)", pack, definitions, tokens), page);
    const ratio = contrast(resolve("var(--accent)", pack, definitions, tokens), raised);
    expect(ratio, `--accent on --panel-raised for ${pack} is ${ratio.toFixed(2)}:1`)
      .toBeGreaterThanOrEqual(NON_TEXT);
  });

  it.each(themePacks)("%s carries --accent-ink on a solid --accent fill", (pack) => {
    const tokens = packTokens(pack);
    const definitions = new Map([...globalDefinitions(pack), ...screenLifts]);
    const ratio = contrast(
      resolve("var(--accent-ink)", pack, definitions, tokens),
      resolve("var(--accent)", pack, definitions, tokens),
    );
    expect(ratio, `--accent-ink on --accent for ${pack}`).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it("records why --accent may not carry small text on these screens", () => {
    // Not a wish: atlas is the pack where the mockups' accent words are a
    // real failure (3.15:1). Dawn clears AA by four hundredths of a point,
    // which is not a margin worth shipping a whole screen's words on, so
    // the lift applies to every pack rather than branching on this one.
    const measured = (["atlas", "dawn"] as const).map((pack) => {
      const tokens = packTokens(pack);
      const definitions = new Map([...globalDefinitions(pack), ...screenLifts]);
      const page = resolve("var(--bg)", pack, definitions, tokens);
      const raised = over(resolve("var(--panel-raised)", pack, definitions, tokens), page);
      return contrast(resolve("var(--accent)", pack, definitions, tokens), raised);
    });
    expect(measured[0]).toBeLessThan(AA_NORMAL);
    expect(measured[1]).toBeLessThan(4.6);
  });

  it("never paints text in --ink-faint", () => {
    expect([...screensCss.matchAll(/color:\s*var\(--ink-faint\)/g)]).toHaveLength(0);
  });

  it("never paints text in the raw --accent", () => {
    // Borders, rings and fills may use it; `color:` may not. `border-color:`
    // ends in "color:" too, so it is excluded explicitly.
    const offenders = [...screensCss.matchAll(/(?<!-)color:\s*var\(--accent\)/g)].map((match) => match[0]);
    expect(offenders).toEqual([]);
  });

  it("derives every screen colour from the pack contract, never a literal", () => {
    // The one permitted literal is the black the vignette mixes toward: a
    // shadow at the edge of the sky is black on every pack, by definition.
    const literals = [...screensCss.matchAll(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi)].map((match) => match[0]);
    expect(literals.filter((literal) => literal.toLowerCase() !== "#000")).toEqual([]);
  });

  it("resolves the screen lifts from tokens every pack actually defines", () => {
    expect([...screenLifts.keys()].sort())
      .toEqual(["--screen-accent-text", "--screen-quiet", "--screen-star"]);
    for (const pack of themePacks) {
      const tokens = packTokens(pack);
      const definitions = new Map([...globalDefinitions(pack), ...screenLifts]);
      for (const value of screenLifts.values()) {
        expect(() => resolve(value, pack, definitions, tokens)).not.toThrow();
      }
    }
  });
});
