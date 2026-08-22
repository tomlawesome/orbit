/**
 * Totality's daytime starfield, carried across from
 * design/family/maintenance.html with its seeded RNG intact. Bright stars
 * only, kept clear of the eclipsed disc — an eclipse is the one time the day
 * stars come out (CON-15).
 *
 * Imperative DOM by design. Svelte renders the markup and stands back.
 */
export function mountTotalitySky() {
  // deterministic starfield — bright stars only; totality lets the day stars out
  const rng = (s => () => (s = (s * 48271) % 2147483647) / 2147483647)(20260812);
  const far = document.getElementById("farstars"), near = document.getElementById("nearstars");
  const NS = "http://www.w3.org/2000/svg";
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
    c.setAttribute("r", r.toFixed(2)); c.setAttribute("fill", "#eef2ff");
    c.setAttribute("opacity", (0.45 + rng() * 0.4).toFixed(2));
    if (rng() < 0.3) { c.setAttribute("class", "tw"); c.style.animationDelay = (rng() * 6).toFixed(1) + "s"; }
    near.appendChild(c); made++;
  }
}
