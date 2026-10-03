/**
 * THE DEMO BODY (#1151 W3-Q4): the one travelling dot four chapters each
 * drew by hand — 03-lands.js (static only, it never moves), 05-time-runs.js
 * and 09-done.js (byte-for-byte identical before this), and 12-yours.js.
 * Each chapter still owns its own class names (its own unit test pins
 * those selectors, and `clear()`'s `data-tourfilm-staged` sweep does not
 * care what a body is called), so this module takes them as arguments
 * rather than hard-coding one chapter's own.
 */

import { dialPlacement } from "../../data/chart.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Eased 0..1, matching the mockup's own `walk`. @param {number} t */
export function ease(t) {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Draws a demo body on the dial: a `<g class={groupClass}>` wrapping one
 * `<circle class={dotClass} r="5.5" style="fill:var(--accent)">`, placed at
 * `days`' own spot on the dial (chart.js's shared geometry law).
 * @param {Document} doc
 * @param {Element} dial
 * @param {number} days
 * @param {string} groupClass
 * @param {string} dotClass
 */
export function drawDemoBody(doc, dial, days, groupClass, dotClass) {
  const group = doc.createElementNS(SVG_NS, "g");
  group.setAttribute("class", groupClass);
  group.setAttribute("aria-hidden", "true");
  const dot = doc.createElementNS(SVG_NS, "circle");
  dot.setAttribute("class", dotClass);
  dot.setAttribute("r", "5.5");
  dot.setAttribute("style", "fill:var(--accent)");
  group.appendChild(dot);
  dial.appendChild(group);
  positionDemoBody(group, days, dotClass);
  return group;
}

/** Re-sets an already-drawn demo body's own dot to `days`' spot.
 * @param {Element} group @param {number} days @param {string} dotClass */
export function positionDemoBody(group, days, dotClass) {
  const { x, y } = dialPlacement(days);
  const dot = group.querySelector(`.${dotClass}`);
  if (!dot) return;
  dot.setAttribute("cx", String(x));
  dot.setAttribute("cy", String(y));
}
