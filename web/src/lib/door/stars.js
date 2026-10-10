/*
 * The door's stars: the dawn's and the dusk's tiled fields, drawn off one seeded stream in the sheet's own order
 * (carried from Orbit's flight/starfields.js), and the SVG they are mounted as.
 */
const NS = "http://www.w3.org/2000/svg";

/** a seeded random stream (Park-Miller), the same on every visit: the fields, and the flight's traffic (engine.js) */
export function seededRng(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 48271) % 2147483647) / 2147483647;
}

/** an SVG element, with attributes, appended */
export function el(name, attrs, parent) {
  const e = document.createElementNS(NS, name);
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

/* the drift is a transform on the layer's own <svg> element, not on a group
   inside one: an element the compositor can move on its own, so the sky
   costs nothing per frame. The tile is 1600 units wide; `--tile` says how
   many pixels that is at this size, so the seam never shows. Returns a function that stops measuring */
export function measureTile(host) {
  const set = () => {
    const scale = Math.max(host.clientWidth / 1600, host.clientHeight / 1000);
    host.style.setProperty("--tile", `${(1600 * scale).toFixed(1)}px`);
  };
  set();
  let t; const onResize = () => { clearTimeout(t); t = setTimeout(set, 100); };
  addEventListener("resize", onResize);
  return () => { clearTimeout(t); removeEventListener("resize", onResize); };
}

/* The dawn's and the dusk's tiled fields, drawn off ONE stream in the sheet's own order. */
const rnd = seededRng(17170812);
function tile(n, rMin, rSpan, oMin, oSpan, twinkle) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const star = { cx: (rnd() * 1600).toFixed(1), cy: (rnd() * 1000).toFixed(1), r: (rMin + rnd() * rSpan).toFixed(2), opacity: (oMin + rnd() * oSpan).toFixed(2), delay: null };
    if (twinkle && i % 6 === 0) star.delay = (rnd() * 5.6).toFixed(1);
    out.push(star);
  }
  return out;
}
export const DAWN_FAR = tile(100, 0.4, 0.5, 0.10, 0.25, true);
export const DAWN_NEAR = tile(44, 0.8, 0.8, 0.35, 0.35, false);
export const DUSK_FAR = tile(100, 0.4, 0.55, 0.14, 0.28, true);
export const DUSK_NEAR = tile(48, 0.8, 0.85, 0.40, 0.38, false);

export function mountFlightSky(host, far, near, idPrefix) {
  /* the far field, the few stars that twinkle, and the near field — each drifting on its own. The twinklers are
     three layers of their own, each fading as a whole, out of step with the others: a layer's fade is the
     compositor's, where a star's own would have the page repaint its layer every frame */
  const layer = (cls, fill, id, stars, tw = null) => {
    const svg = el("svg", { class: cls, viewBox: "0 0 1600 1000", preserveAspectRatio: "xMidYMid slice" }, host);
    if (tw !== null) svg.style.setProperty("--tw", `${tw}s`);
    const g = el("g", { fill }, svg);
    const tile = el("g", { id }, g);
    /* a twinkler is drawn at full strength, its layer fading it */
    for (const s of stars) el("circle", { cx: s.cx, cy: s.cy, r: s.r, opacity: tw === null ? s.opacity : 1 }, tile);
    el("use", { href: `#${id}`, x: "1600" }, g);
  };
  layer("far", "var(--star-far, #e9edf8)", `${idPrefix}-far`, far.filter((s) => !s.delay));
  const twinklers = far.filter((s) => s.delay);
  for (let k = 0; k < 3; k++) layer("far tws", "var(--star-far, #e9edf8)", `${idPrefix}-tw${k}`, twinklers.filter((_, i) => i % 3 === k), -k * 1.5);
  layer("near", "var(--star-near, #f4f0ff)", `${idPrefix}-near`, near);
  return measureTile(host);
}
