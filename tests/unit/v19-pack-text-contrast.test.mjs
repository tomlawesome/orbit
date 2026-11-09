import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { THEME_PACKS } from "../../web/src/lib/theme.js";

import {
  AA_TEXT_FLOOR, BLOCKS, PACK_NAMES, compositeOver, contrastRatio, resolveColor, textGroundToken,
} from "./v19-pack-contrast-lib.mjs";

/*
 * #491 item 3: every "-text" companion (and --ink-quiet) is a promise that a
 * letterform drawn in that colour clears WCAG 2's 4.5:1 body-text floor on
 * the worst ground the pack actually paints it on. The promise is only as
 * good as this file's ability to break when a value regresses — so it parses
 * the real web/src/lib/packs.css (not a copy of it) and measures every pack,
 * rather than asserting a handful of hand-picked spots.
 *
 * Grounds, per the 2026-09-02 ruling: dawn and clouds against --sky-1 (the
 * coolest, darkest stop of the gradient, which is what the top of the dial
 * screen actually paints); the remaining packs against their own --bg.
 *
 * The packs and each one's ground token are discovered from packs.css by
 * v19-pack-contrast-lib.mjs (a pack that defines --sky-1 is graded on it, the
 * rest on --bg), as are the colour maths, color-mix() included.
 */

const GROUND_TOKEN = Object.fromEntries(PACK_NAMES.map((pack) => [pack, textGroundToken(pack)]));

const TEXT_TOKENS = ["--overdue-text", "--degraded-text", "--accent-text", "--ok-text", "--ink-quiet"];


/** An opaque pack colour (a -text companion, --bg, --sky-1) as [r,g,b]. */
const rgbOf = (pack, raw) => resolveColor(pack, raw).rgb;

