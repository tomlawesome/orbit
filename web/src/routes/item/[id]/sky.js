/**
 * The item view's starfield.
 *
 * POL-11 is an owner rule: every page's sky drifts, perceptibly within three
 * to five seconds, seamlessly, in one direction. A screen with a static
 * background would be the first to break it.
 *
 * Same two-layer tiled field and the same generated alphas as home, so this is
 * the same sky seen from a different page rather than a second one. Seeded, so
 * it is identical on every load and the gate could hold it still if this
 * screen ever earns a baseline.
 */
export function mountItemSky(root) {
  const NS = "http://www.w3.org/2000/svg";
  const rng = ((s) => () => (s = (s * 48271) % 2147483647) / 2147483647)(17170812);
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 1600 1000");
  svg.setAttribute("preserveAspectRatio", "xMidYMid slice");

  for (const [cls, count, rMin, rSpan, oMin, oSpan] of [
    ["far", 95, 0.4, 0.5, 0.12, 0.23],
    ["near", 46, 0.8, 0.7, 0.3, 0.4],
  ]) {
    const layer = document.createElementNS(NS, "g");
    layer.setAttribute("class", cls);
    layer.setAttribute("fill", cls === "far" ? "var(--star-far, #e9edf8)" : "var(--star-near, #f4f0ff)");
    const tile = document.createElementNS(NS, "g");
    for (let i = 0; i < count; i++) {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", (rng() * 1600).toFixed(1));
      c.setAttribute("cy", (rng() * 1000).toFixed(1));
      c.setAttribute("r", (rMin + rng() * rSpan).toFixed(2));
      c.setAttribute("opacity", (oMin + rng() * oSpan).toFixed(2));
      tile.appendChild(c);
    }
    /* Tiled and wrapped over exactly one tile width, so the drift never snaps
       or reverses — POL-11's "perfectly seamless". */
    const repeat = document.createElementNS(NS, "use");
    repeat.setAttribute("href", "#" + cls + "tile-item");
    repeat.setAttribute("x", "1600");
    tile.id = cls + "tile-item";
    layer.append(tile, repeat);
    svg.appendChild(layer);
  }
  root.appendChild(svg);
}
