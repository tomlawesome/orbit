import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1299: the descent lagged on desktop Firefox from the dusk beat (3.6 s).
 * Nearly everything on the dusk moves -- the stars drift and twinkle, the
 * belt and the afterglow breathe, the shimmer sweeps -- and every one of them
 * moved INSIDE one of two large drawings (the sky's <svg> and the world's),
 * so Firefox repainted the whole drawing, six full-screen pictures included,
 * on every frame. orbit-site splits them (assets/js/sky.js mountFlightSky,
 * index.html's #dusk .world): each moving part is an <svg> of its own whose
 * animation changes only transform or opacity, which the browser moves or
 * fades as a whole without repainting it.
 *
 * Source-level, shaped like v19-flight-glyph-visibility-dedup.test.mjs: the
 * markup and the stylesheet are read as text.
 */

const FLIGHT = resolve(import.meta.dirname, "../../web/src/lib/flight");
const DUSK = readFileSync(resolve(FLIGHT, "Dusk.svelte"), "utf8");
const CSS = readFileSync(resolve(FLIGHT, "flight.css"), "utf8");
const ATMOSPHERE = readFileSync(resolve(import.meta.dirname, "../../web/src/lib/atmosphere.css"), "utf8");

const markup = DUSK.slice(DUSK.indexOf('<div id="dusk">'));
const sky = markup.slice(markup.indexOf('<div class="sky"'), markup.indexOf('<div class="world"'));
const world = markup.slice(markup.indexOf('<div class="world"'), markup.indexOf('<div class="loginchrome">'));

/** the properties a set of keyframes changes @param {string} name */
function animated(name) {
  const css = CSS + ATMOSPHERE;
  const at = css.indexOf(`@keyframes ${name}{`);
  expect(at, `@keyframes ${name}`).toBeGreaterThan(-1);
  let depth = 0, end = at;
  for (let i = css.indexOf("{", at); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) { end = i; break; }
  }
  const body = css.slice(css.indexOf("{", at) + 1, end);
  return new Set([...body.matchAll(/([a-z-]+)\s*:/gu)].map((m) => m[1]));
}

/** the keyframes a #dusk rule names in its `animation` @param {string} selector */
function keyframesOf(selector) {
  const rule = CSS.match(new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\{([^}]*)\\}`, "mu"));
  expect(rule, selector).not.toBeNull();
  const animation = /** @type {RegExpMatchArray} */ (rule)[1].match(/animation:([^;}]*)/u);
  expect(animation, `${selector} animates`).not.toBeNull();
  return /** @type {RegExpMatchArray} */ (animation)[1].split(",").map((part) => part.trim().split(/\s+/u)[0]);
}

describe("#1299: every moving part of the dusk is a layer of its own", () => {
  it("the sky's drifts and twinkles move whole <svg> layers, not groups or stars inside one", () => {
    expect(sky).not.toMatch(/<g class="(?:far|near)"/u);
    expect(sky).not.toMatch(/<circle[^>]*class="tw"/u);
    expect(sky).toMatch(/<svg class="far" /u);
    expect(sky).toMatch(/<svg class="far tw" /u);
    expect(sky).toMatch(/<svg class="near" /u);
  });

  it("the belt and the afterglow breathe as whole <svg> layers", () => {
    expect(world).toMatch(/<svg class="belt" /u);
    expect(world).toMatch(/<svg class="afterglow" /u);
    expect(world).not.toMatch(/<(?:image|g)[^>]*class="(?:belt|afterglow)"/u);
  });

  it("the shimmer, the one motion that is not a slide or a fade, sweeps a layer holding nothing else", () => {
    const layer = world.match(/<svg class="shimmerlayer"[^>]*>([\s\S]*?)<\/svg>/u);
    expect(layer).not.toBeNull();
    const drawn = [.../** @type {RegExpMatchArray} */ (layer)[1].matchAll(/<(circle|image|rect|path|g|use)\b/gu)];
    expect(drawn.map((m) => m[1])).toEqual(["circle"]);
    expect(/** @type {RegExpMatchArray} */ (layer)[1]).toMatch(/class="shimmer"/u);
  });

  it.each([
    ["#dusk .sky .far"], ["#dusk .sky .near"], ["#dusk .sky .tw"], ["#dusk .belt"], ["#dusk .afterglow"],
  ])("%s animates only transform and opacity", (selector) => {
    for (const name of keyframesOf(selector)) {
      for (const property of animated(name)) expect(["transform", "opacity"], `${selector}: ${name}`).toContain(property);
    }
  });

  it("the drift is a whole tile in screen pixels, measured, and the sky clips what the layers carry past their box", () => {
    expect(CSS).toMatch(/@keyframes recede\{from\{transform:translateX\(calc\(-1 \* var\(--tile, 1600px\)\)\)\}to\{transform:translateX\(0\)\}\}/u);
    expect(DUSK).toMatch(/sky\.style\.setProperty\("--tile", `\$\{1600 \* Math\.max\(box\.width \/ 1600, box\.height \/ 1000\)\}px`\)/u);
    expect(CSS).toMatch(/#dusk \.sky\{overflow:hidden\}/u);
  });

  it("a twinkler keeps its own resting opacity until its twinkle starts, and on the star itself under reduced motion", () => {
    expect(sky).toMatch(/style="--o:\{s\.opacity\};animation-delay:0s,\{s\.delay\}s"/u);
    expect(CSS).toMatch(/#dusk \.sky \.tw\{opacity:var\(--o\);/u);
    const reduced = CSS.slice(CSS.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/#dusk \.sky \.tw\{opacity:1\}/u);
    expect(reduced).toMatch(/#dusk \.sky \.tw circle\{opacity:var\(--o\)\}/u);
  });
});