describe("packs.css text-grade companions clear WCAG 2 AA on their pack's ground (#491)", () => {
  it("grades exactly the roster theme.js names (#865)", () => {
    expect(new Set(PACK_NAMES)).toEqual(new Set(THEME_PACKS));
  });

  it.each(PACK_NAMES)("%s defines every -text companion and --ink-quiet", (pack) => {
    for (const token of TEXT_TOKENS) {
      expect(BLOCKS[pack]).toHaveProperty(token);
    }
  });

  it.each(PACK_NAMES)("%s: every -text companion and --ink-quiet clears 4.5:1 on its ground", (pack) => {
    const groundRgb = rgbOf(pack, `var(${GROUND_TOKEN[pack]})`);
    const failures = [];
    for (const token of TEXT_TOKENS) {
      const raw = BLOCKS[pack][token];
      const rgb = rgbOf(pack, raw);
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

/*
 * #854 (#491 item 3, left unmeasured): two text sites that had no -text
 * companion at all.
 *
 *   --warm    used directly as text — "due soon" labels (.t.soon) and the
 *             arrival screen's error line (arrival.css:134) among others.
 *             Measured raw, --warm cleared 4.5:1 on the dark packs and
 *             retrograde (10.51 / 10.80 / 13.67:1 on --bg) but not on the
 *             daylight packs (2.66 / 2.64 / 2.64:1) — so packs.css now
 *             carries --warm-text, the graded companion (var(--warm) itself,
 *             unmoved, on the packs that already passed). Measured on --bg,
 *             where those sites actually sit, and on --panel, composited
 *             over --bg the way html body{background:var(--bg)} + a
 *             translucent panel actually paints (item.css; belt.css retired in #1319) — a
 *             plain "over" blend, no gamma correction.
 *   --act     on the item screen (the belt page, retired in #1319), .acts
 *             button and .btn-quiet (item.css, belt.css) used one inline
 *             custom property for text, border and fill at once:
 *             color:var(--act,...).
 *             The values bound to it for those buttons are --overdue,
 *             --accent, --ok and --upcoming raw (--warm is also bound there;
 *             its case is the row above). Raw, all of them failed on
 *             --panel on the daylight packs (2.06-4.30:1) even though their
 *             -text companions already existed from #491 — that ground had
 *             simply never been measured. The buttons now carry a sibling
 *             --act-text custom property (set beside --act wherever it is
 *             --overdue/--accent/--ok/--warm/--upcoming — the last one #855,
 *             measured at 2.97-3.54:1 on the same packs) so the ring and fill keep
 *             --act's raw colour and only the letterform reads the graded
 *             one; .acts button/.btn-quiet's `color` now reads
 *             var(--act-text,var(--act,var(--ink-mid))). Measured here as
 *             the -text companion actually used for that value.
 */
const ACT_BUTTON_VALUES = ["overdue", "accent", "ok", "upcoming"];

/** rgba(...) --panel composited over the pack's own --bg — html body's real
 * painted background per item.css (and belt.css, retired). */
function panelGround(pack) {
  return compositeOver(resolveColor(pack, "var(--panel)"), rgbOf(pack, "var(--bg)"));
}

describe("#854: --warm and the item action buttons, measured as text", () => {
  it.each(PACK_NAMES)("%s: defines --warm-text", (pack) => {
    expect(BLOCKS[pack]).toHaveProperty("--warm-text");
  });

  it.each(PACK_NAMES)("%s: --warm-text clears 4.5:1 on --bg", (pack) => {
    const ratio = contrastRatio(rgbOf(pack, "var(--warm-text)"), rgbOf(pack, "var(--bg)"));
    console.log(`#854 ${pack}: --warm-text on --bg = ${ratio.toFixed(2)}:1`);
    expect(ratio).toBeGreaterThanOrEqual(AA_TEXT_FLOOR);
  });

  it.each(PACK_NAMES)("%s: --warm-text clears 4.5:1 on --panel", (pack) => {
    const ratio = contrastRatio(rgbOf(pack, "var(--warm-text)"), panelGround(pack));
    console.log(`#854 ${pack}: --warm-text on --panel = ${ratio.toFixed(2)}:1`);
    expect(ratio).toBeGreaterThanOrEqual(AA_TEXT_FLOOR);
  });

  it.each(PACK_NAMES)("%s: each --act button's -text companion clears 4.5:1 on --panel", (pack) => {
    const ground = panelGround(pack);
    const failures = [];
    for (const token of ACT_BUTTON_VALUES) {
      const ratio = contrastRatio(rgbOf(pack, `var(--${token}-text)`), ground);
      console.log(`#854 ${pack}: --${token}-text (--act-text button text) on --panel = ${ratio.toFixed(2)}:1`);
      if (ratio < AA_TEXT_FLOOR) {
        failures.push(`--${token}-text = ${ratio.toFixed(2)}:1 on --panel`);
      }
    }
    expect(failures).toEqual([]);
  });
});

/*
 * #1686 (design call): words on the chooser glass and the relay tile are set
 * in --ink-quiet, never --ink-faint, with no opacity on top. The relay's
 * "tap to copy" sits on the accent-7% tile, a ground --ink-quiet is held to
 * from now on; the calendar's weekday heads and out-of-month days sit on
 * --panel-raised.
 */
const CALENDAR = readFileSync(new URL("../../web/src/lib/editing/Calendar.svelte", import.meta.url), "utf8");
const web = (rel) => readFileSync(new URL(`../../web/${rel}`, import.meta.url), "utf8");
const CHOOSER = web("src/lib/editing/ChooserCard.svelte");
const TILES = web("src/lib/editing/Tiles.svelte");
const REPEAT_BAND = web("src/lib/editing/RepeatBand.svelte");
/* #1509: the relay's copy hint lives on Settings' Mail card now, desk and phone. */
const SETTINGS_POCKET = web("src/routes/settings/pocket.svelte");
const RELAY_CSS = web("src/routes/settings/relay.css");
const cssRule = (src, selector) => {
  const at = src.indexOf(`${selector}{`);
  if (at < 0) throw new Error(`no rule ${selector}`);
  return src.slice(at + selector.length + 1, src.indexOf("}", at));
};
const bgOf = (pack) => rgbOf(pack, "var(--bg)");
const overBg = (pack, raw) => compositeOver(resolveColor(pack, raw), bgOf(pack));

describe("#1686: --ink-quiet on the relay tile and the calendar clears 4.5:1", () => {
  it.each(PACK_NAMES)("%s: --ink-quiet on the accent-7 percent relay tile", (pack) => {
    const tile = compositeOver(
      resolveColor(pack, "color-mix(in srgb, var(--accent) 7%, var(--panel))"),
      rgbOf(pack, `var(${GROUND_TOKEN[pack]})`),
    );
    const ratio = contrastRatio(rgbOf(pack, "var(--ink-quiet)"), tile);
    console.log(`#1686 ${pack}: --ink-quiet on the relay tile = ${ratio.toFixed(2)}:1`);
    expect(ratio).toBeGreaterThanOrEqual(AA_TEXT_FLOOR);
  });

  /* The computed tile (#111a25) gives today's #768295 4.51:1, a hair over the
     floor; the axe probe measured the painted tile as #131b27 (4.44-4.45:1).
     Hold the token to the probed ground as well, so the lift is required. */
  it("afterdark: --ink-quiet on the relay tile as the axe probe painted it (#131b27)", () => {
    const ratio = contrastRatio(rgbOf("afterdark", "var(--ink-quiet)"), [0x13, 0x1b, 0x27]);
    console.log(`#1686 afterdark: --ink-quiet on the probed relay tile = ${ratio.toFixed(2)}:1`);
    expect(ratio).toBeGreaterThanOrEqual(AA_TEXT_FLOOR);
  });

  it("the calendar's .dow and .day.off are --ink-quiet with no opacity", () => {
    expect(cssRule(CALENDAR, ".dow")).toMatch(/color:var\(--ink-quiet\)/);
    const off = cssRule(CALENDAR, ".day.off");
    expect(off).toMatch(/color:var\(--ink-quiet\)/);
    expect(off).not.toMatch(/opacity/);
  });

  it.each([
    ["ChooserCard h3", CHOOSER, "h3"],
    ["ChooserCard .kb", CHOOSER, ".kb"],
    ["Tiles small", TILES, ".tile>small"],
    ["RepeatBand small", REPEAT_BAND, ".cell>small"],
  ])("%s is --ink-quiet, not --ink-faint, with no opacity", (_name, src, selector) => {
    const rule = cssRule(src, selector);
    expect(rule).toMatch(/color:var\(--ink-quiet\)/);
    expect(rule).not.toMatch(/ink-faint/);
    expect(rule).not.toMatch(/opacity/);
  });

  /* The old relay page's `.rl-copy` row, retargeted with the move (#1509):
     the hint on the address tile of the Mail card's `your relay` tab. The
     phone's is --ink-mid since #1137 (quiet read 4.49:1 there), which is
     only darker; never faint, never dimmed by opacity. */
  it.each([
    ["mail relay tab, phone .st-copy", SETTINGS_POCKET, ".st-copy"],
    ["mail relay tab, desk hint", RELAY_CSS, ".mailcard button.alias small"],
  ])("%s is --ink-mid or --ink-quiet, not --ink-faint, with no opacity", (_name, src, selector) => {
    const rule = cssRule(src, selector);
    expect(rule).toMatch(/color:var\(--ink-(?:mid|quiet)\)/);
    expect(rule).not.toMatch(/ink-faint/);
    expect(rule).not.toMatch(/opacity/);
  });

  it.each(PACK_NAMES)("%s: --ink-quiet on --panel-raised (calendar .dow and .day.off)", (pack) => {
    const ratio = contrastRatio(rgbOf(pack, "var(--ink-quiet)"), overBg(pack, "var(--panel-raised)"));
    console.log(`#1686 ${pack}: --ink-quiet on --panel-raised = ${ratio.toFixed(2)}:1`);
    expect(ratio).toBeGreaterThanOrEqual(AA_TEXT_FLOOR);
  });
});

/*
 * #1684 (design call): the household page's at-rest "save" is --ink-quiet at
 * full opacity (the grade alone says "nothing to save yet"), on the card
 * (--panel over --bg).
 */
const HOUSEHOLD_CSS = readFileSync(
  new URL("../../web/src/routes/household/[id]/household.css", import.meta.url), "utf8",
);

describe("#1684: the household .fsave at rest", () => {
  it("has no opacity dimming at rest", () => {
    const rule = cssRule(HOUSEHOLD_CSS, ".household-page .fsave");
    expect(rule).toMatch(/color:var\(--ink-quiet\)/);
    expect(rule).not.toMatch(/opacity/);
  });

  it.each(PACK_NAMES)("%s: --ink-quiet on the card clears 4.5:1", (pack) => {
    const ratio = contrastRatio(rgbOf(pack, "var(--ink-quiet)"), panelGround(pack));
    console.log(`#1684 ${pack}: .fsave on --panel = ${ratio.toFixed(2)}:1`);
    expect(ratio).toBeGreaterThanOrEqual(AA_TEXT_FLOOR);
  });
});
