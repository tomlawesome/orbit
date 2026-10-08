import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #873: the create/sign-in ring used to close from 500px to 302.4px as ONE
 * box — the stroke, the translucent fill and a `backdrop-filter` blur
 * all on `.ringglass` — animating `width`/`height`. Every frame of the
 * hand-over therefore re-laid-out and re-blurred the glass: worst-case paint
 * 7.06ms against a 16ms budget.
 *
 * The ratified fix is the compensated split (#873, "Decision: the ring close
 * uses the compensated split"). The blurred glass carries no border and
 * closes by `transform: scale()`, which the compositor does; the stroke sits
 * on its own unblurred box that still closes by `width`/`height`, so the line
 * never thins; the orb is untouched. A pure `transform: scale()` of the whole
 * ring was rejected — it thins the stroke and drifts the orb.
 *
 * Pinned against the stylesheets' own text, the way `v19-tour-emphasis` and
 * `v19-flight-mark-ride` pin CSS: a `.css` file has no import surface to
 * assert on, and the rules here are what the browser actually runs.
 */

const root = resolve(import.meta.dirname, "../..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const RINGCARD = read("web/src/lib/ringcard.css");
const ARRIVAL = read("web/src/lib/arrival/arrival.css");

/* Every `selector{…}` pair, comments stripped. Rules nested in an @media
   block are returned on their own, which is what we want: the reduced-motion
   copies are ordinary rules as far as these assertions go. */
function rules(css) {
  const bare = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const found = [];
  const re = /([^{}]+)\{([^{}]*)\}/gu;
  let m;
  while ((m = re.exec(bare)) !== null) {
    found.push({ selector: m[1].trim(), body: m[2] });
  }
  return found;
}

const pick = (css, predicate) => rules(css).filter((r) => predicate(r.selector));

/* The one open-state rule that draws a given ring part. Both sheets also
   carry grouped `pinned` and reduced-motion rules naming the same classes;
   only the base rules are scoped `:where(.arrival, .ringcard)` and end on the
   part they draw, which is what this matches. */
const openRule = (cls) =>
  pick(
    RINGCARD,
    (s) => s.includes(".arrival") && s.endsWith(cls) && !s.includes("body."),
  );

/* Likewise the one closed-state (`body.reclaimed`) rule for that part. */
const closedRule = (cls) =>
  pick(ARRIVAL, (s) => s.includes("body.reclaimed") && s.endsWith(cls));

/* the declared value of one property in a rule body, or "" */
const decl = (body, prop) => {
  const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:([^;}]*)`, "u").exec(body);
  return m ? m[1].trim() : "";
};

describe("#873: the ring closes as a compensated split", () => {
  it("is no longer closed by the arrival: #1263 retired the create card's hand-over", () => {
    // One flight per arrival: the create questions moved into the belong
    // card's drawer, so nothing on the arrival closes the ring any more. The
    // open-state split below still draws the door's own cards.
    for (const part of [".ringglass", ".ringstroke", ".ringorbit"]) {
      expect(closedRule(part), part).toHaveLength(0);
    }
  });

  it("gives the glass a transform transition and no border", () => {
    const open = openRule(".ringglass");
    expect(open).toHaveLength(1);
    const [{ body }] = open;

    expect(decl(body, "backdrop-filter")).toMatch(/blur\(20px\)/u);
    const transition = decl(body, "transition");
    expect(transition).toMatch(/\btransform\b/u);
    expect(transition).not.toMatch(/\bwidth\b/u);
    expect(transition).not.toMatch(/\bheight\b/u);
    // The stroke moved off this box entirely; a border here would be scaled
    // by the transform and thin as the ring closes.
    expect(decl(body, "border")).toBe("");
  });

  it("keeps the stroke on its own unblurred box that still resizes", () => {
    const open = openRule(".ringstroke");
    expect(open).toHaveLength(1);
    const [{ body }] = open;

    expect(decl(body, "width")).toBe("500px");
    expect(decl(body, "height")).toBe("500px");
    // The line is orbit-site's lit ring (#1253): a width the mask reads,
    // registered so the close can still animate it.
    expect(decl(body, "--stroke")).toBe("3.4px");
    // Cheap to redraw is the whole point: nothing blurred on this box.
    expect(body).not.toMatch(/backdrop-filter/u);
    // A transformed sibling paints above plain in-flow boxes, so the stroke
    // must be positioned and lifted or the glass covers it mid-close.
    expect(decl(body, "position")).toBe("relative");
    expect(decl(body, "z-index")).toBe("1");
  });

  it("lifts the orb alongside the stroke", () => {
    const open = openRule(".ringorbit");
    expect(open).toHaveLength(1);
    expect(decl(open[0].body, "position")).toBe("relative");
    expect(decl(open[0].body, "z-index")).toBe("1");
  });

  it("draws the stroke box everywhere the glass is drawn", () => {
    // The ring surfaces are the same card (#914), so none of them may render
    // the glass without its stroke. (The arrival's own ring went with #1263.)
    for (const file of [
      "web/src/lib/flight/SignIn.svelte",
      "web/src/routes/setup/[token]/+page.svelte",
    ]) {
      const markup = read(file);
      expect(markup).toMatch(/class="ringglass"/u);
      expect(markup, `${file} draws the glass without a stroke`).toMatch(
        /class="ringstroke"/u,
      );
    }
  });
});
