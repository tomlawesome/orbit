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
  mountShimmer();
}

/**
 * The shimmer on the photon ring (owner, 2026-09-09): short arcs just outside
 * the crisp 1.2-wide ring, each fading in and out on its own period and
 * delay, so the limb glints unevenly rather than pulsing as one. Plain
 * strokes with an opacity animation — no filter, nothing for the GPU law to
 * object to (#902). Same seed each load, so the picture is reproducible.
 */
function mountShimmer() {
  const rng = seededRng(20260909);
  const host = document.getElementById("shimmer");
  if (!host) return;
  const NS = "http://www.w3.org/2000/svg";
  const R = 172.4;
  for (let i = 0; i < 34; i++) {
    const a0 = rng() * Math.PI * 2;
    const span = (3 + rng() * 11) * (Math.PI / 180);
    const x1 = 800 + R * Math.cos(a0), y1 = 440 + R * Math.sin(a0);
    const x2 = 800 + R * Math.cos(a0 + span), y2 = 440 + R * Math.sin(a0 + span);
    const arc = document.createElementNS(NS, "path");
    arc.setAttribute("d", `M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${R} ${R} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`);
    arc.setAttribute("stroke-width", (0.8 + rng() * 1.4).toFixed(2));
    arc.style.setProperty("--o", (0.3 + rng() * 0.45).toFixed(2));
    arc.style.animationDuration = (2.2 + rng() * 3.6).toFixed(1) + "s";
    arc.style.animationDelay = (-rng() * 6).toFixed(1) + "s";
    host.appendChild(arc);
  }
}
