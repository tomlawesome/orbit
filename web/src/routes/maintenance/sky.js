/**
 * Totality's daytime starfield, carried across from
 * design/family/maintenance.html with its seeded RNG intact. Bright stars
 * only, kept clear of the eclipsed disc — an eclipse is the one time the day
 * stars come out (CON-15).
 *
 * Imperative DOM by design. Svelte renders the markup and stands back.
 *
 * The shape is totality's own, but the randomness is the shared generator's
 * (#445): this file used to carry its own retyped Park–Miller.
 */
import { seededRng } from "$lib/sky.js";

export function mountTotalitySky() {
  // deterministic starfield — bright stars only; totality lets the day stars out
  const rng = seededRng(20260812);
  // Both ids are in the static markup this mounts into, so they always resolve.
  const far = /** @type {Element} */ (document.getElementById("farstars"));
  const near = /** @type {Element} */ (document.getElementById("nearstars"));
  const NS = "http://www.w3.org/2000/svg";
  /** @param {number} x @param {number} y */
  const clearOf = (x, y) => Math.hypot(x - 800, y - 440) > 300;
  let made = 0;
  while (made < 90) {
    const x = rng() * 1600, y = rng() * 1000;
    if (!clearOf(x, y)) continue;
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", x.toFixed(1)); c.setAttribute("cy", y.toFixed(1));
    c.setAttribute("r", (0.4 + rng() * 0.6).toFixed(2));
    c.setAttribute("opacity", (0.12 + rng() * 0.25).toFixed(2));
    if (rng() < 0.16) { c.setAttribute("class", "tw"); c.style.animationDelay = (rng() * 6).toFixed(1) + "s"; }
    far.appendChild(c); made++;
  }
  made = 0;
  while (made < 26) {
    const x = rng() * 1600, y = rng() * 1000;
    if (!clearOf(x, y)) continue;
    const r = 1 + rng() * 0.9;
    const g = document.createElementNS(NS, "circle");
    g.setAttribute("cx", x.toFixed(1)); g.setAttribute("cy", y.toFixed(1));
    g.setAttribute("r", (r * 4).toFixed(1)); g.setAttribute("fill", "url(#stargl)");
    near.appendChild(g);
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", x.toFixed(1)); c.setAttribute("cy", y.toFixed(1));
    c.setAttribute("r", r.toFixed(2)); c.setAttribute("fill", "var(--star-near)");
    c.setAttribute("opacity", (0.45 + rng() * 0.4).toFixed(2));
    if (rng() < 0.3) { c.setAttribute("class", "tw"); c.style.animationDelay = (rng() * 6).toFixed(1) + "s"; }
    near.appendChild(c); made++;
  }
  mountGlints();
}

/**
 * Glints on the limb (owner, 2026-09-09): small bright, almost sparkly spots
 * at random points just outside the photon ring — the beads of light that
 * break through at the moon's edge — each flaring up and dying on its own
 * clock, so a few are lit at any moment and never the same few. A soft halo,
 * a hot core and a thin four-point cross, all plain shapes with an opacity
 * and scale animation: no filter, nothing for the GPU law to object to
 * (#902). Same seed each load, so the picture is reproducible.
 */
function mountGlints() {
  const rng = seededRng(20260909);
  const host = document.getElementById("glints");
  if (!host) return;
  const NS = "http://www.w3.org/2000/svg";
  const R = 171.2;
  for (let i = 0; i < 22; i++) {
    const a = rng() * Math.PI * 2;
    const x = 800 + R * Math.cos(a), y = 440 + R * Math.sin(a);
    const size = 0.9 + rng() * 0.9;
    // the position sits on an outer group: the animation's CSS transform
    // would replace a transform attribute on the same element
    const at = document.createElementNS(NS, "g");
    at.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${size.toFixed(2)})`);
    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", "glint");
    g.style.animationDuration = (3.5 + rng() * 6).toFixed(1) + "s";
    g.style.animationDelay = (-rng() * 9).toFixed(1) + "s";
    const halo = document.createElementNS(NS, "circle");
    halo.setAttribute("r", "9"); halo.setAttribute("fill", "url(#glintg)");
    const cross = document.createElementNS(NS, "path");
    cross.setAttribute("d", "M -7 0 H 7 M 0 -7 V 7");
    cross.setAttribute("stroke", "#fffdf6"); cross.setAttribute("stroke-width", "0.7");
    cross.setAttribute("stroke-linecap", "round"); cross.setAttribute("opacity", ".8");
    const core = document.createElementNS(NS, "circle");
    core.setAttribute("r", "1.6"); core.setAttribute("fill", "#ffffff");
    g.append(halo, cross, core);
    at.appendChild(g);
    host.appendChild(at);
  }
}
