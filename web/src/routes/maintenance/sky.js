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
 * Baily's beads (owner, 2026-09-09): sunlight through the valleys on the
 * moon's edge shows as "a row of lucid points, like a string of beads,
 * irregular in size, and distance from each other", strung along a stretch
 * of the limb, that "quickly disappear one by one". So: a few strings at
 * random stretches of the ring, each bead a hot point with a soft glare
 * that smears a little along the rim, lighting in a run and dying off one
 * by one on the string's own clock. Plain shapes, an opacity animation, no
 * filter (#902). Same seed each load, so the picture is reproducible.
 */
function mountGlints() {
  const rng = seededRng(20260909);
  const host = document.getElementById("glints");
  if (!host) return;
  const NS = "http://www.w3.org/2000/svg";
  const R = 171.6;
  for (let str = 0; str < 7; str++) {
    const centre = rng() * Math.PI * 2;
    const span = (10 + rng() * 22) * Math.PI / 180;
    const n = 3 + Math.floor(rng() * 4);
    const period = 5 + rng() * 4;
    const start = -rng() * period;
    for (let i = 0; i < n; i++) {
      const a = centre + (rng() - 0.5) * span;
      const x = 800 + R * Math.cos(a), y = 440 + R * Math.sin(a);
      const size = 0.55 + rng() * 0.95;
      const at = document.createElementNS(NS, "g");
      // the position sits on an outer group: the animation's CSS transform
      // would replace a transform attribute on the same element
      at.setAttribute("transform",
        `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${(a * 180 / Math.PI + 90).toFixed(1)}) scale(${size.toFixed(2)})`);
      const g = document.createElementNS(NS, "g");
      g.setAttribute("class", "glint");
      g.style.animationDuration = period.toFixed(1) + "s";
      g.style.animationDelay = (start - i * (0.18 + rng() * 0.3)).toFixed(2) + "s";
      const glare = document.createElementNS(NS, "circle");
      glare.setAttribute("r", "11"); glare.setAttribute("fill", "url(#glintg)");
      const smear = document.createElementNS(NS, "ellipse");
      smear.setAttribute("rx", "7"); smear.setAttribute("ry", "2.2");
      smear.setAttribute("fill", "#fff4dc"); smear.setAttribute("opacity", ".45");
      const core = document.createElementNS(NS, "circle");
      core.setAttribute("r", "1.9"); core.setAttribute("fill", "#ffffff");
      g.append(glare, smear, core);
      at.appendChild(g);
      host.appendChild(at);
    }
  }
}
